/**
 * The watched thread's items and comments in Claude's transcript: rows queued while Claude's own turn
 * runs, then drawn one at a time as the plugin's own command output.
 */

import { authorColor } from '../band/band'
import {
  addRows, commentAction, commentAuthor, commentDisplay, commentMarkdown, commentQuote, isDrawnItem, isEventItem,
  itemAuthor, itemDisplay, itemMarkdown, keyedComment, type PendingRow,
} from './conversation'
import { DrawQueue, EMPTY_ROW_TEXT, shownItemId } from './row-delivery'
import { drawnRowKey, type HookEvent, type HookNext, ledgerKey, stateFor } from '../core/session-state'
import type { Host } from '../core/host'
import { personColor, personKey, toolRowParts } from '../band/status'
import { errorText } from '../core/text'
import { feed, watchedSession } from './watch'

/** Rows waiting to be drawn into Claude's transcript, one at a time. */
const drawQueue = new DrawQueue()
let drawing = false
/** A stored row of the plugin's own `show` run: the item its output row draws, or its echo. */
type ShownRow = string | { echo: true }
/** What each stored row of the plugin's own `show` run is, by the row's message id. */
const shownRows = new Map<string, ShownRow>()
/** The pass adding the watched thread's completed items to Claude's transcript, while one runs. */
export let settling: Promise<void> | undefined
/** The last notice a failed pass showed, so the same failure is shown once. */
let settleNotice: string | undefined
/** The answer the engine gives a plugin's command when no `command.run` hook of its own answered it. */
const UNANSWERED_COMMAND = /no command\.run hook answered it/

/** Rows wait while Claude's own turn runs or a local prompt is entering, so they never land inside a turn. */
export function rowsHeld(session: string) {
  const runtime = stateFor(session)
  return !!runtime.currentTurnId || !!runtime.promptEntering
}

/**
 * The transcript draws one `$.ui.log` entry per call and flattens an embedded newline to U+FFFD, so
 * a person-visible item goes out one entry per paragraph, keeping the line breaks it should have.
 */
export function showToPerson(host: Host, text: string) {
  for (const line of text.split('\n')) host.ui.log(line, { to: 'transcript' })
}

/** A hidden row for Claude's context, held back while a turn runs so it never lands inside one. */
export async function deliverNote(host: Host, session: string, text: string) {
  const runtime = stateFor(session)
  runtime.notes.push(text)
  if (!rowsHeld(session)) await flushNotes(host, session)
}

/** Add the notes held for a session to Claude's context, in order. */
async function flushNotes(host: Host, session: string) {
  const runtime = stateFor(session)
  for (const text of runtime.notes.splice(0)) {
    host.ui.log(`Adding a row to Claude's context: ${text.split('\n', 1)[0]}`, { to: 'debug' })
    try { await host.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }) }
    catch (error) { host.ui.log(`Couldn't add a Delta worktree update to Claude's context: ${String(error)}`, { to: 'debug' }) }
  }
}

/**
 * Draw a completed message as the output row of the plugin's own `show <id>` command, which is the
 * only plugin-producible transcript row that draws markdown and that redraws with our own tree.
 *
 * The engine runs a plugin's own call with the calling hook alone skipped, and a call from the
 * plugin's background code carries no calling hook, so it skips the plugin's own `command.run` hook
 * altogether. The row therefore waits for a redraw: a `ui.render` hook is a hook context, and the
 * command it raises inside one is answered.
 */
function drawMessage(host: Host, session: string, id: string): Promise<{ deny?: string }> {
  const result = drawQueue.wait(session, id, () => rowsHeld(session),
    (milliseconds, action) => host.clock.after(milliseconds, action))
  host.ui.invalidate()
  return result
}

/**
 * Abandon the rows a stopped conversation was still waiting to draw. They were not added, so the
 * next snapshot offers them again; a stopped watch reports nothing about them. Returns the pass
 * still running, whose save must finish before a new watch loads or writes the ledger.
 */
export function stopRows(): Promise<void> | undefined {
  drawQueue.drop()
  const running = settling
  settling = undefined
  settleNotice = undefined
  return running
}

/**
 * Run the queued message rows' commands, oldest first, from a hook context. Rows wait while a local
 * turn runs, and the queue keeps its order across redraws. A row is drawn once its output row is
 * stored, which the `session.append` hook confirms; a command that fails or goes unanswered settles
 * its row as not drawn.
 */
export async function drainMessages(host: Host) {
  const session = watchedSession()
  if (drawing || !session || !feed.view) return
  drawing = true
  try {
    while (drawQueue.length) {
      if (watchedSession() !== session || rowsHeld(session)) break
      const entry = drawQueue.shift()!
      let answer: string | undefined
      try { answer = (await host.command.run({ command: 'delta', args: `show ${entry.id}` })).text }
      catch (error) { entry.settle({ deny: errorText(error) }); continue }
      if (answer === undefined || UNANSWERED_COMMAND.test(answer))
        entry.settle({ deny: "this host did not run the plugin's own command" })
      else host.ui.log(`Ran the plugin's own command to draw the Delta item ${entry.id}.`, { to: 'debug' })
    }
  } finally {
    drawing = false
  }
  if (drawQueue.length) host.ui.invalidate()
}

/**
 * Add one model-visible row, and draw a message's copy for the person beside it.
 *
 * The model reads the plugin's own `session.append` row for every kind, so a message is drawn for
 * the person in addition to it, never instead of it. Neither the drawn row nor the model's row is
 * written twice: an item this session already drew is not drawn again, so a retried row repeats
 * neither. A host that will not draw the command output row leaves the model's row alone and shows
 * the person the plain notice.
 */
async function appendRow(host: Host, session: string, row: PendingRow): Promise<{ deny?: string }> {
  const id = row.commandItem
  const runtime = stateFor(session)
  if (id !== undefined) {
    const drawing = runtime.drawn.drawOnce(id, () => drawMessage(host, session, id))
    if (drawing) {
      const refusal = await drawing
      if (refusal.deny === undefined)
        host.ui.log(`Drew the Delta item ${id} as a command output row.`, { to: 'debug' })
      else fallbackNotice(host, row, refusal.deny)
    }
  }
  return host.session.append({ message: { type: 'user', content: [{ type: 'text', text: row.text }] } })
}

/** Show a message or comment the plain way, when its command output row is refused; the model's row stands. */
function fallbackNotice(host: Host, row: PendingRow, reason: string) {
  const view = feed.view
  const commentId = keyedComment(row.id)
  const comment = commentId === undefined ? undefined : view?.comments.get(commentId)
  const item = view?.items.get(row.id)
  const display = !view ? undefined
    : comment ? commentDisplay(comment, view.commentParent(comment), view.commentTarget(comment), view.thread)
    : item ? itemDisplay(item, view.thread) : undefined
  if (display) showToPerson(host, display)
  host.ui.log(`Couldn't draw this Delta message as a command row (${reason}).`, { to: 'debug' })
}

/**
 * Add completed remote items to Claude's transcript as model-visible rows, without starting a
 * turn, and correct rows for items that later changed or disappeared. Held rows resume when the
 * prompt is dropped or its turn completes.
 */
export function settleRemote(host: Host, session: string): Promise<void> | undefined {
  if (settling || watchedSession() !== session) return settling
  const revision = feed.revision
  const owns = () => feed.revision === revision && watchedSession() === session
  let task: Promise<void> | undefined = undefined
  task = (async () => {
    // Start after `task` is assigned, so a run with nothing to do still clears `settling`.
    await undefined
    try {
      if (!rowsHeld(session)) await flushNotes(host, session)
      const view = feed.view
      if (view) await addRows(view, {
        append: (row) => appendRow(host, session, row),
        save: (ledger) => host.store.set(ledgerKey(session), ledger),
        held: () => rowsHeld(session),
        current: owns,
        announce: (text) => showToPerson(host, text),
        debug: (text) => host.ui.log(text, { to: 'debug' }),
        fail: (reason) => settleFailure(host, reason),
      })
    } finally {
      if (settling === task) settling = undefined
    }
    if (owns() && feed.view && !feed.view.settled && !rowsHeld(session)) await settleRemote(host, session)
  })()
  settling = task
  return task
}

function settleFailure(host: Host, reason: string) {
  // Print and SDK sessions keep no conversation a plugin can add rows to; nothing retries that.
  const notice = /keeps no conversation/.test(reason)
    ? `Couldn't add Delta activity to Claude's context: ${reason}. Remote Delta activity isn't available in print or SDK sessions.`
    : `Couldn't add Delta activity to Claude's context: ${reason}. It is offered again when the watcher reconnects.`
  if (settleNotice === notice) return
  settleNotice = notice
  host.ui.log(notice)
}

/**
 * A row of the plugin's own `show` run was stored as `row`: settle the draw of the item its output
 * row shows, and remember what the row is.
 */
export async function storeShownRow(host: Host, row: string, shown: { item?: string; echo?: boolean }) {
  if (shown.item !== undefined) {
    drawQueue.confirm(shown.item)
    await rememberShownRow(host, row, shown.item)
  }
  if (shown.echo) await rememberShownRow(host, row, { echo: true })
}

/**
 * Remember what a stored row of the plugin's own `show` run is, so it draws the same after a restart
 * or resume; one the store refuses is still remembered by this process.
 */
async function rememberShownRow(host: Host, row: string, shown: ShownRow) {
  shownRows.set(row, shown)
  try { await host.store.set(drawnRowKey(await host.session.id(), row), shown) }
  catch (error) { host.ui.log(`Couldn't remember a drawn Delta row (${String(error)}).`, { to: 'debug' }) }
}

/** What a stored row of the plugin's own `show` run is, by the row's message id. */
async function shownRow(host: Host, row: string): Promise<ShownRow | undefined> {
  const known = shownRows.get(row)
  if (known !== undefined) return known
  try {
    // Only this plugin writes these keys, and it writes a ShownRow; the value is checked below.
    const stored = await host.store.get(drawnRowKey(await host.session.id(), row)) as ShownRow | undefined
    if (typeof stored === 'string' || stored?.echo === true) {
      shownRows.set(row, stored)
      return stored
    }
  } catch { /* not known by its id */ }
}

/**
 * The item an output row of the plugin's own `show` run draws: by the row's message id, the one
 * identity the engine documents for a drawn row, else by the run's arguments, which rows stored
 * by earlier versions of the plugin carry.
 */
async function drawnRowItem(host: Host, row: string, args: string): Promise<string | undefined> {
  const shown = await shownRow(host, row)
  return typeof shown === 'string' ? shown : shownItemId(args)
}

/**
 * The plugin's own `show` echo, which Desktop draws as a user row, draws as nothing. It is known by its
 * id: Desktop reports every row's origin as the SDK's. Only empty rows are looked up, as the echo is one.
 */
export async function drawEcho(
  host: Host,
  e: HookEvent<'ui.render', { component: 'UserMessage' }>,
  next: HookNext<'ui.render', { component: 'UserMessage' }>,
) {
  if (e.props.text !== EMPTY_ROW_TEXT || typeof await shownRow(host, e.requestId) !== 'object') return next(e)
  const { Box } = host.ui.resolve(e)
  return <Box />
}

/**
 * The plugin's own command output row: a remote message, event, tool call or comment draws here, from
 * this plugin's own data rather than the row's stored text, which carries none of it.
 */
export async function drawRow(
  host: Host,
  e: HookEvent<'ui.render', { component: 'CommandOutput' }>,
  next: HookNext<'ui.render', { component: 'CommandOutput' }>,
) {
  if (e.props.command !== 'delta') return next(e)
  const id = await drawnRowItem(host, e.requestId, e.props.args)
  if (id === undefined) return next(e)
  const view = feed.view
  const item = view?.items.get(id)
  const { Box, Text, Markdown } = host.ui.resolve(e)
  if (view?.wasRemoved(id)) return <Box />
  const commentId = keyedComment(id)
  if (commentId !== undefined) {
    const comment = view?.comments.get(commentId)
    if (!view || !comment) return <Text dimColor>A Delta comment that is not in this session.</Text>
    // What the comment refers to is earlier material: dim, behind a gutter, elided. The comment
    // itself is new and draws in full, like a message.
    const parent = view.commentParent(comment)
    const target = view.commentTarget(comment)
    const reply = comment.chain !== comment.id
    const quoted = commentQuote(comment, parent, target, view.items, (e.viewport?.columns ?? 80) - 2)
    return <Box flexDirection="column">
      <Text wrap="truncate-end">
        {reply ? <Text dimColor>{'↳ '}</Text> : null}
        <Text bold color={personColor(personKey(comment.author))}>{commentAuthor(comment)}</Text>
        <Text dimColor>{` ${commentAction(comment, parent, target)}${comment.routed_to ? ' · sent to a subthread' : ''}`}</Text>
      </Text>
      {quoted.map((line, index) => <Text key={`quote-${index}`} dimColor wrap="truncate-end">
        {'│ '}{line.before}
        <Text {...line.emphasis && (line.before || line.after) ? { underline: true } : {}}>{line.marked}</Text>
        {line.after}
      </Text>)}
      <Markdown key="delta-comment" text={commentMarkdown(comment, view.thread)} />
    </Box>
  }
  // After a restart, the stored row can draw before the watch supplies its content.
  if (!view || !item) return <Text dimColor>A Delta item that is not in this session.</Text>
  // An item with nothing left to draw, such as an agent message that only held a comment reply.
  if (!isDrawnItem(item)) return <Box />
  if (isEventItem(item)) return <Box flexDirection="column">
    <Text dimColor>Delta activity</Text>
    <Markdown key="delta-event" text={itemMarkdown(item, view.thread)} />
  </Box>
  // An author keeps the color the band gives them; a person's message and their agent's are told apart by label.
  const agent = item.kind !== 'user_message'
  if (item.kind === 'tool_call') {
    // One line, like Claude's own tool rows: the tool in bold, its key input dim, a failure in red.
    // A single Text of spans never wraps a part on its own; the input gives way first, in its
    // middle, so its start and its end (a path's file, a command's last argument) both stay.
    const { name, author, status, statusText, shown } = toolRowParts(item, e.viewport?.columns ?? 80)
    return <Text wrap="truncate-end">
      <Text bold color={authorColor(item)}>{author}</Text>
      <Text dimColor>{' › '}</Text>
      <Text bold>{name}</Text>
      {shown ? <Text dimColor>{` ${shown}`}</Text> : null}
      {statusText ? <Text color={status === 'failed' ? 'red' : 'yellow'}>{statusText}</Text> : null}
    </Text>
  }
  return <Box flexDirection="column">
    <Box flexDirection="row" columnGap={1}>
      <Text bold color={authorColor(item)}>{itemAuthor(item)}</Text>
      <Text dimColor>{agent ? '(agent)' : '(person)'}</Text>
    </Box>
    <Markdown key="delta-message" text={itemMarkdown(item, view.thread)} />
  </Box>
}
