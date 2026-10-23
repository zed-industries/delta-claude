/** First installation uses the published Burn bundle, including its scope and elevation policy. */
export const installWindows = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$lock = $null
$work = $null
$running = $false
$lockPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'delta-claude-install.lock'
try {
  try {
    $lock = [IO.File]::Open($lockPath, 'CreateNew', 'Write', 'None')
  } catch {
    throw "Another Delta installation may be running. Let it finish before retrying. If no installer is running, remove $lockPath and retry."
  }
  # A different plugin host may have installed after discovery.
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
    try {
      $key = $base.OpenSubKey('Software\\Zed Industries\\Delta')
      if ($key) {
        try {
          $folder = $key.GetValue('InstallFolder')
          if ($folder -is [string] -and [IO.Path]::IsPathRooted($folder) -and
              [IO.File]::Exists((Join-Path $folder 'bin\\delta.exe'))) { exit 0 }
        } finally { $key.Dispose() }
      }
    } finally { $base.Dispose() }
  }
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
  switch ($architecture) {
    'AMD64' { $architecture = 'x86_64' }
    'ARM64' { $architecture = 'aarch64' }
    default { throw "Unsupported Windows architecture: $architecture" }
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $release = Invoke-RestMethod -TimeoutSec 30 -Uri "https://delta.dev/api/releases/stable/latest/asset?asset=delta&os=windows&arch=$architecture"
  $url = $null
  if ($release.url -isnot [string] -or
      -not [Uri]::TryCreate($release.url, [UriKind]::Absolute, [ref]$url) -or
      $url.Scheme -ne 'https') { throw 'The release API did not return an HTTPS download URL.' }
  $work = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
  [void][IO.Directory]::CreateDirectory($work)
  $setup = Join-Path $work 'delta-setup.exe'
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $url.AbsoluteUri -OutFile $setup
  $process = Start-Process -FilePath $setup -ArgumentList '/passive', '/norestart' -PassThru
  $running = $true
  if (-not $process.WaitForExit(420000)) {
    throw "The Delta installer is still running; approve any Windows prompt and let it finish. Its files remain at $work. Once it finishes, remove $lockPath before retrying."
  }
  $running = $false
  switch ($process.ExitCode) {
    0 { }
    1602 { throw 'Delta installation was cancelled.' }
    1223 { throw 'Delta installation permission was cancelled.' }
    3010 { throw 'Windows requires a restart to finish installing Delta. Restart Windows before retrying setup.' }
    1641 { throw 'The installer initiated a Windows restart. Finish restarting before retrying setup.' }
    default { throw "The Delta installer failed with exit code $($process.ExitCode)." }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($lock) {
    $lock.Dispose()
    if (-not $running) {
      Remove-Item -LiteralPath $lockPath -Force
      if ($work) { Remove-Item -LiteralPath $work -Recurse -Force }
    }
  }
}
`
