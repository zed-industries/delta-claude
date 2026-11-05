import type { EngineInterface } from 'claude-code'
import { errorText } from '../core/text'
import { parseThreadContract } from './thread-commands'
import { installWindows } from './windows-install'

type Run = EngineInterface['process']['run']
type WindowsDiscovery = Pick<EngineInterface['fs'], 'exists'> & {
  confirmInstall?: () => Promise<boolean>
}
class MissingCliError extends Error {}

/**
 * A possible Delta CLI. Delta's own install locations hold Zed's Delta CLI, whatever its version;
 * an executable found on PATH may be another program named delta, such as the git-delta pager.
 */
type Candidate = { path: string; installed: boolean }

/** Sets the positional parameters to Delta's install locations on this platform, most specific first. */
const installLocations = `
case "$(uname -s)" in
  Darwin) set -- "$HOME/Applications/Delta.app/Contents/MacOS/delta" /Applications/Delta.app/Contents/MacOS/delta ;;
  Linux) set -- "$HOME/.local/delta.app/bin/delta" ;;
  *) echo 'Automatic Delta setup supports macOS and Linux only.' >&2; exit 1 ;;
esac
`

/**
 * Lists every executable named delta on PATH, in PATH order, then each existing install location, one
 * `path <file>` or `installed <file>` line each. Listing runs no candidate, starts no Delta, and
 * downloads nothing, including during resume.
 */
const discover = `
set -eu
: "\${HOME:?HOME is required}"
${installLocations}
# Relative PATH entries are skipped, so nothing in the current checkout is ever run as Delta.
set -f
IFS=:
for directory in $PATH; do
  case "$directory" in
    /*) cli="\${directory%/}/delta"; if [ -f "$cli" ] && [ -x "$cli" ]; then printf 'path %s\\n' "$cli"; fi ;;
  esac
done
unset IFS
set +f
for cli; do
  if [ -x "$cli" ]; then printf 'installed %s\\n' "$cli"; fi
done
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
# Another host may have completed setup since our first discovery. Only an install location counts:
# a delta on PATH was already passed over as another program.
discover_installed() {
${installLocations}
  for cli; do
    if [ -x "$cli" ]; then printf '%s\\n' "$cli"; return 0; fi
  done
  return 3
}
if cli=$(discover_installed); then
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

  async resolve(
    run: Run, allowInstall = false, progress = (_text: string) => {}, windows: WindowsDiscovery | false = false,
  ): Promise<string> {
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

  private async setup(
    run: Run, allowInstall: boolean, progress: (text: string) => void, windows: WindowsDiscovery | false,
  ): Promise<string> {
    if (windows) {
      // Restrict lookup to PATH rather than also searching the current checkout.
      const result = await run(['where.exe', '$PATH:delta.exe'], { timeoutMs: 30_000 })
      if (result.isStdoutTruncated || result.isStderrTruncated) throw new Error('Delta CLI discovery output was truncated; retry.')
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error(`Cannot locate Delta CLI: ${result.stderr.trim()}. Check that where.exe is available and delta.exe is on PATH, then retry.`)
      const onPath = result.exitCode === 0
        ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((path) => ({ path, installed: false }))
        : []
      const selection = await select(run, onPath, true)
      if (selection.executable) return selection.executable
      for (const hive of ['HKCU', 'HKLM']) {
        // Delta's installer uses the native 64-bit view, even if the plugin host is 32-bit.
        const installed = await run(['reg.exe', 'query', `${hive}\\Software\\Zed Industries\\Delta`,
          '/v', 'InstallFolder', '/reg:64'], { timeoutMs: 30_000 })
        if (installed.isStdoutTruncated || installed.isStderrTruncated) throw new Error('Delta CLI discovery output was truncated; retry.')
        if (installed.exitCode !== 0) continue
        const folder = installed.stdout.match(/^\s*InstallFolder\s+REG_SZ\s+(.+?)\s*$/m)?.[1]
        if (!folder) continue
        let candidate: string
        try { candidate = absolutePath(`${folder.replace(/[\\/]+$/, '')}\\bin\\delta.exe`, true) }
        catch { continue }
        if (await windows.exists(candidate)) return candidate
      }
      if (!allowInstall) throw new MissingCliError(missingMessage(selection.passedOver))
      if (!await windows.confirmInstall?.())
        throw new Error('Delta was not installed. Retry /delta-setup, /delta-share, or /delta-join <link> to approve installation, or install Delta manually from https://delta.dev.')
      progress('Installing Delta. Approve the Windows installer prompt if one appears…')
      const installed = await run(
        ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', installWindows],
        { timeoutMs: 600_000 },
      ).catch((error) => {
        throw new Error(`Delta installation could not finish: ${errorText(error)}. An installer may still be running; let it finish and check the installation before retrying.`)
      })
      if (installed.exitCode !== 0 || installed.isStdoutTruncated || installed.isStderrTruncated)
        throw new Error(`Delta installation did not finish: ${installed.stderr.trim() || 'installer failed or output was truncated'}. Check the installation before retrying /delta-share or /delta-join <link>.`)
      return this.setup(run, false, progress, windows)
    }
    const result = await run(['sh', '-c', discover], { timeoutMs: 30_000 })
    if (result.isStdoutTruncated || result.isStderrTruncated) throw new Error('Delta CLI discovery output was truncated; retry.')
    if (result.exitCode !== 0) throw new Error(`Cannot locate Delta CLI: ${result.stderr.trim()}. Fix the issue and retry.`)
    const candidates = result.stdout.split('\n').filter(Boolean).map((line): Candidate =>
      ({ path: line.replace(/^(?:path|installed) /, ''), installed: line.startsWith('installed ') }))
    const selection = await select(run, candidates, false)
    if (selection.executable) return selection.executable
    if (!allowInstall) throw new MissingCliError(missingMessage(selection.passedOver))
    progress('Installing Delta (full app and windowless client) for this user…')
    let installed: Awaited<ReturnType<EngineInterface['process']['run']>>
    try {
      installed = await run(['sh', '-c', install], { timeoutMs: 600_000 })
    } catch (error) {
      throw new Error(`Delta installation could not finish: ${errorText(error)}. Check network access, curl, and disk permissions, then retry /delta-share or /delta-join <link>.`)
    }
    if (installed.exitCode !== 0 || installed.isStdoutTruncated || installed.isStderrTruncated)
      throw new Error(`Delta installation failed: ${installed.stderr.trim() || 'installer failed or output was truncated'}. Check network access, curl, and disk permissions, then retry /delta-share or /delta-join <link>.`)
    return absolutePath(installed.stdout)
  }
}

/**
 * The first candidate that is Zed's Delta CLI, and the PATH programs passed over before it. An install
 * location is taken as it is, so an outdated Delta is still selected and its contract check asks for an
 * update; a program on PATH must answer `thread contract`, which every supported Delta CLI does.
 */
async function select(
  run: Run, candidates: Candidate[], windows: boolean,
): Promise<{ executable?: string; passedOver: string[] }> {
  const passedOver: string[] = []
  for (const candidate of candidates) {
    const path = absolutePath(candidate.path, windows)
    if (candidate.installed) return { executable: path, passedOver }
    // A directory listed twice on PATH is probed once.
    if (passedOver.includes(path)) continue
    if (await answersAsDelta(run, path)) return { executable: path, passedOver }
    passedOver.push(path)
  }
  return { passedOver }
}

/**
 * Whether `executable` answers `thread contract` as Zed's Delta CLI does. The command never starts
 * Delta, and another program named delta, such as git-delta, rejects `--json` without acting.
 */
async function answersAsDelta(run: Run, executable: string): Promise<boolean> {
  try {
    parseThreadContract((await run([executable, '--json', 'thread', 'contract'], { timeoutMs: 30_000 })).stdout)
    return true
  } catch { return false }
}

/** Why discovery found no Delta CLI, naming the programs on PATH it passed over. */
function missingMessage(passedOver: string[]): string {
  const others = passedOver.length === 0 ? ''
    : ` ${passedOver.join(', ')} ${passedOver.length === 1 ? 'is another program' : 'are other programs'} named delta, not Zed's Delta CLI.`
  return `Delta CLI is missing.${others} Run /delta-share or /delta-join <link> explicitly to install Delta and reconnect.`
}

function absolutePath(stdout: string, windows = false): string {
  const path = stdout.trim()
  const absolute = windows
    ? /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+\\/.test(path)
    : path.startsWith('/')
  if (!absolute || /[\r\n\0]/.test(path))
    throw new Error('Delta setup did not return an absolute CLI path. Fix the installation and retry /delta-share or /delta-join <link>.')
  return path
}
