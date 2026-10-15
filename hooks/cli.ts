import type { EngineInterface } from 'claude-code'

type Run = EngineInterface['process']['run']
type WindowsDiscovery = Pick<EngineInterface['fs'], 'exists'>
class MissingCliError extends Error {}

/** Discovery never starts Delta or downloads anything, including during resume. */
const discover = `
set -eu
report() {
  case "$1" in
    /*) printf '%s\\n' "$1" ;;
    *) directory=$(cd "$(dirname "$1")" && pwd); printf '%s/%s\\n' "$directory" "$(basename "$1")" ;;
  esac
}
if cli=$(command -v delta); then report "$cli"; exit 0; fi
: "\${HOME:?HOME is required}"
case "$(uname -s)" in
  Darwin)
    for cli in "$HOME/Applications/Delta.app/Contents/MacOS/delta" /Applications/Delta.app/Contents/MacOS/delta; do
      if [ -x "$cli" ]; then report "$cli"; exit 0; fi
    done ;;
  Linux)
    cli="$HOME/.local/delta.app/bin/delta"
    if [ -x "$cli" ]; then report "$cli"; exit 0; fi ;;
  *) echo 'Automatic Delta setup supports macOS and Linux only.' >&2; exit 1 ;;
esac
exit 3
`

/** The installer owns app layout, architecture selection, extraction, and CLI linking. */
const install = `
set -eu
: "\${HOME:?HOME is required}"
mkdir -p "$HOME/.cache"
lock="$HOME/.cache/delta-claude-install.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "Another Delta plugin may be installing. Wait and retry. If no installation is running, remove $lock and retry." >&2
  exit 1
fi
work=
cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Another host may have completed setup since our first discovery.
discover_existing() {
${discover}
}
if cli=$(discover_existing); then
  printf '%s\\n' "$cli"
  exit 0
fi
work=$(mktemp -d)
curl --fail --show-error --silent --location --connect-timeout 30 --max-time 120 https://delta.dev/install.sh -o "$work/install.sh"
# Recheck under the lock: another plugin may have finished before we acquired it.
if cli=$(sh "$work/install.sh" --locate-cli); then
  printf '%s\\n' "$cli"
else
  sh "$work/install.sh" --non-interactive
fi
`

/** Resolve once per plugin host; failed setup remains retryable. */
export class DeltaCli {
  private executable?: string
  private pending?: Promise<string>

  async resolve(run: Run, allowInstall = false, progress = (_text: string) => {}, windows: WindowsDiscovery | false = false): Promise<string> {
    if (this.executable) return this.executable
    if (this.pending) {
      try { return await this.pending }
      catch (error) {
        // An explicit command can follow an observer's missing-CLI result.
        if (!allowInstall || !(error instanceof MissingCliError)) throw error
        return this.resolve(run, true, progress, windows)
      }
    }
    const pending = this.setup(run, allowInstall, progress, windows)
    this.pending = pending
    try {
      this.executable = await pending
      return this.executable
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  private async setup(run: Run, allowInstall: boolean, progress: (text: string) => void, windows: WindowsDiscovery | false): Promise<string> {
    if (windows) {
      // Restrict lookup to PATH rather than also searching the current checkout.
      const result = await run(['where.exe', '$PATH:delta.exe'], { timeoutMs: 30_000 })
      if (result.isStdoutTruncated || result.isStderrTruncated) throw new Error('Delta CLI discovery output was truncated; retry.')
      if (result.exitCode === 0) return this.path(result.stdout.trim().split(/\r?\n/)[0]!, true)
      if (result.exitCode !== 1)
        throw new Error(`Cannot locate Delta CLI: ${result.stderr.trim()}. Check that where.exe is available and delta.exe is on PATH, then retry.`)
      for (const hive of ['HKCU', 'HKLM']) {
        // Delta's installer uses the native 64-bit view, even if the plugin host is 32-bit.
        const installed = await run(['reg.exe', 'query', `${hive}\\Software\\Zed Industries\\Delta`,
          '/v', 'InstallFolder', '/reg:64'], { timeoutMs: 30_000 })
        if (installed.isStdoutTruncated || installed.isStderrTruncated) throw new Error('Delta CLI discovery output was truncated; retry.')
        if (installed.exitCode !== 0) continue
        const folder = installed.stdout.match(/^\s*InstallFolder\s+REG_SZ\s+(.+?)\s*$/m)?.[1]
        if (!folder) continue
        let candidate: string
        try { candidate = this.path(`${folder.replace(/[\\/]+$/, '')}\\bin\\delta.exe`, true) }
        catch { continue }
        if (await windows.exists(candidate)) return candidate
      }
      throw new Error('Delta CLI, install Delta for Windows from https://delta.dev, restart your terminal and Claude Code, and retry /delta-share or /delta-join <link>.')
    }
    const result = await run(['sh', '-c', discover], { timeoutMs: 30_000 })
    if (result.isStdoutTruncated || result.isStderrTruncated) throw new Error('Delta CLI discovery output was truncated; retry.')
    if (result.exitCode === 0) return this.path(result.stdout)
    if (result.exitCode !== 3) throw new Error(`Cannot locate Delta CLI: ${result.stderr.trim()}. Fix the issue and retry.`)
    if (!allowInstall) throw new MissingCliError('Delta CLI is missing. Run /delta-share or /delta-join <link> explicitly to install Delta and reconnect.')
    progress('Installing Delta (full app and windowless client) for this user…')
    let installed: Awaited<ReturnType<EngineInterface['process']['run']>>
    try {
      installed = await run(['sh', '-c', install], { timeoutMs: 600_000 })
    } catch (error) {
      throw new Error(`Delta installation could not finish: ${String(error)}. Check network access, curl, and disk permissions, then retry /delta-share or /delta-join <link>.`)
    }
    if (installed.exitCode !== 0 || installed.isStdoutTruncated || installed.isStderrTruncated)
      throw new Error(`Delta installation failed: ${installed.stderr.trim() || 'installer failed or output was truncated'}. Check network access, curl, and disk permissions, then retry /delta-share or /delta-join <link>.`)
    return this.path(installed.stdout)
  }

  private path(stdout: string, windows = false): string {
    const path = stdout.trim()
    const absolute = windows
      ? /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+\\/.test(path)
      : path.startsWith('/')
    if (!absolute || /[\r\n\0]/.test(path))
      throw new Error('Delta setup did not return an absolute CLI path. Fix the installation and retry /delta-share or /delta-join <link>.')
    return path
  }
}
