/**
 * The band above the prompt: what it says about the watched thread, a running share, join or
 * installation update, sync reminders, and its spinner, reconnect and copied-link timers.
 */
import type { RenderSurface, TextProps, Timer } from 'claude-code'
import { conversationWebLink, itemAuthor, THOUGHT_KIND, toolCallParts } from '../watch/conversation'
import {
  currentOrganizationId, isPersonalOrganizationId, loadOrganizationDirectory, organizationName,
} from '../setup/organizations'
import {
  activation, type Binding, type HookEvent, type HookNext, report, requests, type Runtime, sessions,
} from '../core/session-state'
import {
  copyText, personColor, personKey, renderBand, SPINNER_FRAMES, type StatusSegment, statusSpinnerRunning,
  type StatusState,
} from './status'
import type { UpdateStep } from '../cli/install-update'
import type { WatchItem } from '../cli/thread-commands'
import { feed, presence, watchStatus, watchedSession, type RemoteTurn } from '../watch/watch'
import { drainMessages } from '../watch/rows'
import { beginRefusalResolution } from '../recording/delivery'
import { beginShare } from '../sharing/share'

/** A share or join that the band is reporting: running, finished, or failed. */
type ProgressTone = 'active' | 'done' | 'error'
/** A share's or join's line in the band: what it says, how it went, and which of its steps it is on. */
export type Progress = { text: string; tone: ProgressTone; step?: [number, number] }

/**
 * What the band keeps of its own: the running share's or join's line, held through the operation and
 * briefly after success, and the band's timers. A watcher restart ends the timers but keeps the line.
 */
const bandState: {
  progress?: Progress
  /** The running installation update's latest step; a share's or join's line takes its place. */
  update?: UpdateStep
  /** Clears a finished operation's line; cancelled on teardown and by the next operation. */
  progressTimer?: Timer
  /**
   * The animation's frame, live only while an operation or another participant's turn runs, and the
   * timer for its next frame, which is pending until that frame is drawn.
   */
  spinner?: { frame: number; timer?: Timer }
  /** The link was just copied; the timer clears the confirmation. */
  copiedTimer?: Timer
} = {}

/** The share or join line the band shows now, if any. */
export function reportedProgress(): Progress | undefined {
  return bandState.progress
}

/** A watcher restart ends the band's timers; a running share or join keeps its line, only its timer ends. */
export function stopBandTimers() {
  bandState.copiedTimer?.cancel()
  bandState.copiedTimer = undefined
  stopSpinner()
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
}
/** The band's animation: one braille cycle, redrawn within the engine's per-site throttle. */
const SPINNER_INTERVAL_MS = 120
/** How long a finished share or join stays in the band before clearing. */
const BAND_NOTICE_MS = 4_000
/** How long another participant's running turn may go without any activity before the band calls it quiet. */
const QUIET_AFTER_MS = 30_000
/** A remote thought or tool call shows as what its agent is doing once open this long, so a burst of quick calls does not flicker. */
const SHOW_ACTIVITY_AFTER_MS = 500
/** How long the band confirms a copied link. */
const COPIED_MS = 2_000

/** Drop a finished operation's notice so the band can show what happened next. */
export function clearDoneNotice() {
  if (bandState.progress?.tone !== 'done') return
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
  bandState.progress = undefined
}

/**
 * Animate the band only while a live watch has a running turn, or an operation runs. Each frame is
 * asked for once the last one was drawn, so time that passes with nothing drawn, as in a test that
 * moves the clock minutes on, costs one frame rather than one per interval.
 */
export function syncSpinner($: Runtime) {
  if (!spinnerRunning()) return stopSpinner()
  const spinner = bandState.spinner ?? { frame: 0 }
  bandState.spinner = spinner
  if (spinner.timer) return
  const timer = $.clock.after(SPINNER_INTERVAL_MS, () => {
    if (bandState.spinner !== spinner || spinner.timer !== timer) return
    spinner.timer = undefined
    spinner.frame = (spinner.frame + 1) % SPINNER_FRAMES.length
    $.ui.invalidate('ui.render')
  })
  spinner.timer = timer
}

/** A running share or join animates wherever it runs; a turn animates only on a live watch. */
function spinnerRunning() {
  return statusSpinnerRunning({ ...feed, connection: watchStatus().actual, progress: currentProgress() })
}

function stopSpinner() {
  bandState.spinner?.timer?.cancel()
  bandState.spinner = undefined
}

/** Record what a share or join is doing and redraw; the band's animation follows it. */
export function setProgress($: Runtime, text: string, tone: ProgressTone, step?: [number, number]) {
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
  bandState.progress = { text, tone, step }
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

/** Finish an operation: a success clears after BAND_NOTICE_MS, a failure stays until replaced. */
export function finishProgress($: Runtime, text: string, tone: 'done' | 'error') {
  setProgress($, text, tone)
  if (tone !== 'done') return
  const timer = $.clock.after(BAND_NOTICE_MS, () => {
    if (bandState.progressTimer !== timer) return
    bandState.progressTimer = undefined
    bandState.progress = undefined
    syncSpinner($)
    $.ui.invalidate('ui.render')
  })
  bandState.progressTimer = timer
}

/** Show the installation update's latest step in place, or drop its line once it ends (undefined). */
export function showUpdateProgress($: Runtime, step: UpdateStep | undefined) {
  bandState.update = step
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

/** Drop an operation's band line, as a torn-down session does. */
export function clearProgress($: Runtime) {
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
  bandState.progress = undefined
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

/**
 * Whether the band has a Delta status to draw: a live watch, a share or join step, a failure, or the
 * reminder of a session Delta does not sync.
 */
function statusShown(): boolean {
  return !!watchedSession() || !!currentProgress() || !!watchStatus().error || !!activeReminder()
}

/** How the band reminds a session Delta does not sync, by the checkout's setting. */
export type SyncReminder = 'manual' | 'not set up'
const REMINDERS: Record<SyncReminder, { text: string; command: string }> = {
  manual: { text: 'Not syncing', command: '/delta-share' },
  'not set up': { text: 'Not set up', command: '/delta-setup' },
}

/**
 * The active session's reminder, while the band has nothing else to say. A running share or join,
 * a failure, or an unfinished join takes its place, and a syncing session's band says `Syncing`
 * instead, so the band always shows the current state.
 */
function activeReminder(): { text: string; command: string } | undefined {
  const runtime = sessions.get(activation.session)
  if (!runtime?.reminder || currentProgress() || watchStatus().error || runtime.binding?.joinTransition) return
  return REMINDERS[runtime.reminder]
}

/**
 * What another participant's turn is doing: its newest thought or tool call open long enough to
 * show, how long that has been open, and how many of its other calls are.
 */
function remoteActivity(remote: RemoteTurn, now: number): NonNullable<StatusState['agent']>['doing'] {
  const shown = [...feed.openSince].flatMap(([id, since]) => {
    const item = feed.view?.items.get(id)
    const current = !remote.turnId || !item?.turn_id || item.turn_id === remote.turnId
    return item?.open && current && (item.kind === 'tool_call' || item.kind === THOUGHT_KIND) &&
      now - since >= SHOW_ACTIVITY_AFTER_MS ? [{ item, since }] : []
  })
  const newest = shown.reduce<typeof shown[number] | undefined>(
    (latest, entry) => !latest || entry.since >= latest.since ? entry : latest, undefined)
  if (!newest) return
  const tool = newest.item.kind === 'tool_call'
  return {
    text: tool ? toolCallParts(newest.item).name : 'thinking', tool,
    seconds: (now - newest.since) / 1000,
    more: shown.filter((entry) => entry !== newest && entry.item.kind === 'tool_call').length,
  }
}

/** What the band shows, at the moment it draws. */
async function statusView($: Runtime): Promise<StatusState> {
  const session = watchedSession()
  const state = session ? sessions.get(session) : undefined
  const watch = watchStatus()
  const remote = feed.turn.state === 'remote' ? feed.remoteTurn : undefined
  const now = await $.clock.now()
  const since = remote?.since ?? now
  const silent = now - (remote?.heard ?? since)
  // A turn with an item still open, such as a long command, is working however long it is silent.
  const open = [...feed.view?.items.values() ?? []].some((item) => item.open)
  const doing = remote ? remoteActivity(remote, now) : undefined
  const binding = state?.binding
  // The visibility label names an organization; read the directory once, and a later redraw fills it.
  if (binding?.visibility) void loadOrganizationDirectory($)
  return {
    ...feed,
    // A staged automatic session records before its watch starts, while the band shows its connection step.
    recording: !!sessions.get(session ?? activation.session)?.binding?.snapshot,
    reminder: activeReminder(),
    // Within the grace after a drop, the band carries on as if the watch were live.
    connection: watch.connection,
    reconnecting: watch.reconnecting,
    error: watch.error,
    deliveryPause: state?.pauses.get('delivery') ?? state?.pauses.get('verification'),
    retryReason: state?.retryTimer ? state.retryReason : undefined,
    progress: currentProgress(),
    spinner: bandState.spinner,
    link: statusLink(),
    audience: audienceLabel(binding),
    // A refused offline thread keeps its controls until the person forks the changes or discards them.
    conflict: state?.refusedOffline ? { fork: 'Fork & Restore', discard: 'Discard' } : undefined,
    // Sharing waits for Claude's turn to finish, so the control says so rather than ignoring a press.
    // A personal organization has nobody to share with, so its threads offer no share control.
    share: binding?.visibility === 'private' && !isPersonalOrganizationId(threadOrganization(binding) ?? currentOrganizationId ?? '') ? {
      label: requests.shareAfterTurn?.session === activation.session && state?.currentTurnId ? 'Sharing after this turn'
        : state?.currentTurnId ? 'Share after this turn'
        : `Share with ${organizationName(threadOrganization(binding)) ?? 'organization'}`,
    } : undefined,
    people: presence.roster(),
    children: feed.children,
    childrenStale: watch.actual !== 'live',
    agent: remote ? {
      seconds: (now - since) / 1000,
      ...!open && silent >= QUIET_AFTER_MS ? { quiet: silent / 1000 } : {},
      ...doing ? { doing } : {},
    } : undefined,
    copied: !!bandState.copiedTimer,
  }
}

/**
 * Who can see the thread, apart from whether it has a link: `Synced with <org>` for a thread only
 * its owner sees (a private one, or any in a personal organization, which has no other members),
 * `Shared with <org>`, or `Unlisted`.
 */
function audienceLabel(binding: Binding | undefined): string | undefined {
  if (!binding?.visibility) return undefined
  if (binding.visibility === 'unlisted') return 'Unlisted'
  const organization = threadOrganization(binding) ?? currentOrganizationId
  const name = organizationName(organization) ?? 'your team'
  return binding.visibility === 'private' || isPersonalOrganizationId(organization ?? '')
    ? `Synced with ${name}` : `Shared with ${name}`
}

/**
 * The organization a session's thread uploads to. The organization the plugin created the thread
 * under names it, since the CLI's status can report none even for a thread created with one.
 * Undefined for a thread shared without a saved team, or joined, which the caller names by the
 * current organization.
 */
export function threadOrganization(binding: Binding): string | undefined {
  return binding.autoUpload?.organization ?? binding.organization ?? binding.upload?.organization_id ?? undefined
}

/**
 * Delta's background upload of an automatic session, drawn on the band's row like a share's steps:
 * its first upload until Delta confirms it, then only a failure. Activation only requests the upload,
 * and Delta registers the thread a moment before it confirms the content, so the link is offered
 * once the upload is confirmed; later per-turn syncs are not shown.
 */
function uploadProgress(binding: Binding | undefined): StatusState['progress'] {
  if (!binding?.autoUpload || !binding.thread) return undefined
  const upload = binding.upload
  if (upload?.state === 'failed')
    return { text: `Sync failed: ${upload.error?.message ?? upload.error?.reason ?? 'unknown reason'}`, tone: 'error' }
  if (binding.uploaded) return undefined
  // Delta reports a failure it retries itself as queued with its error, which is progress, not a failure.
  if (upload?.state === 'queued' && upload.error)
    return { text: `Retrying sync: ${upload.error.message || upload.error.reason || upload.error.code}`, tone: 'active' }
  return { text: upload?.state === 'queued' ? 'Waiting to sync…' : 'Syncing to DeltaDB…', tone: 'active' }
}

/**
 * The operation the band draws: a share, join, or activation step, else an installation update, else
 * an automatic session's upload.
 */
function currentProgress(): StatusState['progress'] {
  const session = watchedSession()
  return bandState.progress ??
    (bandState.update ? { text: 'Updating Delta', tone: 'active', update: bandState.update } : undefined) ??
    uploadProgress(session ? sessions.get(session)?.binding : undefined)
}

/**
 * The shared thread's link: the watched session's saved binding, which every status inspection keeps
 * current. A URL says a thread exists, not that others can see it; the audience is shown apart.
 * Absent until status reports one, and while a share or join still runs the band shows it dim, without
 * offering it.
 */
function statusLink(): string | undefined {
  const session = watchedSession()
  if (!session) return
  return conversationWebLink(sessions.get(session)?.binding?.url)
}

/** The status bar's shade for each kind of theme: a step off the terminal's own background. */
const BAR_SHADES = { dark: '#303030', light: '#e8e8e8' }
/** The shade for the person's theme, read once and again whenever they change it. */
let barTheme: keyof typeof BAR_SHADES | undefined

/** A changed theme changes the shade; the next draw reads it again. */
export function forgetBarTheme() {
  barTheme = undefined
}

/**
 * The status bar's shade for the person's theme. A terminal that cannot show it as given rounds it
 * to a color it has; at worst the shade is lost and the band reads as a plain row.
 */
async function barShade($: Runtime): Promise<string> {
  if (!barTheme) {
    const theme = (await $.config.list()).find((row) => row.key === 'theme')?.value
    barTheme = typeof theme === 'string' && theme.startsWith('light') ? 'light' : 'dark'
  }
  return BAR_SHADES[barTheme]
}

/** Copy the link to the surface the press came from, and confirm it only once the clipboard took it. */
async function copyLink($: Runtime, link: string, surface: RenderSurface) {
  const result = await $.ui.copy({ text: link, surface })
  if (!result.isCopied) {
    await $.ui.log(`Delta: couldn't copy the link: ${result.reason}`, { to: 'debug' })
    return
  }
  bandState.copiedTimer?.cancel()
  const timer = $.clock.after(COPIED_MS, () => {
    if (bandState.copiedTimer !== timer) return
    bandState.copiedTimer = undefined
    $.ui.invalidate('ui.render')
  })
  bandState.copiedTimer = timer
  $.ui.invalidate('ui.render')
}

/** Only the props a segment actually sets, so the surface never sees an undefined style. */
function segmentProps(segment: StatusSegment): TextProps {
  const props: TextProps = {}
  if (segment.color !== undefined) props.color = segment.color
  if (segment.bold) props.bold = true
  if (segment.dim) props.dimColor = true
  if (segment.inverse) props.inverse = true
  return props
}

/** The color the band gives an item's author, so a person reads the same everywhere. */
export function authorColor(item: WatchItem): string {
  return personColor(personKey(item.author ?? { user_id: null, name: itemAuthor(item) }))
}

/**
 * The band above the prompt: the connection, the thread's link to click or copy, and who is here or
 * whose agent is working. It draws only while a Delta conversation is active, yields to a survey,
 * and takes at most the band's rows. Draining the queued message rows here also gives them the hook
 * context their own command needs.
 */
export async function drawBand(
  $: Runtime,
  e: HookEvent<'ui.render', { component: 'AbovePrompt' }>,
  next: HookNext<'ui.render', { component: 'AbovePrompt' }>,
) {
  await drainMessages($)
  if (!statusShown() || e.props.hasSurvey) return next(e)
  const maxRows = Math.max(0, e.props.maxRows)
  if (maxRows === 0) return next(e)
  // This draw shows the current frame, so the animation may ask for the next.
  syncSpinner($)
  const terminal = e.surface === 'terminal'
  const columns = Math.max(0, e.props.bodyColumns)
  const band = renderBand(await statusView($), { columns, terminal, rows: maxRows })
  const { Box, Text, Link, Button } = $.ui.resolve(e)
  const spans = (segments: StatusSegment[]) =>
    segments.map((segment, index) => <Text key={String(index)} {...segmentProps(segment)}>{segment.text}</Text>)
  const { text, href, ownRow, copy } = band.link ?? {}
  // A followable link is a real hyperlink on every surface, so a terminal can open it however it
  // handles clicks. The terminal's Link takes no label: where Claude does not treat the terminal as
  // hyperlink-capable, a labelled Link prints its label and then its URL, the same text twice, while
  // an unlabelled one prints the URL once. While a share or join runs, the link is shown dim and not
  // offered.
  let link = null
  if (text && href) link = terminal ? <Link href={href} /> : <Link href={href} label={text} />
  else if (text) link = <Text {...segmentProps({ text, dim: true })}>{text}</Text>
  let copier = null
  if (href && copy?.copied) copier = <Text color="green">{copyText(copy)}</Text>
  // Taking the band's focus lands on the copy control, so Enter copies; a hotkey hint would read
  // as though the key worked from the prompt, where it only types.
  else if (href && copy) copier = <Button key="copy" plain dimColor autoFocus label={copy.label}
    onPress={(press) => { void copyLink($, href, press.surface).catch((error) => report($, error)) }} />
  // A private thread offers the same publication `/delta share` runs; the band does not repeat it
  // once the thread is shared with the organization.
  const sharer = band.share ? <Button key="share" plain dimColor label={band.share.label}
    onPress={() => { const session = watchedSession(); if (session) beginShare($, session) }} /> : null
  // A refused offline thread offers the person the choice that resolves it.
  const conflict = band.conflict ? [
    <Button key="fork" plain dimColor label={band.conflict.fork}
      onPress={() => { const session = watchedSession(); if (session) beginRefusalResolution($, session, 'fork') }} />,
    <Button key="discard" plain dimColor label={band.conflict.discard}
      onPress={() => { const session = watchedSession(); if (session) beginRefusalResolution($, session, 'discard') }} />,
  ] : []
  // Every control is set apart by the same gap the band's other segments use.
  const controls = [copier, sharer, ...conflict].filter((control) => control !== null)
    .flatMap((control, index) => index ? [<Text key={`gap-${index}`}>{'  '}</Text>, control] : [control])
  const inline = link && !ownRow
  const rows = [
    <Box key="band" flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexDirection="row">
        <Text wrap="truncate-end">
          <Text {...segmentProps(band.mark)}>{band.mark.text}</Text>
          {spans(band.label)}
          {inline ? '  ' : ''}{inline ? link : null}
          {band.audience?.length ? <Text>{'  '}{spans(band.audience)}</Text> : null}
          {controls.length ? '  ' : ''}
        </Text>
        {controls}
      </Box>
      {band.right.length ? <Text wrap="truncate-end">{spans(band.right)}</Text> : null}
    </Box>,
    link && ownRow ? <Text key="link">{'  '}{link}</Text> : null,
    band.detail && maxRows >= 2 ? <Text key="detail" wrap="truncate-end">{'  '}{spans(band.detail)}</Text> : null,
  ].filter((part) => part !== null)
  // Another participant's working agent reads like Claude's own working line: unshaded, above the
  // band, where its finished calls then land in the transcript.
  const activity = band.activity ? <Text key="activity" wrap="truncate-end">{spans(band.activity)}</Text> : null
  const childActivity = band.childActivity ? <Text key="children" wrap="truncate-end">{spans(band.childActivity)}</Text> : null
  // The desktop's own card sets the band apart. The terminal shades it, a status bar the width of
  // the band, so it reads as part of the input area rather than another transcript row.
  if (!terminal) return <Box flexDirection="column">{activity}{childActivity}{rows}</Box>
  const bar = <Box key="bar" flexDirection="column" width={columns} paddingX={1} backgroundColor={await barShade($)}>{rows}</Box>
  if (!activity && !childActivity) return bar
  return <Box flexDirection="column" width={columns}>
    {activity ? <Box paddingX={1}>{activity}</Box> : null}
    {childActivity ? <Box paddingX={1}>{childActivity}</Box> : null}
    {bar}
  </Box>
}
