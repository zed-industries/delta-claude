/**
 * Read-only plugin release checks and explicitly requested native installs. No marketplace settings,
 * install records or cached plugin files are written here; Claude Code owns installation and reload.
 */
import type { Timer } from 'claude-code'
import { clearPluginUpdateNotice, showPluginUpdateNotice } from '../band/plugin-update'
import type { Host } from '../core/host'
import { MINIMUM_CLAUDE_VERSION } from '../core/compatibility'
import { claimInstallation, installation } from '../core/installation'
import { hasInteractiveSurface } from '../sharing/lifecycle'
import { samePath } from '../core/paths'
import { requests, stateFor } from '../core/session-state'
import { errorText } from '../core/text'
import {
  ACTIVATION_WAIT_MS, branchFrom, cachedRelease, CHECK_INTERVAL_MS, compareVersions, installationFrom, manifestUrl, manifestVersion,
  MARKETPLACE, PLUGIN_ID, recentlyChecked, REMINDER_INTERVAL_MS, reminderIsSnoozed, updateMessage, type UpdateTarget,
} from './catalog'

const NOTIFICATIONS = 'plugin-update:notifications'
const PLUGIN_UPDATE_USAGE = 'Usage: /delta-plugin-update [check | notifications on | notifications off]. Updates this Claude Code plugin; terminals request a reload, while Desktop may need a new session. /delta-update updates the Delta app and CLI instead.'
const UNSUPPORTED = 'This copy of Delta is not installed from the Zed Industries marketplace on main or develop. Local copies and pinned or other marketplace sources are left unchanged.'
const APP_UPDATE_BUSY = 'A Delta installation update is still running. Let it finish before updating or activating the Claude Code plugin.'
const RESTART_ADVICE = 'The updated Delta plugin is not active in this session yet. Start a new Claude Code session to apply it.'

type Observer = { session: string; timer?: Timer; first?: Timer; checking: boolean; revision: number }
const observers = new Map<string, Observer>()
let runningVersion: string | undefined
type Activation = {
  session: string; cwd: string; release(): void; queued?: Timer; watchdog?: Timer; running: boolean; detail?: string
}
const activations = new Map<string, Activation>()

/** Each session gets one timer, including the first activity after /clear or /resume. */
export function startPluginUpdates(host: Host, session: string) {
  if (observers.has(session)) return
  const observer: Observer = { session, checking: false, revision: 0 }
  observers.set(session, observer)
  observer.first = host.clock.after(0, () => { void checkInBackground(host, observer) })
  observer.timer = host.clock.every(CHECK_INTERVAL_MS, () => { void checkInBackground(host, observer) })
}

/** A Desktop client can attach after startup's check saw no interactive surface. */
export function pluginSurfaceAttached(host: Host, session: string) {
  startPluginUpdates(host, session)
  const observer = observers.get(session)!
  observer.first?.cancel()
  observer.first = host.clock.after(0, () => { void checkInBackground(host, observer) })
}

export function stopPluginUpdates(host: Host, session: string) {
  const observer = observers.get(session)
  observer?.timer?.cancel()
  observer?.first?.cancel()
  observers.delete(session)
  const activation = activations.get(session)
  if (activation) finishActivation(activation)
  clearPluginUpdateNotice(host, session)
}

async function debugFailure(host: Host, error: unknown) {
  // Update discovery is optional; neither its failure nor logging it may disturb a session.
  try { await host.ui.log(`Delta plugin update check: ${errorText(error)}`, { to: 'debug' }) } catch {}
}

/** CLI listings are local reads. A timeout, truncation or changed output is not an empty list. */
async function readList(host: Host, argv: string[], cwd: string): Promise<unknown> {
  const result = await runClaude(host, argv, cwd, 10_000)
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Claude Code could not read installed plugins.')
  if (result.isStdoutTruncated || result.isStderrTruncated) throw new Error('Claude Code truncated its plugin listing.')
  const value: unknown = JSON.parse(result.stdout)
  return value
}

async function runClaude(host: Host, argv: string[], cwd: string, timeoutMs: number) {
  const advice = `Install Claude Code's terminal CLI (${MINIMUM_CLAUDE_VERSION} or newer), make claude available on PATH, then restart Claude Desktop or this terminal. Desktop's bundled engine does not provide the standalone CLI.`
  try {
    const result = await host.process.run(argv, { cwd, timeoutMs })
    if (result.exitCode === 127) throw new Error(`The claude command was not found. ${advice}`)
    return result
  } catch (error) {
    if (/ENOENT|no such file|executable.*not found|command not found/i.test(errorText(error)))
      throw new Error(`Could not run the claude command. ${advice}`)
    throw error
  }
}

async function targetFor(host: Host, cwd: string, project: string): Promise<UpdateTarget | undefined> {
  runningVersion ??= manifestVersion(await host.fs.read(`${host.plugin.root}/.claude-plugin/plugin.json`))
  const installed = await readList(host, ['claude', 'plugin', 'list', '--json'], cwd)
  const installation = installationFrom(installed, host.plugin.root, runningVersion, project)
  if (!installation) return
  const branch = branchFrom(await readList(host, ['claude', 'plugin', 'marketplace', 'list', '--json'], cwd))
  if (!branch) return
  return { ...installation, branch, runningVersion }
}

async function fetchVersion(host: Host, target: UpdateTarget): Promise<string> {
  let timer: Timer | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = host.clock.after(10_000, () => reject(new Error('The plugin update check timed out.')))
  })
  try {
    const response = await Promise.race([host.http.fetch(manifestUrl(target.branch)), deadline])
    if (!response.ok) throw new Error(`The plugin update check returned HTTP ${response.status}.`)
    if (response.text.length > 16 * 1024) throw new Error('The plugin release manifest is too large.')
    return manifestVersion(response.text)
  } finally { timer?.cancel() }
}

/**
 * Persist a throttle before requesting the release, including on failures. Store writes are atomic,
 * not compare-and-set: simultaneous processes can both fetch. Checking the claim discards a response
 * when another process has already claimed the interval; this is not an interprocess lock.
 * One observer never overlaps its own checks, and only the native installer changes installed files.
 */
async function availableVersion(host: Host, target: UpdateTarget, session: string, force: boolean) {
  // Native auto-update already did the download. Offer activation without needing the network.
  if (compareVersions(target.version, target.runningVersion) === 1) return target.version
  const key = `plugin-update:release:${target.branch}`
  const now = await host.clock.now()
  const cached = cachedRelease(await host.store.get(key))
  if (!force && cached && recentlyChecked(cached.checkedAt, now)) return cached.version
  const claim = `${session}:${now}:${Math.random()}`
  await host.store.set(key, { checkedAt: now, claim, ...cached?.version ? { version: cached.version } : {} })
  const version = await fetchVersion(host, target)
  if (cachedRelease(await host.store.get(key))?.claim !== claim) return
  await host.store.set(key, { checkedAt: now, claim, version })
  return version
}

async function checkInBackground(host: Host, observer: Observer) {
  if (observer.checking || installation?.kind === 'plugin') return
  observer.checking = true
  const revision = observer.revision
  const current = () => observers.get(observer.session) === observer && observer.revision === revision && installation?.kind !== 'plugin'
  try {
    if (!hasInteractiveSurface(await host.session.surfaces()) ||
        !!await host.env.disableNonessentialTraffic() ||
        await host.store.get(NOTIFICATIONS) === false) {
      if (current()) clearPluginUpdateNotice(host, observer.session)
      return
    }
    const cwd = await host.session.cwd()
    const target = await targetFor(host, cwd, await host.session.root())
    if (!current() || !target) return
    const version = await availableVersion(host, target, observer.session, false)
    if (!current() || await host.session.id() !== observer.session || !samePath(cwd, await host.session.cwd()) ||
        await host.store.get(NOTIFICATIONS) === false) return
    // An in-flight or failed check is not evidence that an existing notice is obsolete.
    if (!version) return
    if (compareVersions(version, target.runningVersion) !== 1) {
      clearPluginUpdateNotice(host, observer.session)
      return
    }
    const key = `plugin-update:reminder:${target.branch}`
    const now = await host.clock.now()
    const snoozed = reminderIsSnoozed(await host.store.get(key), version, now)
    if (!current()) return
    const ready = compareVersions(target.version, target.runningVersion) === 1
    const notice = { session: observer.session, branch: target.branch,
      runningVersion: target.runningVersion, version, ready }
    if (snoozed) {
      showPluginUpdateNotice(host, notice, true)
      return
    }
    await host.store.set(key, { version, until: now + REMINDER_INTERVAL_MS })
    if (!current()) return
    showPluginUpdateNotice(host, notice)
    const terminal = (await host.session.surfaces()).includes('terminal')
    await host.ui.log(ready
      ? `Delta's Claude Code plugin ${version} is installed and ready. ${terminal ? 'Run /delta-plugin-update to request a reload.' : 'Desktop may apply it when idle; otherwise start a new Claude Code session.'}`
      : `Delta's Claude Code plugin ${version} is available (running: ${target.runningVersion}). Run /delta-plugin-update to update, or /delta-plugin-update notifications off to stop these notices.`,
    { to: 'transcript' })
  } catch (error) {
    if (current()) await debugFailure(host, error)
  } finally { observer.checking = false }
}

/** A notice's button snoozes that release only; a newly released version can still be announced. */
export async function snoozePluginUpdate(
  host: Host, session: string, branch: UpdateTarget['branch'], version: string,
) {
  if (await host.session.id() !== session) return
  await host.store.set(`plugin-update:reminder:${branch}`, {
    version, until: await host.clock.now() + REMINDER_INTERVAL_MS,
  })
  clearPluginUpdateNotice(host, session)
}

function finishActivation(activation: Activation) {
  activation.queued?.cancel()
  activation.watchdog?.cancel()
  if (activations.get(activation.session) === activation) activations.delete(activation.session)
  activation.release()
}

/**
 * A returned command result (including refusal text) is not proof of activation. Successful reloads
 * unload this environment and cancel its timers. Only a surviving watchdog reports a pending update.
 * Desktop cannot run the interactive reload command; its own optional watcher may apply the install.
 */
function activateInstalled(
  host: Host, session: string, cwd: string, terminal: boolean, target: UpdateTarget, version: string, release: () => void,
) {
  const previous = activations.get(session)
  if (previous) finishActivation(previous)
  const activation: Activation = { session, cwd, release, running: false }
  activations.set(session, activation)
  activation.watchdog = host.clock.after(ACTIVATION_WAIT_MS, () => {
    activation.watchdog = undefined
    void (async () => {
      try {
        if (await host.session.id() !== session || !samePath(cwd, await host.session.cwd())) return
        const notifications = await host.store.get(NOTIFICATIONS) !== false
        if (activations.get(session) !== activation) return
        if (notifications) showPluginUpdateNotice(host, {
          session, branch: target.branch, runningVersion: target.runningVersion, version, ready: true,
        })
        await host.ui.log(`${RESTART_ADVICE}${terminal ? ' In a terminal, you can also retry /reload-plugins.' : ''}${
          activation.detail ? ` Reload response: ${activation.detail}` : ''
        }`, { to: 'transcript' })
      } finally {
        // Keep the installer slot while a terminal command is still queued in the native host.
        if (!activation.running) finishActivation(activation)
        host.ui.invalidate()
      }
    })().catch((error) => debugFailure(host, error))
  })
  if (terminal) {
    // Outside the update hook: command.run cannot queue a command from a hook it waits on.
    activation.queued = host.clock.after(0, () => {
      activation.running = true
      void (async () => {
        if (await host.session.id() !== session || !samePath(cwd, await host.session.cwd())) return
        if (requests.join || requests.share || stateFor(session).currentTurnId) {
          activation.detail = 'A Claude turn, Delta share, or join is in progress.'
          return
        }
        const result = await host.command.run({ command: 'reload-plugins', args: '--force' })
        activation.detail = result.text
      })().catch((error) => { activation.detail = errorText(error) }).finally(() => {
        activation.running = false
        // Never log from this continuation: even a successful reload can reject it as unloaded.
        activation.release()
        if (!activation.watchdog) finishActivation(activation)
      })
    })
  }
  return terminal
    ? 'Requesting a plugin reload now.'
    : 'Desktop may apply it automatically when idle. If this session does not refresh, start a new Claude Code session to apply it.'
}

/** Refresh the catalog explicitly before installing: the update command can read a cached catalog. */
async function runNativeUpdate(host: Host, command: 'marketplace-update' | 'update', target: UpdateTarget, cwd: string) {
  const args = command === 'marketplace-update'
    ? ['marketplace', 'update', MARKETPLACE, '--json']
    : ['update', PLUGIN_ID, '--scope', target.scope, '--json']
  const result = await runClaude(host, ['claude', 'plugin', ...args], cwd, 120_000)
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new Error('Claude Code truncated its update result. Check /plugin before retrying.')
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Claude Code exited with code ${result.exitCode}.`)
  return updateMessage(result.stdout, command)
}

/** All entry points, including the notice and /delta menu, use the same explicit-update path. */
export async function pluginUpdateCommand(host: Host, args: string): Promise<{ text?: string }> {
  const session = await host.session.id()
  try {
    if (args === 'notifications on' || args === 'notifications off') {
      const enabled = args === 'notifications on'
      await host.store.set(NOTIFICATIONS, enabled)
      const observer = observers.get(session)
      if (observer) observer.revision++
      clearPluginUpdateNotice(host, session)
      if (enabled) {
        startPluginUpdates(host, session)
        const current = observers.get(session)!
        host.clock.after(0, () => { void checkInBackground(host, current) })
      }
      return { text: `Delta plugin update notifications are ${enabled ? 'on' : 'off'}. You can always run /delta-plugin-update to update manually.` }
    }
    if (args !== '' && args !== 'check') return { text: PLUGIN_UPDATE_USAGE }
    const active = installation
    if (active?.kind === 'app') return { text: APP_UPDATE_BUSY }
    if (active?.kind === 'plugin') return { text: 'A Delta plugin update or activation is already in progress.' }
    if (args === '' && (requests.join || requests.share || stateFor(session).currentTurnId))
      return { text: 'Wait for the current Claude turn, Delta share, or join to finish, then run /delta-plugin-update.' }
    const cwd = await host.session.cwd()
    const project = await host.session.root()
    const target = await targetFor(host, cwd, project)
    if (!target) return { text: UNSUPPORTED }
    if (args === 'check') {
      const version = await availableVersion(host, target, session, true)
      if (!version) return { text: 'Another session checked for updates. Retry /delta-plugin-update check.' }
      return { text: compareVersions(version, target.runningVersion) === 1
        ? `Delta plugin ${version} is ${compareVersions(target.version, target.runningVersion) === 1 ? 'installed and ready to apply' : 'available'} (running: ${target.runningVersion}). Run /delta-plugin-update for the next step.`
        : `Delta's Claude Code plugin ${target.runningVersion} is up to date on ${target.branch}.` }
    }
    // Recheck after discovery: another explicit invocation or session transition may have won.
    if (await host.session.id() !== session || !samePath(cwd, await host.session.cwd()))
      return { text: 'The session or folder changed. Run /delta-plugin-update in the current session.' }
    const terminal = (await host.session.surfaces()).includes('terminal')
    const release = claimInstallation('plugin')
    if (!release) return { text: installation?.kind === 'app' ? APP_UPDATE_BUSY : 'A Delta plugin update or activation is already in progress.' }
    let activating = false
    try {
      for (const observer of observers.values()) observer.revision++
      clearPluginUpdateNotice(host, session)
      if (compareVersions(target.version, target.runningVersion) === 1) {
        if (!terminal) return { text: `Delta plugin ${target.version} is already installed. ${RESTART_ADVICE}` }
        const message = activateInstalled(host, session, cwd, terminal, target, target.version, release)
        activating = true
        return { text: `Delta plugin ${target.version} is already installed. ${message}` }
      }
      await host.ui.log("Updating Delta's Claude Code plugin…", { to: 'transcript' })
      await runNativeUpdate(host, 'marketplace-update', target, cwd)
      if (await host.session.id() !== session || !samePath(cwd, await host.session.cwd()))
        return { text: 'The session or folder changed. Run /delta-plugin-update in the current session.' }
      const message = await runNativeUpdate(host, 'update', target, cwd)
      const installed = installationFrom(
        await readList(host, ['claude', 'plugin', 'list', '--json'], cwd),
        host.plugin.root, target.runningVersion, project,
      )
      if (!installed || installed.scope !== target.scope)
        throw new Error('The updated installation could not be verified. Check /plugin before retrying.')
      await host.store.delete(`plugin-update:release:${target.branch}`)
      if (compareVersions(installed.version, target.runningVersion) === 1) {
        if (await host.session.id() !== session || !samePath(cwd, await host.session.cwd()))
          return { text: `Installed Delta plugin ${installed.version}. The session or folder changed; run /delta-plugin-update there to reload, or start a new session.` }
        const message = activateInstalled(host, session, cwd, terminal, target, installed.version, release)
        activating = true
        return { text: `Updated Delta's Claude Code plugin to ${installed.version}. ${message}` }
      }
      return { text: message }
    } finally { if (!activating) release() }
  } catch (error) {
    return { text: `Delta plugin ${args === 'check' ? 'update check' : 'update'} failed: ${errorText(error)}` }
  }
}
