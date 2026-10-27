import { type Engine, expect, test as kitTest, tier } from 'claude-code/testing'
import {
  abovePrompt, CHECKOUT, fakeThreads, prompt, sessionEnd, sessionStart, shareCommand, testsWithHeldClockWait,
  turnComplete, turnStart, typedDelta,
} from '../testing/fake-thread-commands'
import { authLoginCommand } from './auth'

tier('user')
const test = testsWithHeldClockWait(kitTest)

/** Start a fresh session under a repository's automatic private-sync policy. */
async function startAutomatic($: Engine, fake: ReturnType<typeof fakeThreads>) {
  fake.files.set(`${CHECKOUT}/.delta/settings.json`, JSON.stringify({ threads: { mode: 'private', organization: 'org-1' } }))
  fake.turns = 0
  await $.session.start(sessionStart)
  await fake.settle()
  await fake.advance(0)
  await fake.settle()
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`automatic sync in ${surface} signs in without blocking work, then uploads the same session`, async ($, on) => {
    const fake = fakeThreads(on)
    fake.surfaces = [surface]
    fake.failOrgList = true
    fake.authReplies = loginReplies()
    let finish!: () => void
    fake.holdAuth = new Promise<void>((resolve) => { finish = resolve })
    await startAutomatic($, fake)
    expect(fake.authCalls.map((argv) => argv.slice(2))).toEqual([
      ['auth', 'status'], ['auth', 'login', '--no-wait'], ['auth', 'wait', 'attempt'],
    ])
    expect(fake.authCalls.every((argv) => argv[0] === '/selected/delta')).toBe(true)
    expect(fake.logs.join('\n')).toContain('https://example.com/login')
    expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain('Waiting for Delta sign-in')
    expect(fake.server.thread).toBeUndefined()

    // Neither the prompt nor its live rows wait on the browser, and no command uploads them yet.
    expect((await $.prompt.submit(prompt('while signing in'))).drop).toBeUndefined()
    await $.session.append({
      door: 'prompt', origin: { kind: 'composer' }, uuid: 'during-login',
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'while signing in' }] },
    } as never)
    await $.turn.start(turnStart('native-login', 'while signing in'))
    await $.turn.complete(turnComplete('native-login'))
    await fake.settle()
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({
      snapshot: true, autoUpload: { mode: 'private', organization: 'org-1' }, pending: expect.anything(),
    })
    expect(fake.records()).toEqual([])
    // Prompts during login do not start extra login attempts.
    expect(fake.authCalls).toHaveLength(3)

    fake.failOrgList = false
    finish()
    await fake.settle()
    await fake.advance(0)
    await fake.settle()
    expect(fake.server.thread).toBe(fake.threadId)
    expect(fake.server.upload).toEqual({ organization: 'org-1', visibility: 'private' })
    expect(fake.updates().some((record) => JSON.stringify(record.update).includes('while signing in'))).toBe(true)
    expect(fake.finishes()).toEqual(fake.starts())
    expect(fake.exports).toBe(0)
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })
}

test('headless automatic sync stays noninteractive when signed out', async ($, on) => {
  const fake = fakeThreads(on)
  fake.surfaces = []
  fake.failOrgList = true
  await startAutomatic($, fake)
  expect(fake.authCalls).toEqual([])
  expect(fake.server.thread).toBeUndefined()
  expect(fake.store.get(`session:${fake.session}`)).toBeUndefined()
  expect(fake.logs.join('\n')).toContain('delta auth login')
  fake.expectClean()
})

test('automatic sync rechecks organization membership after browser sign-in', async ($, on) => {
  const fake = fakeThreads(on)
  fake.failOrgList = true
  fake.authReplies = loginReplies()
  let finish!: () => void
  fake.holdAuth = new Promise<void>((resolve) => { finish = resolve })
  await startAutomatic($, fake)
  fake.failOrgList = false
  fake.organizations = [{ id: 'another-org', name: 'Another team', current: true }]
  finish()
  await fake.settle()
  expect(fake.server.thread).toBeUndefined()
  expect(fake.store.get(`session:${fake.session}`)).toBeUndefined()
  expect(fake.logs.join('\n')).toContain("isn't a member of")
  fake.expectClean()
})

for (const status of ['cancelled', 'expired', 'access_denied'] as const) {
  test(`automatic sign-in ending with ${status} stops recording and does not reopen the browser on prompts`, async ($, on) => {
    const fake = fakeThreads(on)
    fake.failOrgList = true
    fake.authReplies = [...loginReplies().slice(0, 2), { status }]
    let finish!: () => void
    fake.holdAuth = new Promise<void>((resolve) => { finish = resolve })
    await startAutomatic($, fake)
    await $.session.append({
      door: 'prompt', origin: { kind: 'composer' }, uuid: 'before-login-failed',
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'before login failed' }] },
    } as never)
    await $.turn.start(turnStart('native-login-failed', 'before login failed'))
    await $.turn.complete(turnComplete('native-login-failed'))
    await fake.settle()
    expect([...fake.files.keys()].some((path) => path.includes('/outbox/'))).toBe(true)
    finish()
    await fake.settle()
    expect(fake.server.thread).toBeUndefined()
    expect(fake.store.get(`session:${fake.session}`)).toBeUndefined()
    expect([...fake.files.keys()].some((path) => path.includes('/outbox/'))).toBe(false)
    expect(fake.logs.join('\n')).toContain("This session isn't syncing. Run /delta-share to retry.")
    const calls = fake.authCalls.length
    expect((await $.prompt.submit(prompt('after sign-in stopped'))).drop).toBeUndefined()
    await fake.settle()
    expect(fake.authCalls).toHaveLength(calls)
    expect(fake.authCalls.some((argv) => ['cancel', 'logout'].includes(argv[3]!))).toBe(false)

    // Explicit recovery still exports the conversation from Claude, not the removed automatic outbox.
    fake.failOrgList = false
    fake.authReplies = loginReplies()
    const recovered = await fake.share($)
    expect(recovered).toContain(`https://delta.dev/join/${fake.shareId}`)
    expect(fake.exports).toBe(1)
    expect(fake.server.thread).toBe(fake.threadId)
    fake.expectClean()
  })
}

test('ending an automatically syncing session closes its login waiter without cancelling the shared attempt', async ($, on) => {
  const fake = fakeThreads(on)
  fake.failOrgList = true
  fake.authReplies = loginReplies()
  fake.holdAuth = new Promise(() => {})
  await startAutomatic($, fake)
  expect(fake.authCalls.at(-1)?.[3]).toBe('wait')
  await $.session.end(sessionEnd(fake.session))
  await fake.advance(250)
  expect(fake.authWaitClosed).toBe(true)
  expect(fake.server.thread).toBeUndefined()
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status', 'login', 'wait'])
})

test('share signs in an existing installation before exporting, then continues on the selected CLI', async ($, on) => {
  const fake = fakeThreads(on, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  fake.authReplies = loginReplies()
  let finish!: () => void
  fake.holdAuth = new Promise<void>((resolve) => { finish = resolve })
  await $.session.start(sessionStart)
  expect(fake.authCalls).toEqual([])
  await $.command.run(shareCommand)
  await fake.advance(0)
  expect(fake.authCalls.map((argv) => argv.slice(2))).toEqual([
    ['auth', 'status'], ['auth', 'login', '--no-wait'], ['auth', 'wait', 'attempt'],
  ])
  expect(fake.authCalls.every((argv) => argv[0] === '/selected/delta')).toBe(true)
  expect(fake.logs.join('\n')).toContain('https://example.com/login')
  expect(fake.server.thread).toBeUndefined()
  expect(fake.records()).toEqual([])
  const shared = fake.waitForShareLink()
  finish()
  await fake.settle()
  await fake.advance(0)
  expect(await shared).toBe(`https://delta.dev/join/${fake.shareId}`)
  await $.session.end(sessionEnd(fake.session))
  const calls = fake.authCalls.length
  await $.session.start({ ...sessionStart, reason: 'resume' } as never)
  await fake.advance(0)
  expect(fake.authCalls).toHaveLength(calls)
  fake.expectClean()
})

test('failed and unknown authentication outcomes stop share without creating a thread', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  for (const status of ['cancelled', 'expired', 'access_denied', 'wrong_account', 'future_state', 'pending']) {
    fake.authReplies = status === 'cancelled' || status === 'expired'
      ? [...loginReplies().slice(0, 2), { status }]
      : status === 'pending' ? [{ status: 'signed_out' }, { status, login_id: 'broken' }]
      : [{ status, message: 'Access requires approval', url: 'https://example.com/access' }]
    const result = await fake.share($)
    expect(result).toContain('Delta sharing failed')
    if (status === 'access_denied') {
      expect(result).toContain('https://example.com/access')
      expect(result).toContain("Resolve access, then run in your shell: '/selected/delta' auth login. After signing in again, retry /delta-share or /delta-join <link>.")
    }
    expect(fake.server.thread).toBeUndefined()
    expect(fake.records()).toEqual([])
  }
  expect(fake.authCalls.some((argv) => ['cancel', 'logout'].includes(argv[3]!))).toBe(false)
  fake.expectClean()
})

const TERMS_DENIAL = { status: 'access_denied', reason: 'terms_not_accepted', message: 'Accept the terms.', url: 'https://zed.dev/delta/terms' }

/** Answer the plugin's offer to open the beta terms with `answer`, leaving every other question to the fake. */
function answerTerms(fake: ReturnType<typeof fakeThreads>, answer: string) {
  fake.answerQuestion = (question: any) => {
    const text = question.questions[0].question
    if (text.startsWith('Delta needs you to accept its beta terms')) return { result: { answers: { [text]: answer } } }
  }
}

test('unaccepted beta terms open in the browser on request, and the share continues once they are accepted', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  fake.authReplies = [TERMS_DENIAL, TERMS_DENIAL]
  answerTerms(fake, 'Open the beta terms')
  await $.command.run(shareCommand)
  await fake.advance(0)
  await fake.settle()
  expect(fake.opened).toEqual(['https://zed.dev/delta/terms'])
  expect(fake.server.thread).toBeUndefined()
  // Delta reports the sign-in once the terms are accepted on the web; nothing asks the person to retry.
  await fake.advance(2_000)
  await fake.settle()
  expect(fake.server.thread).toBeUndefined()
  await fake.advance(2_000)
  await fake.settle()
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status', 'status', 'status'])
  expect(fake.server.thread).toBeDefined()
  expect(fake.logs.join('\n')).not.toContain('beta terms')
  expect(fake.logs.every((log) => !log.includes('\n'))).toBe(true)
  fake.expectClean()
})

test('sign-in waits for the person to ask for it, and declining opens no browser', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  fake.authReplies = loginReplies()
  fake.answerQuestion = (question: any) => {
    const text = question.questions[0].question
    if (text.startsWith('Delta needs you to sign in')) return { result: { answers: { [text]: 'Not now' } } }
  }
  await $.command.run(shareCommand)
  await fake.advance(0)
  await fake.settle()
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status'])
  expect(fake.logs).toContain("Delta isn't signed in. Run /delta-share or /delta-join <link> again to sign in.")
  expect(fake.logs.join('\n')).not.toContain('Delta sharing failed')
  expect(fake.server.thread).toBeUndefined()
  fake.expectClean()
})

test('declining sign-in for automatic sync leaves the session unsynced without opening a browser', async ($, on) => {
  const fake = fakeThreads(on)
  fake.failOrgList = true
  fake.authReplies = loginReplies()
  fake.answerQuestion = (question: any) => {
    const text = question.questions[0].question
    if (text.startsWith('Delta needs you to sign in')) return { result: { answers: { [text]: 'Not now' } } }
  }
  await startAutomatic($, fake)
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status'])
  expect(fake.logs).toContain("Delta isn't signed in. Run /delta-share again to sign in.")
  expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain('Not syncing')
  expect(fake.server.thread).toBeUndefined()
  fake.expectClean()
})

/** Answer the beta-terms offer by opening them, and an offer to stop waiting with `stop`. */
function answerWait(fake: ReturnType<typeof fakeThreads>, stop: string) {
  fake.answerQuestion = (question: any) => {
    const text = question.questions[0].question
    if (text.startsWith('Delta needs you to accept its beta terms')) return { result: { answers: { [text]: 'Open the beta terms' } } }
    if (text.endsWith('Stop waiting?')) return { result: { answers: { [text]: stop } } }
  }
}

test('running /delta-share again while the beta terms are awaited offers to stop waiting', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  fake.authReplies = [TERMS_DENIAL, TERMS_DENIAL, TERMS_DENIAL]
  answerWait(fake, 'Stop waiting')
  await $.command.run(shareCommand)
  await fake.advance(0)
  await fake.settle()
  expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain("Waiting for Delta's beta terms")
  expect((await $.command.run(shareCommand)).text).toBeUndefined()
  await fake.settle()
  expect(fake.questions.at(-1)?.questions[0].question).toBe('Delta is waiting for you to accept its beta terms in your browser. Stop waiting?')
  expect(fake.logs).toContain("Stopped waiting for Delta's beta terms. Run /delta-share or /delta-join <link> again to accept them.")
  expect(fake.logs.join('\n')).not.toContain('Delta sharing failed')
  // Nothing polls once stopped, and a new share can start.
  const polls = fake.authCalls.length
  await fake.advance(10_000)
  await fake.settle()
  expect(fake.authCalls).toHaveLength(polls)
  expect(fake.server.thread).toBeUndefined()
  fake.authReplies = []
  await $.command.run(shareCommand)
  await fake.advance(0)
  await fake.settle()
  expect(fake.server.thread).toBeDefined()
  fake.expectClean()
})

test('keeping the wait leaves the share waiting for the beta terms, without a second share', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  fake.authReplies = [TERMS_DENIAL, TERMS_DENIAL]
  answerWait(fake, 'Keep waiting')
  await $.command.run(shareCommand)
  await fake.advance(0)
  await fake.settle()
  expect((await $.command.run(shareCommand)).text).toBeUndefined()
  await fake.settle()
  expect(fake.questions.at(-1)?.questions[0].question).toBe('Delta is waiting for you to accept its beta terms in your browser. Stop waiting?')
  await fake.advance(2_000)
  await fake.settle()
  await fake.advance(2_000)
  await fake.settle()
  expect(fake.server.thread).toBeDefined()
  expect(fake.logs.join('\n')).not.toContain('Stopped waiting')
  expect(fake.logs.join('\n')).not.toContain('already in progress')
  fake.expectClean()
})

test('stopping automatic sync while sign-in waits closes the waiter and leaves the session unsynced', async ($, on) => {
  const fake = fakeThreads(on)
  fake.failOrgList = true
  fake.authReplies = loginReplies()
  fake.holdAuth = new Promise(() => {})
  answerWait(fake, 'Stop waiting')
  await startAutomatic($, fake)
  expect(fake.authCalls.at(-1)?.[3]).toBe('wait')
  expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain('Waiting for Delta sign-in')
  await $.command.run(shareCommand)
  await fake.advance(0)
  await fake.settle()
  expect(fake.questions.at(-1)?.questions[0].question).toBe('Delta is waiting for you to finish signing in with your browser. Stop waiting?')
  expect(fake.authWaitClosed).toBe(true)
  expect(fake.authCalls.some((argv) => ['cancel', 'logout'].includes(argv[3]!))).toBe(false)
  expect(fake.logs).toContain('Stopped waiting for Delta sign-in. Run /delta-share again to sign in.')
  expect(JSON.stringify(await $.ui.render(abovePrompt))).toContain('Not syncing')
  expect(fake.server.thread).toBeUndefined()
  fake.expectClean()
})

test('declined beta terms leave a one-line explanation with the terms link, without a failure or a new sign-in', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  fake.authReplies = [TERMS_DENIAL]
  answerTerms(fake, 'Not now')
  await $.command.run(shareCommand)
  await fake.advance(0)
  await fake.settle()
  expect(fake.opened).toEqual([])
  expect(fake.logs).toContain("Delta's beta terms aren't accepted. Accept them at https://zed.dev/delta/terms, then run /delta-share or /delta-join <link> again.")
  expect(fake.logs.join('\n')).not.toContain('Delta sharing failed')
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status'])
  expect(fake.server.thread).toBeUndefined()
  fake.expectClean()
})

test('reauthentication recovery quotes absolute paths for POSIX shells and PowerShell', () => {
  expect(authLoginCommand("/apps/Delta's build/$delta", false)).toBe(`'/apps/Delta'"'"'s build/$delta' auth login`)
  expect(authLoginCommand("C:\\Delta's build\\$delta.exe", true)).toBe("& 'C:\\Delta''s build\\$delta.exe' auth login")
})

test('changing sessions closes the login waiter without cancelling a shared login or continuing share', async ($, on) => {
  const fake = fakeThreads(on)
  fake.authReplies = loginReplies()
  fake.holdAuth = new Promise(() => {})
  await $.session.start(sessionStart)
  await $.command.run(shareCommand)
  await fake.advance(0)
  expect(fake.authCalls.at(-1)?.[3]).toBe('wait')
  await $.session.end(sessionEnd(fake.session))
  await fake.advance(250)
  expect(fake.authWaitClosed).toBe(true)
  expect(fake.server.thread).toBeUndefined()
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status', 'login', 'wait'])
})

test('setup installs Delta and finishes browser sign-in before creating a team and saving the policy', async ($, on) => {
  const fake = fakeThreads(on)
  fake.cliMissing = true
  fake.organizations = []
  fake.authReplies = loginReplies()
  let finish!: () => void
  fake.holdAuth = new Promise<void>((resolve) => { finish = resolve })
  fake.answerQuestion = (question: any) => {
    const text = question.questions[0].question
    const answer = text.startsWith('Create a team to more easily share') ? 'Acme'
      : text.startsWith('Delta needs you to sign in') ? 'Sign in'
      : text.startsWith('Who should join') ? 'Invite later' : 'Private sync'
    return { result: { answers: { [text]: answer } } }
  }
  // A resumed session in a repository already offered setup, so the offer stays out of the way.
  fake.store.set(`setup-offered:${fake.gitCommonDir}`, true)
  await $.session.start(sessionStart)
  await fake.settle()
  expect(fake.authCalls).toEqual([])
  const setup = $.command.run(typedDelta('setup'))
  await fake.waitForLog(0, (log) => log.includes('Finish signing in'))
  await fake.settle()
  expect(fake.authCalls.map((argv) => argv.slice(2))).toEqual([
    ['auth', 'status'], ['auth', 'login', '--no-wait'], ['auth', 'wait', 'attempt'],
  ])
  expect(fake.authCalls.every((argv) => argv[0] === '/selected/delta')).toBe(true)
  expect(fake.commands.some((argv) => argv.includes('org'))).toBe(false)
  // Sign-in is the only question so far: setup asks nothing of its own before it finishes.
  expect(fake.questions.map((question) => question.questions[0].question)).toEqual(['Delta needs you to sign in before it can sync. Sign in with your browser?'])
  expect(fake.files.has('/repo/.delta/settings.json')).toBe(false)
  finish()
  await setup
  expect(JSON.parse(fake.files.get('/repo/.delta/settings.json')!)).toEqual({
    threads: { mode: 'private', organization: 'org-created' },
  })
  expect(fake.server.thread).toBeUndefined()
  await $.session.end(sessionEnd(fake.session))
  fake.session = 'after-setup'
  fake.turns = 0
  await $.session.start(sessionStart)
  await fake.settle()
  await fake.advance(0)
  await fake.settle()
  expect(fake.server.upload).toEqual({ organization: 'org-created', visibility: 'private' })
  expect(fake.server.shared).toBe(false)
  fake.expectClean()
})

test('setup stops before organization operations when sign-in is cancelled or access is required', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  for (const status of ['cancelled', 'terms_not_accepted']) {
    fake.authReplies = status === 'terms_not_accepted'
      ? [{ status: 'access_denied', reason: status, url: 'https://zed.dev/delta/terms' }]
      : [...loginReplies().slice(0, 2), { status }]
    const { text } = await $.command.run(typedDelta('setup'))
    expect(text).toContain('/delta-setup')
    if (status === 'terms_not_accepted') {
      expect(text).toContain('https://zed.dev/delta/terms')
      expect(text).not.toContain('could not sign in')
    } else expect(text).toContain(status)
    expect(fake.commands.some((argv) => argv.includes('org'))).toBe(false)
    expect(fake.files.has('/repo/.delta/settings.json')).toBe(false)
  }
  fake.expectClean()
})

test('ending the session stops setup sign-in without cancelling the app-owned login', async ($, on) => {
  const fake = fakeThreads(on)
  fake.authReplies = loginReplies()
  fake.holdAuth = new Promise(() => {})
  await $.session.start(sessionStart)
  const setup = $.command.run(typedDelta('setup'))
  await fake.waitForLog(0, (log) => log.includes('Finish signing in'))
  await fake.settle()
  await $.session.end(sessionEnd(fake.session))
  await fake.advance(250)
  expect((await setup).text).toContain('could not sign in')
  expect(fake.authWaitClosed).toBe(true)
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status', 'login', 'wait'])
  expect(fake.commands.some((argv) => argv.includes('org'))).toBe(false)
  expect(fake.files.has('/repo/.delta/settings.json')).toBe(false)
  fake.expectClean()
})

test('a session replaced during setup installation cannot start login or write the old checkout policy', async ($, on) => {
  const fake = fakeThreads(on)
  fake.cliMissing = true
  let release!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  let installing!: () => void
  const started = new Promise<void>((resolve) => { installing = resolve })
  fake.holdCliSetup = (install) => {
    if (install) { installing(); return paused }
  }
  await $.session.start(sessionStart)
  const setup = $.command.run(typedDelta('setup'))
  await started
  await $.session.end(sessionEnd(fake.session))
  fake.session = 'replacement'
  await $.session.start(sessionStart)
  release()
  expect((await setup).text).toContain('obsolete setup was stopped')
  expect(fake.authCalls).toEqual([])
  expect(fake.commands.some((argv) => argv.includes('org'))).toBe(false)
  expect(fake.files.has('/repo/.delta/settings.json')).toBe(false)
  fake.expectClean()
})

function loginReplies() {
  return [
    { status: 'signed_out' },
    { status: 'pending', login_id: 'attempt', url: 'https://example.com/login', expires_at: '2099-01-01T00:15:00Z' },
    { status: 'signed_in', account: { account_id: 'user' } },
  ]
}
