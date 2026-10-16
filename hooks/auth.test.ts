import { expect, test as kitTest, tier } from 'claude-code/testing'
import { fakeThreads, sessionStart, sessionEnd, shareCommand, testsWithHeldClockWait } from './fake-thread-commands'
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
  fake.surfaces = []
  await $.session.start(sessionStart)
  fake.authReplies = [{ status: 'access_denied', reason: 'terms_not_accepted', message: 'Accept the terms.', url: 'https://zed.dev/delta/terms' }]
  const { text } = await $.command.run(shareCommand)
  expect(text).toBe('Delta needs you to accept its beta terms first. Accept them here: https://zed.dev/delta/terms\nThen run /delta-share or /delta-join <link> again.')
  expect(fake.authCalls.map((argv) => argv[3])).toEqual(['status'])
  expect(fake.server.thread).toBeUndefined()
  fake.expectClean()
})

test('headless share returns a pending sign-in link without waiting, and a signed-in retry shares', async ($, on) => {
  const fake = fakeThreads(on)
  fake.surfaces = []
  fake.authReplies = loginReplies()
  fake.holdAuth = new Promise(() => {})
  await $.session.start(sessionStart)
  expect(await $.command.run(shareCommand)).toEqual({
    text: 'Delta sign-in is pending. Open https://example.com/login in your browser and finish signing in, then retry /delta-share. This link expires at 2099-01-01T00:15:00Z. No thread has been shared by this command.',
  })
  expect(fake.authCalls.map((argv) => argv.slice(2))).toEqual([
    ['auth', 'status'], ['auth', 'login', '--no-wait', '--no-browser'],
  ])
  expect(fake.server.thread).toBeUndefined()
  expect(fake.exports).toBe(0)
  expect(await $.command.run(shareCommand)).toEqual({
    text: `Delta share link: https://delta.dev/join/${fake.shareId}`,
  })
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

function loginReplies() {
  return [
    { status: 'signed_out' },
    { status: 'pending', login_id: 'attempt', url: 'https://example.com/login', expires_at: '2099-01-01T00:15:00Z' },
    { status: 'signed_in', account: { account_id: 'user' } },
  ]
}
