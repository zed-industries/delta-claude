import { describe, expect, test as kitTest, tier } from 'claude-code/testing'
import type { Engine } from 'claude-code'
import {
  CHECKOUT, abovePrompt, fakeThreads, prompt, sessionEnd, sessionStart, shareCommand, testsWithHeldClockWait, turnComplete, turnStart, typedDelta,
} from './fake-thread-commands'
import { ONBOARDING_DECLINED, ONBOARDING_QUESTION } from './setup'

tier('user')

const test = testsWithHeldClockWait(kitTest)
const POLICY = '/repo/.delta/settings.json'
/** A registered thread's status cannot reach the server while Delta is offline. */
const OFFLINE_STATUS = { operation: 'status', code: 'app_unavailable', message: 'Cannot reach Delta' } as const

/** The status band's drawn tree as text, for asserting what the person sees. */
const drawn = async ($: Engine) => JSON.stringify(await $.ui.render(abovePrompt))
/** The band as drawn when Claude gives it only `maxRows` rows. */
const drawnInRows = async ($: Engine, maxRows: number) =>
  JSON.stringify(await $.ui.render({ ...abovePrompt, props: { ...abovePrompt.props, maxRows } }))

function policy(mode: 'manual' | 'private' | 'organization', organization?: string) {
  return JSON.stringify({ threads: { mode, organization } })
}

/** Store a session that ended long ago, with its ledger; `overrides` change any binding field. */
function seedEnded(store: Map<string, unknown>, id: string, overrides: Record<string, unknown> = {}) {
  store.set(`session:${id}`, { session: id, snapshot: true, next: 1, pending: [], endedAt: -10 * 365 * 24 * 60 * 60 * 1000, ...overrides })
  store.set(`appended:${id}`, { thread: 't', items: {} })
}

type ReminderKind = 'manual' | 'not set up' | 'none'

/** The reminder the band shows a session Delta does not sync, by what it tells the person. */
async function reminderKind($: Engine): Promise<ReminderKind> {
  const band = await drawn($)
  if (band.includes('Not syncing') && band.includes('/delta-share')) return 'manual'
  return band.includes('Not set up') && band.includes('/delta-setup') ? 'not set up' : 'none'
}

/** Store a recorded session for the fixture's session to resume; `overrides` change any binding field. */
function seedResumed(fake: ReturnType<typeof fakeThreads>, overrides: Record<string, unknown> = {}) {
  fake.store.set(`session:${fake.session}`, { session: fake.session, snapshot: true, next: 1, pending: [], ...overrides })
}

function binding(fake: ReturnType<typeof fakeThreads>) {
  return fake.store.get(`session:${fake.session}`) as any
}

async function startAuto($: Engine, fake: ReturnType<typeof fakeThreads>, source = 'startup') {
  await $.session.start(sessionStart)
  await $.classic.SessionStart({ session_id: fake.session, source, cwd: CHECKOUT, transcript_path: '' } as never)
  await fake.clock.settle()
  await fake.clock.advance(0)
  await fake.clock.settle()
}

/** Run `/delta <args>` and let the share it starts on the clock finish. */
async function runShare($: Engine, fake: ReturnType<typeof fakeThreads>, args: string) {
  await $.command.run(typedDelta(args))
  await fake.clock.settle()
  await fake.clock.advance(0)
  await fake.clock.settle()
}

/** Make the server refuse the thread's recorded changes, as an append that keeps failing until resolved. */
function refuseChanges(fake: ReturnType<typeof fakeThreads>, fork?: string) {
  fake.refusedChanges = { fork }
}

describe('automatic activation', () => {
  test('a new session in a policy repository creates with its upload intent, attaches, and watches without sharing', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)

    expect(fake.server.thread).toBe(fake.threadId)
    expect(fake.server.upload).toEqual({ organization: 'org-1', visibility: 'private' })
    expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    expect(fake.operations()).toEqual(expect.arrayContaining(['create', 'attach']))
    // Private mode never publishes: activation must not run `thread share`.
    expect(fake.operations()).not.toContain('share')
    expect(fake.server.shared).toBe(false)
    expect(fake.live()?.ready).toBe(true)
    expect(binding(fake)).toMatchObject({ autoUpload: expect.anything(), snapshot: true, thread: fake.threadId, checkout: CHECKOUT })
    // The session is new, so nothing is exported.
    expect(fake.exports).toBe(0)
    fake.expectClean()
  })

  // Resume and fork take the same branch: only `startup` and `clear` start a new session.
  test('a resumed session never activates', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    await startAuto($, fake, 'resume')
    expect(fake.server.thread).toBeUndefined()
    expect(fake.operations()).not.toContain('create')
    expect(binding(fake)).toBeUndefined()
    fake.expectClean()
  })

  test('a clear session activates and uploads to the organization', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    await startAuto($, fake, 'clear')
    expect(fake.server.thread).toBe(fake.threadId)
    expect(fake.server.upload).toEqual({ organization: 'org-1', visibility: 'organization' })
    fake.expectClean()
  })

  test('a session that already holds a binding is never created again', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    // A saved binding may be an earlier share, a pending join, or a resume; activation never replaces it.
    fake.store.set(`session:${fake.session}`, { session: fake.session, snapshot: true, next: 4, pending: [], thread: 'existing-thread' })
    await startAuto($, fake)
    expect(fake.server.thread).toBeUndefined()
    expect(fake.operations()).not.toContain('create')
    fake.expectClean()
  })

  test('a CLI this plugin cannot record against leaves auto mode off and says which to update', async ($, on) => {
    const fake = fakeThreads(on)
    fake.contractRange = { min: 1, max: 3 }
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    expect(fake.server.thread).toBeUndefined()
    expect(fake.logs.join('\n')).toContain("This session isn't syncing: This Delta is too old for this plugin. Update Delta to continue.")
    expect(binding(fake)).toBeUndefined()
    fake.expectClean()
  })

  test('holds the first prompt, row, and turn until the auto decision, so none is lost', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    let release!: () => void
    // Hold the contract check itself, not create/attach: this is the window before staging.
    fake.holdRun = (operation) => operation === 'contract'
      ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // The decision is still pending: nothing is staged, so an unfixed session would drop what follows.
    expect(fake.store.get(`session:${fake.session}`)).toBeUndefined()

    const submitted = $.prompt.submit(prompt('first'))
    const appended = $.session.append({
      door: 'prompt', origin: { kind: 'composer' }, uuid: 'first-prompt',
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'first' }] },
    } as never)
    const starting = $.turn.start(turnStart('native-first', 'first'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])

    release()
    expect((await submitted).drop).toBeUndefined()
    await appended
    await starting
    await fake.clock.settle()
    await $.turn.complete(turnComplete('native-first'))
    await fake.clock.settle()
    await fake.clock.advance(120_000)
    await fake.clock.settle()

    expect(fake.updates().some((record) => JSON.stringify(record.update).includes('first'))).toBe(true)
    expect(fake.finishes()).toEqual(fake.starts())
    fake.expectClean()
  })

  test("the plugin's own question draws a hint beside each option, and no other question changes", async ($, on) => {
    const fake = fakeThreads(on)
    let drawn: any
    // Stands in for Claude Code's dialog: records what it would draw, and answers with its own drawing.
    on('ui.render', { component: 'AskUserQuestion' }, ($, e) => { drawn = e.props; return { type: 'engine', ref: 'dialog' } as never })
    fake.organizations = [{ id: 'org-1', name: 'Guild', current: false }, { id: 'org-2', name: 'Zed', current: true }]
    let answer!: (value: unknown) => void
    fake.answerQuestion = () => new Promise((resolve) => { answer = resolve })
    // A resumed session, so the setup offer stays out of the way.
    await startAuto($, fake, 'resume')
    const setup = $.command.run({ ...typedDelta('setup') } as never)
    await fake.clock.settle()
    const team = fake.questions.find((question) => question.questions[0].header === 'Team')!
    const render = (questions: unknown[]) =>
      $.ui.render({ component: 'AskUserQuestion', requestId: 'call-1', surface: 'terminal', props: { tool: 'AskUserQuestion', questions } } as never)
    await render(team.questions)
    // Only the selected team carries a hint; every other option is drawn as asked.
    expect(drawn.questions[0].options.map((option: any) => [option.label, option.description || undefined])).toEqual([
      ['Zed', 'Current team'], ['Guild', undefined], ['Cancel', undefined],
    ])
    // Claude's own question, with the same labels, is drawn as asked.
    const theirs = [{ question: 'Which library?', header: 'Library', options: [{ label: 'Zed', description: '' }, { label: 'Guild', description: '' }] }]
    await render(theirs)
    expect(drawn.questions).toEqual(theirs)
    // Once answered, the plugin's question leaves no hints behind.
    answer({ result: { answers: { [team.questions[0].question]: 'Cancel' } } })
    await setup
    await render(team.questions)
    expect(drawn.questions[0].options.every((option: any) => !option.description)).toBe(true)
    fake.expectClean()
  })

  test('a new session without a policy never holds a prompt behind the open setup offer', async ($, on) => {
    const fake = fakeThreads(on)
    let answer!: (value: unknown) => void
    fake.answerQuestion = () => new Promise((resolve) => { answer = resolve })
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.questions).toHaveLength(1)
    let answered = false
    const submitted = $.prompt.submit(prompt('while the offer is open')).then((result) => { answered = true; return result })
    await fake.clock.settle()
    expect(answered).toBe(true)
    answer({ result: { answers: { [fake.questions[0].questions[0].question]: 'Not now' } } })
    expect((await submitted).drop).toBeUndefined()
    await fake.clock.settle()
    fake.expectClean()
  })

  test('the setup offer shows plain-text options, and quitting partway through setup offers it again', async ($, on) => {
    const fake = fakeThreads(on)
    const answers: ((value: unknown) => void)[] = []
    fake.answerQuestion = () => new Promise((resolve) => { answers.push(resolve) })
    await startAuto($, fake)
    // Claude draws only plain-text options; an option it cannot read would show as nonsense or fail.
    expect(fake.questions[0].questions[0].options.map((option: { label: string }) => option.label)).toEqual(['Set up now', 'Not now'])
    answers[0]!({ result: { answers: { [fake.questions[0].questions[0].question]: 'Set up now' } } })
    await fake.clock.settle()
    // The wizard's first question is open and never answered.
    expect(fake.questions).toHaveLength(2)
    const offered = [...fake.store.keys()].find((key) => key.startsWith('setup-offered:'))!
    expect(fake.store.get(offered)).toBe(true)
    await $.session.end({ ...sessionEnd(fake.session), reason: 'prompt_input_exit' })
    expect(fake.store.get(offered)).toBe(false)
  })

  const reminderCases: { name: string; source?: string; expected: ReminderKind; arrange?: (fake: ReturnType<typeof fakeThreads>) => void }[] = [
    { name: 'an unconfigured checkout is told how to set up', expected: 'not set up' },
    { name: 'a Manual checkout is told how to share, not to set up', expected: 'manual',
      arrange: (fake) => { fake.files.set(POLICY, policy('manual')) } },
    { name: 'a headless session gets none', expected: 'none', arrange: (fake) => { fake.surfaces = [] } },
    { name: 'a session with an unfinished join gets none', source: 'resume', expected: 'none',
      arrange: (fake) => { seedResumed(fake, { snapshot: false, joinTransition: { locator: 'x' } }) } },
  ]
  for (const { name, source, expected, arrange } of reminderCases) test(`band reminder: ${name}`, async ($, on) => {
    const fake = fakeThreads(on)
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }]
    fake.answerQuestion = async () => ({ result: { answers: {} } })
    arrange?.(fake)
    await startAuto($, fake, source)
    expect(await reminderKind($)).toBe(expected)
    // The reminder lives on the band; the transcript never carries a line that a later share makes stale.
    expect(fake.logs.some((log) => log.includes('Not syncing') || log.includes('Not set up'))).toBe(false)
  })

  test('the band switches from its reminder to Syncing as soon as the session is shared, and stays so on resume', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = async () => ({ result: { answers: {} } })
    await startAuto($, fake)
    expect(await reminderKind($)).toBe('not set up')
    // The share's own question is answered as the fake answers it by default: with the organization.
    fake.answerQuestion = undefined
    // While the share runs, its progress takes the reminder's place.
    await $.command.run(shareCommand)
    expect(await reminderKind($)).toBe('none')
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(await reminderKind($)).toBe('none')
    expect(await drawn($)).toContain('Syncing')
    await $.session.end(sessionEnd(fake.session))
    await startAuto($, fake, 'resume')
    expect(await reminderKind($)).toBe('none')
    expect(await drawn($)).toContain('Syncing')
  })

  test('a session that ends during attach starts no watcher and gives no share advice', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    let release!: () => void
    fake.holdRun = (operation) => operation === 'attach'
      ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // Attach is pending; the session ends, then attach completes.
    await $.session.end(sessionEnd(fake.session))
    release()
    await fake.clock.settle()
    expect(fake.watches).toHaveLength(0)
    expect(fake.logs.join('\n')).not.toContain('/delta-share')
    fake.expectClean()
  })
})

describe('the band on an automatic session', () => {
  test('shows the link and its audience once Delta finishes the background upload, without a prompt or a share', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }]
    // `thread create` returns the upload intent before Delta registers the thread, so the first
    // status has no link. The upload is the band's operation, like a share's steps, so even a
    // one-row band shows it.
    await startAuto($, fake)
    expect(await drawnInRows($, 1)).toContain('Waiting to sync…')
    // Delta registers the thread: the URL appears, but the content upload is still running, so the
    // first-upload operation stays on the band's row instead of moving to a hidden second row.
    fake.server.registered = true
    await fake.clock.advance(1_000)
    await fake.clock.settle()
    await drawn($)
    await fake.clock.settle()
    const registering = await drawnInRows($, 1)
    expect(registering).toContain('Syncing to DeltaDB…')
    expect(registering).not.toContain('Synced to DeltaDB')
    // Only Delta's confirmation of the content ends the first-upload operation.
    fake.server.confirmed = true
    await fake.clock.advance(2_000)
    await fake.clock.settle()
    await drawn($)
    await fake.clock.settle()
    const finished = await drawn($)
    expect(finished).toContain('Synced to DeltaDB')
    expect(finished).toContain(`https://delta.dev/join/${fake.shareId}`)
    expect(finished).toContain('Shared with Zed')
    await fake.clock.advance(5_000)
    await fake.clock.settle()
    const band = await drawn($)
    expect(band).toContain(`https://delta.dev/join/${fake.shareId}`)
    expect(band).not.toContain('Synced to DeltaDB')
    // Organization mode reaches the organization through the upload, never through `thread share`.
    expect(fake.server.shared).toBe(false)
    fake.expectClean()
  })

  for (const mode of ['organization', 'private'] as const) {
    test(`a ${mode} thread in a personal organization is synced, never shared, and offers no share control`, async ($, on) => {
      const fake = fakeThreads(on)
      // The fake account's login is `tester`, so this is its personal organization by name.
      fake.files.set(POLICY, policy(mode, 'org-p'))
      fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }, { id: 'org-p', name: "tester's Organization", current: false }]
      fake.server.registered = true
      fake.server.confirmed = true
      await startAuto($, fake)
      await drawn($)
      await fake.clock.settle()
      const band = await drawn($)
      expect(band).toContain("Synced with tester's Organization")
      expect(band).not.toContain('Shared with')
      // A wide band has room for every control, so a share control would be drawn if offered.
      expect(JSON.stringify(await $.ui.render({ ...abovePrompt, props: { ...abovePrompt.props, bodyColumns: 200 } }))).not.toContain('Share with')
      fake.expectClean()
    })
  }

  test('a failed background upload shows its reason on the band', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    // Delta registered the thread but rejected the content upload, so the URL exists and the upload failed.
    fake.server.registered = true
    fake.server.uploadFailure = 'storage quota exceeded'
    await startAuto($, fake)
    await fake.clock.advance(1_000)
    await fake.clock.settle()
    await drawn($)
    await fake.clock.settle()
    const band = await drawn($)
    expect(band).toContain('Sync failed: storage quota exceeded')
    expect(band).toContain(`https://delta.dev/join/${fake.shareId}`)
    expect(band).not.toContain('Synced to DeltaDB')
    fake.expectClean()
  })

  test('follows the upload after activation even when the watcher never becomes ready', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.server.registered = true
    fake.server.confirmed = true
    // The watcher never emits readiness, so only a status read made on its own can report the link.
    fake.onWatch = () => {}
    await startAuto($, fake)
    expect(fake.live()?.ready).toBe(false)
    await fake.clock.advance(2_000)
    await fake.clock.settle()
    expect(await drawn($)).toContain(`https://delta.dev/join/${fake.shareId}`)
    fake.expectClean()
  })

  test('a private thread is labelled with its own organization and offers a share control that publishes the same thread', async ($, on) => {
    const fake = fakeThreads(on)
    // The setting names an organization other than the current one, and status names none, as real
    // CLIs have answered; the band still names the setting's.
    fake.files.set(POLICY, policy('private', 'org-2'))
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }, { id: 'org-2', name: 'Personal', current: false }]
    fake.server.reportsOrganization = false
    fake.server.registered = true
    fake.server.confirmed = true
    await startAuto($, fake)
    const thread = fake.server.thread
    // The first draw reads the organization directory; the next one names it.
    await drawn($)
    await fake.clock.settle()
    expect(await drawn($)).toContain('Synced with Personal')
    await fake.clock.settle()
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Share with Personal' })
    await terminal.press({ key: 'share' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // The existing thread is published in place: no new thread, no re-export.
    expect(fake.server.thread).toBe(thread)
    expect(fake.operations().filter((operation) => operation === 'create')).toHaveLength(1)
    expect(fake.operations()).toContain('share')
    expect(fake.exports).toBe(0)
    fake.expectClean()
  })

  test('the share control pressed during a turn shares once the turn ends', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }]
    fake.server.registered = true
    fake.server.confirmed = true
    await startAuto($, fake)
    await $.prompt.submit(prompt('working'))
    await $.turn.start(turnStart('busy', 'working'))
    await fake.clock.settle()
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Share after this turn' })
    await terminal.press({ key: 'share' })
    await fake.clock.settle()
    expect(fake.operations()).not.toContain('share')
    await terminal.find({ type: 'Button', label: 'Sharing after this turn' })
    await $.turn.complete(turnComplete('busy'))
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).toContain('share')
    fake.expectClean()
  })
})

describe('offline recording', () => {
  test('keeps a prompt and its turn while Delta is unreachable, then drains after reconnect', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)

    fake.commandFault = OFFLINE_STATUS
    fake.appendOffline = true
    expect((await $.prompt.submit(prompt('offline'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-offline', 'offline'))
    await fake.clock.settle()
    // The watcher's absence does not stop Claude's turn.
    expect(fake.aborts).toEqual([])
    // Records are appended with local acknowledgment and stay queued.
    expect(fake.delta().some((argv) => argv.includes('--acknowledge') && argv.includes('local'))).toBe(true)
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    await $.turn.complete(turnComplete('native-offline'))
    await fake.clock.settle()

    // Delta comes back; the retry drains everything without a replayed prompt.
    fake.commandFault = undefined
    fake.appendOffline = false
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake).pending).toEqual([])
    expect(fake.finishes()).toEqual(fake.starts())
    expect(fake.entered).toHaveLength(1)
    fake.expectClean()
  })

  test('a /delta share session records offline like an automatic one', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    // A shared thread is registered, so Delta's background uploader pushes what it acknowledges
    // locally: delivery while Delta is unreachable neither blocks Claude nor drops the prompt.
    fake.commandFault = OFFLINE_STATUS
    fake.appendOffline = true
    expect((await $.prompt.submit(prompt('shared offline'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-shared', 'shared offline'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    expect(fake.delta().some((argv) => argv.includes('--acknowledge') && argv.includes('local'))).toBe(true)
    fake.commandFault = undefined
    fake.appendOffline = false
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake).pending).toEqual([])
    fake.expectClean()
  })

  test('a non-retryable refusal pauses delivery but never drops a prompt or publishes', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    fake.commandFault = { operation: 'append', code: 'not_visible', message: 'thread deleted', retryable: false }
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-nonretry'))
    await fake.clock.settle()
    expect((fake.store.get(`session:${fake.session}`) as any).pending.length).toBeGreaterThan(0)
    // A delivery pause stops delivery, not Claude: the next prompt retries and is accepted.
    expect((await $.prompt.submit(prompt('next'))).drop).toBeUndefined()
    await fake.clock.settle()
    // The turn keeps running, and an automatic session never publishes as recovery.
    expect(fake.aborts).toEqual([])
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })

  test('a refused offline append pauses delivery, keeps prompts, and shows both controls until resolved', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake)
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-refused', 'one'))
    await fake.clock.settle()
    // The records stay queued and Claude keeps working: the pause stops delivery, not the turn.
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    expect(fake.aborts).toEqual([])
    expect(await drawn($)).toContain("Delta couldn't publish this thread's offline changes.")
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Fork & Restore' })
    await terminal.find({ type: 'Button', label: 'Discard' })
    // A further prompt is accepted and its records stay queued, not lost.
    expect((await $.prompt.submit(prompt('still here'))).drop).toBeUndefined()
    await fake.clock.settle()
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    // Resolving it elsewhere lets the next append succeed, which clears the choice.
    fake.refusedChanges = undefined
    expect((await $.prompt.submit(prompt('resolved elsewhere'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-resolved', 'resolved elsewhere'))
    await fake.clock.settle()
    expect(binding(fake).pending).toEqual([])
    expect(await drawn($)).not.toContain('Fork & Restore')
    fake.expectClean()
  })

  test('Fork & Restore forks the refused changes, discards the original, and drains the queued records', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake, 'thread-fork-1')
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-fork', 'one'))
    await fake.clock.settle()
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Fork & Restore' })
    await terminal.press({ key: 'fork' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).toEqual(expect.arrayContaining(['fork', 'discard']))
    expect(binding(fake).pending).toEqual([])
    expect(fake.logs.filter((log) => log.includes('thread-fork-1'))).toHaveLength(1)
    expect(await drawn($)).not.toContain('Fork & Restore')
    fake.expectClean()
  })

  test('a failed discard after a fork stays paused with the controls and can fork again', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake, 'thread-fork-2')
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-fork-failed', 'one'))
    await fake.clock.settle()
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    // The discard fails after the fork, so the refusal stays and the person may try again.
    fake.commandFault = { operation: 'discard', code: 'failed', message: 'discard failed', retryable: false }
    await terminal.find({ type: 'Button', label: 'Fork & Restore' })
    await terminal.press({ key: 'fork' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).toEqual(expect.arrayContaining(['fork', 'discard']))
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    expect(await drawn($)).toContain('Fork & Restore')
    fake.expectClean()
  })

  test('Discard drops the refused changes and drains the queued records', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake)
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-discard', 'one'))
    await fake.clock.settle()
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Discard' })
    await terminal.press({ key: 'discard' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).toContain('discard')
    expect(binding(fake).pending).toEqual([])
    expect(await drawn($)).not.toContain('Discard')
    fake.expectClean()
  })

  // Create and attach leave the same staged binding until both finish, so holding attach covers
  // the window for either.
  test('a prompt and rows arriving during activation are accepted and drain once it completes', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    let release!: () => void
    fake.holdRun = (operation) => operation === 'attach' ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // The thread exists but the checkout is not attached: a prompt must still be accepted, and its
    // turn must not be stopped, while activation is in flight.
    expect(binding(fake).thread).toBeUndefined()
    expect((await $.prompt.submit(prompt('during attach'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-attach'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    release()
    await fake.clock.settle()
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake)).toMatchObject({ thread: fake.threadId, checkout: CHECKOUT, pending: [] })
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })

  test('a session that ended before activation finished completes it on resume without dropping a prompt or stopping its turn', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.commandFault = { operation: 'create', code: 'app_unavailable', message: 'Delta is unreachable', retryable: true }
    await startAuto($, fake)
    expect(binding(fake)).toMatchObject({ autoUpload: expect.anything(), snapshot: true })
    expect(binding(fake).thread).toBeUndefined()
    await $.session.end(sessionEnd(fake.session))
    expect(binding(fake).endedAt).toEqual(expect.any(Number))

    fake.commandFault = undefined
    await startAuto($, fake, 'resume')
    expect((await $.prompt.submit(prompt('after resume'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-resumed'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake)).toMatchObject({ thread: fake.threadId, checkout: CHECKOUT })
    expect(binding(fake).endedAt).toBeUndefined()
    expect(fake.server.upload).toEqual({ organization: 'org-1', visibility: 'private' })
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })

  test('a policy naming an organization the account is not in records nothing and explains once per repository', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-other'))
    const explained = () => fake.logs.filter((log) => log.includes("org-other, which your Delta account isn't a member of")).length
    await startAuto($, fake)
    // The membership check runs before staging, so nothing is created or queued.
    expect(fake.operations()).not.toContain('create')
    expect(binding(fake)).toBeUndefined()
    expect(await drawn($)).toContain("isn't in this repo's team")
    expect(explained()).toBe(1)
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await fake.clock.settle()
    expect(fake.operations()).not.toContain('create')
    expect(binding(fake)).toBeUndefined()

    // The next new session in the repository keeps the band line without repeating the explanation.
    await startAuto($, fake, 'clear')
    expect(await drawn($)).toContain("isn't in this repo's team")
    expect(explained()).toBe(1)
    fake.expectClean()
  })

  test('a permanent refusal during activation stops recording and removes what was queued', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    // Memberships aren't loaded, so only the create itself can refuse.
    fake.organizations = []
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.commandFault = { operation: 'create', code: 'not_visible', reason: 'organization_not_member', message: 'not a member of org-1', retryable: false }
    let release!: () => void
    fake.holdRun = (operation) => operation === 'create' ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await startAuto($, fake)
    expect((await $.prompt.submit(prompt('during create'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-refused', 'during create'))
    await fake.clock.settle()
    const queued = binding(fake).pending.flatMap((entry: any) => entry.files)
    expect(queued.length).toBeGreaterThan(0)

    release()
    await fake.clock.settle()
    expect(binding(fake)).toBeUndefined()
    expect(queued.filter((path: string) => fake.files.has(path))).toEqual([])
    expect(await drawn($)).toContain("isn't in this repo's team")
    // Nothing retries: the next prompt is accepted without another create or a new queue.
    expect((await $.prompt.submit(prompt('after'))).drop).toBeUndefined()
    await fake.clock.settle()
    expect(fake.operations().filter((operation) => operation === 'create')).toHaveLength(1)
    expect(binding(fake)).toBeUndefined()
    fake.expectClean()
  })
})

describe('setup command and policy problems', () => {
  test('a headless session refuses /delta setup and never offers onboarding', async ($, on) => {
    const fake = fakeThreads(on)
    fake.surfaces = []
    await startAuto($, fake)
    expect(fake.delta().some((argv) => argv.includes('org'))).toBe(false)
    const answer = await $.command.run({ ...typedDelta('setup') } as never)
    expect((answer as any).text).toContain('needs an interactive Claude Code terminal')
    expect(fake.files.has(POLICY)).toBe(false)
    expect(fake.authCalls).toEqual([])
    fake.expectClean()
  })

  test('a malformed policy is reported once and leaves the checkout recording manually', async ($, on) => {
    const fake = fakeThreads(on)
    const broken = '{ not json'
    fake.files.set(POLICY, broken)
    await startAuto($, fake)
    expect(fake.logs.join('\n')).toContain("couldn't be used")
    expect(fake.files.get(POLICY)).toBe(broken)
    expect(fake.server.thread).toBeUndefined()
    expect(fake.operations()).not.toContain('create')
    fake.expectClean()
  })
})

describe('store retention', () => {
  test('the store prunes a long-ended session through activation, and keeps every unsettled one', async ($, on) => {
    const fake = fakeThreads(on)
    const store = fake.store as Map<string, unknown>
    seedEnded(store, 'expired')
    seedEnded(store, 'marked-recent', { endedAt: 0 })
    seedEnded(store, 'keeper', { next: 5, pending: [{ sequence: 1, files: [], digest: 'x' }] })
    seedEnded(store, 'captured', { captureFailure: 'disk full' })
    seedEnded(store, 'joining', { joinTransition: { locator: 'x' } })
    seedEnded(store, 'live', { endedAt: undefined })
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    const keys = [...store.keys()]
    expect(keys).not.toContain('session:expired')
    expect(keys).not.toContain('appended:expired')
    // Never a binding without an end marker, one within the horizon, or one something still needs.
    for (const id of ['live', 'marked-recent', 'keeper', 'captured', 'joining']) expect(keys).toContain(`session:${id}`)
    fake.expectClean()
  })

  test('a session resumed in another process during pruning keeps its binding', async ($, on) => {
    const fake = fakeThreads(on)
    const store = fake.store as Map<string, unknown>
    seedEnded(store, 'resumed')
    seedEnded(store, 'later')
    // Pruning is still reading another session when a second Claude process resumes this one, which
    // drops its end marker and queues a record; nothing read before that may delete it afterwards.
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    let held = false
    fake.holdStoreGet = (storeKey) => storeKey === 'session:later' && !held ? (held = true, paused) : undefined
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(held).toBe(true)
    store.set('session:resumed', { session: 'resumed', snapshot: true, next: 2, pending: [{ sequence: 1, files: [], digest: 'x' }] })
    release()
    await fake.clock.settle()
    expect(store.get('session:resumed')).toMatchObject({ pending: [{ sequence: 1 }] })
    fake.expectClean()
  })
})

describe('setup dialogs and notices', () => {
  test('/delta setup writes the policy after its questions are answered', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = (question: any) => {
      const text = question.questions[0].question
      // Choose the team and the private option as the person would, by their offered labels.
      const offered = question.questions[0].options.map((option: { label: string }) => option.label)
      const answer = offered.find((label: string) => label === 'Zed' || label.startsWith('Private sync'))
      return { result: { answers: { [text]: answer } } }
    }
    await $.session.start(sessionStart)
    const { text } = await $.command.run({ ...typedDelta('setup') } as never)
    expect(JSON.parse(fake.files.get(POLICY)!)).toEqual({ threads: { mode: 'private', organization: 'org-1' } })
    // The setting starts with the next session, so the band now says this one isn't syncing.
    expect(await reminderKind($)).toBe('manual')
    // The answer names what was saved.
    expect(text).toContain('Saved Private sync with Zed to .delta/settings.json')
    fake.expectClean()
  })

  test('/delta setup offers to create an organization when the account has none, and syncs to it', async ($, on) => {
    const fake = fakeThreads(on)
    fake.organizations = []
    fake.answerQuestion = (question: any) => {
      const text = question.questions[0].question
      const offered: string[] = question.questions[0].options.map((option: { label: string }) => option.label)
      const answer = text.startsWith('Create a team to more easily share') ? 'Acme'
        : text.startsWith('Who should join') ? 'Invite later'
        : offered.find((label) => label.startsWith('Private sync'))
      return { result: { answers: { [text]: answer } } }
    }
    await $.session.start(sessionStart)
    await $.command.run({ ...typedDelta('setup') } as never)
    expect(fake.commands.filter((argv) => argv.includes('create'))).toEqual([[expect.any(String), '--json', 'org', 'create', '--', 'Acme']])
    expect(JSON.parse(fake.files.get(POLICY)!)).toEqual({ threads: { mode: 'private', organization: 'org-created' } })
    fake.expectClean()
  })

  test('/delta share in a repository without a Git remote says so before asking or uploading anything', async ($, on) => {
    const fake = fakeThreads(on)
    fake.gitRemotes = []
    await $.session.start(sessionStart)
    const outcome = await fake.share($)
    expect(outcome).toBe("Delta didn't share this session: This repository has no Git remote, and Delta needs one to sync it. Add a remote and push to it, then run /delta-share again.")
    expect(fake.questions.filter((question) => question.questions[0].header === 'Delta share')).toEqual([])
    expect(fake.cliSetups).toEqual([])
    expect(fake.server.thread).toBeUndefined()
    fake.expectClean()
  })

  test('bare /delta opens a menu that runs the chosen action', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = (question: any) => {
      const text = question.questions[0].question
      const offered: string[] = question.questions[0].options.map((option: { label: string }) => option.label)
      const answer = text === 'What would you like to do with Delta?' ? 'Set up this repository'
        : offered.find((label) => label === 'Zed' || label.startsWith('Manual'))
      return { result: { answers: { [text]: answer } } }
    }
    // A resumed session, so the setup offer a newly loaded plugin makes stays out of the way.
    await startAuto($, fake, 'resume')
    const { text } = await $.command.run({ ...typedDelta('') } as never)
    expect(text).toContain('Saved Manual with Zed')
    fake.expectClean()
  })

  test('syncing this session from /delta setup after Private sync uploads it privately, never to the team', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = (question: any) => {
      const text = question.questions[0].question
      const offered: string[] = question.questions[0].options.map((option: { label: string }) => option.label)
      return { result: { answers: { [text]: offered.find((label) => label === 'Zed' || label.startsWith('Private sync') || label === 'Sync it') } } }
    }
    await $.session.start(sessionStart)
    const { text } = await $.command.run({ ...typedDelta('setup') } as never)
    expect(text).toContain('Syncing this session now.')
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.server.upload).toMatchObject({ visibility: 'private' })
    expect(fake.operations()).not.toContain('share')
    expect(fake.server.shared).toBe(false)
    fake.expectClean()
  })

  test('/delta share in a Manual repository shares to its saved team, not the selected organization', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('manual', 'org-2'))
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }, { id: 'org-2', name: 'Acme', current: false }]
    await $.session.start(sessionStart)
    await fake.share($)
    expect(fake.commands.find((argv) => argv.includes('create'))).toEqual(expect.arrayContaining(['--organization', 'org-2', '--visibility', 'private']))
    expect(fake.server.shared).toBe(true)
    await drawn($)
    await fake.clock.settle()
    expect(await drawn($)).toContain('Shared with Acme')
    fake.expectClean()
  })

  test('/delta share asks who should see the session: "just me" syncs it privately without publishing', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('manual', 'org-2'))
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }, { id: 'org-2', name: 'Acme', current: false }]
    fake.answerQuestion = (question: any) =>
      ({ result: { answers: { [question.questions[0].question]: 'Just me (sync privately)' } } })
    await $.session.start(sessionStart)
    await runShare($, fake, 'share')
    expect(fake.commands.find((argv) => argv.includes('create'))).toEqual(expect.arrayContaining(['--organization', 'org-2', '--visibility', 'private']))
    expect(fake.server.upload).toEqual({ organization: 'org-2', visibility: 'private' })
    expect(fake.operations()).not.toContain('share')
    // Delta's background uploader now owns the session, as it does for Private sync.
    expect(binding(fake)).toMatchObject({ thread: fake.threadId, autoUpload: { mode: 'private', organization: 'org-2' } })
    expect(fake.live()?.ready).toBe(true)
    fake.expectClean()
  })

  test('/delta share with addresses invites them without publishing', async ($, on) => {
    const fake = fakeThreads(on)
    fake.inviteFailures = { 'bo@example.com': 'already a member' }
    await $.session.start(sessionStart)
    await runShare($, fake, 'share ada@example.com, bo@example.com')
    expect(fake.server.invited).toEqual(['ada@example.com', 'bo@example.com'])
    expect(fake.operations()).not.toContain('share')
    expect(fake.logs.join('\n')).toContain(`Invited ada@example.com to this session. Couldn't invite bo@example.com (already a member). Link: https://delta.dev/join/${fake.shareId}`)
    expect(binding(fake)).toMatchObject({ url: `https://delta.dev/join/${fake.shareId}` })
    // Keeping the audience of a thread whose audience Delta never reported, as after an interrupted
    // invitation, reconnects it without publishing it to the team.
    fake.store.set(`session:${fake.session}`, { ...binding(fake), visibility: undefined })
    fake.answerQuestion = (question: any) =>
      ({ result: { answers: { [question.questions[0].question]: 'Keep current sharing' } } })
    await runShare($, fake, 'share')
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })

  test('dismissing the share question shares nothing', async ($, on) => {
    const fake = fakeThreads(on, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    fake.answerQuestion = () => ({ deny: 'dismissed' })
    await $.session.start(sessionStart)
    await runShare($, fake, 'share')
    expect(fake.exports).toBe(0)
    expect(fake.server.thread).toBeUndefined()
    // The band drops the share's progress rather than reporting a failure.
    expect(await drawn($)).not.toContain('Preparing to share')
    expect(fake.logs.join('\n')).not.toContain('Delta sharing failed')
    fake.expectClean()
  })

  test('accepting the startup offer signs in before setup and updates the band once it saves', async ($, on) => {
    const fake = fakeThreads(on)
    fake.authReplies = [
      { status: 'signed_out' },
      { status: 'pending', login_id: 'attempt', url: 'https://example.com/login', expires_at: '2099-01-01T00:15:00Z' },
      { status: 'signed_in', account: { account_id: 'user' } },
    ]
    fake.answerQuestion = (question: any) => {
      const text = question.questions[0].question
      const offered = question.questions[0].options.map((option: { label: string }) => option.label)
      const answer = text === ONBOARDING_QUESTION ? 'Set up now'
        : text.startsWith('Delta needs you to sign in') ? 'Sign in'
        : offered.find((label: string) => label === 'Zed' || label.startsWith('Manual'))
      return { result: { answers: { [text]: answer } } }
    }
    await startAuto($, fake)
    expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status', 'login', 'wait'])
    expect(JSON.parse(fake.files.get(POLICY)!)).toEqual({ threads: { mode: 'manual', organization: 'org-1' } })
    expect(await reminderKind($)).toBe('manual')
  })

  test('the onboarding offer is shown once per repository, then never again', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = (question: any) => ({
      result: { answers: { [question.questions[0].question]: 'Not now' } },
    })
    const startup = async () => {
      await $.session.start(sessionStart)
      await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
      await fake.clock.settle()
      await fake.clock.advance(0)
      await fake.clock.settle()
    }
    await startup()
    expect(fake.questions).toHaveLength(1)
    // A second session in the same repository sees the recorded marker and is not offered again.
    await $.session.end(sessionEnd(fake.session))
    await startup()
    expect(fake.questions).toHaveLength(1)
    expect(fake.authCalls).toEqual([])
    fake.expectClean()
  })

  test('a plugin installed into a running session offers setup there, and declining names /delta-setup', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = (question: any) => ({
      result: { answers: { [question.questions[0].question]: 'Not now' } },
    })
    // Claude reports no start (`classic.SessionStart`) to a plugin enabled in a running session.
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.questions.map((question) => question.questions[0].question)).toEqual([ONBOARDING_QUESTION])
    expect(fake.logs).toContain(ONBOARDING_DECLINED)
    fake.expectClean()
  })

  test('a plugin installed into a running session never starts recording it automatically', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).not.toContain('create')
    expect(fake.questions).toEqual([])
    fake.expectClean()
  })
})
