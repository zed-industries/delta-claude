# Exercise the shipped orchestration in Windows PowerShell without downloading or installing software.
$ErrorActionPreference = 'Stop'
$source = Get-Content (Join-Path $PSScriptRoot '../hooks/cli/windows-install.ts') -Raw
$script = [regex]::Match($source, '(?s)String.raw`\r?\n(.*)\r?\n`').Groups[1].Value
if (-not $script) { throw 'Windows install script not found' }
$work = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
[void][IO.Directory]::CreateDirectory($work)
try {
    $cases = @(
        @{ Architecture = 'AMD64'; Code = 0; Expected = 0; Arch = 'x86_64' },
        @{ Architecture = 'ARM64'; Code = 0; Expected = 0; Arch = 'aarch64' },
        @{ Architecture = 'x86'; Code = 0; Expected = 1; Error = 'Unsupported Windows architecture' },
        @{ Architecture = 'AMD64'; Code = 1602; Expected = 1; Arch = 'x86_64'; Error = 'cancelled' },
        @{ Architecture = 'AMD64'; Code = 3010; Expected = 1; Arch = 'x86_64'; Error = 'requires a restart' },
        @{ Architecture = 'AMD64'; Code = 1641; Expected = 1; Arch = 'x86_64'; Error = 'initiated a Windows restart' },
        @{ Architecture = 'AMD64'; Code = 1603; Expected = 1; Arch = 'x86_64'; Error = 'exit code 1603' },
        @{ Architecture = 'AMD64'; Code = 0; Expected = 1; Arch = 'x86_64'; Timeout = $true; Error = 'still running' },
        @{ Architecture = 'AMD64'; Code = 0; Expected = 1; Arch = 'x86_64'; BadUrl = $true; Error = 'HTTPS download URL' }
    )
    foreach ($case in $cases) {
        $directory = Join-Path $work ([Guid]::NewGuid().ToString())
        [void][IO.Directory]::CreateDirectory($directory)
        $lock = Join-Path $directory 'install.lock'
        $fixture = Join-Path $directory 'fixture.ps1'
        $prefix = @"
`$env:PROCESSOR_ARCHITEW6432 = '$($case.Architecture)'
`$env:PROCESSOR_ARCHITECTURE = 'x86'
function Invoke-RestMethod {
    param(`$TimeoutSec, `$Uri)
    if (`$Uri -ne 'https://delta.dev/api/releases/stable/latest/asset?asset=delta&os=windows&arch=$($case.Arch)') {
        throw "Wrong release URL: `$Uri"
    }
    return @{ url = '$(if ($case.BadUrl) { 'http' } else { 'https' })://releases.delta.dev/setup.exe' }
}
function Invoke-WebRequest {
    param([switch]`$UseBasicParsing, `$TimeoutSec, `$Uri, `$OutFile)
    if (`$Uri -ne 'https://releases.delta.dev/setup.exe') { throw 'Wrong asset URL' }
    [IO.File]::WriteAllText(`$OutFile, 'fixture')
}
function Start-Process {
    param(`$FilePath, `$ArgumentList, [switch]`$PassThru)
    if ((`$ArgumentList -join ' ') -ne '/passive /norestart') { throw 'Unexpected installer arguments' }
    if (-not [IO.File]::Exists(`$FilePath)) { throw 'Missing setup download' }
    `$process = [pscustomobject]@{ ExitCode = $($case.Code) }
    `$process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { return `$$(-not $case.Timeout) }
    return `$process
}
"@
        # Isolate registry and lock state while running the production control flow unchanged.
        $isolated = $script.Replace('Software\Zed Industries\Delta', "Software\DeltaSetupTest\$([Guid]::NewGuid())")
        $isolated = $isolated.Replace(
            "Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'delta-claude-install.lock'",
            "'$($lock.Replace("'", "''"))'")
        # Keep retained timeout artifacts inside the test's own cleanup directory.
        $isolated = $isolated.Replace('[IO.Path]::GetTempPath()', "'$($directory.Replace("'", "''"))'")
        [IO.File]::WriteAllText($fixture, "$prefix`n$isolated")
        $process = Start-Process powershell.exe -ArgumentList "-NoLogo -NoProfile -NonInteractive -File `"$fixture`"" `
            -RedirectStandardOutput (Join-Path $directory 'stdout') `
            -RedirectStandardError (Join-Path $directory 'stderr') -Wait -PassThru
        $stderr = Get-Content (Join-Path $directory 'stderr') -Raw
        if ($process.ExitCode -ne $case.Expected) { throw "Unexpected exit code $($process.ExitCode): $stderr" }
        if ($case.Error -and $stderr -notmatch $case.Error) { throw "Incorrect failure: $stderr" }
        if ((Test-Path $lock) -ne [bool]$case.Timeout) { throw 'Incorrect installation lock lifetime' }
        $retained = @(Get-ChildItem $directory -Directory)
        if ($retained.Count -ne [int][bool]$case.Timeout) { throw 'Incorrect installer artifact lifetime' }
    }
    Write-Host "$($cases.Count) Windows setup scenarios passed."
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
