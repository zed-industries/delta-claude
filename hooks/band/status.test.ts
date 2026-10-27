import { expect, test } from 'claude-code/testing'
import {
  bandWidth, firstNames, formatSeconds, personColor, personKey, pluginUpdateRow, renderBand, shortLink, statusCurrentTurn,
  type StatusSegment, statusSpinnerRunning, type StatusState, toolRowParts,
} from './status'
import { cliFixture } from '../testing/cli-fixtures'
import type { WatchItem } from '../cli/thread-commands'

// Synthetic ID with the production length so width checks remain representative.
const LINK = `https://delta.dev/join/thread_${'0'.repeat(26)}`
const WIDE = { columns: 120, terminal: true }
const text = (segments: StatusSegment[] | undefined) => (segments ?? []).map((segment) => segment.text).join('')
const live: StatusState = { connection: 'live', turn: { state: 'idle' }, link: LINK }
const people = [{ id: 'u-maya', name: 'Maya Rodriguez' }, { id: 'u-sam', name: 'Sam Lee' }, { id: 'u-ada', name: 'Ada' }]

test('a plugin update and its bracketed buttons fit one row', () => {
  for (const version of ['0.1.25', '10.100.1000']) {
    for (const ready of [false, true]) {
      for (let columns = 12; columns <= 160; columns++) {
        // The status band reserves one cell of padding on each side on the terminal.
        const row = pluginUpdateRow(version, ready, columns - 2)
        if (!row) continue
        const controls = [`[ ${row.action} ]`, ...row.later ? ['[ Later ]'] : [], ...row.mute ? ['[ Mute ]'] : []]
        const text = `${ready ? '✓' : '↑'} ${row.prefix}${row.version} ${controls.join(' ')}`
        expect([...text].length + 2).toBeLessThanOrEqual(columns)
        expect(row.summaryColumns).toBe(2 + row.prefix.length + row.version.length)
        expect(text).not.toContain('\n')
      }
    }
  }
  expect(pluginUpdateRow('0.1.25', false, 78)).toMatchObject({
    prefix: 'Plugin ', version: '0.1.25', action: 'Update', later: true, mute: true,
  })
  expect(pluginUpdateRow('0.1.25', true, 38)).toMatchObject({
    prefix: '', version: '0.1.25', action: 'Reload', later: true, mute: true,
  })
  expect(pluginUpdateRow('0.1.25', false, 30)).toMatchObject({ later: true, mute: false })
  expect(pluginUpdateRow('0.1.25', false, 22)).toMatchObject({ later: false, mute: false })
  expect(pluginUpdateRow('0.1.25', false, 12)).toBeUndefined()
})

test('the turn status names who started it, and the band animates only for someone else', () => {
  expect(statusCurrentTurn({})).toEqual({ state: 'idle' })
  expect(statusCurrentTurn({ threadTurn: { type: 'turn', state: 'running', turn_id: 'remote', user: null },
    remoteTurn: { name: 'Ada', id: 'u-ada' } })).toEqual({ state: 'remote', name: 'Ada', id: 'u-ada' })
  expect(statusCurrentTurn({ threadTurn: { type: 'turn', state: 'running', turn_id: null, user: null } }))
    .toEqual({ state: 'starting' })
  expect(statusCurrentTurn({ threadTurn: { type: 'turn', state: 'running', turn_id: null, user: { user_id: null, name: 'Bob' } } }))
    .toEqual({ state: 'starting', name: 'Bob', id: personKey({ user_id: null, name: 'Bob' }) })
  expect(statusCurrentTurn({ producerTurn: { sequence: 1, status: 'running' } })).toEqual({ state: 'own' })
  // Claude already animates this session's own turn.
  for (const [turn, spins] of [[{ state: 'remote', name: 'Ada' }, true], [{ state: 'starting' }, true], [{ state: 'own' }, false], [{ state: 'idle' }, false]] as const)
    expect(statusSpinnerRunning({ connection: 'live', turn })).toBe(spins)
  expect(statusSpinnerRunning({ connection: 'live', turn: { state: 'idle' }, progress: { text: 'Mounting', tone: 'active' } })).toBe(true)
})

test('the mark carries the connection, and a failure adds its reason below', () => {
  const band = renderBand(live, WIDE)
  expect(band).toMatchObject({ tone: 'live', mark: { text: '●' }, link: { text: LINK, href: LINK, copy: { label: 'copy link' } } })
  expect(band.detail).toBeUndefined()
  for (const patch of [{ error: 'watch failed' }, { progress: { text: 'share failed', tone: 'error' as const } }, { deliveryPause: 'record refused' }]) {
    const failed = renderBand({ ...live, ...patch }, WIDE)
    expect(failed.mark.text).toBe('✕')
    expect(text(failed.detail)).toMatch(/failed|refused/)
  }
  // Past a drop's grace the band admits to reconnecting, dims who it last saw, and drops a remote agent.
  const reconnecting = renderBand({ ...live, connection: 'retrying', reconnecting: true, people,
    turn: { state: 'remote', name: 'Maya', id: 'u-maya' } }, WIDE)
  expect(reconnecting.mark.text).toBe('◌')
  expect(text(reconnecting.right)).toBe('Maya, Sam, Ada')
  expect(reconnecting.right.filter((segment) => segment.bold).every((segment) => segment.dim)).toBe(true)
  expect(renderBand({ ...live, retryReason: 'timeout' }, WIDE).detail?.[0]?.text).toContain('timeout')
  expect(renderBand({ ...live, connection: 'stopped' }, WIDE).mark.text).toBe('○')
})

test('a recorded session says so beside the name at every width, and an unrecorded one does not', () => {
  expect(text(renderBand(live, WIDE).label)).toBe(' Delta')
  for (const columns of [120, 40]) {
    const band = renderBand({ ...live, recording: true, people }, { columns, terminal: true })
    expect(text(band.label)).toBe(' Delta · Syncing')
  }
})

test('a running share shows its step and the link only once it can be followed', () => {
  const step = { text: 'Publishing the thread…', tone: 'active' as const, step: [4, 5] as [number, number] }
  const before = renderBand({ ...live, link: undefined, progress: step }, WIDE)
  expect(before.link).toEqual({ text: 'link appears when ready' })
  expect(text(before.right)).toContain('Publishing the thread… 4/5')
  // Published but still uploading: the real link, shown and not offered.
  expect(renderBand({ ...live, progress: { ...step, step: [5, 5] } }, WIDE).link).toEqual({ text: LINK })
  const done = renderBand({ ...live, progress: { text: 'Shared', tone: 'done' } }, WIDE)
  expect(done.link?.href).toBe(LINK)
  expect(text(done.right)).toBe('✔ Shared')
  expect(renderBand({ ...live, copied: true }, WIDE).link?.copy).toEqual({ label: 'copy link', copied: true })
})

test('a running installation update draws its step from data and promises no link', () => {
  const version = '0.22.0-trunk.20261026.2'
  const updating = (update: NonNullable<NonNullable<StatusState['progress']>['update']>): StatusState =>
    ({ connection: 'stopped', turn: { state: 'idle' }, progress: { text: 'Updating Delta', tone: 'active', update } })
  const downloading = updating({ phase: 'downloading', version, percent: 45 })
  const band = renderBand(downloading, WIDE)
  expect(text(band.label)).toBe(' Delta · Updating')
  expect(text(band.right)).toBe(`⠋ Downloading ${version} ▰▰▰▰▱▱▱▱ 45%`)
  expect(band.link).toBeUndefined()
  // Narrowing drops the bar, then the version; the percent stays.
  expect(text(renderBand(downloading, { columns: 70, terminal: true }).right)).toBe(`⠋ Downloading ${version} 45%`)
  expect(text(renderBand(downloading, { columns: 40, terminal: true }).right)).toBe('⠋ Downloading 45%')
  expect(text(renderBand(updating({ phase: 'preparing', version }), WIDE).right)).toBe(`⠋ Preparing ${version}…`)
  expect(text(renderBand(updating({ action: 'approve_installer' }), WIDE).right)).toBe('⠋ Waiting for installer approval')
})

test('the roster lists first names in their own colors, with +N past three and arrivals highlighted', () => {
  const band = renderBand({ ...live, people: [...people.slice(0, 2), { ...people[2]!, arriving: true }] }, WIDE)
  expect(text(band.right)).toBe('Maya, Sam, Ada')
  expect(band.right.find((segment) => segment.text === 'Ada')).toMatchObject({ inverse: true, color: personColor('u-ada') })
  const many = [...people, { id: 'u-4', name: 'Priya' }, { id: 'u-5', name: 'Jon' }]
  expect(text(renderBand({ ...live, people: many }, WIDE).right)).toBe('Maya, Sam, Ada +2')
  expect(firstNames([{ id: 'a', name: 'Maya Rodriguez' }, { id: 'b', name: 'Maya Chen' }, { id: 'c', name: 'Sam' }]))
    .toEqual(new Map([['a', 'Maya R.'], ['b', 'Maya C.'], ['c', 'Sam']]))
  expect(['green', 'yellow', 'red']).not.toContain(personColor('u-maya'))
})

test("another participant's agent takes a line of its own, or its owner's place on a short band", () => {
  const remote: StatusState = { ...live, turn: { state: 'remote', name: 'Maya Rodriguez', id: 'u-maya' }, people, agent: { seconds: 34 } }
  const band = renderBand(remote, WIDE)
  expect(text(band.right)).toBe('Maya, Sam, Ada')
  expect(text(band.activity!)).toMatch(/^. Maya's agent  \(34s\)$/)
  expect(band.activity![1]).toMatchObject({ color: personColor('u-maya'), bold: true })
  // What it is doing: its newest open call, timed from when that opened, with the others counted.
  const doing = { text: 'cargo test -p thread', tool: true, seconds: 72, more: 2 }
  expect(text(renderBand({ ...remote, agent: { seconds: 300, doing } }, WIDE).activity!))
    .toMatch(/^. Maya's agent › cargo test -p thread  \(1m 12s · 2 more running\)$/)
  expect(text(renderBand({ ...remote, agent: { seconds: 300, doing: { text: 'thinking', tool: false, seconds: 8, more: 0 } } }, WIDE).activity!))
    .toMatch(/› thinking  \(8s\)$/)
  // The line has the whole width, so a long title keeps its start and its end.
  const long = { ...doing, more: 0, text: 'cargo test -p thread external_recording -- --nocapture' }
  const narrow = text(renderBand({ ...remote, agent: { seconds: 300, doing: long } }, { columns: 60, terminal: true }).activity!)
  expect(narrow.length).toBeLessThanOrEqual(58)
  expect(narrow).toContain('cargo')
  expect(narrow).toContain('…')
  expect(narrow).toContain('capture')
  expect(text(renderBand({ ...remote, agent: { seconds: 130, quiet: 45 } }, WIDE).activity!)).toBe("◌ Maya's agent quiet 45s")
  expect(text(renderBand({ ...live, turn: { state: 'starting' } }, WIDE).activity!)).toMatch(/^. An agent starting…$/)
  // With one row the agent takes its owner's place on the band's row, and a failure's reason outranks its line.
  expect(text(renderBand({ ...remote, agent: { seconds: 34, doing } }, { ...WIDE, rows: 1 }).right)).toMatch(/^. Maya's agent 34s · Sam, Ada$/)
  const failing = renderBand({ ...remote, error: 'watch failed' }, { ...WIDE, rows: 2 })
  expect(failing.activity).toBeUndefined()
  expect(text(failing.right)).toContain("Maya's agent")
  expect(formatSeconds(130)).toBe('2m 10s')
})

test('as the band narrows it always fits, gives parts up in order, and keeps the link', () => {
  const remote: StatusState = { ...live, turn: { state: 'remote', name: 'Maya', id: 'u-maya' }, people, agent: { seconds: 34 } }
  for (const [terminal, rows] of [[true, 12], [true, 1], [false, 12]] as const) {
    let previous = renderBand(remote, { columns: 160, terminal, rows })
    for (let columns = 159; columns >= 20; columns--) {
      const band = renderBand(remote, { columns, terminal, rows })
      // The desktop keeps its short link, so it fits from a little wider than the terminal does.
      if (columns >= (terminal ? 32 : 52)) expect(bandWidth(band, terminal)).toBeLessThanOrEqual(columns)
      // Nothing comes back as the band narrows; the copy control and whoever is working always stay.
      expect(text(band.right).length).toBeLessThanOrEqual(text(previous.right).length)
      expect(band.link).toMatchObject({ href: LINK, copy: {} })
      expect(text(band.activity ?? band.right)).toContain('Maya')
      previous = band
    }
  }
  // Wide, everything rides on the row; narrow, the URL takes its own row, whole; with one row it goes.
  expect(renderBand(remote, WIDE).link).toEqual({ text: LINK, href: LINK, copy: { label: 'copy link' } })
  expect(renderBand(remote, { columns: 60, terminal: true, rows: 12 }).link).toMatchObject({ text: LINK, ownRow: true })
  expect(renderBand(remote, { columns: 60, terminal: true, rows: 1 }).link?.text).toBeUndefined()
  // A failure's reason takes the second row before the URL does.
  expect(renderBand({ ...remote, error: 'watch failed' }, { columns: 100, terminal: true, rows: 2 }).link?.ownRow).toBeUndefined()
  // The desktop's link keeps the URL's short form on the row.
  expect(shortLink(LINK)).toBe('delta.dev/join/…000000')
  expect(renderBand(remote, { columns: 40, terminal: false }).link).toMatchObject({ text: shortLink(LINK) })
})

test('on a narrow one-row band the share control and audience give way before the link', () => {
  const shared: StatusState = { ...live, audience: 'Private', share: { label: 'Share with Zed Industries' } }
  const band = renderBand(shared, { columns: 78, terminal: true, rows: 1 })
  expect(band.link?.text).toBe(LINK)
  expect(band.share).toBeUndefined()
  expect(band.audience).toBeUndefined()
  // A little wider, only the share control has gone.
  const roomy = renderBand(shared, { columns: 100, terminal: true, rows: 1 })
  expect(roomy).toMatchObject({ link: { text: LINK }, audience: [{ text: 'Private' }] })
  expect(roomy.share).toBeUndefined()
})

test('long tool input keeps its start and end, fitting the available row width', () => {
  const path = '/Users/ada/delta/checkouts/00000000-0000-4000-8000-000000000001/src/main.rs'
  const item = { ...cliFixture('item').item, kind: 'tool_call', author: { user_id: null, name: 'Delta agent' },
    content: { sessionUpdate: 'tool_call_update', toolCallId: 'session/read-1', title: 'Read file',
      name: 'Read', kind: 'read', status: 'failed', rawInput: { file_path: path },
      content: [{ type: 'content', content: { type: 'text', text: 'Permission denied' } }] } } as WatchItem
  const row = toolRowParts(item, 80)
  expect(row.name).toBe('Read file')
  expect(row.shown).toContain('…')
  expect(row.shown.startsWith('/Users/')).toBe(true)
  expect(row.shown.endsWith('src/main.rs')).toBe(true)
  expect(`${row.author} › ${row.name} ${row.shown}${row.statusText}`.length).toBeLessThanOrEqual(80 - 6)
  expect(toolRowParts(item, 30).shown).toBe('')
})

test('children report independently of an idle parent, with distinct statuses and stale readback', () => {
  const child = { thread_id: 'child-1', reference: 'thread#s=child-1', kind: 'subagent' as const, name: 'Investigate build failures', status: 'queued' }
  const state = { ...live, children: [child] }
  const shown = (status: string) => text(renderBand({ ...state, children: [{ ...child, status }] }, WIDE).childActivity)
  expect(shown('queued')).toContain('queued')
  expect(shown('waiting_for_synchronization')).toContain('syncing')
  expect(shown('future_status')).toContain('unknown')
  expect(text(renderBand({ ...state, children: [{ ...child, kind: 'future_kind' }] }, WIDE).childActivity))
    .toContain('child Investigate build failures queued')
  expect(text(renderBand({ ...state, children: [{ ...child, status: 'completed' }] }, WIDE).right)).toContain('completed')
  expect(renderBand({ ...state, children: [{ ...child, status: 'completed' }] }, WIDE).childActivity).toBeUndefined()
  expect(text(renderBand({ ...state, childrenStale: true }, WIDE).childActivity)).toContain('unknown')
  expect(statusSpinnerRunning(state)).toBe(false)
  expect(statusSpinnerRunning({ ...state, children: [{ ...child, status: 'running' }] })).toBe(true)
  expect(text(renderBand(state, { ...WIDE, rows: 1 }).right)).toContain('queued')
  expect(renderBand(state, { ...WIDE, rows: 1 }).childActivity).toBeUndefined()
})

test('a named running child does not hide siblings in the same state when other states exist', () => {
  const child = { thread_id: 'first', reference: 'thread#s=first', kind: 'subagent' as const, name: 'First', status: 'running' }
  const band = renderBand({ ...live, children: [
    child,
    { ...child, thread_id: 'second', name: 'Second' },
    { ...child, thread_id: 'idle', name: 'Idle', status: 'inactive' },
  ] }, WIDE)
  expect(text(band.childActivity)).toBe('⠋ agent First running · +1 running')
  expect(renderBand({ ...live, children: [{ ...child, status: 'inactive' }] }, WIDE).childActivity).toBeUndefined()
})

test('mixed failed and running children retain both states in compact terminal and desktop bands', () => {
  const children = [
    { thread_id: 'failed', reference: 'thread#s=failed', kind: 'subagent' as const, name: 'Old\n\u0007failure', status: 'failed' },
    { thread_id: 'running', reference: 'thread#s=running', kind: 'subthread' as const, name: 'Current', status: 'running' },
  ]
  const state = { ...live, children }
  const wide = renderBand(state, { ...WIDE, rows: 2 })
  expect(text(wide.childActivity)).toContain('1 running')
  expect(text(wide.childActivity)).not.toContain('\n')
  expect(text(wide.childActivity)).not.toContain('\u0007')
  for (const terminal of [true, false]) {
    const narrow = renderBand(state, { columns: 48, terminal, rows: 1 })
    expect(narrow.childActivity).toBeUndefined()
    expect(text(narrow.right)).toContain('failed')
    expect(text(narrow.right)).toContain('running')
    expect(bandWidth(narrow, terminal)).toBeLessThanOrEqual(48)
    const four = renderBand({ ...state, children: [
      ...children,
      { thread_id: 'syncing', reference: 'thread#s=syncing', kind: 'subagent' as const, name: 'Sync', status: 'waiting_for_synchronization' },
      { thread_id: 'queued', reference: 'thread#s=queued', kind: 'subagent' as const, name: 'Later', status: 'queued' },
    ] }, { columns: 48, terminal, rows: 1 })
    expect(text(four.right)).toMatch(/fail.*run.*sync.*queu/)
    expect(bandWidth(four, terminal)).toBeLessThanOrEqual(48)
  }
})
