/**
 * Reading Claude's plugin listings and release manifests. Only our Git-hosted marketplace's main
 * and develop branches are update channels; local copies, other sources and pinned refs stay alone.
 */
import { isJsonObject, isNonEmptyString, isOneOf } from '../core/json'
import { pathKey, samePath } from '../core/paths'

export const PLUGIN_ID = 'delta@zed-industries'
export const MARKETPLACE = 'zed-industries'
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
export const REMINDER_INTERVAL_MS = 24 * CHECK_INTERVAL_MS
export const ACTIVATION_WAIT_MS = 15_000

const SCOPES = ['user', 'project', 'local', 'managed'] as const
const BRANCHES = ['main', 'develop'] as const

type Installation = {
  scope: typeof SCOPES[number]
  version: string
  installPath: string
}
export type UpdateTarget = Installation & { branch: typeof BRANCHES[number]; runningVersion: string }

/** `x.y.z`, as every plugin.json release uses. */
function versionParts(version: string): number[] | undefined {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)?.slice(1).map(Number)
  return parts?.every(Number.isSafeInteger) ? parts : undefined
}

/** Undefined for an unknown version, rather than guessing an order or recommending a downgrade. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) return
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index]! > b[index]! ? 1 : -1
  }
  return 0
}

/** A release manifest, never executable content or a command received from the network. */
export function manifestVersion(text: string): string {
  const value: unknown = JSON.parse(text)
  if (!isJsonObject(value) || value.name !== 'delta' ||
      typeof value.version !== 'string' || !versionParts(value.version))
    throw new Error("Delta's plugin manifest has no supported version.")
  return value.version
}

/**
 * A background updater can have advanced the install path since this module loaded. Only the
 * version directory of a known marketplace cache may differ; a --plugin-dir checkout never matches.
 */
function belongsToInstallation(runningRoot: string, installedPath: string, runningVersion: string): boolean {
  if (samePath(runningRoot, installedPath)) return true
  const root = pathKey(runningRoot, installedPath), installed = pathKey(installedPath, runningRoot)
  const suffix = `/cache/${MARKETPLACE}/delta/${runningVersion}`
  return root.endsWith(suffix) && installed.startsWith(root.slice(0, -runningVersion.length)) &&
    !installed.slice(root.length - runningVersion.length).includes('/')
}

/** Select the same project-specific scope the native updater uses, restricted to the running copy. */
export function installationFrom(
  value: unknown, runningRoot: string, runningVersion: string, project: string,
): Installation | undefined {
  if (!Array.isArray(value)) throw new Error('Claude Code returned an unreadable plugin list.')
  for (const scope of ['local', 'project', 'user', 'managed'] as const) {
    for (const entry of value) {
      if (!isJsonObject(entry) || entry.id !== PLUGIN_ID || entry.enabled !== true || entry.scope !== scope ||
          !isNonEmptyString(entry.installPath) || !isNonEmptyString(entry.version)) continue
      if ((scope === 'local' || scope === 'project') &&
          (typeof entry.projectPath !== 'string' || !samePath(entry.projectPath, project))) continue
      if (belongsToInstallation(runningRoot, entry.installPath, runningVersion))
        return { scope, version: entry.version, installPath: entry.installPath }
    }
  }
}

/** A supported release branch from the marketplace Claude actually registered, not its display name alone. */
export function branchFrom(value: unknown): UpdateTarget['branch'] | undefined {
  if (!Array.isArray(value)) throw new Error('Claude Code returned an unreadable marketplace list.')
  const entry: unknown = value.find((item) => isJsonObject(item) && item.name === MARKETPLACE)
  if (!isJsonObject(entry)) return
  const trusted = entry.source === 'github' && entry.repo === 'zed-industries/delta-claude' ||
    entry.source === 'git' && isOneOf(entry.url, [
      'https://github.com/zed-industries/delta-claude.git',
      'https://github.com/zed-industries/delta-claude',
      'git@github.com:zed-industries/delta-claude.git',
      'ssh://git@github.com/zed-industries/delta-claude.git',
    ])
  if (!trusted) return
  if (entry.ref === undefined || entry.ref === 'main') return 'main'
  if (entry.ref === 'develop') return 'develop'
}

/** A single small file from the same release channel the native installer will follow. */
export function manifestUrl(branch: UpdateTarget['branch']): string {
  return `https://raw.githubusercontent.com/zed-industries/delta-claude/${branch}/.claude-plugin/plugin.json`
}

/**
 * The hourly check every session shares: the installation of the copy running from `root`, and the
 * newest release on its branch. Without a target, that copy is not one this updater follows.
 */
export type Check = { checkedAt: number; root: string; project: string; target?: UpdateTarget; version?: string }

export function checkFrom(value: unknown): Check | undefined {
  if (!isJsonObject(value) || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt) ||
      !isNonEmptyString(value.root) || typeof value.project !== 'string' ||
      (value.version !== undefined && (typeof value.version !== 'string' || !versionParts(value.version)))) return
  const check = {
    checkedAt: value.checkedAt, root: value.root, project: value.project, ...value.version ? { version: value.version } : {},
  }
  const target = value.target
  if (target === undefined) return check
  if (!isJsonObject(target) || !isOneOf(target.scope, SCOPES) || !isOneOf(target.branch, BRANCHES) ||
      !isNonEmptyString(target.version) || !isNonEmptyString(target.installPath) ||
      !isNonEmptyString(target.runningVersion)) return
  return { ...check, target: {
    scope: target.scope, branch: target.branch, version: target.version,
    installPath: target.installPath, runningVersion: target.runningVersion,
  } }
}

/**
 * Another session's check holds for the same running copy and, unless that copy is installed for
 * every project, the same project.
 */
export function answersFor(check: Check, root: string, project: string): boolean {
  return samePath(check.root, root) &&
    (check.target?.scope === 'user' || check.target?.scope === 'managed' || samePath(check.project, project))
}

/** A future timestamp is not a permanent throttle after the machine's clock moves backwards. */
export function recentlyChecked(checkedAt: number, now: number): boolean {
  return now >= checkedAt && now - checkedAt < CHECK_INTERVAL_MS
}

export function reminderIsSnoozed(value: unknown, version: string, now: number): boolean {
  return isJsonObject(value) && value.version === version && typeof value.until === 'number' &&
    value.until > now && value.until <= now + REMINDER_INTERVAL_MS
}

/** --json writes its result last; earlier lines can describe a refused marketplace command. */
export function updateMessage(stdout: string, command: 'update' | 'marketplace-update' = 'update'): string {
  const value: unknown = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '')
  if (!isJsonObject(value) || value.command !== command || !isNonEmptyString(value.message) ||
      (value.pluginId !== undefined && value.pluginId !== PLUGIN_ID) ||
      (value.marketplace !== undefined && value.marketplace !== MARKETPLACE))
    throw new Error('Claude Code returned an unreadable plugin update result.')
  if (value.outcome !== 'ok') throw new Error(value.message)
  return value.message
}
