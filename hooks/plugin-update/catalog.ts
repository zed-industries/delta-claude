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

export type Installation = {
  scope: 'user' | 'project' | 'local' | 'managed'
  version: string
  installPath: string
}
export type UpdateTarget = Installation & { branch: 'main' | 'develop'; runningVersion: string }

/** Strict semver, including prereleases; build metadata does not change precedence. */
function versionParts(version: string): { numbers: number[]; prerelease: string[] } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match) return
  const numbers = match.slice(1, 4).map(Number)
  const prerelease = match[4]?.split('.') ?? []
  if (!numbers.every(Number.isSafeInteger) ||
      prerelease.some((part) => /^\d+$/.test(part) && (part.length > 1 && part[0] === '0' || !Number.isSafeInteger(Number(part)))))
    return
  return { numbers, prerelease }
}

/** Undefined for an unknown version, rather than guessing an order or recommending a downgrade. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) return
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! > b.numbers[index]! ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return Number(!a.prerelease.length) - Number(!b.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
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
  const scopes = ['local', 'project', 'user', 'managed'] as const
  for (const scope of scopes) {
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

export type CachedRelease = { checkedAt: number; claim: string; version?: string }

export function cachedRelease(value: unknown): CachedRelease | undefined {
  if (!isJsonObject(value) || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt) ||
      typeof value.claim !== 'string' ||
      (value.version !== undefined && (typeof value.version !== 'string' || !versionParts(value.version)))) return
  return { checkedAt: value.checkedAt, claim: value.claim, ...value.version ? { version: value.version } : {} }
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
