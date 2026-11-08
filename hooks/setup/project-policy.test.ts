import { describe, expect, test } from 'claude-code/testing'
import { readProjectPolicy, recordsAutomatically, serializeProjectPolicy, serializeStopped } from './project-policy'

describe('project policy', () => {
  test('each kind of file reads as its effective policy, and unusable ones record manually', () => {
    const problem = expect.any(String)
    const cases: [string | undefined, object, boolean?][] = [
      [undefined, { mode: 'manual', configured: false }],
      ['{}', { mode: 'manual', configured: false }],
      ['{"threads":{}}', { mode: 'manual', configured: false }],
      ['{"threads":{"mode":"manual"}}', { mode: 'manual', configured: true }],
      ['{"threads":{"mode":"manual","organization":"org-1"}}', { mode: 'manual', organization: 'org-1', configured: true }],
      ['{"threads":{"mode":"organization","organization":"org-1"}}', { mode: 'organization', organization: 'org-1', configured: true }],
      ['{"threads":{"mode":"private"}}', { mode: 'manual', configured: false, problem }],
      ['{"threads":{"mode":"team"}}', { mode: 'manual', configured: false, problem }],
      ['{ not json', { mode: 'manual', configured: false, problem }, true],
    ]
    for (const [text, policy, malformed] of cases) {
      const file = readProjectPolicy(text)
      expect(file.policy).toEqual(policy)
      expect(file.malformed).toBe(malformed)
    }
  })

  test('serializing preserves unknown keys and round-trips through the reader', () => {
    const previous = { unrelated: { keep: [1, 2] }, threads: { future: 'x', mode: 'private', organization: 'org-1' } }
    const text = serializeProjectPolicy(previous, 'organization', 'org-2')
    expect(JSON.parse(text)).toEqual({
      unrelated: { keep: [1, 2] },
      threads: { future: 'x', mode: 'organization', organization: 'org-2' },
    })
    expect(readProjectPolicy(text).policy).toEqual({ mode: 'organization', organization: 'org-2', configured: true })
    // Manual keeps the organization `/delta share` shares to, and drops it when none is given.
    const manual = serializeProjectPolicy(JSON.parse(text), 'manual', 'org-2')
    expect(readProjectPolicy(manual).policy).toEqual({ mode: 'manual', organization: 'org-2', configured: true })
    expect(JSON.parse(serializeProjectPolicy(JSON.parse(text), 'manual')))
      .toEqual({ unrelated: { keep: [1, 2] }, threads: { future: 'x', mode: 'manual' } })
  })

  test('a stopped file keeps its mode and team, records nothing automatically, and counts as configured', () => {
    const stopped = readProjectPolicy('{"threads":{"mode":"private","organization":"org-1","stopped":true}}').policy
    expect(stopped).toEqual({ mode: 'private', organization: 'org-1', configured: true, stopped: true })
    expect(recordsAutomatically(stopped)).toBe(false)
    // Stopping a checkout that was never set up is still a choice, so setup is not offered.
    expect(readProjectPolicy('{"threads":{"stopped":true}}').policy).toEqual({ mode: 'manual', configured: true, stopped: true })
    // Only `true` stops.
    expect(readProjectPolicy('{"threads":{"mode":"private","organization":"org-1","stopped":"yes"}}').policy.stopped).toBeUndefined()
  })

  test('stopping and starting round-trip without losing the mode, the team, or unknown keys', () => {
    const previous = { unrelated: 1, threads: { future: 'x', mode: 'organization', organization: 'org-1' } }
    const stopped = serializeStopped(previous, true)
    expect(JSON.parse(stopped)).toEqual({ unrelated: 1, threads: { future: 'x', mode: 'organization', organization: 'org-1', stopped: true } })
    const started = serializeStopped(JSON.parse(stopped), false)
    expect(JSON.parse(started)).toEqual(previous)
    expect(recordsAutomatically(readProjectPolicy(started).policy)).toBe(true)
    // Choosing a mode in setup starts sync again.
    expect(JSON.parse(serializeProjectPolicy(JSON.parse(stopped), 'private', 'org-1')).threads.stopped).toBeUndefined()
  })
})
