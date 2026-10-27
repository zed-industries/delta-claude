/**
 * What the band above the prompt shows, worked out from the watch and progress state without a `Host`:
 * the turn it reports, the people and children it lists, and the rows it lays out. `band.tsx` draws it.
 */
import { conversationText, itemAuthor, middleTruncate, toolCallParts } from '../watch/conversation'
import type { UpdateStep } from '../cli/install-update'
import type { ThreadTurn, WatchChild, WatchEvent, WatchItem } from '../cli/thread-commands'

export type TurnStatus =
  | { state: 'idle' }
  | { state: 'starting'; name?: string; id?: string }
  | { state: 'remote'; name: string; id?: string }
  | { state: 'own' }
export type StatusSegment = { text: string; color?: string; bold?: boolean; dim?: boolean; inverse?: boolean }
/** Someone in the thread, as the band lists them; `id` is their person key, which keeps their color. */
export type Person = { id: string; name: string; arriving?: boolean; leaving?: boolean }
export type StatusState = {
  connection: 'stopped' | 'connecting' | 'live' | 'retrying'
  /** This session's conversation and checkout are being captured for Delta, uploaded or still queued. */
  recording?: boolean
  /** A session Delta does not sync: what the band says instead, and the command that changes it. */
  reminder?: { text: string; command: string }
  /** A dropped watch that outlasted its grace; within it the band is told the watch is live. */
  reconnecting?: boolean
  turn: TurnStatus
  error?: string
  /**
   * A running operation. An installation `update` draws its own step in place of `text` and publishes
   * no link, so the band promises none.
   */
  progress?: { text: string; tone: 'active' | 'done' | 'error'; step?: [number, number]; update?: UpdateStep }
  spinner?: { frame: number }
  deliveryPause?: string
  retryReason?: string
  /** The thread's share link; absent until a share has published one. */
  link?: string
  /** The thread's audience as a label, such as `Private` or `Shared with Zed`; shown apart from the link. */
  audience?: string
  /** Controls for a thread Delta refused: fork the rejected local changes into a kept thread, or discard them. */
  conflict?: { fork: string; discard: string }
  /** A control that publishes a private thread to the organization, like `/delta share`. */
  share?: { label: string }
  people?: Person[]
  children?: WatchChild[]
  /** The inventory was last observed on a watch that is no longer live. */
  childrenStale?: boolean
  /**
   * Another participant's running turn: how long it has run, how long it has been silent once that
   * counts as quiet, and what it is doing now, a thought or tool call open long enough to show, with
   * how long that has been open and how many other calls are.
   */
  agent?: { seconds: number; quiet?: number; doing?: { text: string; tool: boolean; seconds: number; more: number } }
  /** The link was just put on the clipboard. */
  copied?: boolean
}
/**
 * The band: on its one row the connection mark, the link and its copy control, and who is here or
 * whose agent is working; below, the link when the row cannot hold it, and a failure's reason.
 */
export type BandView = {
  tone: 'error' | 'live' | 'pending' | 'quiet'
  mark: StatusSegment
  /**
   * The name beside the mark, which says `Syncing` while the session is captured, or a session's
   * reminder and its command while it is not; it never gives way.
   */
  label: StatusSegment[]
  /**
   * The link: `text` shows it, on the row or on its own row below (`ownRow`), or nowhere when no
   * row can hold it. It is followable and copyable only with `href`; while a share or join still
   * runs it is shown dim, without one.
   */
  link?: { text?: string; href?: string; ownRow?: true; copy?: { label: string; copied?: true } }
  /** The thread's audience, shown beside the link; who can see the thread, not whether it has a link. */
  audience?: StatusSegment[]
  /** Controls for a thread Delta refused: fork the rejected local changes into a kept thread, or discard them. */
  conflict?: { fork: string; discard: string }
  /** A control that publishes a private thread to the organization. */
  share?: { label: string }
  right: StatusSegment[]
  detail?: StatusSegment[]
  /** Another participant's agent at work, on a line of its own above the band. */
  activity?: StatusSegment[]
  /** Child status on its own line when the host has room. */
  childActivity?: StatusSegment[]
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Fit a tool's key input between its author, name, status, and transcript gutter. */
export function toolRowParts(item: WatchItem, columns: number) {
  const { name, detail, status } = toolCallParts(item)
  const author = itemAuthor(item)
  const statusText = status ? ` (${status})` : ''
  const room = columns - 6 - author.length - 3 - name.length - statusText.length - 1
  return { name, author, status, statusText, shown: detail && room >= 12 ? middleTruncate(detail, room) : '' }
}

/** Determine ownership without adopting a turn already identified as remote. */
export function threadTurnOwned(state: {
  remoteTurn?: { turnId: string | null }
  execution?: { sequence: number; lost?: true }
  producerTurn?: ThreadTurn
  ownTurnId?: string
}, turn: Extract<WatchEvent, { type: 'turn' }>): boolean {
  if (state.remoteTurn && turn.turn_id === state.remoteTurn.turnId) return false
  const execution = state.execution
  const status = state.producerTurn?.status
  return (!!execution && !execution.lost && state.producerTurn?.sequence !== execution.sequence) ||
    (status === 'running' || (status === 'finished' && !!turn.turn_id && turn.turn_id === state.ownTurnId))
}

/** The two independently arriving watch streams determine the turn shown in the status band. */
export function statusCurrentTurn(state: {
  threadTurn?: Extract<WatchEvent, { type: 'turn' }>
  producerTurn?: ThreadTurn
  remoteTurn?: { name: string; id?: string }
}): TurnStatus {
  const turn = state.threadTurn
  if (turn?.state === 'running') {
    if (turn.turn_id === null) {
      const name = conversationText(turn.user?.name ?? '').trim() || undefined
      return { state: 'starting', ...name ? { name } : {}, ...turn.user ? { id: personKey(turn.user) } : {} }
    }
    const remote = state.remoteTurn
    return remote ? { state: 'remote', name: remote.name, ...remote.id ? { id: remote.id } : {} } : { state: 'own' }
  }
  return state.producerTurn?.status === 'running' ? { state: 'own' } : { state: 'idle' }
}

/**
 * The band animates a running share, join or installation update, and another participant's turn;
 * Claude already animates this session's own.
 */
export function statusSpinnerRunning(state: Pick<StatusState, 'progress' | 'connection' | 'turn' | 'children'>): boolean {
  return state.progress?.tone === 'active' ||
    (state.connection === 'live' && (state.turn.state === 'remote' || state.turn.state === 'starting' ||
      !!state.children?.some((child) => child.status === 'running')))
}

const UNKNOWN_CHILD_PRIORITY = 5
const CHILD_PRIORITY: Readonly<Record<string, number>> = {
  failed: 0, running: 1, waiting_for_synchronization: 2, queued: 3, preparing: 4,
  unknown: UNKNOWN_CHILD_PRIORITY, completed: 6, stopped: 7,
}

/** Where a child of `status` sorts in the band; a status this plugin does not know sorts as `unknown`. */
function childPriority(status: string): number {
  return CHILD_PRIORITY[status] ?? UNKNOWN_CHILD_PRIORITY
}

function childState(status: string, stale: boolean): string {
  if (stale) return 'unknown'
  if (status === 'waiting_for_synchronization') return 'syncing'
  return Object.hasOwn(CHILD_PRIORITY, status) ? status : 'unknown'
}

/** Show one representative child and count the rest without conflating their state with the parent turn. */
function childStatus(children: readonly WatchChild[], stale: boolean, frame: string, room: number): StatusSegment[] {
  if (!children.length) return []
  const ordered = [...children].sort((a, b) => childPriority(a.status) - childPriority(b.status))
  const child = ordered[0]!
  const status = childState(child.status, stale)
  const counts = new Map<string, number>()
  for (const entry of ordered) {
    const label = childState(entry.status, stale)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const summary = [...counts].map(([label, count]) => `${count} ${label}`).join(' · ')
  const compactNames: Record<string, string> = {
    failed: 'fail', running: 'run', syncing: 'sync', queued: 'queue',
  }
  const compact = [...counts].map(([label, count]) => `${count} ${compactNames[label] ?? label}`).join(' ')
  const color = stale ? undefined : child.status === 'failed' ? 'red'
    : child.status === 'running' ? 'cyan'
      : ['queued', 'waiting_for_synchronization', 'preparing'].includes(child.status) ? 'yellow' : undefined
  const prefix = stale ? '◌' : child.status === 'running' ? frame : child.status === 'failed' ? '✕' : '·'
  const kind = child.kind === 'subagent' ? 'agent' : child.kind === 'subthread' ? 'thread' : 'child'
  const otherStates = [...counts].filter(([label]) => label !== status)
    .map(([label, count]) => `${count} ${label}`).join(' · ')
  const sameStateOthers = (counts.get(status) ?? 1) - 1
  const suffix = ` ${status}${sameStateOthers ? ` · +${sameStateOthers} ${status}` : ''}${otherStates ? ` · ${otherStates}` : ''}`
  const base = `${prefix} ${kind} `
  const name = middleTruncate(conversationText(child.name).replace(/\s+/g, ' ').trim() || child.thread_id,
    Math.max(0, room - textWidth(base + suffix)))
  if (!name || room < textWidth(base + suffix) + 1)
    return [{ text: textWidth(summary) <= room ? summary : compact, dim: stale || undefined }]
  return [
    { text: base, color, dim: stale || undefined },
    { text: name, bold: true, dim: stale || undefined },
    { text: suffix, color, dim: stale || undefined },
  ]
}

/** Colors a person keeps across the band and their transcript rows: none that means a status. */
const PERSON_COLORS = ['magenta', 'cyan', 'blue', 'magentaBright', 'cyanBright', 'blueBright']
/** The least space between the two sides of the row. */
const MIN_GAP = 2
/** The status bar's padding, a column at each end. */
const BAR_PADDING = 2
/** Names shown before the rest collapse to +N. */
const MAX_NAMES = 3

/** Who a thread user is, across presence, turns and items: their id, or their name without one. */
export function personKey(user: { user_id: string | null; name: string | null } | null | undefined): string {
  return user?.user_id ?? `name:${conversationText(user?.name ?? '').trim()}`
}

/** The same person gets the same color every time, from their person key. */
export function personColor(key: string): string {
  let hash = 0
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return PERSON_COLORS[hash % PERSON_COLORS.length]!
}

/** First names, with a last initial where two people share one. */
export function firstNames(people: readonly { id: string; name: string }[]): Map<string, string> {
  const words = people.map(({ id, name }) => {
    const [first = '', second = ''] = name.trim().split(/\s+/)
    return { id, first, initial: [...second][0] }
  })
  const shared = (first: string) => words.filter((word) => word.first === first).length > 1
  return new Map(words.map(({ id, first, initial }) => [id, shared(first) && initial ? `${first} ${initial}.` : first]))
}

/** A thread's link as a short label: its host, first segment and tail. */
export function shortLink(href: string): string {
  try {
    const url = new URL(href)
    const [segment, ...rest] = url.pathname.split('/').filter(Boolean)
    const last = rest.at(-1)
    if (!segment || !last) return `${url.host}${url.pathname}`.replace(/\/$/, '')
    return `${url.host}/${segment}/…${[...last].slice(-6).join('')}`
  } catch { return href }
}

export function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`
}

const UPDATE_BAR_CELLS = 8

/**
 * A running installation update's step: what it is doing to which version, and a download's bar and
 * percent. The bar gives way first, then the version. An action the person must take shows as a short
 * state; the transcript holds its whole message.
 */
function updateStep(step: UpdateStep, frame: string, give: { bar: boolean; version: boolean }): StatusSegment[] {
  const spinner = { text: `${frame} `, color: 'yellow' }
  if ('action' in step) return [spinner, {
    text: step.action === 'approve_installer' ? 'Waiting for installer approval' : 'Waiting for you',
    color: 'yellow', bold: true,
  }]
  const version = give.version && step.version ? ` ${step.version}` : ''
  const doing = ({
    checking: 'Checking for updates', downloading: 'Downloading', preparing: 'Preparing', installing: 'Installing',
  } as const)[step.phase]
  if (step.phase !== 'downloading' || step.percent === undefined)
    return [spinner, { text: `${doing}${version}…`, color: 'yellow' }]
  const filled = Math.round(step.percent / 100 * UPDATE_BAR_CELLS)
  return [spinner, { text: `${doing}${version}`, color: 'yellow' },
    ...give.bar ? [{ text: ` ${'▰'.repeat(filled)}${'▱'.repeat(UPDATE_BAR_CELLS - filled)}`, color: 'yellow' }] : [],
    { text: ` ${step.percent}%`, color: 'yellow' }]
}

const textWidth = (text: string) => [...text].length
const width = (segments: readonly StatusSegment[]) => segments.reduce((sum, { text }) => sum + textWidth(text), 0)

/**
 * A plugin release and its bracketed buttons share one row. Drop the prefix, then secondary actions
 * as space runs out; long prerelease versions truncate before the buttons do. Columns exclude padding.
 */
export function pluginUpdateRow(version: string, ready: boolean, columns: number, canReload = true) {
  const action = ready ? canReload ? 'Reload' : 'Details' : 'Update'
  for (const layout of [
    { prefix: 'Plugin ', later: true, mute: true },
    { prefix: '', later: true, mute: true },
    { prefix: '', later: true, mute: false },
    { prefix: '', later: false, mute: false },
  ]) {
    // Native terminal buttons render as "[ label ]": four cells of chrome, one between buttons.
    const controls = action.length + 4 + (layout.later ? 10 : 0) + (layout.mute ? 9 : 0)
    const room = Math.floor(columns) - controls - 1 - 2 - layout.prefix.length
    if (room < Math.min(8, version.length)) continue
    const shown = middleTruncate(version, room)
    return { ...layout, version: shown, action, summaryColumns: 2 + layout.prefix.length + shown.length }
  }
}

/** What the band's renderer draws for the copy control. */
export function copyText(copy: { label: string; copied?: true }): string {
  return copy.copied ? '✔ copied' : copy.label
}

/**
 * The columns the band's first row takes, as its renderer draws it:
 * `● Delta  link  copy link        Maya, Sam`, padded by a column at each end on the terminal.
 */
export function bandWidth(band: BandView, terminal: boolean): number {
  const link = band.link?.text && !band.link.ownRow ? 2 + textWidth(band.link.text) : 0
  const copy = band.link?.copy ? 2 + textWidth(copyText(band.link.copy)) : 0
  const audience = band.audience?.length ? 2 + width(band.audience) : 0
  const conflict = band.conflict ? 2 + textWidth(band.conflict.fork) + 2 + textWidth(band.conflict.discard) : 0
  const share = band.share ? 2 + textWidth(band.share.label) : 0
  const right = width(band.right)
  return (terminal ? BAR_PADDING : 0) + width([band.mark, ...band.label]) + link + audience + copy + share + conflict +
    (right ? MIN_GAP + right : 0)
}

/** What gives way as the row narrows, each step keeping the ones before it. */
type GiveWay = { shortCopy?: true; linkBelow?: true; initials?: true; alone?: true; noShare?: true; noAudience?: true; noLink?: true }
const GIVE_WAY: GiveWay[] = [
  {},
  { shortCopy: true },
  { shortCopy: true, linkBelow: true },
  { shortCopy: true, linkBelow: true, initials: true },
  { shortCopy: true, linkBelow: true, initials: true, alone: true },
  { shortCopy: true, linkBelow: true, initials: true, alone: true, noShare: true },
  { shortCopy: true, linkBelow: true, initials: true, alone: true, noShare: true, noAudience: true },
  { shortCopy: true, linkBelow: true, initials: true, alone: true, noShare: true, noAudience: true, noLink: true },
]

/**
 * The band as a view of state; rendering never starts timers or mutates its input. As the row
 * narrows, parts give way in GIVE_WAY's order: the copy label shortens, the terminal's URL moves to
 * a row of its own below, other people become initials and the working agent's owner drops
 * "'s agent", the others go, and then the share control and the audience label. The mark, the link
 * and whoever is working stay; only a band without a row for the URL drops its text, and the copy
 * control still copies it. The desktop's link shows the URL's short form on the row throughout.
 *
 * Rows go to the band's row, then a failure's reason, then another participant's working agent on a
 * line of its own, then the terminal's URL. With no row for the agent's line, it takes its owner's
 * place on the band's row, as the narrowing above describes. The thread's audience sits beside the
 * link on the band's row.
 */
export function renderBand(state: StatusState, layout: { columns: number; terminal: boolean; rows?: number }): BandView {
  const progress = state.progress
  const failure = progress?.tone === 'error' ? progress.text : state.error ?? state.deliveryPause
  const running = progress?.tone === 'active' ? progress : undefined
  const tone: BandView['tone'] = failure ? 'error'
    : running || state.retryReason || state.reconnecting || state.connection === 'connecting' ? 'pending'
    : state.connection === 'stopped' ? 'quiet' : 'live'
  const mark = ({
    error: { text: '✕', color: 'red' }, pending: { text: '◌', color: 'yellow' },
    live: { text: '●', color: 'green' }, quiet: { text: '○', dim: true },
  } as const)[tone]
  const label: StatusSegment[] = [{ text: ' Delta', dim: true },
    ...running?.update ? [{ text: ' · ', dim: true }, { text: 'Updating' }]
      : state.recording ? [{ text: ' · ', dim: true }, { text: 'Syncing' }]
      : state.reminder ? [{ text: ' · ', dim: true }, { text: state.reminder.text }, { text: `  ${state.reminder.command}`, dim: true }]
      : []]
  const detail = failure ? [{ text: failure, color: 'red' }]
    : state.retryReason ? [{ text: `Retrying: ${state.retryReason}`, color: 'yellow' }] : undefined
  const frame = SPINNER_FRAMES[state.spinner?.frame ?? 0]!
  // A link is followable once published; while a share or join still runs it is shown, not offered.
  const href = running ? undefined : state.link
  const linkText = state.link ? (layout.terminal ? state.link : shortLink(state.link))
    : running && !running.update ? 'link appears when ready' : undefined
  const turn = state.turn
  const owner = (turn.state === 'remote' || turn.state === 'starting') && state.connection !== 'stopped' && !state.reconnecting
    ? turn : undefined
  // A working agent takes a line of its own when the rows hold it after a failure's reason;
  // otherwise it takes its owner's place on the band's row.
  const activityLine = !!owner && (layout.rows ?? Infinity) >= 2 + (detail ? 1 : 0)
  // An inactive child is not activity, so the band leaves it out entirely.
  const children = (state.children ?? []).filter((child) => child.status !== 'inactive')
  const childLine = children.some((child) =>
    state.childrenStale || !['completed', 'stopped'].includes(child.status)) &&
    (layout.rows ?? Infinity) >= 2 + (detail ? 1 : 0) + (activityLine ? 1 : 0)
  // The URL's own row, wrapped as the terminal wraps it, fits only within the rows the others leave.
  const linkRows = linkText ? Math.ceil((2 + textWidth(linkText)) / Math.max(1, layout.columns - BAR_PADDING)) : 0
  const roomBelow = layout.terminal &&
    (layout.rows ?? Infinity) >= 1 + linkRows + (detail ? 1 : 0) + (activityLine ? 1 : 0) + (childLine ? 1 : 0)
  const others = (state.people ?? []).filter((person) => activityLine || person.id !== owner?.id)
  const names = firstNames(others)

  const roster = (initials: boolean): StatusSegment[] => {
    const out: StatusSegment[] = []
    others.slice(0, MAX_NAMES).forEach((person, index) => {
      if (index) out.push(initials ? { text: ' ' } : { text: ', ', dim: true })
      const name = names.get(person.id) ?? ''
      out.push({ text: initials ? [...name][0] ?? '' : name, color: personColor(person.id), bold: true,
        inverse: person.arriving || undefined, dim: person.leaving || state.reconnecting || undefined })
    })
    if (others.length > MAX_NAMES) out.push({ text: ` +${others.length - MAX_NAMES}`, dim: true })
    return out
  }
  /** The working agent: on the band's row, its owner and the turn's time; on its own line, what it is doing too. */
  const agent = (short: boolean, line = false): StatusSegment[] => {
    if (!owner) return []
    const color = personColor(owner.id ?? owner.name ?? '')
    const first = owner.name?.trim().split(/\s+/)[0]
    const who = { text: first ? (short ? first : `${first}'s agent`) : 'An agent', color, bold: true }
    const spinner = { text: `${frame} `, color }
    if (owner.state === 'starting') return [spinner, who, { text: ' starting…', dim: true }]
    const quiet = state.agent?.quiet
    if (quiet !== undefined) return [{ text: '◌ ', color: 'yellow' }, who, { text: ` quiet ${formatSeconds(quiet)}`, color: 'yellow' }]
    if (!state.agent) return [spinner, who]
    const doing = line ? state.agent.doing : undefined
    if (!doing) return [spinner, who, { text: line ? `  (${formatSeconds(state.agent.seconds)})` : ` ${formatSeconds(state.agent.seconds)}`, dim: true }]
    const separator = { text: ' › ', dim: true }
    const time = { text: `  (${formatSeconds(doing.seconds)}${doing.more ? ` · ${doing.more} more running` : ''})`, dim: true }
    // The line has the whole width, so a long title gives up its middle rather than its end.
    const room = layout.columns - (layout.terminal ? BAR_PADDING : 0) - width([spinner, who, separator, time])
    return [spinner, who, separator, { text: middleTruncate(doing.text, room), ...doing.tool ? { bold: true } : {} }, time]
  }
  const right = (give: GiveWay): StatusSegment[] => {
    if (running?.update) return updateStep(running.update, frame, { bar: !give.initials, version: !give.alone })
    if (running) return [{ text: `${frame} ${running.text}`, color: 'yellow' },
      ...running.step ? [{ text: ` ${running.step.join('/')}`, dim: true }] : []]
    if (progress?.tone === 'done') return [{ text: `✔ ${progress.text}`, color: 'green' }]
    const working = activityLine ? [] : agent(!!give.initials)
    const people = give.alone ? [] : roster(!!give.initials)
    const below = give.linkBelow && roomBelow
    const inlineLink = give.noLink && !below && (layout.terminal || !!children.length) ? undefined : linkText
    const linkRoom = inlineLink && !below ? 2 + textWidth(inlineLink) : 0
    const copyRoom = href ? 2 + textWidth(give.shortCopy ? 'copy' : 'copy link') : 0
    const child = childLine ? [] : childStatus(children, !!state.childrenStale, frame,
      Math.max(0, layout.columns - (layout.terminal ? BAR_PADDING : 0) - 7 - linkRoom - copyRoom -
        MIN_GAP - width(working) - (working.length ? 3 : 0)))
    const parts = [working, child, people].filter((part) => part.length)
    return parts.flatMap((part, index) => index ? [{ text: ' · ', dim: true }, ...part] : part)
  }
  const view = (give: GiveWay): BandView => {
    const below = give.linkBelow && roomBelow
    const text = give.noLink && !below && (layout.terminal || !!children.length) ? undefined : linkText
    const copy = href ? { copy: { label: give.shortCopy ? 'copy' : 'copy link', ...state.copied ? { copied: true as const } : {} } } : {}
    return {
      tone, mark, label, right: right(give),
      ...detail ? { detail } : {},
      ...state.audience && !give.noAudience ? { audience: [{ text: state.audience, dim: true }] } : {},
      ...state.conflict ? { conflict: state.conflict } : {},
      ...state.share && !give.noShare ? { share: state.share } : {},
      ...activityLine ? { activity: agent(false, true) } : {},
      ...childLine ? { childActivity: childStatus(children, !!state.childrenStale, frame,
        Math.max(10, layout.columns - (layout.terminal ? BAR_PADDING : 0))) } : {},
      ...linkText ? { link: { ...text ? { text } : {}, ...href ? { href } : {}, ...below ? { ownRow: true as const } : {}, ...copy } } : {},
    }
  }
  const views = GIVE_WAY.map(view)
  return views.find((band) => bandWidth(band, layout.terminal) <= layout.columns) ?? views.at(-1)!
}
