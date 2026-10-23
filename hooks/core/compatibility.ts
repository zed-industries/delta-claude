/** The oldest supported host, also pinned in CI and documented in the README. */
export const MINIMUM_CLAUDE_VERSION = '2.1.303'

/** Warn without blocking startup when the host is older than the supported minimum. */
export function claudeVersionWarning(version: string | undefined): string | undefined {
  const parsed = version?.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!parsed)
    return `Warning: Delta couldn't determine the Claude Code version. Delta supports Claude Code ${MINIMUM_CLAUDE_VERSION} or newer and will continue without a compatibility check.`

  const minimum = MINIMUM_CLAUDE_VERSION.split('.').map(Number)
  for (let index = 0; index < minimum.length; index++) {
    const component = Number(parsed[index + 1])
    if (component > minimum[index]!) return
    if (component < minimum[index]!)
      return unsupportedVersionWarning(version!)
  }
  if (parsed[4]) return unsupportedVersionWarning(version!)
}

function unsupportedVersionWarning(version: string): string {
  return `Warning: Delta supports Claude Code ${MINIMUM_CLAUDE_VERSION} or newer; you are running ${version}. Update Claude Code. Delta will continue, but some features may not work.`
}
