import { expect, test as kitTest, tier } from 'claude-code/testing'
import { parseInstallUpdate, parseProgressEvent } from './install-update'
import {
  drawBandText, fakeThreads, prompt, sessionStart, testsWithHeldClockWait, typedDelta, UPDATE_HELPER_APPROVAL,
  UPDATE_HELPER_ARGV, WINDOWS_DELTA,
} from '../testing/fake-thread-commands'

tier('user')
const test = testsWithHeldClockWait(kitTest)

test('startup checks once, read-only, and notifies without changing sync state', async ($, on) => {
  const fake = fakeThreads(on)
  fake.updateStatus = 'update_available'
  await $.session.start(sessionStart)
  await fake.advance(0)
  await fake.settleUntil(() => fake.logs.some((text) => text.includes('1.1.0 is available')))
  expect(fake.installUpdates).toHaveLength(1)
  expect(fake.installUpdates[0]).toMatchObject({
    argv: ['/selected/delta', 'update', '--check', '--json'], timeoutMs: 5_000,
    env: { DELTA_CLI_INTEGRATION: 'claude_code' },
  })
  expect(fake.cliSetups).toEqual([])
  expect(fake.operations()).toEqual([])
  await $.session.start(sessionStart)
  await fake.advance(0)
  expect(fake.installUpdates).toHaveLength(1)
  fake.expectClean()
})

test('a stalled startup check cannot block prompts or sharing and expires without a late notice', async ($, on) => {
  const fake = fakeThreads(on)
  fake.updateStatus = 'update_available'
  let release!: () => void
  fake.holdUpdate = new Promise<void>((resolve) => { release = resolve })
  await $.session.start(sessionStart)
  await fake.advance(0)
  await fake.settleUntil(() => fake.installUpdates.length === 1)
  expect((await $.prompt.submit(prompt('hello'))).drop).toBeUndefined()
  expect(await fake.share($)).toContain('https://delta.dev/join/')
  await fake.advance(10_000)
  await fake.settleUntil(() => fake.updateDebug.some((text) => text.includes('update check timed out')))
  release()
  await fake.settle()
  expect(fake.logs.some((text) => text.includes('1.1.0 is available'))).toBe(false)
  fake.expectClean()
})

for (const command of ['delta-update', 'delta'] as const)
  test(`${command} explicitly updates with its telemetry command form`, async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    let release!: () => void
    fake.holdUpdate = new Promise<void>((resolve) => { release = resolve })
    const updating = $.command.run({
      ...typedDelta(command === 'delta' ? 'update' : ''), command,
    })
    // The band draws the CLI's latest event in place of the last; the transcript only says it started.
    await fake.settleUntil(() => fake.debugLogs.some((text) => text.includes('"percent":45')))
    await fake.settle()
    const band = await drawBandText($)
    expect(band).toContain('Downloading 1.1.0')
    expect(band).toContain(' 45%')
    expect(band).not.toContain('25%')
    expect(fake.logs.filter((text) => text.includes('Delta'))).toEqual(['Updating Delta installation…'])
    release()
    const result = await updating
    expect(result.text).toContain('Updated Delta to 1.1.0')
    expect(await drawBandText($)).not.toContain('Downloading')
    const updates = fake.installUpdates.filter((entry) => !entry.argv.includes('--check'))
    expect(updates.map((entry) => entry.argv)).toEqual([['/selected/delta', 'update', '--json']])
    expect(updates[0]!.env).toMatchObject({
      DELTA_CLI_INTEGRATION: 'claude_code',
      DELTA_CLI_COMMAND_FORM: command === 'delta' ? 'delta_subcommand' : 'dedicated_command',
    })
    fake.expectClean()
  })

const WINDOWS_OUTCOMES = {
  installed: 'Updated Delta to 1.1.0.',
  restart: 'Updated Delta to 1.1.0. Windows reports that a restart is required to finish the installation; restart Windows, then Claude Code.',
  refused: 'Delta installation update failed: update: app_running: Delta is running. Quit it, then update again.',
  crash: 'Delta installation update failed: The Delta installer helper exited with code 3221225477. Run `delta update --check` before retrying /delta-update.',
  unsaid: 'Delta installation update failed: Unexpected Delta update response. Update your Delta installation from https://delta.dev, then restart Claude Code and retry /delta-update.',
} as const

test('on Windows the plugin runs the installer once the CLI exits and reports each outcome', async ($, on) => {
  const fake = fakeThreads(on, { env: { OS: 'Windows_NT' } })
  fake.updateInstallStatus = 'install_ready'
  await $.session.start(sessionStart)
  for (const [outcome, expected] of Object.entries(WINDOWS_OUTCOMES)) {
    fake.helperOutcome = outcome === 'refused'
      ? { code: 'app_running', message: 'Delta is running. Quit it, then update again.' }
      : outcome as 'installed' | 'restart' | 'crash' | 'unsaid'
    expect((await $.command.run(typedDelta('update'))).text).toBe(expected)
  }
  const cli = [WINDOWS_DELTA, 'update', '--download-only', '--json']
  expect(fake.installUpdates.filter((entry) => !entry.argv.includes('--check')).map((entry) => entry.argv))
    .toEqual(Object.keys(WINDOWS_OUTCOMES).flatMap(() => [cli, UPDATE_HELPER_ARGV]))
  // Each started installer asks for approval once, in full; a refused or crashed one never got that far.
  expect(fake.logs.filter((text) => text === UPDATE_HELPER_APPROVAL)).toHaveLength(3)
  fake.expectClean()
})

test('an installer the plugin did not ask for is refused and never started', async ($, on) => {
  const fake = fakeThreads(on)
  fake.updateInstallStatus = 'install_ready'
  await $.session.start(sessionStart)
  expect((await $.command.run(typedDelta('update'))).text).toContain('Unexpected Delta update response.')
  expect(fake.installUpdates.map((entry) => entry.argv[0])).not.toContain(UPDATE_HELPER_ARGV[0])
  fake.expectClean()
})

test('a Windows installer still running at the deadline is left to finish', async ($, on) => {
  const fake = fakeThreads(on, { env: { OS: 'Windows_NT' } })
  fake.updateInstallStatus = 'install_ready'
  let release!: () => void
  fake.holdHelper = new Promise<void>((resolve) => { release = resolve })
  await $.session.start(sessionStart)
  const updating = $.command.run(typedDelta('update'))
  await fake.settleUntil(() => fake.logs.includes(UPDATE_HELPER_APPROVAL))
  // The band keeps a short state and goes on animating while the installer waits on the person.
  const waiting = await drawBandText($)
  expect(waiting).toContain('Waiting for installer approval')
  await fake.advance(120)
  const next = await drawBandText($)
  expect(next).toContain('Waiting for installer approval')
  expect(next).not.toBe(waiting)
  await fake.advance(600_000)
  expect((await updating).text).toBe('Delta installation update failed: The Delta installer is still running after 10 minutes; it may be waiting for you to approve a Windows prompt. Let it finish, then run `delta update --check` before retrying /delta-update.')
  expect(fake.helperStopped).toBe(false)
  expect((await $.command.run(typedDelta('plugin-update'))).text).toContain('installation update is still running')
  expect((await $.command.run(typedDelta('update'))).text).toContain('already in progress')
  release()
  await fake.settle()
  fake.holdHelper = undefined
  expect((await $.command.run(typedDelta('update'))).text).toContain('Updated Delta')
  fake.expectClean()
})

for (const status of ['updated', 'install_ready'] as const)
  test(`read-only checks reject ${status}`, async ($, on) => {
    const fake = fakeThreads(on)
    fake.updateStatus = status
    await $.session.start(sessionStart)
    await fake.advance(0)
    await fake.settleUntil(() => fake.updateDebug.some((text) =>
      text.includes('Unexpected installation change reported by a read-only update check')))
    expect(fake.logs.some((text) => text.includes('1.1.0'))).toBe(false)
    fake.expectClean()
  })

test('a stalled explicit update times out and allows a later retry', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  let release!: () => void
  fake.holdUpdate = new Promise<void>((resolve) => { release = resolve })
  const updating = $.command.run(typedDelta('update'))
  await fake.settleUntil(() => fake.debugLogs.some((text) => text.includes('"percent":45')))
  await fake.advance(600_000)
  expect((await updating).text).toContain('update timed out')
  release()
  fake.holdUpdate = undefined
  expect((await $.command.run(typedDelta('update'))).text).toContain('Updated Delta to 1.1.0')
  fake.expectClean()
})

/** What each failure's answer must say for the person to act on it. */
const FAILURE_ADVICE = {
  'old-cli': 'https://delta.dev',
  network: 'Check network access.',
  'app-running': 'Quit Delta and retry.',
  // The CLI's own advice names `delta update`; the plugin's names its own command.
  'app-working': 'Retry /delta-update once that work finishes.',
  malformed: 'https://delta.dev',
  crash: 'exited with code 101 without reporting a result',
} as const

for (const [failure, advice] of Object.entries(FAILURE_ADVICE) as [keyof typeof FAILURE_ADVICE, string][])
  test(`${failure} update failures stay actionable and do not block sharing`, async ($, on) => {
    const fake = fakeThreads(on)
    fake.updateFailure = failure
    await $.session.start(sessionStart)
    await fake.advance(0)
    await fake.settleUntil(() => [...fake.logs, ...fake.updateDebug].some((text) => text.startsWith('Delta update check:')))
    const result = await $.command.run(typedDelta('update'))
    expect(result.text).toContain(advice)
    expect(result.text).not.toMatch(/panicked|`delta update` again/)
    expect(await fake.share($)).toContain('https://delta.dev/join/')
    fake.expectClean()
  })

test('progress events are read by schema; other lines and unknown events are not progress', () => {
  expect(parseProgressEvent('{"schema_version":1,"type":"progress","phase":"downloading","version":"1.1","percent":45}'))
    .toEqual({ type: 'progress', phase: 'downloading', version: '1.1', percent: 45 })
  expect(parseProgressEvent('{"schema_version":1,"type":"progress","phase":"checking"}'))
    .toEqual({ type: 'progress', phase: 'checking' })
  expect(parseProgressEvent('{"schema_version":1,"type":"action_required","action":"approve_installer","message":"Approve it."}'))
    .toEqual({ type: 'action_required', action: 'approve_installer', message: 'Approve it.' })
  for (const line of [
    'delta: Delta is running agent work.', '{not json',
    '{"schema_version":2,"type":"progress","phase":"checking"}',
    '{"schema_version":1,"type":"progress","phase":"verifying"}',
    '{"schema_version":1,"type":"progress","phase":"downloading","percent":101}',
    '{"schema_version":1,"type":"progress","phase":"downloading","version":""}',
    '{"schema_version":1,"type":"action_required","action":"approve_installer"}',
  ])
    expect(parseProgressEvent(line)).toBeUndefined()
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

test('a ready installer requires a target version, installation capability and its command', () => {
  const result = { schema_version: 1, status: 'install_ready', current_version: '1.0',
    latest_version: '1.1', channel: 'stable', message: 'Ready', can_install: true,
    install_argv: ['C:\\Updates\\helper.exe', '--internal-windows-update-install'] }
  expect(parseInstallUpdate(JSON.stringify(result))).toEqual({
    status: 'install_ready', currentVersion: '1.0', latestVersion: '1.1', message: 'Ready', canInstall: true,
    installArgv: ['C:\\Updates\\helper.exe', '--internal-windows-update-install'],
  })
  for (const changed of [
    { latest_version: null }, { can_install: false }, { install_argv: undefined }, { install_argv: [] },
    { install_argv: ['helper.exe', ''] },
  ])
    expect(() => parseInstallUpdate(JSON.stringify({ ...result, ...changed }))).toThrow()
  expect(() => parseInstallUpdate(JSON.stringify({ ...result, status: 'updated', restart_required: 'yes' }))).toThrow()
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
    await fake.advance(0)
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
