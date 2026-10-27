import { expect, test } from 'claude-code/testing'
import {
  branchFrom, cachedRelease, CHECK_INTERVAL_MS, compareVersions, installationFrom, manifestUrl, manifestVersion,
  recentlyChecked, REMINDER_INTERVAL_MS, reminderIsSnoozed, updateMessage,
} from './catalog'

test('versions compare numerically, and an unknown version has no order', () => {
  const cases: [string, string, number | undefined][] = [
    ['0.1.10', '0.1.9', 1], ['0.2.0', '0.10.0', -1], ['1.0.0', '0.99.99', 1], ['1.0.0', '1.0.0', 0],
    ['unknown', '1.0.0', undefined], ['01.2.3', '1.2.3', undefined], ['1.0.0-rc.1', '1.0.0', undefined],
    ['999999999999999999999.0.0', '1.0.0', undefined],
  ]
  for (const [a, b, order] of cases) expect(compareVersions(a, b)).toBe(order)
})

test('only the named plugin with a valid version is a release', () => {
  expect(manifestVersion('{"name":"delta","version":"0.2.0"}')).toBe('0.2.0')
  for (const text of ['null', '{}', '{"name":"other","version":"1.0.0"}', '{"name":"delta","version":7}', '<html>'])
    expect(() => manifestVersion(text)).toThrow()
})

test('release checks accept our Git marketplace on main or develop, not same-name substitutes or pins', () => {
  const entry = { name: 'zed-industries', source: 'github', repo: 'zed-industries/delta-claude' }
  expect(branchFrom([entry])).toBe('main')
  expect(branchFrom([{ ...entry, ref: 'develop' }])).toBe('develop')
  expect(branchFrom([{ name: entry.name, source: 'git', url: 'git@github.com:zed-industries/delta-claude.git' }])).toBe('main')
  for (const change of [
    { repo: 'someone/delta-claude' }, { ref: 'v1.0.0' }, { ref: 'a'.repeat(40) },
    { source: 'directory' }, { source: 'git', url: 'https://github.com.evil.test/zed-industries/delta-claude.git' },
  ]) expect(branchFrom([{ ...entry, ...change }])).toBeUndefined()
  expect(manifestUrl('develop')).toBe('https://raw.githubusercontent.com/zed-industries/delta-claude/develop/.claude-plugin/plugin.json')
  expect(() => branchFrom({})).toThrow()
})

test('installation selection follows scope and project, and recognizes a native update of the running cached copy', () => {
  const root = '/custom/plugins/cache/zed-industries/delta/0.1.1'
  const entry = { id: 'delta@zed-industries', enabled: true, version: '0.1.2',
    installPath: '/custom/plugins/cache/zed-industries/delta/0.1.2', scope: 'user' }
  const local = { ...entry, scope: 'local', projectPath: '/repo' }
  expect(installationFrom([entry, local], root, '0.1.1', '/repo')?.scope).toBe('local')
  expect(installationFrom([entry, local], root, '0.1.1', '/other')?.scope).toBe('user')
  expect(installationFrom([{ ...entry, scope: 'managed' }], root, '0.1.1', '/repo')?.scope).toBe('managed')
  for (const change of [{ enabled: false }, { id: 'delta@other' }, { installPath: `${entry.installPath}/nested` }])
    expect(installationFrom([{ ...entry, ...change }], root, '0.1.1', '/repo')).toBeUndefined()
  expect(installationFrom([entry], '/repo', '0.1.1', '/repo')).toBeUndefined()
  expect(installationFrom([entry], '/repo/0.1.1', '0.1.1', '/repo')).toBeUndefined()
  expect(installationFrom([{ ...entry, installPath: 'C:/plugins/cache/zed-industries/delta/0.1.2' }],
    'C:\\plugins\\cache\\zed-industries\\delta\\0.1.1', '0.1.1', 'C:/repo')?.version).toBe('0.1.2')
})

test('persisted throttles expire, survive clock changes, and snooze only the announced release', () => {
  expect(recentlyChecked(0, CHECK_INTERVAL_MS - 1)).toBe(true)
  expect(recentlyChecked(0, CHECK_INTERVAL_MS)).toBe(false)
  expect(recentlyChecked(100, 0)).toBe(false)
  expect(cachedRelease({ checkedAt: 1, version: '1.2.3' })?.version).toBe('1.2.3')
  for (const value of [null, { checkedAt: NaN }, { checkedAt: 1, version: {} }])
    expect(cachedRelease(value)).toBeUndefined()
  const reminder = { version: '1.2.3', until: REMINDER_INTERVAL_MS }
  expect(reminderIsSnoozed(reminder, '1.2.3', 0)).toBe(true)
  expect(reminderIsSnoozed(reminder, '1.2.4', 0)).toBe(false)
  expect(reminderIsSnoozed(reminder, '1.2.3', REMINDER_INTERVAL_MS)).toBe(false)
  expect(reminderIsSnoozed(reminder, '1.2.3', -1)).toBe(false)
})

test('native update results must identify the operation and success, and the last line carries JSON', () => {
  const result = { command: 'update', outcome: 'ok', pluginId: 'delta@zed-industries', message: 'Updated.' }
  expect(updateMessage(`Checking...\n${JSON.stringify(result)}\n`)).toBe('Updated.')
  for (const value of [{}, { ...result, outcome: 'failed' }, { ...result, pluginId: 'other@zed-industries' }])
    expect(() => updateMessage(JSON.stringify(value))).toThrow()
})
