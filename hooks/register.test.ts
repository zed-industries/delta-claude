import { describe, expect, test as kitTest, tier, type Engine } from 'claude-code/testing'
import type { UiCopyResult } from 'claude-code'
import { addRows, itemFingerprint, RemoteView, type PendingRow } from './conversation'
import { cliFixture } from './cli-fixtures'
import { personColor, personKey } from './status'
import {
  ADA, CHECKOUT, CONFIG, LIVE, PENDING, abovePrompt, bash, commandOutput, commandRunRows, fakeThreads,
  localCommandCaveat, prompt, remoteComment, remoteItem, sessionEnd, sessionStart, shareCommand, testsWithHeldClockWait,
  turnComplete, turnStart, typedDelta,
} from './fake-thread-commands'

tier('user')

/** Keeps a clock wait held, so stepping the mock clock does not wait out a settle budget. */
const test = testsWithHeldClockWait(kitTest)

const text = (value: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: value }] })

/** The status band's drawn tree as text, for asserting what the person sees. */
const drawn = async ($: Engine) => JSON.stringify(await $.ui.render(abovePrompt))

/**
 * A redraw, which is the hook context the plugin answers its own command in: a remote message's
 * row only reaches Claude when the host draws a site again.
 */
const redraw = async ($: Engine) => JSON.stringify(await $.ui.render(abovePrompt))

/** Keep redrawing, as a live host does, until the plugin has drawn every row it had ready. */
async function drawReady($: Engine, fake: ReturnType<typeof fakeThreads>) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = fake.rows.length
    await redraw($)
    // A row's draw is awaited by the row loop, so let its continuation queue the next one.
    await fake.clock.settle()
    if (fake.rows.length === before) return
  }
}

/** Append one command run's rows as the engine does; `fake.stored` holds them as the plugin rewrote them. */
async function appendAsEngine($: Engine, rows: readonly unknown[]) {
  for (const row of rows) await $.session.append(row as never)
}

function expectNoSetupCommands(fake: ReturnType<typeof fakeThreads>, since: number) {
  expect(fake.operations().slice(since).filter((operation) => ['create', 'attach', 'share'].includes(operation!)))
    .toEqual([])
}

function expectStagedRecords(fake: ReturnType<typeof fakeThreads>, sequences: number[]) {
  const { pending } = fake.store.get(`session:${fake.session}`) as {
    pending: { sequence: number, files: string[] }[]
  }
  expect(pending.map((entry) => entry.sequence)).toEqual(sequences)
  expect(pending.every((entry) => entry.files.every((path) => fake.files.has(path)))).toBe(true)
}

describe('thread commands', () => {
  test('resume with a missing CLI preserves the binding and asks for explicit setup', async ($, on) => {
    const fake = fakeThreads(on)
    fake.cliMissing = true
    const binding = { session: fake.session, thread: fake.threadId, checkout: CHECKOUT,
      snapshot: true, next: 1, pending: [] }
    fake.store.set(`session:${fake.session}`, binding)
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.cliSetups).toEqual(['discover'])
    expect(fake.store.get(`session:${fake.session}`)).toEqual(binding)
    expect(fake.operations()).toEqual([])
    expect(fake.logs.join('\n')).toContain('Run /delta share or /delta join')
  })

  test('first explicit share installs a missing CLI, never plugin load or contract failure', async ($, on) => {
    const fake = fakeThreads(on)
    fake.cliMissing = true
    fake.contractRange = { min: 0, max: 0 }
    await $.session.start(sessionStart)
    expect(fake.cliSetups).toEqual([])
    await fake.share($)
    expect(fake.cliSetups).toEqual(['discover', 'install'])
    expect(fake.operations()).toEqual([])
    fake.contractRange = undefined
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.cliSetups).toEqual(['discover', 'install'])
  })

  for (const change of ['session', 'folder'] as const) test(`share stops when its ${change} changes during installation`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('original conversation')] })
    fake.cliMissing = true
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    fake.holdCliSetup = (install) => {
      if (!install) return
      entered()
      return held
    }
    await $.session.start(sessionStart)
    await $.command.run(shareCommand)
    const running = fake.clock.advance(0)
    await waiting
    if (change === 'session') {
      await $.session.end(sessionEnd(fake.session))
      fake.session = 'replacement'
      fake.messages = [text('replacement conversation')]
      await $.session.start(sessionStart)
    } else fake.cwd = '/different-checkout'
    release()
    await running
    await fake.clock.settle()
    expect(fake.exports).toBe(0)
    expectNoSetupCommands(fake, 0)
    expect((await $.prompt.submit(prompt('continue here'))).drop).toBeUndefined()
    fake.expectClean()
  })

  test('first share binds and publishes the checkout, and repeating it does not reimport', async ($, on) => {
    const fake = fakeThreads(on, {
      messages: [text('<local-command-stdout>framing</local-command-stdout>'), text('first'), text('second'), text('third')],
    })
    await $.session.start(sessionStart)
    expect(fake.operations().some((operation) => ['create', 'attach', 'share', 'append'].includes(operation!))).toBe(false)
    expect(fake.server.thread).toBeUndefined()
    expect(fake.server.mount).toBeUndefined()
    expect(fake.server.shared).toBe(false)
    expect(fake.records()).toEqual([])

    const url = await fake.share($)
    expect(url).toBe(`https://delta.dev/join/${fake.shareId}`)
    // The band above the prompt reports the live conversation.
    expect(await drawn($)).toContain(LIVE)
    expect(fake.server.thread).toBe(fake.threadId)
    expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    expect(fake.server.shared).toBe(true)
    expect(fake.live()?.ready).toBe(true)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({
      thread: fake.threadId, checkout: CHECKOUT, checkoutReference: fake.server.mount!.reference,
      url, snapshot: true, next: 4, pending: [],
    })
    const records = fake.records()
    expect(records).toHaveLength(3)
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3])
    expect(records[0]).toMatchObject({ update: { content: [{ text: 'first' }] } })
    expect(records.at(-1)).toMatchObject({ update: { content: [{ text: 'third' }] } })
    expect(records.every((record) => record.turnSequence === undefined)).toBe(true)

    fake.messages = [text('changed export must not be imported')]
    expect(await fake.share($)).toBe(url)
    // A repeat share reopens nothing and disturbs nothing: the band still reports the same conversation.
    expect(await drawn($)).toContain(LIVE)
    expect(fake.records()).toEqual(records)
    expect(fake.exports).toBe(1)
    expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    fake.expectClean()
  })

  test('share without an interactive surface returns failures and confirmed success through the command', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    fake.surfaces = []
    await $.session.start(sessionStart)
    fake.commandFault = { operation: 'share', code: 'authentication_required', message: 'Sign in to Delta' }
    expect(await $.command.run(shareCommand)).toEqual({
      text: 'Delta sharing failed: DeltaCommandError: thread share: authentication_required: Sign in to Delta. Fix the issue and retry /delta share; saved records retain their sequence.',
    })

    fake.commandFault = undefined
    let release!: () => void
    fake.holdAppend = new Promise<void>((resolve) => { release = resolve })
    let completed = false
    const result = $.command.run(shareCommand).then((result) => { completed = true; return result })
    await fake.clock.settle()
    expect(completed).toBe(false)
    release()
    expect(await result).toEqual({ text: `Delta share link: https://delta.dev/join/${fake.shareId}` })
    // Completion releases the command's prompt gate without relying on a redraw or a timer.
    expect((await $.prompt.submit(prompt('after sharing'))).drop).toBeUndefined()
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  for (const failure of ['record write']) test(`a staging ${failure} failure contacts no Delta command and leaves no partial import`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    await $.session.start(sessionStart)
    if (failure === 'record write') fake.failWrite = true
    else fake.failStoreSet = true
    expect(await fake.share($)).toContain('failed')
    expect(fake.delta()).toEqual([])
    expect(fake.watches).toEqual([])
    expect(fake.store.get(`session:${fake.session}`)).toBeUndefined()
    expect(fake.server.thread).toBeUndefined()
    expect(fake.server.mount).toBeUndefined()
    expect(fake.server.shared).toBe(false)
    fake.failWrite = false
    fake.failStoreSet = false
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.records()).toMatchObject([{ sequence: 1, update: { content: [{ text: 'initial' }] } }])
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual([])
    fake.expectClean()
  })

  test('a partial append retains exactly the unacknowledged suffix and never restages the export', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one'), { role: 'assistant', content: [{ type: 'text', text: 'two' }] }] })
    await $.session.start(sessionStart)
    fake.appendFaults.push({ accept: 1, exitCode: 1, stderr: 'temporary failure' })
    const first = await fake.share($)
    expect(first).toContain('failed')
    expect(fake.records().map((record) => record.sequence)).toEqual([1])
    const saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved).toMatchObject({ thread: fake.threadId, checkout: CHECKOUT, snapshot: true, next: 3 })
    expect(saved.pending.map((entry: any) => entry.sequence)).toEqual([2])
    const pendingFiles = new Map<string, string>(saved.pending[0].files.map((path: string) => [path, fake.files.get(path)]))
    expect([...pendingFiles.values()].join('')).toContain('two')
    expect(fake.server.shared).toBe(true)
    expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    // A resumed or compacted source must never replace an already staged export.
    fake.messages = [text('compacted-away')]
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2])
    expect(fake.server.records.get(2)?.line + '\n').toBe([...pendingFiles.values()].join(''))
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual([])
    expect(fake.exports).toBe(1)
    expect(JSON.stringify(fake.records())).not.toContain('compacted-away')
    expect([...fake.files.values()].join('')).not.toContain('compacted-away')
    fake.expectClean()
  })

  test('a call recorded before its input row names itself, and plan approvals record nothing', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.tool.call(bash('first', 'echo first'))
    await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'plan', plan: 'Do it' })
    await fake.clock.settle()
    expect(fake.updates().map((record) => record.update)).toEqual([
      expect.anything(),
      expect.objectContaining({ toolCallId: 'first', name: 'Bash', title: 'echo first', kind: 'execute' }),
    ])
    fake.expectClean()
  })

  test('a failed append shows the CLI error in the transcript once, keeps the record queued, and retries it', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    const failure = { accept: 0, exitCode: 2, stdout: () => JSON.stringify({
      error: { code: 'failed', reason: 'sync', message: 'Delta did not confirm the record within 10 seconds', retryable: true } }) }
    fake.appendFaults.push(failure, failure)
    await $.tool.call(bash('unsent', 'echo unsent'))
    await fake.clock.settle()
    const shown = () => fake.logs.filter((log) => log.includes('sync'))
    expect(shown()).toHaveLength(1)
    // The band shows the retry in yellow while the watch stays live.
    expect(await drawn($)).toContain('sync')
    expect(await drawn($)).toContain('"color":"yellow"')
    expect(fake.records()).toHaveLength(1)
    expectStagedRecords(fake, [2])
    // Nothing else happens to trigger delivery: the retry is scheduled by the failure itself.
    await fake.clock.advance(2000)
    await fake.clock.settle()
    expect(fake.appendCalls).toBeGreaterThanOrEqual(3)
    expectStagedRecords(fake, [2])
    expect(shown()).toHaveLength(1)
    await fake.clock.advance(4000)
    await fake.clock.settle()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2])
    expectStagedRecords(fake, [])
    expect(fake.statuses.at(-1)).toBeUndefined()
    // Delivery recovered, so the band is back to connected.
    expect(await drawn($)).toContain('"color":"green"')
    fake.expectClean()
  })

  function appendEnvelope(code: string, message = 'the server refused the record', extra: Record<string, unknown> = {}) {
    return { accept: 0, exitCode: 2, stdout: () => JSON.stringify({ error: { code, message, ...extra } }) }
  }

  test('a permanent append failure pauses with its reason instead of retrying a poison record', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    const calls = fake.appendCalls
    fake.appendFaults.push(appendEnvelope('invalid_record', 'the server refused the record', { retryable: false }))
    await $.tool.call(bash('poison', 'echo poison'))
    await fake.clock.settle()
    const paused = 'invalid_record'
    expect(fake.logs.filter((log) => log.includes(paused))).toHaveLength(1)
    // A live watch does not make delivery healthy: the band shows the pause, in red, with what to do.
    expect(await drawn($)).toContain(paused)
    expect(await drawn($)).toContain('"color":"red"')
    expectStagedRecords(fake, [2])
    await fake.clock.advance(120_000)
    // Neither remote activity nor a passing checkout check lifts a refusal of the record itself.
    fake.upsert(remoteItem('Remote edit'))
    await fake.clock.settle()
    await redraw($)
    expect((await $.prompt.submit(prompt('still refused'))).drop).toBeDefined()
    await $.tool.call(bash('queued-behind', 'echo behind'))
    expect(fake.appendCalls).toBe(calls + 1)
    expectStagedRecords(fake, [2, 3])
    // Reattaching resumes delivery, in order, once the cause is repaired.
    await fake.share($)
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2, 3])
    expect(await drawn($)).not.toContain(paused)
    expect(await drawn($)).toContain('"color":"green"')
    fake.expectClean()
  })

  test('a growing backlog reports the same reason once, and ending the session cancels and resets its retry', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    for (let attempt = 0; attempt < 3; attempt++) fake.appendFaults.push(appendEnvelope('failed', 'Delta did not confirm the record', { reason: 'sync', retryable: true }))
    await $.tool.call(bash('first', 'echo first'))
    await fake.clock.settle()
    await $.tool.call(bash('second', 'echo second'))
    await fake.clock.settle()
    await $.tool.call(bash('third', 'echo third'))
    await fake.clock.settle()
    // Each failure carries a larger batch, but the user sees the reason once.
    expect(fake.logs.filter((log) => log.includes('failed (sync): Delta did not confirm the record'))).toHaveLength(1)
    const calls = fake.appendCalls
    await $.session.end(sessionEnd(fake.session))
    await fake.clock.advance(120_000)
    expect(fake.appendCalls).toBe(calls)
    // A new session starts its backoff over rather than inheriting the old attempts.
    fake.appendFaults.push(appendEnvelope('failed', 'Delta did not confirm the record', { reason: 'sync', retryable: true }))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.appendCalls).toBe(calls + 1)
    await fake.clock.advance(2000)
    expect(fake.appendCalls).toBe(calls + 2)
    expectStagedRecords(fake, [])
    fake.expectClean()
  })

  test('a drain that fails after its session ended cannot revive the session with a pause', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    let release!: () => void
    fake.holdStatus = new Promise<void>((resolve) => { release = resolve })
    fake.commandFault = { operation: 'status', code: 'not_visible', message: 'denied' }
    await $.tool.call(bash('in-flight', 'echo in flight'))
    await fake.clock.settle()
    await $.session.end(sessionEnd(fake.session))
    release()
    await fake.clock.settle()
    fake.holdStatus = undefined
    fake.commandFault = undefined
    // A new session is not paused by the old one's refused check, so it delivers what was queued.
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2])
    fake.expectClean()
  })

  test('a share that fails before the watcher restarts leaves prompts accepted', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    fake.failGit = true
    expect(await fake.share($)).toContain('Git checkout')
    expect(fake.live()?.ready).toBe(true)
    expect((await $.prompt.submit(prompt('still connected'))).drop).toBeUndefined()
    fake.failGit = false
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    fake.expectClean()
  })

  test('a failure that lands after its session ended is neither retried nor shown', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    const calls = fake.appendCalls
    const logs = fake.logs.length
    let release!: () => void
    fake.holdAppend = new Promise<void>((resolve) => { release = resolve })
    fake.appendFaults.push(appendEnvelope('failed', 'Delta did not confirm the record', { reason: 'sync', retryable: true }))
    await $.tool.call(bash('in-flight', 'echo in flight'))
    await fake.clock.settle()
    await $.session.end(sessionEnd(fake.session))
    fake.holdAppend = undefined
    release()
    await fake.clock.settle()
    await fake.clock.advance(120_000)
    expect(fake.appendCalls).toBe(calls + 1)
    expect(fake.logs.slice(logs).some((log) => log.includes("Couldn't send") || log.includes('will be retried'))).toBe(false)
    expect(fake.statuses.some((status) => status?.includes('will be retried'))).toBe(false)
    fake.expectClean()
  })

  test('a lost acknowledgment replays identical records and accepts the advanced cumulative frontier', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one'), text('two')] })
    await $.session.start(sessionStart)
    fake.appendFaults.push({ throwAfterAccept: true })
    expect(await fake.share($)).toContain('failed')
    expect(fake.records()).toHaveLength(2)
    const accepted = new Map(fake.server.records)
    const pending = structuredClone((fake.store.get(`session:${fake.session}`) as any).pending)
    expect(pending.map((entry: any) => entry.sequence)).toEqual([1, 2])
    expect(pending.every((entry: any) => entry.files.every((path: string) => fake.files.has(path)))).toBe(true)
    expect(fake.server.shared).toBe(true)
    fake.messages = [text('changed after lost response')]
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual([])
    expect(fake.server.records).toEqual(accepted)
    expect(fake.exports).toBe(1)
    // Nothing remains pending: a later live row takes the next sequence.
    await $.tool.call(bash('after-replay', 'echo after replay'))
    await fake.clock.settle()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2, 3])
    fake.expectClean()
  })

  for (const operation of ['attach']) test(`failed ${operation} preserves the staged manifest for retry`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one'), text('two')] })
    await $.session.start(sessionStart)
    fake.commandFault = { operation, message: `${operation} unavailable` }
    expect(await fake.share($)).toContain(`${operation} unavailable`)
    const manifest = fake.store.get(`session:${fake.session}`) as any
    expect(manifest.snapshot).toBe(true)
    expect(manifest.next).toBe(3)
    expectStagedRecords(fake, [1, 2])
    expect(manifest.thread).toBe(operation === 'create' ? undefined : fake.threadId)
    const staged = structuredClone(manifest.pending)
    expect(fake.server.thread).toBe(operation === 'create' ? undefined : fake.threadId)
    if (operation === 'share') expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    else expect(fake.server.mount).toBeUndefined()
    expect(fake.records()).toEqual([])
    expect(fake.watches).toEqual([])
    expect(fake.server.shared).toBe(false)
    expect((await $.prompt.submit(prompt('unsafe'))).drop).toBeDefined()
    expect(fake.entered).toEqual([])
    fake.messages = [text('changed export must not be imported')]
    fake.commandFault = undefined
    const commands = fake.operations().length
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expectNoSetupCommands(fake, commands)
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual(staged)
    expect(fake.server.shared).toBe(false)
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.exports).toBe(1)
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2])
    expect(JSON.stringify(fake.records())).not.toContain('changed export')
    fake.expectClean()
  })

  for (const [operation, failure, exitCode] of [
    ['attach', 'response', 1], ['attach', 'receipt save', undefined],
    ['share', 'response', undefined], ['share', 'receipt save', undefined],
  ] as const) test(`lost ${operation} ${failure}${exitCode ? ` with exit ${exitCode}` : ''} preserves completed setup for explicit retry`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    if (failure === 'response') fake.commandFault = { operation, message: 'setup receipt lost', after: true, exitCode }
    else fake.failStoreSet = () => operation === 'attach' ? !!fake.server.mount : fake.server.shared
    expect(await fake.share($)).toContain(failure === 'response' ? 'setup receipt lost' : 'failed')
    const manifest = fake.store.get(`session:${fake.session}`) as any
    expect(manifest.thread).toBe(fake.threadId)
    expect(manifest.checkout).toBe(operation === 'attach' ? undefined : CHECKOUT)
    expect(manifest.url).toBeUndefined()
    expectStagedRecords(fake, [1])
    expect(fake.server.checkout).toBe('attached')
    const mount = { ...fake.server.mount }
    expect(fake.server.shared).toBe(operation === 'share')
    expect(fake.records()).toEqual([])
    fake.commandFault = undefined
    fake.failStoreSet = false
    fake.messages = [text('changed export must not replace staged content')]
    const commands = fake.operations().length
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expectNoSetupCommands(fake, commands)
    expect(fake.server.shared).toBe(operation === 'share')
    expect(fake.server.mount).toEqual(mount)
    if (operation === 'attach') {
      expect((fake.store.get(`session:${fake.session}`) as any).checkout).toBeUndefined()
      expect(fake.records()).toEqual([])
    }
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.server.mount).toEqual(mount)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({
      thread: fake.threadId, checkout: CHECKOUT, pending: [],
    })
    expect(fake.server.shared).toBe(true)
    expect(fake.exports).toBe(1)
    expect(fake.records()).toMatchObject([{ sequence: 1, update: { content: [{ text: 'one' }] } }])
    fake.expectClean()
  })

  for (const patch of [{ reference: ' ' }]) test(`invalid attachment receipt ${JSON.stringify(patch)} keeps the binding and outbox`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    fake.attachmentPatch = patch
    expect(await fake.share($)).toContain('Invalid checkout attachment receipt')
    const manifest = fake.store.get(`session:${fake.session}`) as any
    expect(manifest.thread).toBe(fake.threadId)
    expect(manifest.checkout).toBeUndefined()
    expectStagedRecords(fake, [1])
    expect(fake.server.shared).toBe(false)
    expect(fake.operations()).not.toContain('share')
    expect(fake.records()).toEqual([])
    expect((await $.prompt.submit(prompt('unsafe receipt'))).drop).toBeDefined()
    expect(fake.entered).toEqual([])
    fake.attachmentPatch = undefined
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ checkout: CHECKOUT, pending: [] })
    expect(fake.exports).toBe(1)
    expect(fake.records()).toHaveLength(1)
    fake.expectClean()
  })

  for (const failure of ['response', 'binding write', 'local binding']) test(`lost creation ${failure} retries the same source identity`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    if (failure === 'binding write') fake.failStoreSet = () => !!fake.server.thread
    else fake.commandFault = { operation: 'create', message: 'lost response', after: true }
    expect(await fake.share($)).toContain('failed')
    expect(fake.server.thread).toBe(fake.threadId)
    expect((fake.store.get(`session:${fake.session}`) as any).thread).toBeUndefined()
    expect(fake.server.mount).toBeUndefined()
    expect(fake.server.shared).toBe(false)
    expect(fake.operations().some((operation) => ['attach', 'share', 'append'].includes(operation!))).toBe(false)
    fake.commandFault = undefined
    fake.failStoreSet = false
    const commands = fake.operations().length
    await $.session.end(sessionEnd(fake.session))
    if (failure === 'local binding') fake.store.delete(`session:${fake.session}`)
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expectNoSetupCommands(fake, commands)
    expect(fake.server.thread).toBe(fake.threadId)
    expect(fake.server.shared).toBe(false)
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ thread: fake.threadId, pending: [] })
    expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    expect(fake.exports).toBe(failure === 'local binding' ? 2 : 1)
    expect(fake.records()).toHaveLength(1)
    fake.expectClean()
  })

  for (const patch of [{ thread_id: 'other-thread' }])
    test(`invalid publication receipt ${JSON.stringify(patch)} preserves setup and staged records`, async ($, on) => {
      const fake = fakeThreads(on, { messages: [text('one')] })
      await $.session.start(sessionStart)
      fake.publicationPatch = patch
      expect(await fake.share($)).toContain('Invalid publication receipt')
      const binding = fake.store.get(`session:${fake.session}`) as any
      expect(binding).toMatchObject({ thread: fake.threadId, checkout: CHECKOUT, snapshot: true, next: 2 })
      expect(binding.url).toBeUndefined()
      expectStagedRecords(fake, [1])
      expect(fake.server.shared).toBe(true)
      const mount = { ...fake.server.mount }
      expect(fake.records()).toEqual([])
      fake.publicationPatch = undefined
      expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
      expect(fake.server.mount).toEqual(mount)
      expect(fake.store.get(`session:${fake.session}`)).toMatchObject({
        thread: fake.threadId, url: `https://delta.dev/join/${fake.shareId}`, pending: [],
      })
      expect(fake.records()).toMatchObject([{ sequence: 1, update: { content: [{ text: 'one' }] } }])
      expect(fake.exports).toBe(1)
      fake.expectClean()
    })

  test('a missing session binding cannot adopt a nonempty producer or import a regenerated suffix', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one'), text('two')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    const ledger = new Map(fake.server.records)
    const mount = { ...fake.server.mount }
    const commands = fake.operations().length
    // Lose the actual local identity and receipts, not merely change the remote frontier.
    fake.store.delete(`session:${fake.session}`)
    fake.messages = [text('one'), text('two'), text('regenerated suffix must not be imported')]
    await $.session.start(sessionStart)
    expect(await fake.share($)).toMatch(/Restore.*producer state|start a new Claude session/i)
    expect(fake.operations().slice(commands).some((operation) => ['attach', 'share', 'append'].includes(operation!))).toBe(false)
    expect((fake.store.get(`session:${fake.session}`) as any).thread).toBeUndefined()
    expect(fake.server.records).toEqual(ledger)
    expect(fake.server.mount).toEqual(mount)
    expect(fake.server.shared).toBe(true)
    const staged = structuredClone((fake.store.get(`session:${fake.session}`) as any).pending)
    expect((await $.prompt.submit(prompt('unsafe after reset'))).drop).toBeDefined()
    // The newly saved immutable plan still is not evidence of the lost identity.
    expect(await fake.share($)).toMatch(/Restore.*producer state|start a new Claude session/i)
    expect(fake.exports).toBe(2)
    expect(fake.operations().slice(commands).some((operation) => ['attach', 'share', 'append'].includes(operation!))).toBe(false)
    expect(fake.server.records).toEqual(ledger)
    expect(fake.server.mount).toEqual(mount)
    expect(fake.server.shared).toBe(true)
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual(staged)
    fake.expectClean()
  })

  for (const [name, change] of [
    ['lost acknowledged history', (fake: ReturnType<typeof fakeThreads>) => { fake.server.next = 1 }],
  ] as const) test(`readiness with ${name} fails closed without reset or reimport`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one'), text('two')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    change(fake)
    const appends = fake.appendCalls
    const ledger = new Map(fake.server.records)
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await $.tool.call(bash('queued', 'echo queued while mismatched'))
    await fake.clock.settle()
    expect(fake.appendCalls).toBe(appends)
    expect(fake.server.records).toEqual(ledger)
    expect(fake.exports).toBe(1)
    const submitted = await $.prompt.submit(prompt('continue'))
    expect(submitted.drop).toBeDefined()
    expect(fake.entered).toEqual([])
    // Explicit sharing is not a reset either.
    expect(await fake.share($)).toContain('failed')
    expect(fake.appendCalls).toBe(appends)
    expect(fake.exports).toBe(1)
    fake.expectClean()
  })

  for (const state of ['attached', 'unshared'] as const) test(`resume observes ${state} setup without publishing or reattaching`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    expect(fake.server.checkout).toBe('attached')
    if (state === 'unshared') fake.server.shared = false
    else fake.server.checkout = state
    const mount = { ...fake.server.mount }
    const commands = fake.operations().length
    await $.session.start(sessionStart)
    await fake.clock.settle()
    const submitted = await $.prompt.submit(prompt('continue after resume'))
    if (state === 'attached') {
      expect(fake.live()?.ready).toBe(true)
      expect(submitted.drop).toBeUndefined()
    } else {
      expect(submitted.drop).toBeDefined()
      expect(fake.entered).toEqual([])
    }
    await $.tool.call(bash('after-resume', 'echo after resume'))
    await fake.clock.settle()
    expectNoSetupCommands(fake, commands)
    expect(fake.server.mount).toEqual(mount)
    expect(fake.server.shared).toBe(state !== 'unshared')
    expect(fake.server.checkout).toBe(state === 'unshared' ? 'attached' : state)
    expect(fake.records().map((record) => record.sequence)).toEqual(state === 'attached' ? [1, 2] : [1])
    expect((fake.store.get(`session:${fake.session}`) as any).pending.map((entry: any) => entry.sequence))
      .toEqual(state === 'attached' ? [] : [2])
    fake.messages = [text('changed export must not be imported')]
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.server.checkout).toBe('attached')
    expect(fake.server.mount).toEqual(mount)
    expect(fake.server.shared).toBe(true)
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2])
    expect(fake.records()[1]?.update).toMatchObject({ toolCallId: 'after-resume' })
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual([])
    expect(fake.exports).toBe(1)
    fake.expectClean()
  })

  test('resume checks authenticated denied access without deriving it from a URL', async ($, on) => {
      const fake = fakeThreads(on, { messages: [text('one')] })
      await $.session.start(sessionStart)
      expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
      await $.session.end(sessionEnd(fake.session))
      const commands = fake.operations().length
      fake.statusPatch = { access: { state: 'granted', is_owner: null } }
      fake.commandFault = { operation: 'status', code: 'not_visible', reason: 'access_denied', message: 'Cannot verify authenticated access' }
      await $.session.start(sessionStart)
      await fake.clock.settle()
      expect((await $.prompt.submit(prompt('participate'))).drop).toBeDefined()
      await $.tool.call(bash('access-checked', 'echo local'))
      await fake.clock.settle()
      expect(fake.records()).toHaveLength(1)
      expectNoSetupCommands(fake, commands)
      expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ thread: fake.threadId })
      fake.expectClean()
    })

  test('legacy checkout adoption is unique within the thread and preserves the pending producer frontier', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('pending')] })
    await $.session.start(sessionStart)
    fake.appendOffline = true
    expect(await fake.share($)).toContain('failed')
    await $.session.end(sessionEnd(fake.session))
    const saved = structuredClone(fake.store.get(`session:${fake.session}`) as any)
    delete saved.checkoutReference
    fake.store.set(`session:${fake.session}`, saved)
    const worktrees = [
      { reference: 'other#t=0', checkouts: [
        { directory: '/other', state: 'attached' }, { directory: CHECKOUT, state: 'inactive' },
      ] },
      ...fake.state().worktrees.items,
    ]
    fake.statusPatch = { worktrees: { status: 'available', items: [...worktrees].reverse() } }
    let release!: () => void
    fake.holdAppend = new Promise<void>((resolve) => { release = resolve })
    fake.appendOffline = false
    const commands = fake.operations().length
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.store.get(`session:${fake.session}`)).toEqual({
      ...saved, checkoutReference: fake.server.mount!.reference,
    })
    expect(fake.records()).toEqual([])
    expectNoSetupCommands(fake, commands)
    release()
    await fake.clock.settle()
    expect(fake.records()).toMatchObject([{ sequence: 1, update: { content: [{ text: 'pending' }] } }])
    fake.expectClean()
  })

  test('unavailable inspection pauses participation and preserves binding and pending files across resume', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    const original = structuredClone(fake.store.get(`session:${fake.session}`) as any)
    const commands = fake.operations().length
    const worktrees = { status: 'unavailable',
      error: { code: 'failed', reason: 'storage', message: 'Attachment storage cannot be read' } }
    fake.statusPatch = { worktrees }
    await $.tool.call(bash('inspection-pending', 'echo queued'))
    await fake.clock.settle()
    const saved = structuredClone(fake.store.get(`session:${fake.session}`) as any)
    expect(saved).toMatchObject({
      thread: original.thread, checkout: original.checkout, checkoutReference: original.checkoutReference,
      next: original.next + 1, pending: [{ sequence: original.next }],
    })
    const files = new Map<string, string>(saved.pending[0].files.map((path: string) => [path, fake.files.get(path)]))
    expect([...files.values()].join('')).toContain('inspection-pending')
    expect((await $.prompt.submit(prompt('unsafe inspection'))).drop).toBeDefined()
    expect(fake.logs.some((log) => log.includes(worktrees.error.code))).toBe(true)
    expect(fake.records()).toHaveLength(1)
    expect(fake.store.get(`session:${fake.session}`)).toEqual(saved)
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect((await $.prompt.submit(prompt('still unavailable'))).drop).toBeDefined()
    expect(fake.store.get(`session:${fake.session}`)).toEqual(saved)
    for (const [path, contents] of files) expect(fake.files.get(path)).toBe(contents)
    expectNoSetupCommands(fake, commands)
    expect(fake.records()).toHaveLength(1)
    await $.session.end(sessionEnd(fake.session))
    fake.statusPatch = undefined
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.records()).toHaveLength(2)
    expect(fake.server.records.get(original.next)?.line + '\n').toBe([...files.values()].join(''))
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual([])
    fake.expectClean()
  })

  for (const code of ['app_unavailable']) test(`a transient ${code} failure is surfaced and retried instead of latching the pause`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    fake.commandFault = { operation: 'status', code, message: 'Cannot reach Delta' }
    await $.tool.call(bash('while-offline', 'echo queued'))
    await fake.clock.settle()
    expect(fake.records()).toHaveLength(1)
    expectStagedRecords(fake, [2])
    expect(await drawn($)).toContain(code)
    fake.commandFault = undefined
    // No watcher refresh intervenes: the next delivery attempt alone must recover.
    await $.tool.call(bash('after-recovery', 'echo later'))
    await fake.clock.settle()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2, 3])
    expectStagedRecords(fake, [])
    expect((await $.prompt.submit(prompt('proceeds'))).drop).toBeUndefined()
    fake.expectClean()
  })

  test('a detached checkout pauses delivery until a later successful check lifts the pause it set', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    fake.server.checkout = 'detached'
    await $.tool.call(bash('while-detached', 'echo queued'))
    await fake.clock.settle()
    expectStagedRecords(fake, [2])
    fake.server.checkout = 'attached'
    // The pause is latched: reattachment alone does not restart delivery.
    await $.tool.call(bash('still-paused', 'echo queued'))
    await fake.clock.settle()
    expectStagedRecords(fake, [2, 3])
    // A prompt verifies the checkout again, which lifts the pause that a failed check set.
    expect((await $.prompt.submit(prompt('after reattachment'))).drop).toBeUndefined()
    await $.tool.call(bash('resumed', 'echo delivered'))
    await fake.clock.settle()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2, 3, 4])
    expectStagedRecords(fake, [])
    fake.expectClean()
  })

  test('reference-bound checkout selection cannot silently switch or adopt ambiguous inventories', async ($, on) => {
      const fake = fakeThreads(on, { messages: [text('one')] })
      await $.session.start(sessionStart)
      await fake.share($)
      await $.session.end(sessionEnd(fake.session))
      const saved = structuredClone(fake.store.get(`session:${fake.session}`) as any)
      fake.store.set(`session:${fake.session}`, saved)
      const other = { reference: 'different#t=0', checkouts: [{ directory: CHECKOUT, state: 'attached' }] }
      fake.statusPatch = { worktrees: { status: 'available', items: [other] } }
      const commands = fake.operations().length
      await $.session.start(sessionStart)
      await fake.clock.settle()
      expect((await $.prompt.submit(prompt('unsafe'))).drop).toBeDefined()
      expect(fake.store.get(`session:${fake.session}`)).toEqual(saved)
      expect(fake.records()).toHaveLength(1)
      expectNoSetupCommands(fake, commands)
      fake.attachmentPatch = { reference: other.reference }
      await fake.share($)
      expect(fake.store.get(`session:${fake.session}`)).toEqual(saved)
      fake.expectClean()
    })

  test('a large status bypasses short-command capture', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    // Fields the plugin does not read can still make the status larger than process.run captures.
    fake.statusPatch = { diagnostics: 'x'.repeat(4 * 1024 * 1024) }
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect((await $.prompt.submit(prompt('large diagnostics'))).drop).toBeUndefined()
    await $.tool.call(bash('large-status', 'echo local'))
    await fake.clock.settle()
    expect(fake.records()).toHaveLength(2)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({
      thread: fake.threadId, checkoutReference: fake.server.mount!.reference, next: 3, pending: [],
    })
    fake.expectClean()
  })

  test('reconnection retries with capped backoff and session end stops the idle child', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    const first = fake.watches.length
    fake.onWatch = (watch, index) => {
      const attempt = index - first
      const view = remoteItem(attempt === 0 ? 'Earlier view' : 'Recovered view', { id: 'view' })
      fake.server.items.set(view.id, view)
      // The last connection stays idle, never live, so the band's grace runs out.
      if (attempt >= 2 || !watch.observe()) return
      // The second connection stays up until the test drops it.
      if (attempt === 0) watch.exit(1)
    }
    const attempts = () => fake.watches.length - first
    await $.session.start(sessionStart)
    await fake.clock.settle()
    // The first watch went live before it dropped, so the band waits out its grace.
    expect(await drawn($)).toContain(LIVE)
    await fake.clock.advance(999)
    expect(attempts()).toBe(1)
    await fake.clock.advance(1)
    expect(attempts()).toBe(2)
    expect(await drawn($)).toContain(LIVE)
    // A live watch that drops looks live through its grace, reconnecting attempts included.
    fake.watches.at(-1)?.exit(1)
    await fake.clock.settle()
    expect(await drawn($)).toContain(LIVE)
    const before = attempts()
    await fake.clock.advance(1999)
    expect(attempts()).toBe(before)
    await fake.clock.advance(1)
    expect(attempts()).toBeGreaterThan(before)
    expect(await drawn($)).toContain(LIVE)
    // Past the grace, counted from the drop, the band admits to reconnecting.
    await fake.clock.advance(2000)
    expect(await drawn($)).toContain(PENDING)
    const idle = fake.watches.at(-1)!
    expect(idle.closed).toBe(false)
    await $.session.end(sessionEnd(fake.session))
    await fake.clock.settle()
    expect(idle.closed).toBe(true)
    const ended = attempts()
    await fake.clock.advance(120_000)
    expect(attempts()).toBe(ended)
    fake.expectClean()
  })

  for (const nth of [1, 2]) test(`ending during startup store read ${nth} cannot start the watcher`, async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    let reads = 0
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    fake.holdStoreGet = () => {
      if (++reads !== nth) return undefined
      entered()
      return held
    }
    const before = fake.watches.length
    const starting = $.session.start(sessionStart)
    await waiting
    await $.session.end(sessionEnd(fake.session))
    release()
    await starting
    await fake.clock.advance(60_000)
    expect(fake.watches.slice(before).filter((watch) => !watch.closed)).toEqual([])
    expect(fake.watches.length - before).toBe(0)
    fake.expectClean()
  })

  for (const target of ['watch', 'status'] as const) test(`ending during ${target} CLI resolution never spawns the obsolete command`, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    const contracts = fake.contractChecks
    const watches = fake.watches.length
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    fake.holdCliResolution = () => {
      if (fake.contractChecks === contracts) return
      if (target === 'status' && fake.watches.length === watches) return
      entered()
      return held
    }
    const starting = $.session.start(sessionStart)
    await waiting
    const before = fake.commands.length
    await $.session.end(sessionEnd(fake.session))
    fake.holdCliResolution = undefined
    release()
    await starting
    await fake.clock.settle()
    expect(fake.commands.slice(before)).toEqual([])
    expect(fake.watches.length).toBe(watches + (target === 'status' ? 1 : 0))
    expect(fake.watches.filter((watch) => !watch.closed)).toEqual([])
    fake.expectClean()
  })

  test('outbox collection follows durable acknowledgments and never blocks delivery', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    const directory = `${CONFIG}/delta-plugin/outbox/${fake.session}`
    fake.files.set(`${directory}/notes.json`, 'not a record')
    await $.session.start(sessionStart)
    fake.failRemoval = true
    await fake.share($)
    await fake.clock.settle()
    const first = [...fake.files.keys()].filter((path) => /\/1-\d+\.json$/.test(path))
    expect(first.length).toBeGreaterThan(0)
    expect(first.every((path) => fake.files.has(path))).toBe(true)
    expect(fake.logs.some((log) => log.includes('could not be removed'))).toBe(true)

    // Sequence 2 is staged but its delivery fails, so it must survive collection.
    fake.failRemoval = false
    fake.appendOffline = true
    await $.tool.call(bash('pending', 'echo pending'))
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    const pending = [...fake.files.keys()].filter((path) => /\/2-\d+\.json$/.test(path))
    expect(first.some((path) => fake.files.has(path))).toBe(false)
    expect(pending.length).toBeGreaterThan(0)
    expect(pending.every((path) => fake.files.has(path))).toBe(true)
    expect(fake.files.get(`${directory}/notes.json`)).toBe('not a record')

    // Delivery completes while the collector is blocked and failing.
    fake.failRemoval = true
    fake.appendOffline = false
    let releaseListing!: () => void
    fake.holdListing = new Promise<void>((resolve) => { releaseListing = resolve })
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2])
    releaseListing()
    fake.holdListing = undefined
    await fake.clock.settle()
    fake.failRemoval = false
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect([...fake.files.keys()]).toEqual([`${directory}/notes.json`])
    fake.expectClean()
  })

  test('an acknowledgment that cannot be saved keeps its record and replays it', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await fake.clock.settle()
    // Staging succeeds; only saving the server's acknowledgment fails.
    fake.failStoreSet = () => fake.server.records.has(2)
    await $.tool.call(bash('unsaved-ack', 'echo row'))
    await fake.clock.settle()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2])
    const second = [...fake.files.keys()].filter((path) => /\/2-\d+\.json$/.test(path))
    expect(second.length).toBeGreaterThan(0)
    fake.failStoreSet = false
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    await $.tool.call(bash('after', 'echo after'))
    await fake.clock.settle()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2, 3])
    fake.expectClean()
  })

  test('an out-of-range recording contract refuses to share, and a later retry re-checks', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    await $.session.start(sessionStart)
    fake.contractRange = { min: 0, max: 0 }
    expect(await fake.share($)).toContain('Update Delta')
    // Nothing was created, attached, published, or imported, and no record was appended.
    expect(fake.server.thread).toBeUndefined()
    expect(fake.server.mount).toBeUndefined()
    expect(fake.server.shared).toBe(false)
    expect(fake.records()).toEqual([])
    expect(fake.store.get(`session:${fake.session}`)).toBeUndefined()
    expect([...fake.files.keys()]).toEqual([])
    expect(fake.contractChecks).toBe(1)
    // The refusal is not remembered: an updated Delta shares the same session.
    fake.contractRange = undefined
    expect(await fake.share($)).toBe(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.contractChecks).toBe(2)
    fake.expectClean()
  })

  test('a CLI newer than this plugin asks the person to update the plugin', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    await $.session.start(sessionStart)
    fake.contractRange = { min: 3, max: 4 }
    expect(await fake.share($)).toContain('Update the Delta plugin')
    expect(fake.server.thread).toBeUndefined()
    expect(fake.records()).toEqual([])
    fake.expectClean()
  })

  test('a shared session records each new title once, a rename over Claude\'s own', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    fake.contractRange = { min: 1, max: 2 }
    await $.session.start(sessionStart)
    await fake.share($)
    const transcript = '/config/projects/repo/session.jsonl'
    const titles = () => fake.records().flatMap((record) =>
      record.update?.sessionUpdate === 'session_info_update' ? [record.update.title] : [])
    const stop = async (...lines: object[]) => {
      fake.files.set(transcript, [...(fake.files.get(transcript) ?? '').split('\n').filter(Boolean),
        ...lines.map((line) => JSON.stringify(line))].join('\n') + '\n')
      await $.classic.Stop({ transcript_path: transcript, stop_hook_active: false } as any)
      await fake.clock.settle()
    }
    // No title yet: nothing is recorded.
    await stop({ type: 'user', message: { role: 'user', content: 'hello' } })
    expect(titles()).toEqual([])
    await stop({ type: 'ai-title', aiTitle: 'Fix the parser', sessionId: fake.session })
    expect(titles()).toEqual(['Fix the parser'])
    // The same title at a later turn's end is not recorded again.
    await stop()
    expect(titles()).toEqual(['Fix the parser'])
    // A rename wins over a title Claude chooses after it.
    await stop({ type: 'custom-title', customTitle: 'Parser rewrite', sessionId: fake.session },
      { type: 'ai-title', aiTitle: 'Something else', sessionId: fake.session })
    expect(titles()).toEqual(['Fix the parser', 'Parser rewrite'])
    expect(fake.store.get(`session:${fake.session}`).title).toBe('Parser rewrite')
    // Each read starts where the last one ended, never at the start of the file again.
    const reads = fake.commands.filter((argv) => argv[0] === 'tail').map((argv) => Number(argv[2]!.slice(1)))
    expect(reads[0]).toBe(1)
    expect(reads.slice(1).every((start, index) => start > reads[index]!)).toBe(true)
    fake.expectClean()
  })

  test('a title still arrives when reading from an offset fails, and a missing transcript fails nothing', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    fake.contractRange = { min: 1, max: 2 }
    await $.session.start(sessionStart)
    await fake.share($)
    const transcript = '/config/projects/repo/session.jsonl'
    const titles = () => fake.records().flatMap((record) =>
      record.update?.sessionUpdate === 'session_info_update' ? [record.update.title] : [])
    const stop = async (path = transcript) => {
      await $.classic.Stop({ transcript_path: path, stop_hook_active: false } as any)
      await fake.clock.settle()
    }
    // Neither a missing transcript nor a missing reader pauses sharing or says anything.
    await stop('/config/projects/repo/missing.jsonl')
    fake.failTranscriptRead = true
    fake.files.set(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Read whole', sessionId: fake.session }) + '\n')
    await stop()
    expect(titles()).toEqual(['Read whole'])
    // The session reads its transcript whole from then on, without trying the offset read again.
    const tries = fake.commands.filter((argv) => argv[0] === 'tail').length
    fake.files.set(transcript, fake.files.get(transcript)! + JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' }) + '\n')
    await stop()
    expect(titles()).toEqual(['Read whole', 'Renamed'])
    expect(fake.commands.filter((argv) => argv[0] === 'tail')).toHaveLength(tries)
    expect(fake.logs.join('\n')).not.toContain('title')
    expect((await $.prompt.submit(prompt('still sharing'))).drop).toBeUndefined()
    fake.expectClean()
  })

  test('a CLI whose contract predates titles is never sent one', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    fake.contractRange = { min: 1, max: 1 }
    await $.session.start(sessionStart)
    await fake.share($)
    const transcript = '/config/projects/repo/session.jsonl'
    fake.files.set(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the parser', sessionId: fake.session }) + '\n')
    await $.classic.Stop({ transcript_path: transcript, stop_hook_active: false } as any)
    await fake.clock.settle()
    expect(fake.records().some((record) => record.update?.sessionUpdate === 'session_info_update')).toBe(false)
    expect(fake.commands.some((argv) => argv[0] === 'tail')).toBe(false)
    fake.expectClean()
  })

  test('a CLI that predates thread contract is treated as too old', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('initial')] })
    await $.session.start(sessionStart)
    fake.contractUnknownSubcommand = true
    expect(await fake.share($)).toContain('Update Delta')
    expect(fake.server.thread).toBeUndefined()
    expect(fake.records()).toEqual([])
    fake.expectClean()
  })

  test('the recording contract is checked once per session, not per command', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    const url = await fake.share($)
    expect(url).toBe(`https://delta.dev/join/${fake.shareId}`)
    // One check covers create, attach, and share, and a repeat share reuses the verdict.
    expect(fake.contractChecks).toBe(1)
    expect(await fake.share($)).toBe(url)
    expect(fake.contractChecks).toBe(1)
    fake.expectClean()
  })

  test('a resumed session refuses to participate against an incompatible contract', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    const binding = structuredClone(fake.store.get(`session:${fake.session}`))
    await $.session.end(sessionEnd(fake.session))
    const watches = fake.watches.length
    // A resumed session re-checks; a Delta that now speaks only a newer contract blocks it.
    fake.contractRange = { min: 3, max: 4 }
    await $.session.start(sessionStart)
    expect(fake.store.get(`session:${fake.session}`)).toEqual(binding)
    expect(fake.watches.length).toBe(watches)
    expect(await drawn($)).toContain('Update the Delta plugin')
    expect(fake.logs.join('\n')).toContain('Update the Delta plugin')
    expect((await $.prompt.submit(prompt('blocked'))).drop).toContain('Update the Delta plugin')
    fake.expectClean()
  })
})

describe('remote activity', () => {
  test('land activity draws from snapshots and live updates without starting a turn or echoing to Delta', async ($, on) => {
    const fake = fakeThreads(on)
    const createdText = 'Land changes: \n<subthread-event kind="land" event="created" note="Informational, not a task.">\n</subthread-event>'
    const created = remoteItem(createdText, {
      id: 'land-start', kind: 'subthread_event',
      content: { text: createdText, thread_id: 'land-child', event: 'created' },
    })
    fake.server.items.set(created.id, created)
    await $.session.start(sessionStart)
    await fake.share($)
    await fake.clock.settle()
    await drawReady($, fake)
    expectOfferedItems(fake, ['land-start'])
    const startTree = JSON.stringify(await $.ui.render(commandOutput('show land-start', '.')))
    expect(startTree).toContain('Land changes')
    expect(startTree).not.toContain('<subthread-event')
    expect(JSON.stringify(fake.stored)).toContain('Informational, not a task.')

    fake.upsert(remoteItem('Landed: Land Changes\nmain 2d867ce6c CI passed', {
      id: 'land-end', kind: 'subthread_event',
      content: { text: 'Landed: Land Changes\nmain 2d867ce6c CI passed', thread_id: 'land-child', event: 'landed' },
    }))
    await fake.clock.settle()
    await drawReady($, fake)
    expectOfferedItems(fake, ['land-start', 'land-end'])
    const endTree = JSON.stringify(await $.ui.render(commandOutput('show land-end', '.')))
    for (const text of ['Landed: Land Changes', 'main 2d867ce6c CI passed']) expect(endTree).toContain(text)
    expect(fake.entered).toEqual([])
    expect(JSON.stringify(fake.records())).not.toContain('land-child')

    fake.live()!.exit(1)
    await fake.clock.advance(1000)
    await drawReady($, fake)
    expectOfferedItems(fake, ['land-start', 'land-end'])
    fake.expectClean()
  })

  test('a snapshot draws completed messages without waiting for children or starting a turn', async ($, on) => {
    const fake = fakeThreads(on)
    fake.holdChildren = new Promise<void>(() => {})
    const claude = { user_id: null, name: 'Claude' }
    for (const item of [
      remoteItem('Earlier question', { id: 'a' }),
      remoteItem('Earlier answer', { id: 'b', kind: 'agent_message', author: claude }),
      remoteItem('Still typing', { id: 'c', kind: 'agent_message', author: claude, open: true }),
      remoteItem('mystery', { id: 'd', kind: 'unknown' }),
    ]) fake.server.items.set(item.id, item)
    await $.session.start(sessionStart)
    await fake.share($)
    await fake.clock.settle()
    await drawReady($, fake)
    expectOfferedItems(fake, ['a', 'b'])
    // A message reaches the person and Claude through its command output row, not as a notice.
    expect(fake.logs.some((log) => log.startsWith('Ada:') || log.startsWith('Claude:'))).toBe(false)
    expect(fake.entered).toEqual([])
    // The rows reach Claude's transcript, never Delta again.
    expect(JSON.stringify(fake.records())).not.toContain('Earlier question')
    expect((await $.prompt.submit(prompt('continue'))).drop).toBeUndefined()
    expect(fake.entered.at(-1)?.context).toBeUndefined()
    expect(fake.rows).toHaveLength(2)
    fake.expectClean()
  })

  test('a streaming message draws one command row when it completes, in arrival order', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    const claude = { user_id: null, name: 'Claude' }
    fake.upsert(remoteItem('Working on', { id: 's', kind: 'agent_message', author: claude, open: true }))
    fake.stream('s', ' the parser')
    await fake.clock.settle()
    await drawReady($, fake)
    expect(fake.rows).toEqual([])
    fake.upsert({ ...fake.server.items.get('s')!, content: { text: 'Working on the parser. Done.' }, open: false })
    await fake.clock.settle()
    await drawReady($, fake)
    expectOfferedItems(fake, ['s'])
    fake.upsert(remoteItem('Can you check the tests?\nThey fail on CI.', { id: 'q' }))
    await fake.clock.settle()
    await drawReady($, fake)
    expectOfferedItems(fake, ['s', 'q'])
    expect(fake.entered).toEqual([])
    fake.expectClean()
  })


  test('a restart repeats no rows from the saved record and corrects what changed while away', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    const keep = remoteItem('Keep me', { id: 'a' })
    const change = remoteItem('Change me', { id: 'b' })
    // What an earlier process recorded after adding these rows; the test host cannot keep rows itself.
    fake.store.set(`appended:${fake.session}`, { thread: fake.threadId, items: {
      a: await itemFingerprint(keep), b: await itemFingerprint(change), c: await itemFingerprint(remoteItem('Remove me')),
    } })
    fake.server.items.set('a', keep)
    fake.server.items.set('b', { ...change, content: { text: 'Changed while away' } })
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.live()?.ready).toBe(true)
    expectOfferedItems(fake, ['b', 'c'])
    // Reconnecting sends the same snapshot again.
    fake.live()!.exit(1)
    await fake.clock.advance(1000)
    expect(fake.live()?.ready).toBe(true)
    expect(fake.rows.filter((row) => row.includes('item a'))).toEqual([])
    fake.expectClean()
  })

  test('a remote agent\'s thinking is announced when it completes, but never reaches Claude', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    const claude = { user_id: null, name: 'Claude' }
    fake.upsert(remoteItem('Weighing', { id: 'thought', kind: 'agent_thought', author: claude, open: true }))
    fake.stream('thought', ' two approaches\nso far')
    await fake.clock.settle()
    fake.upsert({ ...fake.server.items.get('thought')!, open: false })
    // A later re-send of the completed thought is not announced again.
    fake.upsert({ ...fake.server.items.get('thought')!, after_id: 'moved' })
    await fake.clock.settle()
    // The person sees the whole thought, labelled, one entry per paragraph, and never Claude.
    expect(fake.logs.filter((log) => log === 'Claude (thinking)')).toHaveLength(1)
    expect(fake.logs.slice(-2)).toEqual(['Claude (thinking)', 'Weighing two approaches so far'])
    expect(fake.rows).toEqual([])
    fake.expectClean()
  })

  test('the internal show form is only answered for the plugin itself; typing it gets the usage text', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.upsert(remoteItem('# Title\n\nSecret body', { id: 'm' }))
    await fake.clock.settle()
    const typed = await $.command.run(typedDelta('show m'))
    expect(typed.text).toContain('/delta')
    // Neither the plugin nor the test host answers an item id the person typed.
    expect(typed.text).not.toContain('Secret body')
    expect(fake.commandRuns).toEqual([])
    fake.expectClean()
  })

  test('the command output row draws its author and the item\'s own markdown', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.upsert(remoteItem('# Title\n\n**bold** and `code`', { id: 'm' }))
    await fake.clock.settle()
    await drawReady($, fake)
    const tree = JSON.stringify(await $.ui.render(commandOutput('show m', "delta: what the engine prefixes")))
    expect(tree).toContain('"Ada"')
    expect(tree).toContain('"bold":true')
    expect(tree).toContain('(person)')
    // The body is the item's own markdown, not the engine-prefixed row text.
    expect(tree).toContain('Markdown')
    expect(tree).toContain('# Title')
    expect(tree).not.toContain('what the engine prefixes')
    // Another agent's message is labelled apart from a person's, its author in the color the band gives them.
    fake.upsert(remoteItem('Reply', { id: 'r', kind: 'agent_message', author: { user_id: null, name: 'Claude' } }))
    await fake.clock.settle()
    await drawReady($, fake)
    const agent = JSON.stringify(await $.ui.render(commandOutput('show r', 'x')))
    expect(agent).toContain('"Claude"')
    expect(agent).toContain('(agent)')
    expect(agent).toContain(`"color":"${personColor(personKey({ user_id: null, name: 'Claude' }))}"`)
    // A row another command printed is left to the host.
    expect(JSON.stringify(await $.ui.render(commandOutput('1', 'x', 'cost')))).toContain('the output row')
    // A stored row of the plugin's own run, whose item this session no longer holds, is drawn by the
    // plugin as a placeholder instead of the near-empty text the row stores.
    const gone = JSON.stringify(await $.ui.render(commandOutput('show missing', '.')))
    expect(gone).toContain('A Delta item that is not in this session.')
    expect(gone).not.toContain('the output row')
    const before = fake.logs.length
    fake.upsert(remoteItem('', { id: 't', kind: 'tool_call', author: { user_id: null, name: 'Delta agent' },
      content: { name: 'Bash', status: 'failed', rawInput: { command: 'head -40 README.md\n  && ls' } } }))
    await fake.clock.settle()
    await drawReady($, fake)
    // Nothing about it reaches the transcript as a plugin notice.
    expect(fake.logs.slice(before).filter((log) => log.includes('Bash'))).toEqual([])
    const toolTree = JSON.stringify(await $.ui.render(commandOutput('show t', '.')))
    expect(toolTree).toContain('"Delta agent"')
    expect(toolTree).toContain('"Bash"')
    // The key input is flattened onto the line, dim, and a failure is red.
    expect(toolTree).toContain('head -40 README.md && ls')
    expect(toolTree).toContain('(failed)')
    expect(toolTree).toContain('"red"')
    expect(toolTree).not.toContain('Markdown')
    // The whole line is one Text, cut at the end if it must be, so no part wraps on its own.
    expect(JSON.parse(toolTree)).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' } })
    // Stored command rows for removed messages and tools draw nothing, unlike unknown IDs.
    for (const id of ['m', 't']) {
      fake.remove(id)
      await fake.clock.settle()
      const removed = await $.ui.render(commandOutput(`show ${id}`, '.'))
      expect(removed).toMatchObject({ type: 'Box' })
      const serialized = JSON.stringify(removed)
      expect(serialized).not.toContain('A Delta item that is not in this session.')
      expect(serialized).not.toContain('Text')
      expect(serialized).not.toContain('Markdown')
    }
    fake.expectClean()
  })

  test('the model\'s copy is the plugin\'s own row, and the show run\'s rows carry nothing', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.upsert(remoteItem('Please rename the flag.', { id: 'a' }))
    await fake.clock.settle()
    await drawReady($, fake)
    expectOfferedItems(fake, ['a'])
    // The engine appends the run's rows beside it; this plugin neutralizes its own as they are kept.
    await appendAsEngine($, commandRunRows('delta', 'show a', '.', { kind: 'plugin', name: 'delta' }))
    // The message's own row is the model's one copy of it; no command row carries it.
    const [own, ...rows] = fake.stored
    expect(own).toMatchObject({ door: 'note', origin: { kind: 'plugin', name: 'delta' },
      content: [{ type: 'text', text: '[Delta] Ada, user message (item a):\nPlease rename the flag.' }] })
    expect(rows.map((row) => row.content)).toEqual([
      // The engine's own caveat names no command and no item id, so it arrives as it is.
      [{ type: 'text', text: localCommandCaveat }],
      // The echo, which named the internal command and its item id, stores nothing.
      [],
      // The output row keeps the wrapper the engine draws it from, around the least it accepts.
      [{ type: 'text', text: '<local-command-stdout>.</local-command-stdout>' }],
    ])
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain('/delta')
    expect(stored).not.toContain('show a')
    expect(stored).not.toContain('Please rename the flag.')
    fake.expectClean()
  })




  test('a comment-only send draws each comment as its own row and gives it to Claude, with no empty message', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    const before = fake.logs.length
    fake.upsert(remoteItem('', { id: 'm' }))
    fake.comment(remoteComment('Why **this** name?', { id: 'c', delivered_with: 'm', target: {
      kind: 'file', worktree: null, path: 'src/main.rs', view: 'diff', selected: null,
      regions: [{ first_line: 4, last_line: 7, status: 'added', text: 'one\ntwo\nthree\nfour' }],
    } }))
    fake.comment(remoteComment('Agreed.', { id: 'r', chain: 'c', after_id: 'c', delivered_with: 'm', target: null,
      author: { user_id: 'user-bob', name: 'Bob' } }))
    await fake.clock.settle()
    await drawReady($, fake)
    // Claude reads one row per comment and none for the message that only carried them.
    expect(fake.rows).toEqual(['[Delta] Ada, comment (comment c):', '[Delta] Bob, reply to a comment (comment r):'])
    const model = fake.stored.flatMap((row) => row.content.flatMap((block) => block.type === 'text' ? [block.text] : []))
      .filter((text) => text.startsWith('[Delta]'))
    expect(model).toHaveLength(2)
    for (const row of model) expect(row).toContain('<file>src/main.rs</file>\n  <context>\n4 + one')
    expect(model[1]).toContain('<comment from="Bob">Agreed.</comment>')
    // The person sees each comment drawn, never a blank message or a plain notice.
    expect(fake.logs.slice(before).filter((log) => log.includes('Why') || log.includes('Ada'))).toEqual([])
    const drawnComment = JSON.stringify(await $.ui.render(commandOutput('show comment:c', '.')))
    for (const part of ['"Ada"', ' commented on src/main.rs:4–7', '"│ "', '"4 + one"', '"5 + two"', '"…"', 'Markdown', 'Why **this** name?'])
      expect(drawnComment).toContain(part)
    expect(drawnComment).not.toContain('6 + three')
    // A withdrawn comment corrects Claude's row, and its stored command row draws nothing.
    fake.removeComment('c')
    await fake.clock.settle()
    await drawReady($, fake)
    expect(fake.rows).toHaveLength(3)
    expect(JSON.stringify(await $.ui.render(commandOutput('show comment:c', '.')))).not.toContain('Text')
    expect(JSON.stringify(await $.ui.render(commandOutput('show comment:gone', '.'))))
      .toContain('A Delta comment that is not in this session.')
    expect(fake.entered).toEqual([])
    fake.expectClean()
  })

  test('an agent\'s reply draws once, as the reply under the line it answers, and its emptied message adds nothing', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    const agent = { user_id: null, name: 'openai-subscribed/gpt-6-luna' }
    fake.upsert(remoteItem('hello dude', { id: 'q' }))
    fake.upsert(remoteItem('Hey! What can I help you with?', { id: 'a', kind: 'agent_message', author: agent }))
    fake.upsert(remoteItem('', { id: 'm' }))
    fake.comment(remoteComment('who is you?', { id: 'c', delivered_with: 'm',
      target: { kind: 'transcript', item_id: 'a', quote: 'you' } }))
    // Delta leaves the reply's block out of the agent's message, which can leave it empty.
    fake.upsert(remoteItem('', { id: 'b', kind: 'agent_message', author: agent }))
    fake.comment(remoteComment('I meant you.', { id: 'r', chain: 'c', after_id: 'c', delivered_with: 'm',
      target: null, agent: true, author: agent }))
    await fake.clock.settle()
    await drawReady($, fake)
    expect(fake.rows).toEqual([
      '[Delta] Ada, user message (item q):',
      '[Delta] openai-subscribed/gpt-6-luna, agent message (item a):',
      '[Delta] Ada, comment (comment c):',
      '[Delta] openai-subscribed/gpt-6-luna, reply to a comment (comment r):',
    ])
    const root = JSON.stringify(await $.ui.render(commandOutput('show comment:c', '.', 'delta', 60)))
    for (const part of ['"Ada"', ' commented on', '"Hey! What can I help "', '"underline":true', '"you"', '" with?"', 'who is you?'])
      expect(root).toContain(part)
    const reply = JSON.stringify(await $.ui.render(commandOutput('show comment:r', '.', 'delta', 60)))
    for (const part of ['"↳ "', 'openai-subscribed/gpt-6-luna', ' replied to Ada', '"who is you?"', 'I meant you.'])
      expect(reply).toContain(part)
    // A stored row for the message that only held the reply draws nothing, not a placeholder.
    const emptied = await $.ui.render(commandOutput('show b', '.'))
    expect(emptied).toMatchObject({ type: 'Box' })
    expect(JSON.stringify(emptied)).not.toContain('Text')
    fake.expectClean()
  })

  test('a snapshot\'s comments follow their messages, and a restart repeats none of them', async ($, on) => {
    const fake = fakeThreads(on)
    fake.server.items.set('m', remoteItem('Please look at these.', { id: 'm' }))
    fake.server.comments.set('c', remoteComment('Why this?', { id: 'c', delivered_with: 'm' }))
    await $.session.start(sessionStart)
    await fake.share($)
    await fake.clock.settle()
    await drawReady($, fake)
    expect(fake.rows).toHaveLength(2)
    expect(fake.rows[0]).toContain('(item m)')
    expect(fake.rows[1]).toContain('(comment c)')
    // Reconnecting sends the same snapshot again, which adds nothing.
    fake.live()!.exit(1)
    await fake.clock.advance(1000)
    await drawReady($, fake)
    expect(fake.rows).toHaveLength(2)
    fake.expectClean()
  })

  test('a message row waits out a local turn and is drawn only after it ends', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    // The prompt has entered and its turn has not finished, so rows are held.
    expect((await $.prompt.submit(prompt('mine'))).drop).toBeUndefined()
    fake.upsert(remoteItem('Remote while busy', { id: 'b' }))
    await fake.clock.settle()
    await redraw($)
    expect(fake.rows).toEqual([])
    await $.turn.start(turnStart('turn-1', 'mine'))
    await fake.clock.settle()
    await redraw($)
    expect(fake.rows).toEqual([])
    // The turn's end releases the held row, and the host's redraw is what draws it.
    const completing = $.turn.complete(turnComplete('turn-1'))
    await fake.clock.settle()
    await drawReady($, fake)
    await completing
    expectOfferedItems(fake, ['b'])
    fake.expectClean()
  })

  test('a host that never redraws falls back to the plain notice and still keeps the row for Claude', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.upsert(remoteItem('Hello there', { id: 'f' }))
    await fake.clock.settle()
    // No redraw ever came, so the item is shown the plain way and the row is offered to Claude.
    await fake.clock.advance(2_001)
    await fake.clock.settle()
    expect(fake.logs).toEqual(['Ada:', 'Hello there'])
    expect(fake.stored.map((row) => row.content)).toEqual([
      [{ type: 'text', text: '[Delta] Ada, user message (item f):\nHello there' }],
    ])
    fake.expectClean()
  })








  for (const loss of ['supersession']) test(`${loss} aborts the owned turn and remote rows wait until it ends`, { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('local turn'))
    await $.turn.start(turnStart('native-owned'))
    await fake.clock.settle()
    fake.live()!.frame({ type: 'producer.turn', sequence: fake.starts()[0]! + 100, status: 'superseded' })
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    if (loss === 'supersession') {
      fake.supersede()
      await fake.clock.settle()
      expect(await drawn($)).toContain("Ada's agent")
      fake.upsert(remoteItem('Taking over: stop that', { id: 'takeover' }))
    } else fake.live()!.exit(1)
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-owned'])
    // A row added now would land inside the aborted turn.
    expect(fake.rows).toEqual([])
    if (loss === 'disconnect') {
      expect((await $.prompt.submit(prompt('disconnected'))).drop).toBeDefined()
      expect(fake.logs.some((log) => log.startsWith('Connection interrupted'))).toBe(true)
    }
    await $.turn.complete(turnComplete('native-owned', 'aborted'))
    await fake.clock.settle()
    // The hook returns before the released rows are drawn; the host's redraw is what draws them.
    await drawReady($, fake)
    expectOfferedItems(fake, loss === 'supersession' ? ['takeover'] : [])
    expect(fake.entered).toHaveLength(1)
    fake.expectClean()
  })

  for (const code of ['watch_reset']) test(`${code} reconnects for a fresh snapshot`, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    const watches = fake.watches.length
    fake.live()!.frame({ error: { code, message: 'start a new watch', retryable: true } })
    await fake.clock.settle()
    expect(fake.logs.some((log) => log.includes(code))).toBe(true)
    await fake.clock.advance(1000)
    expect(fake.watches.length).toBe(watches + 1)
    expect(fake.live()?.ready).toBe(true)
    expect((await $.prompt.submit(prompt('after reconnect'))).drop).toBeUndefined()
    fake.expectClean()
  })

  test('a gone thread pauses sharing with its reason instead of reconnecting', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.live()!.frame({ error: { code: 'not_visible', reason: 'thread_gone', message: 'The thread was deleted', retryable: false } })
    await fake.clock.settle()
    const watches = fake.watches.length
    await fake.clock.advance(120_000)
    expect(fake.watches.length).toBe(watches)
    expect(fake.logs.some((log) => log.includes('not_visible (thread_gone)') && log.includes('/delta share'))).toBe(true)
    expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain('not_visible')
    expect((await $.prompt.submit(prompt('after deletion'))).drop).toBeDefined()
    expect(fake.entered).toEqual([])
    const calls = fake.appendCalls
    await $.tool.call(bash('while-gone', 'echo queued'))
    await fake.clock.settle()
    expect(fake.appendCalls).toBe(calls)
    expectStagedRecords(fake, [1])
    fake.expectClean()
  })

  for (const code of ['failed', 'incompatible_app']) test(`a non-retryable ${code} watch error pauses participation`, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.live()!.frame({ error: { code, reason: code === 'failed' ? 'storage' : code, message: 'cannot continue', retryable: false } })
    await fake.clock.settle()
    const watches = fake.watches.length
    await fake.clock.advance(120_000)
    expect(fake.watches.length).toBe(watches)
    expect((await $.prompt.submit(prompt('while paused'))).drop).toBeDefined()
    fake.expectClean()
  })

  test('a retryable failed watch error reconnects like any lost connection', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    const watches = fake.watches.length
    fake.live()!.frame({ error: { code: 'failed', reason: 'sync', message: 'synchronization stalled', retryable: true } })
    await fake.clock.settle()
    await fake.clock.advance(1000)
    expect(fake.watches.length).toBe(watches + 1)
    expect(fake.live()?.ready).toBe(true)
    expect((await $.prompt.submit(prompt('after reconnect'))).drop).toBeUndefined()
    fake.expectClean()
  })


  test('malformed watch output surfaces failure and reconnects', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.live()!.write('{"type":"item","item":{"id":""}}\n')
    await fake.clock.settle()
    expect(fake.logs.some((log) => log.startsWith('Connection interrupted'))).toBe(true)
    expect((await $.prompt.submit(prompt('invalid'))).drop).toBeDefined()
    await fake.clock.advance(1000)
    expect((await $.prompt.submit(prompt('ready after automatic reconnect'))).drop).toBeUndefined()
    fake.expectClean()
  })

  test('incoming activity never executes or starts a turn, and the band shows only status', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await fake.clock.settle()
    const records = fake.records().length
    const line = JSON.stringify({ type: 'item', item: remoteItem('complete response', { kind: 'agent_message' }) }) + '\n'
    const live = fake.live()!
    live.write(line.slice(0, 20))
    live.write(line.slice(20))
    await fake.clock.settle()
    live.exit(2)
    await fake.clock.settle()
    expect(fake.logs.some((log) => log.startsWith('Connection interrupted'))).toBe(true)
    expect(JSON.stringify(await $.ui.render(abovePrompt))).not.toContain('complete response')
    expect(fake.entered).toEqual([])
    expect(fake.records()).toHaveLength(records)
    fake.expectClean()
  })

  test('readiness processes turns and items while initial status is pending', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.turn.start(turnStart('previous-host-turn'))
    await fake.clock.settle()
    const sequence = fake.starts()[0]!
    await $.session.end(sessionEnd(fake.session))
    // Restore an abandoned execution to exercise observer-only resume recovery.
    const saved = structuredClone(fake.store.get(`session:${fake.session}`) as any)
    saved.execution = { sequence, turnId: 'previous-host-turn' }
    fake.store.set(`session:${fake.session}`, saved)
    fake.server.turn = { sequence, status: 'running' }
    let release!: () => void
    fake.holdStatus = new Promise<void>((resolve) => { release = resolve })
    const commands = fake.operations().length
    const starting = $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.live()?.ready).toBe(true)
    expect(fake.statusProcesses.at(-1)!.closed).toBe(false)
    fake.upsert(remoteItem('Changed during inspection'))
    fake.live()!.frame({ type: 'producer.turn', sequence, status: 'superseded' })
    await fake.clock.settle()
    expect((fake.store.get(`session:${fake.session}`) as any).execution).toBeUndefined()
    expect((fake.store.get(`session:${fake.session}`) as any).pending).not.toEqual([])
    fake.holdStatus = undefined
    release()
    await starting
    await fake.clock.settle()
    expectNoSetupCommands(fake, commands)
    fake.expectClean()
  })


  for (const failure of [false, true]) test(`a stopped observer's late status ${failure ? 'error' : 'result'} cannot replace a restarted binding`, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    const saved = structuredClone(fake.store.get(`session:${fake.session}`) as any)
    let release!: () => void
    fake.holdStatus = new Promise<void>((resolve) => { release = resolve })
    fake.ignoreReadCancellation = true
    if (failure) fake.commandFault = { operation: 'status', code: 'unavailable', message: 'Old delayed inspection failure' }
    else fake.statusPatch = { url: 'https://delta.dev/join/old_inspection' }
    const starting = $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.statusProcesses.at(-1)!.closed).toBe(false)
    await $.session.end(sessionEnd(fake.session))
    await starting
    fake.holdStatus = undefined
    fake.ignoreReadCancellation = false
    fake.commandFault = undefined
    fake.statusPatch = undefined
    await $.session.start(sessionStart)
    release()
    await fake.clock.settle()
    expect(fake.store.get(`session:${fake.session}`)).toEqual(saved)
    expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain(LIVE)
    expect((await $.prompt.submit(prompt('after inspection restart'))).drop).toBeUndefined()
    fake.expectClean()
  })
})

describe('native turns', () => {
  for (const callFirst of [true, false]) {
    test(`a remote Bash call reaches the receiver once with output (${callFirst ? 'call hook' : 'assistant row'} first)`, async ($, on) => {
      const fake = fakeThreads(on, { messages: [text('one')] })
      await $.session.start(sessionStart)
      await fake.share($)
      await $.prompt.submit(prompt('run a command'))
      await $.turn.start(turnStart('native-tool', 'run a command'))
      await fake.clock.settle()
      const sequence = fake.starts()[0]!
      const view = new RemoteView(fake.threadId, { thread: fake.threadId, items: {} })
      view.endSnapshot()
      const rows: PendingRow[] = []
      let consumed = 0
      const receive = async () => {
        await fake.clock.settle()
        const records = fake.updates().filter((record) => record.update.toolCallId === 'remote-bash')
        for (const record of records.slice(consumed)) {
          expect(record.turnSequence).toBe(sequence)
          const previous = view.items.get('remote-bash')
          const content = { ...previous?.content, ...record.update }
          view.upsert(remoteItem('', { id: 'remote-bash', kind: 'tool_call', content,
            open: content.status !== 'completed' && content.status !== 'failed' }))
          await addRows(view, {
            append: async (row) => { rows.push(row); return {} },
            save: async () => {}, held: () => false, current: () => true,
            announce: () => {}, debug: () => {}, fail: (reason) => { throw new Error(reason) },
          })
        }
        consumed = records.length
      }
      const assistant = async () => {
        await $.session.append({ door: 'response', uuid: 'assistant-tool',
          message: { type: 'assistant', role: 'assistant', content: [
            { type: 'tool_use', id: 'remote-bash', name: 'Bash', input: { command: 'echo output' } },
          ] } })
        await receive()
      }
      const call = async () => {
        await $.tool.call(bash('remote-bash', 'echo output'))
        await receive()
      }
      if (callFirst) { await call(); await assistant() }
      else { await assistant(); await call() }
      expect(rows).toHaveLength(0)
      await $.session.append({ door: 'tool-result', uuid: 'result-tool',
        message: { type: 'user', role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'remote-bash', content: 'tool output' },
        ] } })
      await receive()
      expect(consumed).toBe(3)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.text).toContain('tool call echo output (completed)')
      expect(rows[0]!.text).toContain('tool output')
      expect(rows[0]!.text).not.toContain('changed an earlier')
      expect(view.items.get('remote-bash')!.content.content).toEqual([
        { type: 'content', content: { type: 'text', text: 'tool output' } },
      ])
      view.upsert({ ...view.items.get('remote-bash')!, content: {
        ...view.items.get('remote-bash')!.content, rawOutput: 'genuinely edited output',
      } })
      expect((await view.nextRow())!.text).toContain('changed an earlier tool call echo output')
      await $.turn.complete(turnComplete('native-tool'))
      await fake.clock.settle()
      fake.expectClean()
    })
  }

  test('a queued own finish does not block a new prompt', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('first'))
    await $.turn.start(turnStart('native-first'))
    await fake.clock.settle()
    const first = fake.starts()[0]!
    let release!: () => void
    fake.holdAppend = new Promise<void>((resolve) => { release = resolve })
    const completion = $.turn.complete(turnComplete('native-first'))
    await fake.clock.settle()
    expect(fake.finishes()).toEqual([])
    expect((await $.prompt.submit(prompt('next before idle replicates'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-second'))
    await fake.clock.settle()
    fake.holdAppend = undefined
    release()
    await completion
    await fake.clock.settle()
    const second = fake.starts()[1]!
    expect(fake.finishes()).toEqual([first])
    const idle = fake.records().find((record) => record.update?.state === 'idle')!
    expect(idle.sequence).toBeLessThan(second)
    expect((fake.store.get(`session:${fake.session}`) as any).execution).toMatchObject({ sequence: second })
    await $.turn.complete(turnComplete('native-second'))
    await fake.clock.settle()
    expect(fake.logs.some((log) => log.includes("agent is working"))).toBe(false)
    fake.expectClean()
  })

  test('a local prompt takes over a running remote turn, and rows wait for its turn', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.turn('running', ADA, 'remote-turn')
    await fake.clock.settle()
    expect(await drawn($)).toContain("Ada's agent")
    expect((await $.prompt.submit(prompt('take over'))).drop).toBeUndefined()
    // Arriving after the prompt entered, this row would otherwise land inside the new turn.
    fake.upsert(remoteItem('Late remote note', { id: 'late' }))
    await fake.clock.settle()
    expect(fake.rows).toEqual([])
    await $.turn.start(turnStart('native-takeover'))
    await fake.clock.settle()
    // The start is staged and delivered like a native send; Delta's arbitration supersedes the remote turn.
    const [sequence] = fake.starts()
    expect(fake.records().find((record) => record.sequence === sequence)?.turnSequence).toBe(sequence)
    fake.live()!.frame(cliFixture('producerTurn', { sequence, status: 'running' }))
    fake.turn('running', { user_id: 'user-me', name: 'Me' }, `producer-turn-${sequence}`)
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    // The takeover returns the band to this session's own turn, which Claude's own spinner already
    // shows; no transcript notice is written.
    expect(await drawn($)).not.toContain("Ada's agent")
    expect(await drawn($)).toContain(LIVE)
    expect(fake.logs.some((log) => log.includes('finished its turn') || log.startsWith('Me'))).toBe(false)
    expect(fake.rows).toEqual([])
    await $.turn.complete(turnComplete('native-takeover'))
    await fake.clock.settle()
    // Completion releases the held row without awaiting its draw, so the host's redraw draws it.
    await drawReady($, fake)
    expectOfferedItems(fake, ['late'])
    expect(fake.logs.some((log) => log.includes('finished its turn') || log.startsWith('Me'))).toBe(false)
    fake.expectClean()
  })

  test('completion delivers its finish before the hook returns, so a host that exits right after a reply still records it', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('last turn before exit'))
    await $.turn.start(turnStart('native-last'))
    await fake.clock.settle()
    await $.turn.complete(turnComplete('native-last'))
    await fake.clock.settle()
    // The hook awaited delivery, so the idle finish reached the thread before it returned and a
    // host that exits now has still delivered it.
    expect(fake.finishes()).toEqual(fake.starts())
    expect((fake.store.get(`session:${fake.session}`) as any).execution).toBeUndefined()
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toEqual([])
    fake.expectClean()
  })

  test('a completion whose append outlasts the budget returns and leaves delivery to the outbox', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('first'))
    await $.turn.start(turnStart('native-a', 'first'))
    await $.tool.call(bash('tool-a', 'echo a'))
    await fake.clock.settle()
    const first = fake.starts()[0]!
    // Hold the append as an upload that outlasts the hook's budget, which is what Claude kills a
    // completion hook on.
    let release!: () => void
    fake.holdAppend = new Promise<void>((resolve) => { release = resolve })
    let returned = false
    const completion = $.turn.complete(turnComplete('native-a')).then(() => { returned = true })
    await fake.clock.settle()
    // The hook waits for its finish within the budget before giving up on the append.
    expect(returned).toBe(false)
    // The next turn starts and produces output while that delivery is still held.
    expect((await $.prompt.submit(prompt('second'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-b', 'second'))
    await $.tool.call(bash('tool-b', 'echo b'))
    await fake.clock.settle()
    // Delivery is still held, so read the durable outbox: the next turn's start and its output are
    // already recorded and correlated, and the held finish is still queued behind them.
    const { pending } = fake.store.get(`session:${fake.session}`) as { pending: { files: string[] }[] }
    const staged = pending.map((entry) => JSON.parse(fake.files.get(entry.files[0]!)!))
    const startB = staged.find((record) => record.update?.sessionUpdate === 'state_update'
      && record.update.state === 'running' && record.sequence > first)!
    expect(startB.turnSequence).toBe(startB.sequence)
    const tapped = staged.find((record) => JSON.stringify(record).includes('tool-b'))!
    expect(tapped.turnSequence).toBe(startB.sequence)
    expect(staged.some((record) => record.update?.state === 'idle' && record.turnSequence === first)).toBe(true)
    // Past the budget the hook returns and the outbox keeps draining in the background.
    await fake.clock.advance(5_001)
    await fake.clock.settle()
    expect(returned).toBe(true)
    release()
    await completion
    await fake.clock.settle()
    expect(fake.finishes()).toEqual([first])
    fake.expectClean()
  })

  test("output whose turn's start is still staging waits for that start", async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('first'))
    await $.turn.start(turnStart('native-a', 'first'))
    await $.turn.complete(turnComplete('native-a'))
    await fake.clock.settle()
    const first = fake.starts()[0]!
    expect((await $.prompt.submit(prompt('second'))).drop).toBeUndefined()
    // `turn.start` fixes this turn's local identity before its scoped start record is durable.
    // Hold that write, so output is produced while the start it belongs to is still staging.
    let releaseStore!: () => void
    const held = new Promise<void>((resolve) => { releaseStore = resolve })
    fake.holdStoreGet = (key) => {
      if (key !== `session:${fake.session}`) return
      fake.holdStoreGet = undefined
      return held
    }
    const starting = $.turn.start(turnStart('native-b', 'second'))
    await fake.clock.settle()
    const tool = $.tool.call(bash('tool-b', 'echo b'))
    await fake.clock.settle()
    // Nothing is recorded yet: the row waits for its own turn instead of naming the finished one.
    expect(fake.updates().some((record) => JSON.stringify(record).includes('tool-b'))).toBe(false)
    releaseStore()
    await starting
    await tool
    await fake.clock.settle()
    const second = fake.starts()[1]!
    const tapped = fake.updates().find((record) => JSON.stringify(record).includes('tool-b'))!
    expect(tapped.turnSequence).toBe(second)
    expect(second).toBeGreaterThan(first)
    await $.turn.complete(turnComplete('native-b'))
    await fake.clock.settle()
    expect(fake.finishes()).toEqual([first, second])
    fake.expectClean()
  })

  test('late and subagent completions cannot close a newer main turn', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('first'))
    await $.turn.start(turnStart('native-old'))
    await fake.clock.settle()
    const first = fake.starts()[0]!
    await $.turn.start(turnStart('native-new'))
    await fake.clock.settle()
    const second = fake.starts()[1]!
    await $.turn.complete({ ...turnComplete('native-new'), agentId: 'subagent' })
    await $.turn.complete(turnComplete('native-old'))
    await fake.clock.settle()
    expect(fake.finishes()).toEqual([first])
    expect((fake.store.get(`session:${fake.session}`) as any).execution)
      .toMatchObject({ sequence: second, turnId: 'native-new' })
    await $.turn.complete(turnComplete('native-new'))
    await fake.clock.settle()
    expect(fake.finishes()).toEqual([first, second])
    fake.expectClean()
  })

  test('live turns report the installed plugin version and only confirmed finish reasons', async ($, on) => {
    const fake = fakeThreads(on)
    fake.pluginVersion = '0.2.3'
    await $.session.start(sessionStart)
    await fake.share($)
    for (const [reason, expected] of [
      ['answer', 'end_turn'], ['aborted', 'cancelled'], ['refusal', 'refusal'], ['error', 'error'],
    ] as const) {
      await $.turn.start(turnStart(reason))
      await fake.clock.settle()
      await $.turn.complete({ ...turnComplete(reason), reason, isAborted: reason === 'aborted' })
      await fake.clock.settle()
      const start = fake.records().find((record) => record.sequence === fake.starts().at(-1))
      expect(start?.update).toEqual({
        sessionUpdate: 'state_update', state: 'running',
        _meta: { delta: { producer_version: '0.2.3' } },
      })
      const finish = fake.records().find((record) =>
        record.update?.sessionUpdate === 'state_update' && record.update.state === 'idle' &&
        record.turnSequence === start?.sequence)
      expect(finish?.update).toEqual({
        sessionUpdate: 'state_update', state: 'idle', stopReason: expected,
        ...reason === 'error' ? { error: { code: -32603, message: 'External producer reported an error' } } : {},
      })
    }
    await $.turn.start(turnStart('interrupted'))
    await fake.clock.settle()
    await $.turn.start(turnStart('replacement'))
    await fake.clock.settle()
    const recovered = fake.records().find((record) =>
      record.update?.sessionUpdate === 'state_update' && record.update.state === 'idle' &&
      record.turnSequence === fake.starts().at(-2))
    expect(recovered?.update).toEqual({ sessionUpdate: 'state_update', state: 'idle' })
    fake.pluginVersion = '/private-version'
    await $.turn.start(turnStart('unknown-version'))
    await fake.clock.settle()
    const unknown = fake.records().find((record) => record.sequence === fake.starts().at(-1))
    expect(unknown?.update).toEqual({ sessionUpdate: 'state_update', state: 'running' })
    for (const operation of ['create', 'share', 'append']) {
      const calls = fake.cliIntegrations.filter((call) => call.operation === operation)
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((call) => call.integration === 'claude_code')).toBe(true)
    }
    fake.expectClean()
  })

  for (const [flag, location] of [
    ['true', 'remote'], ['false', 'local'], [undefined, undefined],
  ] as const)
    test(`execution location follows only an explicit Claude host flag (${flag ?? 'missing'})`, async ($, on) => {
      const fake = fakeThreads(on, { env: flag ? { CLAUDE_CODE_REMOTE: flag } : {} })
      await $.session.start(sessionStart)
      await fake.share($)
      await $.turn.start(turnStart('host-context'))
      await fake.clock.settle()
      const start = fake.records().find((record) => record.sequence === fake.starts().at(-1))
      expect(start?.update).toEqual({
        sessionUpdate: 'state_update', state: 'running',
        _meta: { delta: {
          producer_version: '0.1.1',
          ...location ? { execution_location: location } : {},
        } },
      })
      fake.expectClean()
    })

  for (const failure of ['write'] as const)
    test(`a failed durable start ${failure} aborts its local ID without publishing a partial start`, async ($, on) => {
      const fake = fakeThreads(on)
      await $.session.start(sessionStart)
      await fake.share($)
      await $.prompt.submit(prompt('cannot save'))
      if (failure === 'write') fake.failWrite = true
      else fake.failStoreSet = true
      await $.turn.start(turnStart('native-unsaved'))
      await fake.clock.settle()
      expect(fake.aborts).toEqual(['native-unsaved'])
      expect(fake.starts()).toEqual([])
      expect((fake.store.get(`session:${fake.session}`) as any).next).toBe(1)
      expect(fake.statuses.some((status) => status?.includes('sharing paused'))).toBe(true)
      fake.expectClean()
    })

  test('live capture failure cancels the exact local turn even when the store is unavailable', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('capture'))
    await $.turn.start(turnStart('native-capture'))
    await fake.clock.settle()
    fake.failStoreSet = true
    await $.tool.call(bash('failed-capture', 'echo captured'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-capture'])
    expect((await $.prompt.submit(prompt('blocked'))).drop).toBeDefined()
    fake.expectClean()
  })

  test('restart delivers a queued abandoned start and its matching finish without aborting a saved Claude ID', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    await seedPending(fake, [
      { schemaVersion: 1, sequence: 1, turnSequence: 1, update: { sessionUpdate: 'state_update', state: 'running' } },
    ], { sequence: 1, turnId: 'old-process-id' })
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.starts()).toEqual([1])
    expect(fake.finishes()).toEqual([1])
    expect(fake.aborts).toEqual([])
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ next: 3, pending: [] })
    fake.expectClean()
  })

  test('old mixed pending records translate without sequence reset across partial receipts and restart', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    const records = [
      { schemaVersion: 1, sequence: 1, update: { sessionUpdate: 'state_update', state: 'idle' } },
      { schemaVersion: 1, sequence: 2, turn: { action: 'claim' } },
      { schemaVersion: 1, sequence: 3, claim: 2, update: { sessionUpdate: 'agent_message', messageId: 'first', content: [{ type: 'text', text: 'first' }] } },
      { schemaVersion: 1, sequence: 4, claim: 2, update: { sessionUpdate: 'agent_message', messageId: 'second', content: [{ type: 'text', text: 'second' }] } },
      { schemaVersion: 1, sequence: 5, turn: { action: 'end', claim: 2 } },
      { schemaVersion: 1, sequence: 6, claim: 2, update: { sessionUpdate: 'agent_message', content: [{ type: 'text', text: 'late' }] } },
    ]
    await seedPending(fake, records, { claim: 2, endSequence: 5 })
    const immutable = new Map(fake.files)
    fake.appendFaults.push({ accept: 3, exitCode: 1, stderr: 'partial content' })
    await $.session.start(sessionStart)
    await fake.clock.settle()
    let saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved.pending.map((entry: any) => entry.sequence)).toEqual([4, 5, 6])
    expect(saved.execution).toBeUndefined()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2, 3])
    expect(fake.finishes()).toEqual([])
    for (const entry of saved.pending)
      for (const file of entry.files) expect(fake.files.get(file)).toBe(immutable.get(file))

    fake.appendFaults.push({ throwAfterAccept: true })
    expect(await fake.share($)).toContain('failed')
    saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved.pending.map((entry: any) => entry.sequence)).toEqual([4, 5, 6])
    expect(saved.execution).toBeUndefined()
    expect(fake.records().map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved).toMatchObject({ next: 7, pending: [] })
    expect(saved.execution).toBeUndefined()
    expect(fake.records()[0]).toEqual(records[0])
    expect(fake.records()[1]).toEqual({
      schemaVersion: 1, sequence: 2, turnSequence: 2, update: { sessionUpdate: 'state_update', state: 'running' },
    })
    expect(fake.records()[2]).toMatchObject({ sequence: 3, turnSequence: 2, update: records[2]!.update })
    expect(fake.starts()).toEqual([2])
    expect(fake.finishes()).toEqual([2])
    expect(fake.records().find((record) => record.sequence === 6)?.turnSequence).toBe(2)
    expect(fake.entered).toEqual([])
    fake.expectClean()
  })

  test('a malformed lifecycle receipt leaves its pending start unchanged without blocking entry', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.appendFaults.push({ ack: (ack) => {
      fake.appendOffline = true
      return { ...ack, turn_sequence: undefined }
    } })
    expect((await $.prompt.submit(prompt('no receipt needed'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-pending'))
    await fake.clock.settle()
    let saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved.execution).toMatchObject({ sequence: 1, turnId: 'native-pending' })
    expect(saved.pending.map((entry: any) => entry.sequence)).toEqual([1])
    const file = saved.pending[0].files[0]
    const immutable = fake.files.get(file)
    expect(fake.entered).toHaveLength(1)
    await $.turn.complete(turnComplete('native-pending'))
    await fake.clock.settle()
    expect(fake.files.get(file)).toBe(immutable)
    fake.appendOffline = false
    await fake.share($)
    await fake.clock.settle()
    saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved.pending).toEqual([])
    expect(saved.execution).toBeUndefined()
    expect(fake.starts()).toEqual([1])
    expect(fake.finishes()).toEqual([1])
    fake.expectClean()
  })

  test('a malformed finish receipt and failed durable retry retain the immutable pending finish', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('owned'))
    await $.turn.start(turnStart('native-wrong-end', 'owned'))
    await fake.clock.settle()
    fake.appendFaults.push({ ack: (ack) => ({ ...ack, operation: 'turn_ended' }) })
    await $.turn.complete(turnComplete('native-wrong-end'))
    await fake.clock.settle()
    let saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved.execution).toBeUndefined()
    expect(saved.pending.map((entry: any) => entry.sequence)).toEqual([2])
    const file = saved.pending[0].files[0]
    const immutable = fake.files.get(file)
    fake.failStoreSet = () => (fake.store.get(`session:${fake.session}`) as any).pending.length === 1
    await $.session.end(sessionEnd(fake.session))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.files.get(file)).toBe(immutable)
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toHaveLength(1)
    fake.failStoreSet = false
    await fake.share($)
    await fake.clock.settle()
    saved = fake.store.get(`session:${fake.session}`) as any
    expect(saved.execution).toBeUndefined()
    expect(saved.pending).toEqual([])
    expect(fake.finishes()).toEqual([1])
    fake.expectClean()
  })

  for (const patch of [{ schemaVersion: 2 }]) test(`malformed saved control ${JSON.stringify(patch)} is not translated or discarded`, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    // Raw journals get a matching digest, so duplicate-key rejection cannot rely on tamper detection.
    await seedPending(fake, [typeof patch === 'string' ? patch
      : { schemaVersion: 1, sequence: 1, turn: { action: 'claim' }, ...patch }])
    // The manifest's sequence remains 1, even when the saved envelope disagrees.
    const before = JSON.stringify(fake.store.get(`session:${fake.session}`))
    const files = [...fake.files]
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(JSON.stringify(fake.store.get(`session:${fake.session}`))).toBe(before)
    expect([...fake.files]).toEqual(files)
    expect(fake.records()).toEqual([])
    expect(fake.operations()).not.toContain('append')
    expect(fake.statuses.some((status) => status?.includes('invalid pending record'))).toBe(true)
    fake.expectClean()
  })

  test('a prompt enters without delivery permission; actual start binds lifecycle before output', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    fake.appendOffline = true
    const result = await $.prompt.submit(prompt('build it'))
    expect(result.drop).toBeUndefined()
    expect(fake.starts()).toEqual([])
    expect(fake.entered).toHaveLength(1)
    await $.turn.start(turnStart('native-1', 'build it'))
    const saved = fake.store.get(`session:${fake.session}`) as any
    const sequence = saved.execution.sequence
    expect(saved.execution.turnId).toBe('native-1')
    const start = JSON.parse(fake.files.get(saved.pending[0].files[0])!)
    expect(start).toEqual({
      schemaVersion: 1, sequence, turnSequence: sequence,
      update: {
        sessionUpdate: 'state_update', state: 'running',
        _meta: { delta: { producer_version: '0.1.1' } },
      },
    })
    // Steering uses local lifecycle even while the start is undelivered.
    const steering = await $.prompt.submit(prompt('also test it', 'native-1'))
    expect(steering.drop).toBeUndefined()
    await $.tool.call(bash('tool-1', 'make'))
    await $.tool.call(bash('tool-2', 'make test'))
    await $.turn.complete(turnComplete('native-1'))
    await fake.clock.settle()
    fake.appendOffline = false
    await fake.share($)
    await fake.clock.settle()

    const records = fake.records()
    const output = records.filter((record) => record.update?.sessionUpdate === 'tool_call_update')
    expect(output).toHaveLength(2)
    expect(output.every((record) => record.turnSequence === sequence)).toBe(true)
    expect(fake.finishes()).toEqual([sequence])
    const end = records.find((record) => record.update?.state === 'idle')!
    expect(end.sequence).toBeGreaterThan(Math.max(...output.map((record) => record.sequence)))
    expect(fake.aborts).toEqual([])
    fake.expectClean()
  })

  test('a raced busy start is observed independently of snapshots and cancels only its local ID', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    // Catch-up looked idle; another producer begins before our actual turn.start.
    expect((await $.prompt.submit(prompt('raced'))).drop).toBeUndefined()
    fake.appendFaults.push({ disposition: 'fenced', frames: [cliFixture('producerTurn', { sequence: 2, status: 'superseded' })] })
    await $.turn.start(turnStart('native-raced'))
    await fake.clock.settle()
    const [sequence] = fake.starts()
    expect(fake.records().find((record) => record.sequence === sequence)?.turnSequence).toBe(sequence)
    expect(fake.aborts).toEqual(['native-raced'])
    expect(fake.finishes()).toEqual([sequence])
    fake.releaseRemote()
    fake.refusePrompt = 'another hook refused'
    expect((await $.prompt.submit(prompt('refused below'))).drop).toBe('another hook refused')
    await fake.clock.settle()
    expect(fake.starts()).toEqual([sequence])
    fake.expectClean()
  })

  test('queued lifecycle survives disconnect and reconnect without replaying a prompt', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    fake.appendOffline = true
    expect((await $.prompt.submit(prompt('offline'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-offline'))
    fake.live()!.exit(1)
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-offline'])
    // Observing turn.abort does not mean its asynchronous finish is persisted.
    // The host's aborted completion provides the durable lifecycle boundary.
    await $.turn.complete(turnComplete('native-offline', 'aborted'))
    expect((fake.store.get(`session:${fake.session}`) as any).pending).toHaveLength(2)
    fake.appendOffline = false
    await fake.clock.advance(60_000)
    expect(fake.finishes()).toEqual(fake.starts())
    expect(fake.entered).toHaveLength(1)
    fake.expectClean()
  })

  test('ownership loss aborts exactly the bound native turn and fences its later output', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('long task'))
    await $.turn.start(turnStart('native-lost', 'long task'))
    await $.tool.call(bash('before-loss', 'echo before loss'))
    await fake.clock.settle()
    const sequence = fake.starts()[0]!
    // A stale event for another turn is not this turn's loss.
    fake.live()!.frame({ type: 'producer.turn', sequence: sequence + 100, status: 'superseded' })
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    fake.supersede()
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-lost'])
    await $.tool.call(bash('after-loss', 'echo written after loss'))
    await $.turn.complete(turnComplete('native-lost', 'aborted'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-lost'])
    for (const record of fake.updates().filter((record) => record.sequence > sequence))
      expect(record.turnSequence).toBe(sequence)
    expect(fake.entered).toHaveLength(1)
    fake.expectClean()
  })

  test('a fenced receipt for the running turn aborts exactly that Claude turn with a notice', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('contested'))
    await $.turn.start(turnStart('native-fenced', 'contested'))
    await fake.clock.settle()
    const sequence = fake.starts()[0]!
    // Delta already superseded this turn, so the next record we send comes back fenced.
    fake.appendFaults.push({ disposition: 'fenced' })
    await $.tool.call(bash('late', 'echo contested'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-fenced'])
    expect(fake.logs.filter((log) => log.includes('stopped Claude turn native-fenced'))).toHaveLength(1)
    expect((fake.store.get(`session:${fake.session}`) as any).execution).toBeUndefined()
    // The stop still writes the turn's finish once the abort completes.
    await $.turn.complete(turnComplete('native-fenced', 'aborted'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-fenced'])
    expect(fake.finishes()).toContain(sequence)
    fake.expectClean()
  })

  test("a fenced receipt for an earlier turn's late output leaves the running turn alone", async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('first'))
    await $.turn.start(turnStart('native-earlier', 'first'))
    await fake.clock.settle()
    const first = fake.starts()[0]!
    let releaseTool!: () => void
    fake.holdTool = new Promise<void>((resolve) => { releaseTool = resolve })
    const tool = $.tool.call(bash('slow-tool', 'sleep'))
    await fake.clock.settle()
    fake.supersede()
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-earlier'])
    await $.turn.complete(turnComplete('native-earlier', 'aborted'))
    fake.releaseRemote()
    fake.holdTool = undefined

    expect((await $.prompt.submit(prompt('second'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-later', 'second'))
    await fake.clock.settle()
    const second = fake.starts()[1]!
    // The late output keeps the earlier turn's sequence, so its fence must not touch the running one.
    fake.appendFaults.push({ disposition: 'fenced' })
    releaseTool()
    await tool
    await fake.clock.settle()
    const late = fake.updates().filter((record) => JSON.stringify(record).includes('slow-tool'))
    expect(late.every((record) => record.turnSequence === first)).toBe(true)
    expect(fake.aborts).toEqual(['native-earlier'])
    expect((fake.store.get(`session:${fake.session}`) as any).execution).toMatchObject({ sequence: second, turnId: 'native-later' })
    await $.turn.complete(turnComplete('native-later'))
    await fake.clock.settle()
    expect(fake.finishes()).toContain(second)
    fake.expectClean()
  })

  test('a watch supersession and a fenced receipt for the same turn abort it once', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('contested'))
    await $.turn.start(turnStart('native-contested', 'contested'))
    await fake.clock.settle()
    const sequence = fake.starts()[0]!
    // Both signals name the same turn: the watcher's supersession and the outbox's fence.
    fake.appendFaults.push({ disposition: 'fenced' })
    const tool = $.tool.call(bash('late', 'echo contested'))
    fake.supersede()
    await fake.clock.settle()
    await tool
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-contested'])
    expect(fake.logs.filter((log) => log.includes('stopped Claude turn native-contested'))).toHaveLength(1)
    expect(fake.finishes()).toContain(sequence)
    await $.turn.complete(turnComplete('native-contested', 'aborted'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-contested'])
    fake.expectClean()
  })

  test('a disconnected observer held in abort cannot corrupt a restarted live observer or its ready gate', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('owned'))
    await $.turn.start(turnStart('native-held-abort', 'owned'))
    let release!: () => void
    fake.holdAbort = new Promise<void>((resolve) => { release = resolve })
    fake.live()!.exit(1)
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-held-abort'])
    // The old abort is still held, but completion and a new observer can proceed.
    fake.holdAbort = undefined
    await $.turn.complete(turnComplete('native-held-abort', 'aborted'))
    await $.session.end(sessionEnd(fake.session))
    fake.server.items.set('fresh', remoteItem('New observer live snapshot', { id: 'fresh' }))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await redraw($)
    const live = fake.live()!
    // A press handle is new with every draw; the band is otherwise the same.
    const drawnBand = async () => JSON.stringify(await $.ui.render(abovePrompt)).replace(/"handle":\d+/g, '')
    const band = await drawnBand()
    expect(band).toContain(LIVE)
    release()
    await fake.clock.settle()
    await redraw($)
    expect(await drawnBand()).toBe(band)
    expect((await $.prompt.submit(prompt('new observer still ready'))).drop).toBeUndefined()
    expect(fake.live()).toBe(live)
    fake.expectClean()
  })

  test('an observer loss queued across session end cannot write or abort the restarted execution', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('owned'))
    await $.turn.start(turnStart('native-queued-loss', 'owned'))
    await fake.clock.settle()
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    fake.holdStoreGet = (key) => {
      if (key !== `session:${fake.session}`) return
      fake.holdStoreGet = undefined
      entered()
      return held
    }
    fake.live()!.frame({ type: 'producer.turn', sequence: fake.starts()[0], status: 'superseded' })
    await waiting
    await $.session.end(sessionEnd(fake.session))
    const restarting = $.session.start(sessionStart)
    release()
    await restarting
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    expect((fake.store.get(`session:${fake.session}`) as any).execution).toBeUndefined()
    expect(fake.finishes()).toEqual(fake.starts())
    expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain(LIVE)
    await $.turn.complete(turnComplete('native-queued-loss'))
    fake.expectClean()
  })


  test('completion finishes its lifecycle without waiting for an unresolved tool callback', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('first'))
    await $.turn.start(turnStart('native-done', 'first'))
    await $.tool.call(bash('settled-tool', 'echo settled'))
    await fake.clock.settle()
    const sequence = fake.starts()[0]!
    let releaseTool!: () => void
    fake.holdTool = new Promise<void>((resolve) => { releaseTool = resolve })
    const tool = $.tool.call(bash('straggler', 'sleep'))
    await fake.clock.settle()
    fake.holdTool = undefined
    await $.turn.complete(turnComplete('native-done'))
    await fake.clock.settle()
    expect(fake.finishes()).toEqual([sequence])
    const settled = fake.updates().find((record) => JSON.stringify(record).includes('settled-tool'))!
    const end = fake.records().find((record) => record.update?.state === 'idle')!
    expect(settled.sequence).toBeLessThan(end.sequence)

    expect((await $.prompt.submit(prompt('second'))).drop).toBeUndefined()
    releaseTool()
    await tool
    await fake.clock.settle()
    const late = fake.updates().filter((record) => JSON.stringify(record).includes('straggler'))
    expect(late).toHaveLength(1)
    expect(late.every((record) => record.turnSequence === sequence)).toBe(true)
    fake.expectClean()
  })

  test('late tool output keeps the sequence captured by its own turn', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('one')] })
    await $.session.start(sessionStart)
    await fake.share($)
    await $.prompt.submit(prompt('first'))
    await $.turn.start(turnStart('native-a', 'first'))
    await fake.clock.settle()
    const first = fake.starts()[0]!
    let releaseTool!: () => void
    fake.holdTool = new Promise<void>((resolve) => { releaseTool = resolve })
    const tool = $.tool.call(bash('slow-tool', 'sleep'))
    await fake.clock.settle()
    fake.supersede()
    await fake.clock.settle()
    expect(fake.aborts).toEqual(['native-a'])
    await $.turn.complete(turnComplete('native-a', 'aborted'))
    fake.releaseRemote()
    fake.holdTool = undefined

    expect((await $.prompt.submit(prompt('second'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-b', 'second'))
    releaseTool()
    await tool
    await fake.clock.settle()
    const second = fake.starts()[1]!
    const late = fake.updates().filter((record) => JSON.stringify(record).includes('slow-tool'))
    expect(late).toHaveLength(1)
    expect(late.every((record) => record.turnSequence === first)).toBe(true)
    expect(fake.updates().some((record) => record.turnSequence === second && JSON.stringify(record).includes('slow-tool'))).toBe(false)
    await $.turn.complete(turnComplete('native-b'))
    await fake.clock.settle()
    expect(fake.finishes()).toContain(second)
    expect(fake.aborts).toEqual(['native-a'])
    fake.expectClean()
  })
})

describe('the status band', () => {

  test('child updates preserve siblings and reconnect replaces the inventory while the parent is idle', async ($, on) => {
    const fake = fakeThreads(on)
    fake.server.children = [
      { thread_id: 'child-one', kind: 'subagent', name: 'Scout', status: 'queued' },
      { thread_id: 'sibling', kind: 'subthread', name: 'Sibling', status: 'inactive' },
    ]
    await $.session.start(sessionStart)
    await fake.share($)
    await fake.clock.settle()
    expect(await drawn($)).toContain('queued')
    fake.child({ thread_id: 'child-one', kind: 'subagent', name: 'Scout', status: 'running' })
    await fake.clock.settle()
    expect(await drawn($)).toContain('running')
    expect(await drawn($)).toContain('1 inactive')
    expect(await drawn($)).not.toContain('queued')
    fake.child({ thread_id: 'new-child', kind: 'future_kind', name: 'New', status: 'running' })
    await fake.clock.settle()
    expect(await drawn($)).toContain('+1 running')
    fake.removeChild('child-one')
    await fake.clock.settle()
    expect(await drawn($)).not.toContain('Scout')
    expect(await drawn($)).toContain('New')
    expect(await drawn($)).toContain('1 inactive')
    fake.live()!.exit(1)
    await fake.clock.settle()
    expect(await drawn($)).toContain('unknown')
    let releaseChildren!: () => void
    fake.holdChildren = new Promise<void>((resolve) => { releaseChildren = resolve })
    fake.server.children = [{ thread_id: 'child-two', kind: 'subthread', name: 'Review', status: 'failed' }]
    await fake.clock.advance(1000)
    // Readiness clears the previous connection's inventory even when discovery is delayed.
    expect(await drawn($)).not.toContain('New')
    expect(await drawn($)).not.toContain('inactive')
    expect(await drawn($)).not.toContain('Review')
    releaseChildren()
    fake.holdChildren = undefined
    await fake.clock.settle()
    expect(await drawn($)).toContain('failed')
    fake.removeChild('child-two')
    await fake.clock.settle()
    expect(await drawn($)).not.toContain('Review')
    expect(fake.starts()).toEqual([])
    fake.expectClean()
  })


  test('animates only while a turn runs, and stops with the turn and with the watcher', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    expect(await drawn($)).not.toContain('⠋')

    fake.turn('running', { user_id: 'user-bob', name: 'Bob' }, 'spin')
    await fake.clock.settle()
    expect(await drawn($)).toContain('⠋')
    await fake.clock.advance(120)
    expect(await drawn($)).toContain('⠙')
    // While a turn runs, the animation's redraw is the only timer work.
    fake.invalidates = 0
    await fake.clock.advance(120)
    expect(fake.invalidates).toBe(1)

    fake.turn('idle')
    await fake.clock.settle()
    expect(await drawn($)).toContain(LIVE)
    fake.invalidates = 0
    await fake.clock.advance(1200)
    expect(fake.invalidates).toBe(0)

    // Teardown cancels the running turn's timer as well.
    fake.turn('running', { user_id: 'user-bob', name: 'Bob' }, 'spin-again')
    await fake.clock.settle()
    await $.session.end(sessionEnd(fake.session))
    await fake.clock.settle()
    // Teardown's own redraw is not the animation; after it, no timer ticks.
    fake.invalidates = 0
    await fake.clock.advance(1200)
    expect(fake.invalidates).toBe(0)
    // A finished share leaves a separate notice timer; teardown cancels that too.
    await $.session.start(sessionStart)
    await fake.share($)
    await $.session.end(sessionEnd(fake.session))
    fake.invalidates = 0
    await fake.clock.advance(30_000)
    expect(fake.invalidates).toBe(0)
    fake.expectClean()
  })



  test('/delta share returns at once and reports in the band before exporting', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('a'), text('b'), text('c')] })
    await $.session.start(sessionStart)
    let release!: () => void
    fake.holdExport = new Promise<void>((resolve) => { release = resolve })
    // Progress is the band's alone: a started share adds no transcript row.
    expect((await $.command.run(shareCommand)).text).toBeUndefined()
    // The band reports the running share even before the watch is up.
    expect(await drawn($)).toContain('Preparing to share')
    expect(fake.exports).toBe(0)
    await fake.clock.advance(0)
    expect(fake.records()).toEqual([])
    const completed = fake.waitForShareLink()
    release()
    await completed
    expect(fake.records()).toHaveLength(3)
    fake.expectClean()
  })

  test('a prompt cannot race a share, and the band reports its progress and success', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    let release!: () => void
    fake.holdStatus = new Promise<void>((resolve) => { release = resolve })
    await $.command.run(shareCommand)
    expect(await drawn($)).toContain('Preparing to share')
    // A prompt cannot start a turn while the share is in flight.
    expect((await $.prompt.submit(prompt('race the share'))).drop).toBeDefined()
    expect(fake.entered).toEqual([])
    await fake.clock.settle()
    expect(await drawn($)).toContain('"color":"yellow"')
    release()
    await fake.clock.settle()
    // Once the share is done, a prompt is accepted again.
    expect((await $.prompt.submit(prompt('after the share'))).drop).toBeUndefined()
    fake.expectClean()
  })

  test('a peer joins the band once their arrival settles, and leaves after a grace', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    // The first report establishes the baseline; the arrival counts only after its debounce.
    fake.presence([])
    await fake.clock.settle()
    fake.presence([{ user_id: 'user-bob', name: 'Bob Stone' }])
    await fake.clock.settle()
    expect(await drawn($)).not.toContain('Bob')
    await fake.clock.advance(3000)
    expect(await drawn($)).toContain('"Bob"')
    fake.presence([])
    await fake.clock.advance(5000)
    expect(await drawn($)).not.toContain('Bob')
    fake.expectClean()
  })

  test("another participant's turn names its owner, counts up, and goes quiet only with nothing open", async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.turn('running', ADA, 'remote-turn')
    await fake.clock.settle()
    expect(await drawn($)).toContain("Ada's agent")
    await fake.clock.advance(12_000)
    expect(await drawn($)).toContain('(12s)')
    // An item still open, such as a long command, keeps the turn working however long it is silent.
    fake.upsert(remoteItem('npm test', { id: 'long', open: true }))
    await fake.clock.advance(31_000)
    expect(await drawn($)).not.toContain('quiet')
    // Its completion is activity too; 30s after it, with nothing open, the turn is quiet.
    fake.upsert(remoteItem('npm test', { id: 'long' }))
    await fake.clock.advance(29_000)
    expect(await drawn($)).not.toContain('quiet')
    await fake.clock.advance(2_000)
    expect(await drawn($)).toContain(' quiet 31s')
    fake.turn('idle')
    await fake.clock.settle()
    expect(await drawn($)).not.toContain("Ada's agent")
    fake.expectClean()
  })

  test("another participant's agent shows what it is doing once a call or thought has been open half a second", async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    fake.turn('running', ADA, 'remote-turn')
    const tool = (id: string, title: string, open: boolean) => remoteItem('', {
      id, kind: 'tool_call', turn_id: 'remote-turn', open,
      content: { toolCallId: id, title, status: open ? 'in_progress' : 'completed' },
    })
    fake.upsert(tool('quick', 'Read src/a.rs', true))
    await fake.clock.advance(200)
    fake.upsert(tool('quick', 'Read src/a.rs', false))
    fake.upsert(tool('test', 'cargo test -p thread', true))
    await fake.clock.advance(300)
    // A quick call never shows, and a slow one waits out the same half second, so bursts do not flicker.
    expect(await drawn($)).not.toContain('Read src/a.rs')
    expect(await drawn($)).not.toContain('cargo test')
    await fake.clock.advance(12_000)
    expect(await drawn($)).toContain('cargo test -p thread')
    expect(await drawn($)).toContain('(12s)')
    fake.upsert(remoteItem('', { id: 'thought', kind: 'agent_thought', turn_id: 'remote-turn', open: true, content: { text: 'Hmm' } }))
    await fake.clock.advance(600)
    expect(await drawn($)).toContain('thinking')
    fake.upsert(remoteItem('', { id: 'thought', kind: 'agent_thought', turn_id: 'remote-turn', content: { text: 'Hmm' } }))
    fake.upsert(tool('test', 'cargo test -p thread', false))
    await fake.clock.settle()
    expect(await drawn($)).not.toContain('thinking')
    expect(await drawn($)).not.toContain('cargo test')
    fake.turn('idle')
    await fake.clock.settle()
    fake.expectClean()
  })

  test('the band is a shaded row with the link to copy; it yields to a survey', async ($, on) => {
    const fake = fakeThreads(on)
    const copied: string[] = []
    let refuse = false
    on('ui.copy', (_$, e) => {
      if (!refuse) copied.push(e.text)
      const value: UiCopyResult = refuse ? { isCopied: false, reason: 'no-clipboard' } : { isCopied: true }
      return { value }
    })
    await $.session.start(sessionStart)
    await fake.share($)
    const link = `https://delta.dev/join/${fake.shareId}`
    const mount = (surface: 'terminal' | 'desktop', props: Partial<{ hasSurvey: boolean; maxRows: number }> = {}) =>
      $.ui.mount({ plugin: 'delta', surface, component: 'AbovePrompt', props: { ...abovePrompt.props, ...props } })
    // A survey owns the band, and with no room at all the band is the host's.
    expect(JSON.stringify(await (await mount('terminal', { hasSurvey: true })).drawn())).not.toContain('Delta')
    expect(JSON.stringify(await (await mount('terminal', { maxRows: 0 })).drawn())).not.toContain('Delta')
    // The terminal shades the row and shows the URL as text: a terminal without hyperlinks would
    // draw a Link's URL twice. Pressing copy puts the whole link on the clipboard, and says so
    // only once the clipboard took it.
    const terminal = await mount('terminal')
    expect(JSON.stringify(await terminal.drawn())).toContain('"backgroundColor":"#303030"')
    expect(await terminal.find({ type: 'Link' })).toBeUndefined()
    expect(await terminal.find({ type: 'Text', text: link })).toBeDefined()
    await terminal.press({ key: 'copy' })
    expect(copied).toEqual([link])
    await fake.clock.settle()
    expect(await drawn($)).toContain('✔ copied')
    await fake.clock.advance(2000)
    expect(await drawn($)).not.toContain('✔ copied')
    refuse = true
    await terminal.press({ key: 'copy' })
    await fake.clock.settle()
    expect(await drawn($)).not.toContain('✔ copied')
    // The desktop's own card sets the band apart: no shade, and a link labelled with its short form.
    const desktop = await mount('desktop')
    expect(JSON.stringify(await desktop.drawn())).not.toContain('backgroundColor')
    expect((await desktop.find({ type: 'Link' }))?.props).toMatchObject({ href: link, label: expect.stringContaining('…') })
    fake.expectClean()
  })

})

async function seedPending(
  fake: ReturnType<typeof fakeThreads>, records: (Record<string, unknown> | string)[], execution?: Record<string, unknown>,
) {
  const binding = fake.store.get(`session:${fake.session}`) as any
  const pending = []
  for (const [index, record] of records.entries()) {
    const sequence = index + 1
    const line = (typeof record === 'string' ? record : JSON.stringify(record)) + '\n'
    const file = `${CONFIG}/delta-plugin/outbox/${fake.session}/${sequence}-0.json`
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(line))
    const digest = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
    fake.files.set(file, line)
    pending.push({ sequence, files: [file], digest })
  }
  fake.store.set(`session:${fake.session}`, { ...binding, next: records.length + 1, pending, execution })
}

function expectOfferedItems(fake: ReturnType<typeof fakeThreads>, ids: string[]) {
  expect(fake.rows).toHaveLength(ids.length)
  ids.forEach((id, index) => expect(fake.rows[index]).toContain(`(item ${id})`))
}
