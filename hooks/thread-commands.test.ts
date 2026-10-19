import { describe, expect, test, tier } from 'claude-code/testing'
import { cliFixture } from './cli-fixtures'
import {
  DeltaCommandError, JoinNotReadyError, appendFailure, classifyCommandFailure, contractRefusal, contractVersion, parseAppendReceipt,
  parseThreadContract, parseThreadFork, parseThreadMount, permanentFailureAdvice,
  parseWatchEvent, parseThreadStatus, validateJoinedMounts,
  validateThreadFrontier, validateThreadCheckout, type ThreadReady, type ThreadStatus,
} from './thread-commands'

tier('user')

describe('thread watch', () => {
  test('decodes readiness, item changes, turn state, and presence', () => {
    expect(parseWatchEvent(JSON.stringify({ type: 'ready', ...ready() }))).toEqual({ type: 'ready', ...ready() })
    for (const status of ['running', 'finished', 'superseded'] as const) {
      const running = { type: 'ready', ...ready(), producer: { ...ready().producer!, turn: { sequence: 3, status } } }
      expect(parseWatchEvent(JSON.stringify(running))).toEqual(running)
    }
    const item = { id: 'a', kind: 'tool_call', after_id: null, turn_id: 't', author: null, created_at: 1, open: true,
      content: { toolCallId: 'x', status: 'in_progress' } }
    for (const event of [
      { type: 'item', item },
      { type: 'item', item: { ...item, kind: 'user_message', turn_id: null, created_at: null, content: { text: 'Imported without a timestamp' } } },
      { type: 'item', item: { ...item, kind: 'unknown', author: { user_id: null, name: 'Ada' }, after_id: 'b', turn_id: null } },
      { type: 'item.append', id: 'a', text: 'more' },
      { type: 'remove', id: 'a' },
      { type: 'live' },
      { type: 'turn', state: 'running', turn_id: null, user: { user_id: 'u', name: 'Ada' } },
      { type: 'turn', state: 'running', turn_id: 't', user: { user_id: null, name: null } },
      { type: 'turn', state: 'idle', turn_id: null, user: null },
      { type: 'producer.turn', sequence: 2, status: 'running' },
      { type: 'presence', users: [{ user_id: 'u', name: 'Ada' }, { user_id: null, name: 'Bob' }] },
      { type: 'presence', users: [{ user_id: null, name: null }] },
    ]) expect(parseWatchEvent(JSON.stringify(event))).toEqual(event)

    // A person's name is null while Delta's actor-to-user lookup is pending or failed; that is a
    // legitimate state, not a version mismatch.
    const pending = { id: 'a', kind: 'user_message', after_id: null, turn_id: 't', author: { user_id: null, name: null },
      created_at: 1, open: false, content: { text: 'Pending' } }
    for (const event of [
      { type: 'item', item: pending },
      { type: 'turn', state: 'running', turn_id: 't', user: { user_id: 'u', name: null } },
      { type: 'presence', users: [{ user_id: 'u', name: null }] },
    ]) expect(parseWatchEvent(JSON.stringify(event))).toEqual(event)
    // A newer CLI may add events; they are skipped rather than failing the watch.
    expect(parseWatchEvent(JSON.stringify({ type: 'typing', users: [] }))).toBeUndefined()
    expect(parseThreadStatus(JSON.stringify(status()))).toEqual(status())
  })

  test('decodes child snapshots and updates with future kinds and statuses but rejects malformed children', () => {
    const child = { thread_id: 'child-1', reference: 'opaque-child-reference', kind: 'future_kind', name: 'Explore tests', status: 'future_status' }
    expect(parseWatchEvent(JSON.stringify({ type: 'children', children: [child], extra: true })))
      .toEqual({ type: 'children', children: [child] })
    expect(parseWatchEvent(JSON.stringify({ type: 'child', child }))).toEqual({ type: 'child', child })
    const { reference: _reference, ...unaddressed } = child
    for (const malformed of [{ ...child, thread_id: '' }, { ...child, kind: '' },
      { ...child, name: null }, { ...child, status: null }, { ...child, reference: '' }, unaddressed]) {
      expect(() => parseWatchEvent(JSON.stringify({ type: 'child', child: malformed }))).toThrow()
    }
    expect(() => parseWatchEvent(JSON.stringify({ type: 'children', children: [{ ...child, kind: '' }] }))).toThrow()
    expect(() => parseWatchEvent('{"type":"child.remove","thread_id":""}')).toThrow()
    expect(() => parseWatchEvent('{"type":"children","children":null}')).toThrow()
  })

  test('rejects mismatched, reset, or advanced producer state without changing the binding', () => {
    const binding = { session: 'session', thread: 'thread', next: 5, pending: [{ sequence: 4 }] }
    const before = JSON.stringify(binding)
    for (const frame of [
      { ...ready(), thread_id: 'other' },
      { ...ready(), producer: { ...ready().producer!, next_sequence: 1 } },
      { ...ready(), producer: { ...ready().producer!, next_sequence: 6 } },
      { ...ready(), producer: { ...ready().producer!, source: 'other' } },
      { ...ready(), producer: { ...ready().producer!, external_id: 'other-session' } },
      { ...ready(), producer: null },
    ]) expect(() => validateThreadFrontier(frame, binding)).toThrow()
    expect(JSON.stringify(binding)).toBe(before)
    validateThreadFrontier({ ...ready(), producer: { ...ready().producer!, next_sequence: 4 } }, binding)
    // Server accepted the pending record but the producer lost its acknowledgment.
    validateThreadFrontier({ ...ready(), producer: { ...ready().producer!, next_sequence: 5 } }, binding)
  })

  test('carries lifecycle changes for one exact start sequence', () => {
    for (const status of ['running', 'finished', 'superseded'])
      expect(parseWatchEvent(JSON.stringify({ type: 'producer.turn', sequence: 7, status, thread_id: 'ignored' })))
        .toEqual({ type: 'producer.turn', sequence: 7, status })
    for (const event of [
      { type: 'producer.turn', status: 'superseded' },
      { type: 'producer.turn', sequence: 0, status: 'superseded' },
      { type: 'producer.turn', sequence: 1.5, status: 'superseded' },
      { type: 'producer.turn', sequence: '7', status: 'superseded' },
    ]) expect(() => parseWatchEvent(JSON.stringify(event))).toThrow()
  })

  test('minimal readiness and full status decode without inventing a producer or authorizing from a URL', () => {
    expect(parseWatchEvent(JSON.stringify({ type: 'ready', ...ready(), producer: null })))
      .toEqual({ type: 'ready', ...ready(), producer: null })
    const local = { ...status(), producer: null, url: null,
      access: { state: 'local_only' as const, is_owner: null }, worktrees: { status: 'available' as const, items: [] } }
    expect(parseThreadStatus(JSON.stringify(local))).toEqual(local)
    const binding = { checkout: '/repo', checkoutReference: 'history#t=0' }
    expect(() => validateThreadCheckout({ ...local, url: status().url }, binding)).toThrow('/delta-share')
    for (const is_owner of [false, null]) {
      const state = { ...status(), access: { state: 'granted' as const, is_owner }, url: null }
      expect(validateThreadCheckout(state, binding))
        .toEqual({ directory: '/repo', reference: 'history#t=0' })
    }
  })

  test('empty available inspection differs from unavailable inspection', () => {
    const binding = { checkout: '/repo', checkoutReference: 'history#t=0' }
    const common = status()
    const empty = { status: 'available' as const, items: [] }
    const unavailable = { status: 'unavailable' as const,
      error: { code: 'inspection_failed', message: 'Attachment storage cannot be read' } }
    for (const worktrees of [empty, unavailable]) {
      const state = { ...common, worktrees }
      expect(parseThreadStatus(JSON.stringify(state))).toEqual(state)
      expect(() => validateThreadCheckout({ ...common, worktrees }, binding)).toThrow()
    }
    expect(() => validateThreadCheckout({ ...common, worktrees: unavailable }, binding))
      .toThrow(unavailable.error.code)
    expect(() => validateThreadCheckout({ ...common, worktrees: empty }, binding)).toThrow('missing')
    expect(binding).toEqual({ checkout: '/repo', checkoutReference: 'history#t=0' })
  })

  test('checkout selection uses reference and directory independently of inventory order', () => {
    const worktrees: Extract<ThreadStatus['worktrees'], { status: 'available' }>['items'] = [
      { reference: 'other#t=0', checkouts: [{ directory: '/repo', state: 'attached' }] },
      { reference: 'history#t=0', checkouts: [
        { directory: '/other', state: 'attached' }, { directory: '/repo', state: 'attached' },
      ] },
    ]
    const binding = { checkout: '/repo', checkoutReference: 'history#t=0' }
    for (const inventory of [worktrees, [...worktrees].reverse().map((tree) => ({ ...tree, checkouts: [...tree.checkouts].reverse() }))])
      expect(validateThreadCheckout({ ...status(), worktrees: { status: 'available', items: inventory } }, binding))
        .toEqual({ directory: '/repo', reference: 'history#t=0' })
    expect(() => validateThreadCheckout({ ...status(), worktrees: { status: 'available', items: worktrees } }, { checkout: '/repo' })).toThrow('ambiguous')
    expect(() => validateThreadCheckout(status(), { ...binding, checkoutReference: 'wrong#t=0' })).toThrow('preserved')
    expect(binding).toEqual({ checkout: '/repo', checkoutReference: 'history#t=0' })
  })

  test('Windows separator equivalence preserves checkout identity and readiness requirements', () => {
    const directory = String.raw`C:\Workspace\zed\delta\.delta\worktrees\rn4eercbxvfw\delta`
    const reported = String.raw`C:\Workspace\zed\delta\.delta\worktrees\rn4eercbxvfw/delta`
    const mount = { reference: 'history#t=0', name: 'delta', directory }
    const checkout = { directory: reported, state: 'detached' as const, active: true }
    const state = (patch: object = {}): ThreadStatus => ({
      ...status(), worktrees: { status: 'available', items: [
        { reference: mount.reference, checkouts: [{ ...checkout, ...patch }] },
      ] },
    })
    expect(validateJoinedMounts(state(), [mount])).toBeUndefined()
    expect(validateThreadCheckout(state({ state: 'attached' }), { checkout: directory, checkoutReference: mount.reference }))
      .toEqual({ directory: reported, reference: mount.reference })
    expect(() => validateThreadCheckout(state(), { checkout: directory })).toThrow()
    expect(() => validateJoinedMounts(state(), [{ ...mount, reference: 'other' }])).toThrow(JoinNotReadyError)
    for (const patch of [{ active: false }, { state: 'missing' }, { directory: `${reported}-other` }])
      expect(() => validateJoinedMounts(state(patch), [mount])).toThrow(JoinNotReadyError)
    for (const [actual, requested] of [
      [String.raw`\\server\share\delta`, '//server/share/delta'],
      [String.raw`\\server\share\delta`, String.raw`//server/share\delta`],
      [String.raw`\\server\share\delta`, String.raw`//server\share/delta`],
      ['/repo/Delta', '/repo/delta'],
      [String.raw`/repo/a\b`, '/repo/a/b'],
      [String.raw`//server/share\delta`, '//server/share/delta'],
      [directory, directory.toLowerCase()],
    ]) {
      const run = () => validateJoinedMounts(state({ directory: actual }), [{ ...mount, directory: requested }])
      if (actual.startsWith('\\\\')) expect(run()).toBeUndefined()
      else expect(run).toThrow(JoinNotReadyError)
    }
  })

  test('decodes the worktrees event, requiring each worktree name, and tolerates what a newer CLI adds', () => {
    expect(parseWatchEvent(JSON.stringify({ type: 'worktrees', worktrees: [] }))).toEqual({ type: 'worktrees', worktrees: [] })
    expect(parseWatchEvent(JSON.stringify({ type: 'worktrees', worktrees: [{ reference: 'a#t=0', name: 'delta', directory: '/ignored' }] })))
      .toEqual({ type: 'worktrees', worktrees: [{ reference: 'a#t=0', name: 'delta' }] })
    for (const event of [{ type: 'worktrees' }, { type: 'worktrees', worktrees: [{ name: 'delta' }] }, { type: 'worktrees', worktrees: [{ reference: 'b#t=0' }] }])
      expect(() => parseWatchEvent(JSON.stringify(event))).toThrow()
  })

  test('a mount result names every worktree checkout, and a joined check names the one that is not ready', () => {
    const mounted = { operation: 'mounted', thread_id: 'thread', owner: 'session', directory: '/folder',
      worktrees: [{ reference: 'a#t=0', name: 'delta', directory: '/a', state: 'mounted' },
        { reference: 'b#t=0', name: 'web', directory: '/folders/web', state: 'mounted' }] }
    expect(parseThreadMount(JSON.stringify(mounted), 'session')).toEqual({
      thread_id: 'thread', owner: 'session', directory: '/folder',
      worktrees: [{ reference: 'a#t=0', name: 'delta', directory: '/a', state: 'mounted' },
        { reference: 'b#t=0', name: 'web', directory: '/folders/web', state: 'mounted' }] })
    expect(parseThreadMount(JSON.stringify({ ...mounted, worktrees: [] }), 'session').worktrees).toEqual([])
    for (const bad of [{ operation: 'unmounted' }, { owner: 'other' }, { directory: '' }, { worktrees: [{ reference: 'a#t=0', directory: '/a', state: 'mounted' }] }])
      expect(() => parseThreadMount(JSON.stringify({ ...mounted, ...bad }), 'session')).toThrow('Unexpected thread mount result')
    expect(() => parseThreadMount(JSON.stringify({ error: { code: 'not_visible', message: 'no access' } }), 'session'))
      .toThrow(DeltaCommandError)

    const mounts = [{ reference: 'a#t=0', name: 'delta', directory: '/a' }, { reference: 'b#t=0', name: 'web', directory: '/b' }]
    const state = (second: object): ThreadStatus => ({ ...status(), worktrees: { status: 'available', items: [
      { reference: 'a#t=0', checkouts: [{ directory: '/a', state: 'detached', active: true }] },
      { reference: 'b#t=0', checkouts: [{ directory: '/b', state: 'detached', active: true, ...second }] }] } })
    validateJoinedMounts(state({}), mounts)
    const notReady = (second: object) => { try { validateJoinedMounts(state(second), mounts) } catch (error) { return error } }
    for (const second of [{ active: false }, { state: 'missing' }, { directory: '/elsewhere' }]) {
      const error = notReady(second)
      expect(error).toBeInstanceOf(JoinNotReadyError)
      expect((error as Error).message).toContain('web')
      expect((error as Error).message).not.toContain('"delta"')
    }
  })

  test('decodes delivered comments, tolerates target kinds a newer Delta adds, and rejects malformed ones', () => {
    const comment = cliFixture('comment').comment
    expect(parseWatchEvent(JSON.stringify(cliFixture('comment')))).toEqual({ type: 'comment', comment })
    expect(parseWatchEvent(JSON.stringify(cliFixture('commentRemove')))).toEqual({ type: 'comment.remove', id: 'comment_example' })
    const newer = { ...comment, target: { kind: 'image', region: [0, 0, 4, 4] }, extra: true }
    expect(parseWatchEvent(JSON.stringify({ type: 'comment', comment: newer }))?.type).toBe('comment')
    for (const bad of [
      { ...comment, id: '' },
      { ...comment, delivered_with: undefined },
      { ...comment, after_id: '' },
      { ...comment, author: 'Ada' },
      { ...comment, co_authors: [{ user_id: 1, name: 'Bob' }] },
      { ...comment, agent: 'no' },
      { ...comment, text: null },
      { ...comment, target: { kind: 'transcript', item_id: null } },
      { ...comment, target: { kind: 'file', worktree: null, path: 'a', view: 'diff', selected: null, regions: [{ first_line: 1.5 }] } },
      { ...comment, target: 'src/main.rs' },
    ]) expect(() => parseWatchEvent(JSON.stringify({ type: 'comment', comment: bad }))).toThrow('Unexpected thread watch event')
    expect(() => parseWatchEvent('{"type":"comment.remove","id":""}')).toThrow('Unexpected thread watch event')
  })

  test('rejects malformed events and carries typed watch failures', () => {
    const item = { id: 'a', kind: 'agent_message', after_id: null, turn_id: null, author: null, created_at: 1, open: false, content: { text: 'x' } }
    for (const event of [
      { ...ready(), type: 'ready', thread_id: '' },
      { ...ready(), type: 'ready', producer: undefined },
      { ...ready(), type: 'ready', producer: { ...ready().producer!, source: '' } },
      { ...ready(), type: 'ready', producer: { ...ready().producer!, external_id: '' } },
      { ...ready(), type: 'ready', producer: { ...ready().producer!, next_sequence: 0 } },
      { ...ready(), type: 'ready', producer: { ...ready().producer!, next_sequence: 1.5 } },
      { ...ready(), type: 'ready', producer: { ...ready().producer!, turn: undefined } },
      { ...ready(), type: 'ready', producer: { ...ready().producer!, turn: { sequence: 0, status: 'running' } } },
      { ...ready(), type: 'ready', producer: { ...ready().producer!, turn: { sequence: 2, status: 'pending' } } },
      { type: 'item', item: { ...item, id: '' } },
      { type: 'item', item: { ...item, open: 'no' } },
      { type: 'item', item: { ...item, content: 'text' } },
      { type: 'item', item: { ...item, author: { name: 3 } } },
      { type: 'item', item: { ...item, author: 'Ada' } },
      { type: 'turn', state: 'running', turn_id: 't', user: { user_id: null, name: 3 } },
      { type: 'turn', state: 'running', turn_id: 't', user: { name: null } },
      { type: 'presence', users: [{ user_id: 'u' }] },
      { type: 'item', item: { ...item, created_at: undefined } },
      { type: 'item.append', id: 'a' },
      { type: 'remove', id: '' },
      { type: 'turn', state: 'paused', turn_id: null, user: null },
      { type: 'presence', users: [{ user_id: 1, name: 'Ada' }] },
      { event: 'changed', thread_id: 'thread', cursor: 'current' },
    ]) expect(() => parseWatchEvent(JSON.stringify(event))).toThrow()
    const reset = parseWatchEvent('{"error":{"code":"watch_reset","reason":"watch_overflow","message":"History was reset","retryable":true}}')
    expect(reset?.type === 'error' && [reset.error.code, reset.error.reason, reset.error.message, classifyCommandFailure(reset.error)])
      .toEqual(['watch_reset', 'watch_overflow', 'watch_reset (watch_overflow): History was reset', 'transient'])
    const gone = parseWatchEvent('{"error":{"code":"not_visible","reason":"thread_gone","message":"Deleted","retryable":false}}')
    expect(gone?.type === 'error' && classifyCommandFailure(gone.error)).toBe('permanent')
  })

  test('status still requires full inspection and surfaces typed errors', () => {
    expect(() => parseThreadStatus(JSON.stringify({ ...ready(), operation: 'status' }))).toThrow()
    for (const patch of [
      { access: undefined }, { thread_id: '' }, { url: '' },
      { worktrees: { status: 'available', items: [{ reference: 'history#t=0', checkouts: [{ directory: '', state: 'attached' }] }] } },
      { worktrees: [] }, { worktrees: null },
      { worktrees: { status: 'available', items: null } },
      { worktrees: { status: 'unavailable', error: { message: 'Missing error code' } } },
      { producer: { ...ready().producer!, next_sequence: 0 } },
      ...[undefined, '1', 1.5].map((next_sequence) => ({ producer: { ...ready().producer!, next_sequence } })),
      { operation: 'created' },
    ]) expect(() => parseThreadStatus(JSON.stringify({ ...status(), ...patch }))).toThrow()
    try {
      parseThreadStatus('{"error":{"code":"not_visible","reason":"access_denied","message":"Sign in","retryable":false}}')
      throw new Error('Expected typed refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(DeltaCommandError)
      expect((error as DeltaCommandError).code).toBe('not_visible')
    }
  })
})

describe('failure classification', () => {
  test('the envelope verdict wins, and only the plugin local codes fall back to a table', () => {
    const classify = (code: string, retryable?: boolean) =>
      classifyCommandFailure(new DeltaCommandError(code, 'x', retryable === undefined ? {} : { retryable }))
    // A retryable envelope is retried; a non-retryable one never is, whatever its code.
    for (const code of ['app_unavailable', 'watch_reset', 'failed', 'authentication_required', 'unknown_code'])
      expect(classify(code, true)).toBe('transient')
    for (const code of ['not_visible', 'wrong_account', 'invalid_record', 'failed', 'unknown_code'])
      expect(classify(code, false)).toBe('permanent')
    // Only the plugin local codes come without an envelope.
    for (const code of ['process_failed', 'timeout']) expect(classify(code)).toBe('transient')
    for (const code of ['command_failed', 'invalid_acknowledgment']) expect(classify(code)).toBe('permanent')
    // A published code with no verdict is not retried on a guess.
    expect(classify('not_visible')).toBe('permanent')
    expect(classifyCommandFailure(new Error('timeout'))).toBe('permanent')
  })

  test('codes survive status decoding, append envelopes, and unavailable inspection', () => {
    const failure = (run: () => unknown) => { try { run() } catch (error) { return error } }
    expect(classifyCommandFailure(failure(() => parseThreadStatus('{"error":{"code":"failed","reason":"cloud_request_failed","message":"offline","retryable":true}}'))))
      .toBe('transient')
    expect(classifyCommandFailure(failure(() => parseThreadStatus('{"error":{"code":"not_visible","reason":"access_denied","message":"denied","retryable":false}}'))))
      .toBe('permanent')
    expect(classifyCommandFailure(failure(() => parseThreadStatus('{"error":{"code":"x","message":"y","retryable":true,"retry_after_ms":1500}}'))))
      .toBe('transient')
    expect((failure(() => parseThreadStatus('{"error":{"code":"x","message":"y","retryable":true,"retry_after_ms":1500}}')) as DeltaCommandError).hints)
      .toEqual({ retryable: true, retryAfterMs: 1500 })
    const unavailable = (error: { code: string; reason?: string; message: string }) => failure(() => validateThreadCheckout(
      { ...status(), worktrees: { status: 'unavailable', error } }, { checkout: '/repo' }))
    const storage = unavailable({ code: 'failed', reason: 'storage', message: 'cannot read checkout' }) as DeltaCommandError
    expect(classifyCommandFailure(storage)).toBe('permanent')
    expect(storage.reason).toBe('storage')
    expect(storage.message).toContain('failed (storage)')
    const appended = appendFailure('{"operation":"appended"}\n{"error":{"code":"failed","reason":"sync","message":"not confirmed","retryable":true}}', 'ignored', 2)
    expect(appended).toMatchObject({ code: 'failed', reason: 'sync' })
    expect(appendFailure('', ' disk full \n', 1)).toMatchObject({ code: 'process_failed', message: 'disk full' })
    // Detached, inactive, missing, and local-only results are plain state errors.
    expect(classifyCommandFailure(failure(() => validateThreadCheckout(
      { ...status(), worktrees: { status: 'available', items: [] } }, { checkout: '/repo' })))).toBe('permanent')
  })
})

describe('permanent failure advice', () => {
  test('names the documented client action for each published code', () => {
    for (const code of ['not_visible', 'authentication_required', 'wrong_account'])
      expect(permanentFailureAdvice(code)).toContain('sign-in')
    expect(permanentFailureAdvice('organization_required')).toContain('delta-org switch')
    expect(permanentFailureAdvice('not_shared')).toContain('/delta-share')
    expect(permanentFailureAdvice('invalid_reference')).toContain('reference')
    expect(permanentFailureAdvice('invalid_record')).toContain('Update Delta')
    expect(permanentFailureAdvice('sequence_gap')).toContain('do not reset the sequence')
    expect(permanentFailureAdvice('history_reset')).toContain('replaced this thread')
    expect(permanentFailureAdvice('reload_required')).toContain('Fork & Restore or Discard')
    expect(permanentFailureAdvice('checkout_inactive')).toContain('Mount')
    expect(permanentFailureAdvice('incompatible_app')).toContain('restart')
    expect(permanentFailureAdvice('invalid_invocation')).toContain('plugin')
    expect(permanentFailureAdvice('invalid_invocation', false, 'organization_mismatch')).toContain('different Delta team')
  })
})

describe('operation receipts', () => {
  test('accepts durable recording receipts, including scoped starts and unscoped content', () => {
    const common = { thread_id: 'thread', sequence: 7, next_sequence: 8, duplicate: false, version: 'server-1' }
    for (const turn_sequence of [null, 2, 7])
      for (const disposition of ['recorded', 'fenced', 'duplicate'])
        expect(parseAppendReceipt(JSON.stringify({ ...common, operation: 'appended', disposition, turn_sequence }), 'thread', 7).disposition)
          .toBe(disposition)
    for (const operation of ['appended', 'turn_claimed', 'turn_ended']) {
      for (const disposition of ['recorded', 'fenced', 'duplicate', 'admitted', 'busy', 'lost', 'ended']) {
        const line = JSON.stringify({ ...common, operation, disposition, turn_sequence: 7 })
        if (operation !== 'appended' || !['recorded', 'fenced', 'duplicate'].includes(disposition))
          expect(() => parseAppendReceipt(line, 'thread', 7)).toThrow()
      }
    }
  })

  test('receipts require identity, frontier, version and a valid optional turn sequence', () => {
    for (const patch of [
      { thread_id: 'other' }, { sequence: 8 }, { next_sequence: 7 }, { next_sequence: 8.5 },
      { version: '' }, { duplicate: undefined }, { turn_sequence: 0 }, { turn_sequence: 8 },
      { turn_sequence: undefined }, { turn_sequence: '7' },
    ]) expect(() => parseAppendReceipt(JSON.stringify({
      operation: 'appended', thread_id: 'thread', sequence: 7, next_sequence: 8,
      duplicate: true, version: 'server-1', disposition: 'duplicate', turn_sequence: 7, ...patch,
    }), 'thread', 7)).toThrow()
  })

  test('decodes a pretty-printed fork summary and refuses a malformed one', () => {
    const summary = JSON.stringify({ source_thread_id: 'thread', thread_id: 'thread-fork', name: 'Example (local changes)' }, null, 2)
    expect(parseThreadFork(summary)).toEqual({ thread_id: 'thread-fork' })
    expect(() => parseThreadFork('{"source_thread_id":"thread"}')).toThrow('matching CLI and plugin builds')
    expect(() => parseThreadFork('{"thread_id":""}')).toThrow('matching CLI and plugin builds')
    expect(() => parseThreadFork('not json')).toThrow('matching CLI and plugin builds')
    expect(() => parseThreadFork('{"error":{"code":"reload_required","message":"refused"}}')).toThrow(DeltaCommandError)
  })
})

describe('recording contract', () => {
  test('decodes a contract range and refuses a malformed one', () => {
    expect(parseThreadContract(JSON.stringify(cliFixture('contract')))).toEqual({ operation: 'contract', min: 1, max: 7 })
    expect(parseThreadContract('{"operation":"contract","min":1,"max":4}')).toEqual({ operation: 'contract', min: 1, max: 4 })
    for (const bad of [
      '{"operation":"status","min":1,"max":1}',
      '{"operation":"contract","min":1}',
      '{"operation":"contract","min":1,"max":0}',
      '{"operation":"contract","min":1.5,"max":2}',
      '{"operation":"contract","min":-1,"max":1}',
      'not json',
    ]) expect(() => parseThreadContract(bad)).toThrow('matching CLI and plugin builds')
    expect(() => parseThreadContract('{"error":{"code":"incompatible_app","message":"old"}}')).toThrow(DeltaCommandError)
  })

  test('records only against a CLI whose range covers the current contract', () => {
    const at = (min: number, max: number) => ({ operation: 'contract' as const, min, max })
    for (const range of [at(1, 6), at(6, 7), at(7, 8)]) expect(contractRefusal(range)).toBeUndefined()
    for (const range of [at(1, 5), undefined]) expect(contractRefusal(range)).toContain('Update Delta')
    expect(contractRefusal(at(8, 9))).toContain('Update the Delta plugin')
    // A later capability is gated on the version both sides speak.
    expect([at(3, 6), at(3, 9)].map(contractVersion)).toEqual([6, 7])
  })
})

function ready(): ThreadReady {
  const fixture = cliFixture('ready', { thread_id: 'thread', producer: cliFixture('status').producer })
  return { thread_id: fixture.thread_id, producer: fixture.producer }
}

function status(): ThreadStatus {
  return cliFixture('status', {
    thread_id: 'thread', url: 'https://delta.dev/join/thread_cloud',
    worktrees: { status: 'available', items: [{ reference: 'history#t=0', checkouts: [{ directory: '/repo', state: 'attached' }] }] },
  }) as ThreadStatus
}
