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

type Observer = { session: string; timer?: Timer; first?: Timer; checking: boolean }
const observers = new Map<string, Observer>()
const watchdogs = new Map<string, Timer>()
let runningVersion: string | undefined

/** Each session gets one timer, including the first activity after /clear or /resume. */
export function startPluginUpdates(host: Host, session: string) {
  if (observers.has(session)) return
  const observer: Observer = { session, checking: false }
  observers.set(session, observer)
  observer.first = host.clock.after(0, () => { void checkInBackground(host, observer) })
  observer.timer = host.clock.every(CHECK_INTERVAL_MS, () => { void checkInBackground(host, observer) })
}

/** Check now: a Desktop client can attach after startup's check saw no interactive surface. */
export function recheckPluginUpdates(host: Host, session: string) {
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
  watchdogs.get(session)?.cancel()
  watchdogs.delete(session)
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
 * The newest release, through a cache every session shares for an hour. The check is recorded before
 * the request, so a failure also waits an hour; two processes checking at once both fetch.
 */
async function availableVersion(host: Host, target: UpdateTarget, force: boolean) {
  // Native auto-update already did the download. Offer activation without needing the network.
  if (compareVersions(target.version, target.runningVersion) === 1) return target.version
  const key = `plugin-update:release:${target.branch}`
  const now = await host.clock.now()
  const cached = cachedRelease(await host.store.get(key))
  if (!force && cached && recentlyChecked(cached.checkedAt, now)) return cached.version
  await host.store.set(key, { checkedAt: now, ...cached?.version ? { version: cached.version } : {} })
  const version = await fetchVersion(host, target)
  await host.store.set(key, { checkedAt: now, version })
  return version
}

async function checkInBackground(host: Host, observer: Observer) {
  if (observer.checking) return
  observer.checking = true
  // A check that outlives its session, the person's opt-out or an installation shows nothing.
  const current = async () => observers.get(observer.session) === observer && installation?.kind !== 'plugin' &&
    await host.store.get(NOTIFICATIONS) !== false
  try {
    const surfaces = await host.session.surfaces()
    if (!hasInteractiveSurface(surfaces) || !!await host.env.disableNonessentialTraffic() || !await current()) {
      clearPluginUpdateNotice(host, observer.session)
      return
    }
    const target = await targetFor(host, await host.session.cwd(), await host.session.root())
    const version = target && await availableVersion(host, target, false)
    // A failed check is not evidence that an existing notice is obsolete.
    if (!target || !version || !await current()) return
    if (compareVersions(version, target.runningVersion) !== 1) {
      clearPluginUpdateNotice(host, observer.session)
      return
    }
    const key = `plugin-update:reminder:${target.branch}`
    const now = await host.clock.now()
    const ready = compareVersions(target.version, target.runningVersion) === 1
    const terminal = surfaces.includes('terminal')
    const notice = { session: observer.session, branch: target.branch, version, ready, terminal }
    if (reminderIsSnoozed(await host.store.get(key), version, now)) {
      showPluginUpdateNotice(host, notice, true)
      return
    }
    await host.store.set(key, { version, until: now + REMINDER_INTERVAL_MS })
    showPluginUpdateNotice(host, notice)
    await host.ui.log(ready
      ? `Delta's Claude Code plugin ${version} is installed and ready. ${terminal ? 'Run /delta-plugin-update to request a reload.' : 'Desktop may apply it when idle; otherwise start a new Claude Code session.'}`
      : `Delta's Claude Code plugin ${version} is available (running: ${target.runningVersion}). Run /delta-plugin-update to update, or /delta-plugin-update notifications off to stop these notices.`,
    { to: 'transcript' })
  } catch (error) {
    if (observers.get(observer.session) === observer) await debugFailure(host, error)
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

/**
 * Takes over `release`. A returned command result (including refusal text) is not proof of activation:
 * a successful reload unloads this environment and its timers, so only a surviving watchdog reports a
 * pending update. Desktop cannot run the interactive reload command; its own optional watcher may
 * apply the install.
 */
function activateInstalled(
  host: Host, session: string, terminal: boolean, branch: UpdateTarget['branch'], version: string, release: () => void,
) {
  watchdogs.get(session)?.cancel()
  let response: string | undefined
  watchdogs.set(session, host.clock.after(ACTIVATION_WAIT_MS, () => {
    watchdogs.delete(session)
    void (async () => {
      if (await host.store.get(NOTIFICATIONS) !== false)
        showPluginUpdateNotice(host, { session, branch, version, ready: true, terminal })
      await host.ui.log(`${RESTART_ADVICE}${terminal ? ' In a terminal, you can also retry /reload-plugins.' : ''}${
        response ? ` Reload response: ${response}` : ''
      }`, { to: 'transcript' })
    })().catch((error) => debugFailure(host, error))
  }))
  if (!terminal) {
    release()
    return 'Desktop may apply it automatically when idle. If this session does not refresh, start a new Claude Code session to apply it.'
  }
  // Outside the update hook: command.run cannot queue a command from a hook it waits on. Never log
  // from this continuation: even a successful reload can reject it as unloaded.
  host.clock.after(0, () => {
    void host.command.run({ command: 'reload-plugins', args: '--force' })
      .then((result) => { response = result.text }, (error) => { response = errorText(error) })
      .finally(release)
  })
  return 'Requesting a plugin reload now.'
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

/** All entry points, including the notice and /delta, use the same explicit-update path. */
export async function pluginUpdateCommand(host: Host, args: string): Promise<{ text?: string }> {
  const session = await host.session.id()
  try {
    if (args === 'notifications on' || args === 'notifications off') {
      const enabled = args === 'notifications on'
      await host.store.set(NOTIFICATIONS, enabled)
      clearPluginUpdateNotice(host, session)
      if (enabled) recheckPluginUpdates(host, session)
      return { text: `Delta plugin update notifications are ${enabled ? 'on' : 'off'}. You can always run /delta-plugin-update to update manually.` }
    }
    if (args !== '' && args !== 'check') return { text: PLUGIN_UPDATE_USAGE }
    const cwd = await host.session.cwd()
    const project = await host.session.root()
    if (args === 'check') {
      const target = await targetFor(host, cwd, project)
      if (!target) return { text: UNSUPPORTED }
      const version = await availableVersion(host, target, true)
      return { text: version && compareVersions(version, target.runningVersion) === 1
        ? `Delta plugin ${version} is ${compareVersions(target.version, target.runningVersion) === 1 ? 'installed and ready to apply' : 'available'} (running: ${target.runningVersion}). Run /delta-plugin-update for the next step.`
        : `Delta's Claude Code plugin ${target.runningVersion} is up to date on ${target.branch}.` }
    }
    if (requests.join || requests.share || stateFor(session).currentTurnId)
      return { text: 'Wait for the current Claude turn, Delta share, or join to finish, then run /delta-plugin-update.' }
    const release = claimInstallation('plugin')
    if (!release) return { text: installation?.kind === 'app' ? APP_UPDATE_BUSY : 'A Delta plugin update or activation is already in progress.' }
    let handedOff = false
    try {
      const target = await targetFor(host, cwd, project)
      if (!target) return { text: UNSUPPORTED }
      clearPluginUpdateNotice(host, session)
      const terminal = (await host.session.surfaces()).includes('terminal')
      const activate = (version: string) => {
        handedOff = true
        return activateInstalled(host, session, terminal, target.branch, version, release)
      }
      if (compareVersions(target.version, target.runningVersion) === 1)
        return { text: `Delta plugin ${target.version} is already installed. ${terminal ? activate(target.version) : RESTART_ADVICE}` }
      await host.ui.log("Updating Delta's Claude Code plugin…", { to: 'transcript' })
      await runNativeUpdate(host, 'marketplace-update', target, cwd)
      const message = await runNativeUpdate(host, 'update', target, cwd)
      const installed = installationFrom(
        await readList(host, ['claude', 'plugin', 'list', '--json'], cwd),
        host.plugin.root, target.runningVersion, project,
      )
      if (!installed || installed.scope !== target.scope)
        throw new Error('The updated installation could not be verified. Check /plugin before retrying.')
      await host.store.delete(`plugin-update:release:${target.branch}`)
      if (compareVersions(installed.version, target.runningVersion) !== 1) return { text: message }
      // A reload would apply the other session's or folder's installation scope.
      if (await host.session.id() !== session || !samePath(cwd, await host.session.cwd()))
        return { text: `Installed Delta plugin ${installed.version}. The session or folder changed; run /delta-plugin-update there to reload, or start a new session.` }
      return { text: `Updated Delta's Claude Code plugin to ${installed.version}. ${activate(installed.version)}` }
    } finally { if (!handedOff) release() }
  } catch (error) {
    return { text: `Delta plugin ${args === 'check' ? 'update check' : 'update'} failed: ${errorText(error)}` }
  }
}
