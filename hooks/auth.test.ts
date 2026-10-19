import { expect, test as kitTest, tier } from 'claude-code/testing'
import { CHECKOUT, fakeThreads, sessionStart, sessionEnd, shareCommand, testsWithHeldClockWait, typedDelta } from './fake-thread-commands'
import { authLoginCommand } from './auth'

tier('user')
const test = testsWithHeldClockWait(kitTest)

test('share signs in an existing installation before exporting, then continues on the selected CLI', async ($, on) => {
  const fake = fakeThreads(on, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  fake.authReplies = loginReplies()
  let finish!: () => void
  fake.holdAuth = new Promise<void>((resolve) => { finish = resolve })
  await $.session.start(sessionStart)
  expect(fake.authCalls).toEqual([])
  await $.command.run(shareCommand)
  await fake.clock.advance(0)
  expect(fake.authCalls.map((argv) => argv.slice(2))).toEqual([
    ['auth', 'status'], ['auth', 'login', '--no-wait'], ['auth', 'wait', 'attempt'],
  ])
  expect(fake.authCalls.every((argv) => argv[0] === '/selected/delta')).toBe(true)
  expect(fake.logs.join('\n')).toContain('https://example.com/login')
  expect(fake.server.thread).toBeUndefined()
  expect(fake.records()).toEqual([])
  const shared = fake.waitForShareLink()
  finish()
  await fake.clock.settle()
  await fake.clock.advance(0)
  expect(await shared).toBe(`https://delta.dev/join/${fake.shareId}`)
  await $.session.end(sessionEnd(fake.session))
  const calls = fake.authCalls.length
  await $.session.start({ ...sessionStart, reason: 'resume' })
  await fake.clock.advance(0)
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

test('unaccepted beta terms point to the terms page and a retry, without a failure or a new sign-in', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  fake.authReplies = [{ status: 'access_denied', reason: 'terms_not_accepted', message: 'Accept the terms.', url: 'https://zed.dev/delta/terms' }]
  await $.command.run(shareCommand)
  await fake.clock.advance(0)
  await fake.clock.settle()
  expect(fake.logs).toContain('Delta needs you to accept its beta terms first. Accept them here: https://zed.dev/delta/terms\nThen run /delta-share or /delta-join <link> again.')
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
  await fake.clock.advance(0)
  expect(fake.authCalls.at(-1)?.[3]).toBe('wait')
  await $.session.end(sessionEnd(fake.session))
  await fake.clock.advance(250)
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
    const answer = text.startsWith('Delta syncs your sessions into a team') ? 'Acme'
      : text.startsWith('Invite teammates') ? 'Not now' : 'Private sync'
    return { result: { answers: { [text]: answer } } }
  }
  await $.session.start(sessionStart)
  expect(fake.authCalls).toEqual([])
  const setup = $.command.run(typedDelta('setup'))
  await fake.waitForLog(0, (log) => log.includes('Waiting for sign-in'))
  await fake.clock.settle()
  expect(fake.authCalls.map((argv) => argv.slice(2))).toEqual([
    ['auth', 'status'], ['auth', 'login', '--no-wait'], ['auth', 'wait', 'attempt'],
  ])
  expect(fake.authCalls.every((argv) => argv[0] === '/selected/delta')).toBe(true)
  expect(fake.commands.some((argv) => argv.includes('org'))).toBe(false)
  expect(fake.questions).toEqual([])
  expect(fake.files.has('/repo/.delta/settings.json')).toBe(false)
  finish()
  await setup
  expect(JSON.parse(fake.files.get('/repo/.delta/settings.json')!)).toEqual({
    threads: { mode: 'private', organization: 'org-created' },
  })
  expect(fake.server.thread).toBeUndefined()
  await $.session.end(sessionEnd(fake.session))
  fake.session = 'after-setup'
  await $.session.start(sessionStart)
  await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
  await fake.clock.settle()
  await fake.clock.advance(0)
  await fake.clock.settle()
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
  await fake.waitForLog(0, (log) => log.includes('Waiting for sign-in'))
  await fake.clock.settle()
  await $.session.end(sessionEnd(fake.session))
  await fake.clock.advance(250)
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
