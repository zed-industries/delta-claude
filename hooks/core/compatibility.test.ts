import { expect, test } from 'claude-code/testing'
import { claudeVersionWarning, MINIMUM_CLAUDE_VERSION } from './compatibility'

test('host compatibility compares numeric versions and accepts newer releases without an upper cutoff', () => {
  for (const version of ['1.9.999', '2.0.999', '2.1.99', '2.1.300', '2.1.301', '2.1.302', '2.1.303-dev.1'])
    expect(claudeVersionWarning(version)).toBe(`Warning: Delta supports Claude Code ${MINIMUM_CLAUDE_VERSION} or newer; you are running ${version}. Update Claude Code. Delta will continue, but some features may not work.`)
  for (const version of [MINIMUM_CLAUDE_VERSION, '2.1.303+build.1', '2.1.304', '2.2.0', '3.0.0'])
    expect(claudeVersionWarning(version)).toBeUndefined()
  for (const version of [undefined, 'unknown'])
    expect(claudeVersionWarning(version)).toBe(`Warning: Delta couldn't determine the Claude Code version. Delta supports Claude Code ${MINIMUM_CLAUDE_VERSION} or newer and will continue without a compatibility check.`)
})
