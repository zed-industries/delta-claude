import type { EngineInterface } from 'claude-code'
import { DeltaCli } from './cli'
import { commandErrorFromEnvelope } from './thread-commands'

export type UpdateHost = {
  run: EngineInterface['process']['run']
  windows(): Promise<boolean>
  exists(path: string): Promise<boolean>
  after: EngineInterface['clock']['after']
  log(text: string, to: 'transcript' | 'debug'): Promise<void>
}
type CommandForm = 'dedicated_command' | 'delta_subcommand'
type UpdateResult = { canInstall: boolean } & (
  | { status: 'update_available' | 'updated'; currentVersion: string; latestVersion: string; message: string }
  | { status: 'up_to_date' | 'unsupported'; currentVersion: string; latestVersion: string | null; message: string }
)

const MANUAL_UPDATE = 'Update your Delta installation from https://delta.dev, then restart Claude Code and retry /delta-update.'
class UnsupportedUpdateCommand extends Error {}

/** Parses the versioned installation-update response, independently of the thread protocol. */
export function parseInstallUpdate(stdout: string): UpdateResult {
  const value = JSON.parse(stdout)
  const failure = commandErrorFromEnvelope(value?.error, 'update')
  if (failure) throw failure
  if (value?.schema_version !== 1 || typeof value.can_install !== 'boolean' ||
      !['up_to_date', 'update_available', 'updated', 'unsupported'].includes(value.status) ||
      typeof value.current_version !== 'string' || !value.current_version ||
      !(value.latest_version === null || typeof value.latest_version === 'string' && value.latest_version) ||
      !['dev', 'trunk', 'stable'].includes(value.channel) || typeof value.message !== 'string' ||
      (['update_available', 'updated'].includes(value.status) && !value.latest_version))
    throw new Error(`Unexpected Delta update response. ${MANUAL_UPDATE}`)
  return {
    status: value.status, currentVersion: value.current_version,
    latestVersion: value.latest_version, message: value.message, canInstall: value.can_install,
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
      await host.log(`Delta update check: ${String(error)}`,
        error instanceof UnsupportedUpdateCommand ? 'transcript' : 'debug').catch(() => {})
    }
  }

  async update(host: UpdateHost, form: CommandForm): Promise<string> {
    if (this.updating) return 'A Delta installation update is already in progress. Wait for its result.'
    this.updating = true
    this.revision++
    try {
      const result = await this.run(host, false, form)
      switch (result.status) {
        case 'updated': return `Updated Delta to ${result.latestVersion}. Restart Claude Code to use the updated installation.`
        case 'up_to_date': return `Delta ${result.currentVersion} is already up to date.`
        case 'unsupported': return `Delta cannot update this installation: ${result.message}`
        case 'update_available': return `Delta was not updated: ${result.message}`
      }
    } catch (error) {
      await host.log(`Delta installation update failed: ${String(error)}`, 'debug').catch(() => {})
      return `Delta installation update failed: ${String(error)}`
    } finally {
      this.updating = false
    }
  }

  private async run(host: UpdateHost, check: boolean, form?: CommandForm): Promise<UpdateResult> {
    const timeoutMs = check ? 10_000 : 600_000
    let expired = false
    let timer: ReturnType<UpdateHost['after']> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = host.after(timeoutMs, () => {
        expired = true
        reject(new Error(`Delta ${check ? 'update check' : 'update'} timed out. Retry /delta-update; check the installation before retrying an interrupted update.`))
      })
    })
    const operation = async () => {
      const run: UpdateHost['run'] = (argv, init) => {
        if (expired) throw new Error('Delta update deadline expired')
        return host.run(argv, {
          ...init, timeoutMs: check ? 5_000 : timeoutMs,
          env: { ...init?.env, DELTA_CLI_INTEGRATION: 'claude_code',
            ...form ? { DELTA_CLI_COMMAND_FORM: form } : {} },
        })
      }
      // A private discovery instance cannot make sync/share wait for this optional check, or
      // inherit a concurrent explicit install. Discovery itself never installs anything.
      const cli = new DeltaCli()
      const executable = await cli.resolve(run, false, undefined,
        await host.windows() ? { exists: (path) => host.exists(path) } : false)
      const output = await run([executable, 'update', ...check ? ['--check'] : [], '--json'])
      if (output.isStdoutTruncated || output.isStderrTruncated)
        throw new Error('Delta update output was truncated. Retry /delta-update.')
      if (output.exitCode !== 0 && /(?:unrecognized|unknown|unexpected|invalid).*(?:subcommand|argument|update|--check|--json)/i.test(output.stderr))
        throw new UnsupportedUpdateCommand(`This Delta CLI does not support installation updates. ${MANUAL_UPDATE}`)
      if (output.exitCode !== 0) {
        // Typed failures use the same envelope as the rest of the CLI.
        if (output.stdout.trim().startsWith('{')) parseInstallUpdate(output.stdout)
        throw new Error(`${output.stderr.trim() || `Delta exited with code ${output.exitCode}`}. Retry /delta-update.`)
      }
      const result = parseInstallUpdate(output.stdout)
      if (check && result.status === 'updated') throw new Error('Unexpected installation change reported by a read-only update check.')
      return result
    }
    try { return await Promise.race([operation(), deadline]) }
    finally { timer?.cancel() }
  }
}
