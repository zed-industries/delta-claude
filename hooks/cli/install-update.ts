import type { EngineInterface } from 'claude-code'
import { DeltaCli } from './cli'
import { errorText } from '../core/text'
import { commandErrorFromEnvelope } from './thread-commands'

export type UpdateHost = {
  run: EngineInterface['process']['run']
  spawn: EngineInterface['process']['spawn']
  windows(): Promise<boolean>
  exists(path: string): Promise<boolean>
  after: EngineInterface['clock']['after']
  log(text: string, to: 'transcript' | 'debug'): Promise<void>
}
type CommandForm = 'dedicated_command' | 'delta_subcommand'
type UpdateResult = { canInstall: boolean } & (
  | { status: 'update_available'; currentVersion: string; latestVersion: string; message: string }
  | { status: 'updated'; currentVersion: string; latestVersion: string; message: string; restartRequired?: boolean }
  | {
    status: 'install_ready'; currentVersion: string; latestVersion: string; message: string; canInstall: true
    installArgv: string[]
  }
  | { status: 'up_to_date' | 'unsupported'; currentVersion: string; latestVersion: string | null; message: string }
)
/** What a finished update command wrote; a streamed process stopped by a signal has no exit code. */
type CommandOutput = {
  stdout: string; stderr: string; exitCode: number | null; isStdoutTruncated: boolean; isStderrTruncated: boolean
}

const MANUAL_UPDATE = 'Update your Delta installation from https://delta.dev, then restart Claude Code and retry /delta-update.'
class UnsupportedUpdateCommandError extends Error {}

/** Parses the versioned installation-update response, independently of the thread protocol. */
export function parseInstallUpdate(stdout: string): UpdateResult {
  const value = JSON.parse(stdout)
  const failure = commandErrorFromEnvelope(value?.error, 'update')
  if (failure) throw failure
  if (value?.schema_version !== 1 || typeof value.can_install !== 'boolean' ||
      !['up_to_date', 'update_available', 'updated', 'install_ready', 'unsupported'].includes(value.status) ||
      typeof value.current_version !== 'string' || !value.current_version ||
      !(value.latest_version === null || typeof value.latest_version === 'string' && value.latest_version) ||
      !['dev', 'trunk', 'stable'].includes(value.channel) || typeof value.message !== 'string' ||
      (['update_available', 'updated', 'install_ready'].includes(value.status) && !value.latest_version) ||
      (value.restart_required !== undefined && typeof value.restart_required !== 'boolean') ||
      (value.status === 'install_ready' && (value.can_install !== true || !Array.isArray(value.install_argv) ||
        !value.install_argv.length || !value.install_argv.every((part: unknown) => typeof part === 'string' && part))))
    throw new Error(`Unexpected Delta update response. ${MANUAL_UPDATE}`)
  return {
    status: value.status, currentVersion: value.current_version,
    latestVersion: value.latest_version, message: value.message, canInstall: value.can_install,
    ...value.status === 'updated' && value.restart_required !== undefined
      ? { restartRequired: value.restart_required } : {},
    ...value.status === 'install_ready' ? { installArgv: value.install_argv } : {},
  }
}

/** Checks once per plugin host; installation only runs from an explicit command. */
export class InstallationUpdates {
  private started = false
  private updating = false
  private revision = 0

  async check(host: UpdateHost): Promise<void> {
    if (this.started) return
    this.started = true
    const revision = this.revision
    try {
      const result = await this.run(host, true)
      if (revision !== this.revision) return
      if (result.status === 'update_available')
        await host.log(`Delta ${result.latestVersion} is available (installed: ${result.currentVersion}). ${
          result.canInstall ? 'Run /delta-update or /delta update to update the installation.' : result.message
        }`, 'transcript')
      else if (result.status === 'unsupported')
        await host.log(`Delta update check: ${result.message}`, 'transcript')
    } catch (error) {
      if (revision !== this.revision) return
      // The check is optional: if even its report fails, startup goes on without it.
      await host.log(`Delta update check: ${errorText(error)}`,
        error instanceof UnsupportedUpdateCommandError ? 'transcript' : 'debug').catch(() => {})
    }
  }

  async update(host: UpdateHost, form: CommandForm): Promise<string> {
    if (this.updating) return 'A Delta installation update is already in progress. Wait for its result.'
    this.updating = true
    this.revision++
    try {
      await host.log('Updating Delta installation…', 'transcript')
      const result = await this.run(host, false, form)
      switch (result.status) {
        case 'updated': return result.restartRequired
          ? `Updated Delta to ${result.latestVersion}. Windows reports that a restart is required to finish the installation; restart Windows, then Claude Code.`
          : `Updated Delta to ${result.latestVersion}.`
        case 'up_to_date': return `Delta ${result.currentVersion} is already up to date.`
        case 'unsupported': return `Delta cannot update this installation: ${result.message}`
        case 'update_available': return `Delta was not updated: ${result.message}`
        default: {
          const unreachable: never = result
          return unreachable
        }
      }
    } catch (error) {
      // The person reads the failure in the command's answer below; the debug copy is best effort.
      await host.log(`Delta installation update failed: ${String(error)}`, 'debug').catch(() => {})
      return `Delta installation update failed: ${errorText(error)}`
    } finally {
      this.updating = false
    }
  }

  private async run(
    host: UpdateHost, check: boolean, form?: CommandForm,
  ): Promise<Exclude<UpdateResult, { status: 'install_ready' }>> {
    const env = { DELTA_CLI_INTEGRATION: 'claude_code', ...form ? { DELTA_CLI_COMMAND_FORM: form } : {} }
    const result = await withDeadline(host, check ? 10_000 : 600_000,
      `Delta ${check ? 'update check' : 'update'} timed out. Retry /delta-update; check the installation before retrying an interrupted update.`,
      async (live) => {
        const run: UpdateHost['run'] = (argv, init) => {
          live.ensure()
          return host.run(argv, { ...init, timeoutMs: check ? 5_000 : 600_000, env: { ...init?.env, ...env } })
        }
        // A private discovery instance cannot make sync/share wait for this optional check, or
        // inherit a concurrent explicit install. Discovery itself never installs anything.
        const cli = new DeltaCli()
        const windows = await host.windows()
        const executable = await cli.resolve(run, false, undefined,
          windows ? { exists: (path) => host.exists(path) } : false)
        // Windows cannot replace the CLI while it runs, so it leaves the installer for this plugin to start.
        const argv = [executable, 'update', ...check ? ['--check'] : windows ? ['--download-only'] : [], '--json']
        const output = check ? await run(argv) : await stream(host, argv, env, live)
        if (output.exitCode !== 0 && /(?:unrecognized|unknown|unexpected|invalid).*(?:subcommand|argument|update|--check|--json)/i.test(output.stderr))
          throw new UnsupportedUpdateCommandError(`This Delta CLI does not support installation updates. ${MANUAL_UPDATE}`)
        const result = parseOutput(output, (failed) =>
          `${failed.stderr.trim() || `Delta exited with code ${failed.exitCode}`}. Retry /delta-update.`)
        if (check && (result.status === 'updated' || result.status === 'install_ready'))
          throw new Error('Unexpected installation change reported by a read-only update check.')
        if (result.status === 'install_ready' && !windows)
          throw new Error(`Unexpected Delta update response. ${MANUAL_UPDATE}`)
        return result
      })
    if (result.status !== 'install_ready') return result
    // The CLI has exited, so the installer can replace it. The helper takes the installation lock
    // again and rechecks for running sessions before it installs. Past the deadline it is left to
    // finish: stopping it mid-install would release that lock while the installer still runs.
    const installed = await withDeadline(host, 600_000,
      'The Delta installer is still running after 10 minutes; it may be waiting for you to approve a Windows prompt. Let it finish, then run `delta update --check` before retrying /delta-update.',
      async (live) => parseOutput(await stream(host, result.installArgv, env, live), (failed) =>
        `The Delta installer helper exited with code ${failed.exitCode}. Run \`delta update --check\` before retrying /delta-update.`),
      { leaveRunning: true })
    if (installed.status !== 'updated' || installed.restartRequired === undefined)
      throw new Error(`Unexpected Delta update response. ${MANUAL_UPDATE}`)
    return installed
  }
}

/** A step's link to its deadline: `ensure` throws once it has passed, `track` records the step's process. */
type Live = { ensure(): void; track(process: ReturnType<UpdateHost['spawn']>): void }

/** Runs one step against a deadline, stopping the process it started when it ends unless `leaveRunning`. */
async function withDeadline<T>(
  host: UpdateHost, timeoutMs: number, timeoutText: string, step: (live: Live) => Promise<T>,
  { leaveRunning = false } = {},
): Promise<T> {
  let expired = false
  let process: ReturnType<UpdateHost['spawn']> | undefined
  let timer: ReturnType<UpdateHost['after']> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = host.after(timeoutMs, () => {
      expired = true
      reject(new Error(timeoutText))
    })
  })
  const live: Live = {
    ensure: () => { if (expired) throw new Error('Delta update deadline expired') },
    track: (started) => { process = started },
  }
  try { return await Promise.race([step(live), deadline]) }
  finally {
    timer?.cancel()
    if (!leaveRunning) await process?.return?.({ code: null, signal: 'SIGTERM' })
  }
}

/** Runs `argv`, showing its stderr progress in the transcript line by line as it arrives. */
async function stream(
  host: UpdateHost, argv: string[], env: Record<string, string>, live: Live,
): Promise<CommandOutput> {
  live.ensure()
  const process = host.spawn({ argv, env })
  live.track(process)
  let stdout = '', stderr = '', pending = ''
  while (true) {
    const piece = await process.next()
    live.ensure()
    if (piece.done) {
      if (pending.trim()) await host.log(pending.trim(), 'transcript')
      return { stdout, stderr, exitCode: piece.value.code, isStdoutTruncated: false, isStderrTruncated: false }
    }
    if (piece.value.stream === 'stdout') stdout += piece.value.text
    else {
      stderr += piece.value.text
      pending += piece.value.text
    }
    if (stdout.length + stderr.length > 1024 * 1024)
      throw new Error('Delta update output exceeded the transport limit. Check the installation before retrying.')
    const lines = pending.split(/\r?\n/)
    pending = lines.pop()!
    for (const line of lines) {
      if (line.trim()) await host.log(line.trim(), 'transcript')
    }
  }
}

/** The update response on stdout. A nonzero exit without a typed envelope is described by `failure`. */
function parseOutput(output: CommandOutput, failure: (output: CommandOutput) => string): UpdateResult {
  if (output.isStdoutTruncated || output.isStderrTruncated)
    throw new Error('Delta update output was truncated. Retry /delta-update.')
  if (output.exitCode !== 0) {
    // Typed failures use the same envelope as the rest of the CLI.
    if (output.stdout.trim().startsWith('{')) parseInstallUpdate(output.stdout)
    throw new Error(failure(output))
  }
  return parseInstallUpdate(output.stdout)
}
