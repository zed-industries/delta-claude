import { expect, test as kitTest, tier } from 'claude-code/testing'
import { parseInstallUpdate } from './install-update'
import { fakeThreads, prompt, sessionStart, testsWithHeldClockWait, typedDelta } from './fake-thread-commands'

tier('user')
const test = testsWithHeldClockWait(kitTest)

test('startup checks once, read-only, and notifies without changing sync state', async ($, on) => {
  const fake = fakeThreads(on)
  fake.updateStatus = 'update_available'
  await $.session.start(sessionStart)
  await fake.clock.advance(0)
  await fake.settleUntil(() => fake.logs.some((text) => text.includes('1.1.0 is available')))
  expect(fake.installUpdates).toHaveLength(1)
  expect(fake.installUpdates[0]).toMatchObject({
    argv: ['/selected/delta', 'update', '--check', '--json'], timeoutMs: 5_000,
    env: { DELTA_CLI_INTEGRATION: 'claude_code' },
  })
  expect(fake.cliSetups).toEqual([])
  expect(fake.operations()).toEqual([])
  await $.session.start(sessionStart)
  await fake.clock.advance(0)
  expect(fake.installUpdates).toHaveLength(1)
  fake.expectClean()
})

test('a stalled startup check cannot block prompts or sharing and expires without a late notice', async ($, on) => {
  const fake = fakeThreads(on)
  fake.updateStatus = 'update_available'
  let release!: () => void
  fake.holdUpdate = new Promise<void>((resolve) => { release = resolve })
  await $.session.start(sessionStart)
  await fake.clock.advance(0)
  await fake.settleUntil(() => fake.installUpdates.length === 1)
  expect((await $.prompt.submit(prompt('hello'))).drop).toBeUndefined()
  expect(await fake.share($)).toContain('https://delta.dev/join/')
  await fake.clock.advance(10_000)
  await fake.settleUntil(() => fake.updateDebug.some((text) => text.includes('update check timed out')))
  release()
  await fake.clock.settle()
  expect(fake.logs.some((text) => text.includes('1.1.0 is available'))).toBe(false)
  fake.expectClean()
})

for (const command of ['delta-update', 'delta'] as const)
  test(`${command} explicitly updates with its telemetry command form`, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    const result = await $.command.run({
      ...typedDelta(command === 'delta' ? 'update' : ''), command,
    })
    expect(result.text).toContain('Updated Delta to 1.1.0')
    expect(result.text).toContain('Restart Claude Code')
    const updates = fake.installUpdates.filter((entry) => !entry.argv.includes('--check'))
    expect(updates).toHaveLength(1)
    expect(updates[0]!.env).toMatchObject({
      DELTA_CLI_INTEGRATION: 'claude_code',
      DELTA_CLI_COMMAND_FORM: command === 'delta' ? 'delta_subcommand' : 'dedicated_command',
    })
    fake.expectClean()
  })

for (const failure of ['old-cli', 'network', 'app-running', 'malformed'] as const)
  test(`${failure} update failures stay actionable and do not block sharing`, async ($, on) => {
    const fake = fakeThreads(on)
    fake.updateFailure = failure
    await $.session.start(sessionStart)
    await fake.clock.advance(0)
    await fake.settleUntil(() => [...fake.logs, ...fake.updateDebug].some((text) => text.startsWith('Delta update check:')))
    const result = await $.command.run(typedDelta('update'))
    expect(result.text).toContain(failure === 'old-cli' || failure === 'malformed'
      ? 'https://delta.dev' : failure === 'network' ? 'Check network access.' : 'Quit Delta and retry.')
    expect(await fake.share($)).toContain('https://delta.dev/join/')
    fake.expectClean()
  })

test('update replies require the negotiated schema and typed version fields', () => {
  const result = { schema_version: 1, status: 'update_available', current_version: '1.0',
    latest_version: '1.1', channel: 'stable', message: 'Available', can_install: true }
  expect(parseInstallUpdate(JSON.stringify(result))).toMatchObject({
    status: 'update_available', currentVersion: '1.0', latestVersion: '1.1', canInstall: true,
  })
  for (const changed of [{ schema_version: 2 }, { status: 'new_status' }, { latest_version: null }, { channel: 'unknown' }, { can_install: undefined }, { can_install: 'false' }])
    expect(() => parseInstallUpdate(JSON.stringify({ ...result, ...changed }))).toThrow()
})

for (const status of ['update_available', 'unsupported'] as const)
  test(`${status} preserves manual installation advice without offering an unsupported command`, async ($, on) => {
    const fake = fakeThreads(on)
    fake.updateStatus = status
    fake.updateCanInstall = false
    fake.updateMessage = status === 'update_available'
      ? 'Quit Delta, then run the Windows installer from https://delta.dev.'
      : 'Update Delta through your package manager.'
    await $.session.start(sessionStart)
    await fake.clock.advance(0)
    const notice = status === 'update_available'
      ? `Delta 1.1.0 is available (installed: 1.0.0). ${fake.updateMessage}`
      : `Delta update check: ${fake.updateMessage}`
    await fake.settleUntil(() => fake.logs.includes(notice))
    expect(fake.logs.filter((text) => text.includes(fake.updateMessage))).toEqual([notice])
    const result = await $.command.run(typedDelta('update'))
    expect(result.text).toBe(status === 'update_available'
      ? `Delta was not updated: ${fake.updateMessage}`
      : `Delta cannot update this installation: ${fake.updateMessage}`)
    fake.expectClean()
  })
