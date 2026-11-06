import { isJsonObject, jsonText } from '../core/json'
import { cutsSurrogatePair, errorText } from '../core/text'
import type { WatchComment, WatchCommentTarget, WatchItem } from '../cli/thread-commands'

/** Kinds shown in the pane and announced as transcript rows. */
const MESSAGE_KINDS = new Set(['user_message', 'agent_message', 'cross_agent_message'])
/** Remote agents' thinking is for the person: shown in the pane and announced, never given to Claude. */
export const THOUGHT_KIND = 'agent_thought'
/** Each large section of a rendered item, such as tool output or one patch, keeps at most this much. */
const SECTION_LIMIT = 8_000
/** A whole rendered item stays well below what Claude moves out of a row into a file. */
const ROW_LIMIT = 24_000
/** One person-visible transcript entry is a `$.ui.log` line, which the terminal draws its first 2,000 characters of. */
export const DISPLAY_LIMIT = 2_000
/** A person-visible tool call is one transcript line of at most this many characters. */
const TOOL_LINE_LIMIT = 200
/** A tool's title keeps at most this much, so its key input always has room beside it. */
const TOOL_NAME_LIMIT = 60
/** One `Markdown` element draws at most this much of an item's own text. */
export const MARKDOWN_LIMIT = 10_000
/** How many of a snapshot's newest first-seen items are drawn for the person. */
export const SNAPSHOT_TAIL = 5
/**
 * How many characters of a snapshot's first-seen rows reach Claude, newest first (about 100k tokens
 * at four characters a token); older items are left out behind one row naming how to read them, so
 * joining a long thread does not fill Claude's context.
 */
const SNAPSHOT_BUDGET = 400_000

/** Claude's text nodes allow tabs and newlines, but reject other control characters. */
export function conversationText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** Keep an invalid destination from making Claude reject the entire pane. */
export function conversationWebLink(value?: string): string | undefined {
  if (!value) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) return
    if (url.username || url.password || url.href.length > 2048 || /[^\x21-\x7e]|@/.test(url.href)) return
    return url.href
  } catch { return }
}

/** The item's text, for kinds that carry `{ text }`. */
function itemText(item: WatchItem): string | undefined {
  return typeof item.content.text === 'string' ? item.content.text : undefined
}

/** Who an item is from, as a person reads it. */
export function itemAuthor(item: WatchItem): string {
  const name = conversationText(item.author?.name ?? '').trim()
  if (name) return name
  return item.kind === 'user_message' ? 'Someone in Delta' : 'Delta agent'
}

/** Whether the pane shows this item and its completion is announced in the transcript. */
export function isMessageItem(item: WatchItem): boolean {
  return MESSAGE_KINDS.has(item.kind) && !!itemText(item)?.trim()
}

/** Structured thread activity is shown as an event, not attributed to the surrounding agent turn. */
export function isEventItem(item: WatchItem): boolean {
  return (item.kind === 'subthread_event' || item.kind === 'land_result') && !!itemText(item)?.trim()
}

/** Whether an item is drawn for the person as the plugin's own command output row. */
export function isDrawnItem(item: WatchItem): boolean {
  return isMessageItem(item) || isEventItem(item) || item.kind === 'tool_call'
}

export function isThoughtItem(item: WatchItem): boolean {
  return item.kind === THOUGHT_KIND && !!itemText(item)?.trim()
}

/**
 * A completed remote item as the person reads it in a `$.ui.log` line, or undefined for kinds the
 * transcript does not show. A message or thought is one entry per paragraph under its author, with
 * markdown markers stripped and no empty entries, because each entry is a single drawn line; a tool
 * call is one line naming what ran; a thought is labelled and stays out of Claude's context. Text
 * past what one line can carry ends at a marker naming the command that reads the item back.
 */
export function itemDisplay(item: WatchItem, thread: string): string | undefined {
  if (item.kind === 'tool_call') return toolCallDisplay(item)
  if (isEventItem(item)) return personLines('Delta activity:', personParagraphs(eventText(item)), thread)
  const paragraphs = personParagraphs(itemText(item) ?? '')
  if (!paragraphs.length) return
  if (isThoughtItem(item)) return personLines(`${itemAuthor(item)} (thinking)`, paragraphs, thread)
  if (isMessageItem(item)) return personLines(`${itemAuthor(item)}:`, paragraphs, thread)
}

/**
 * An item's text as the person-visible entries it makes: a blank line separates entries, markdown
 * markers are stripped because a notice draws them literally, and each entry is folded onto the one
 * line a `$.ui.log` call draws. Nothing empty becomes an entry.
 */
export function personParagraphs(text: string): string[] {
  return conversationText(text).split(/\n\s*\n+/)
    .map((part) => withoutMarkdown(part).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** The item's own text for a `Markdown` element: markdown intact, cut at the read-more marker. */
export function itemMarkdown(item: WatchItem, thread: string): string {
  return clipWithNote(conversationText(isEventItem(item) ? eventText(item) : itemText(item) ?? '').trim(), MARKDOWN_LIMIT, thread)
}

/** Event storage can include model-only instructions after its human-readable headline. */
function eventText(item: WatchItem): string {
  const text = itemText(item) ?? ''
  return (text.split(/\n<(?:subthread-event|review-thread-event)\b/, 1)[0] ?? '').trim().replace(/:$/, '')
}

/** Emphasis, code and heading markers removed, since a `$.ui.log` line draws them literally. */
function withoutMarkdown(text: string): string {
  return text
    .replace(/^(\s*)#{1,6}\s+/gm, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[\s(])[*_](?=\S)/g, '$1')
    .replace(/(\S)[*_](?=$|[\s.,;:!?)])/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
}

/** A label and its paragraphs as the person-visible entries, each within what one line can draw. */
function personLines(label: string, paragraphs: string[], thread: string): string {
  return [label, ...paragraphs.map((paragraph) => clipWithNote(paragraph, DISPLAY_LIMIT, thread))].join('\n')
}

/** The marker naming how much a person-visible entry leaves out, and the command that reads it back. */
function readMoreNote(omitted: number, thread: string): string {
  return ` [… ${omitted} more characters; read with ` +
    `\`delta thread show ${thread} --format messages --messages 1-20\`]`
}

/** Cut `text` to `limit` characters, naming the omitted count so a person is never silently truncated. */
function clipWithNote(text: string, limit: number, thread: string): string {
  if (text.length <= limit) return text
  // Reserve the note's own length so the whole row stays within the limit.
  let end = Math.max(0, limit - readMoreNote(text.length, thread).length)
  if (end < 1) return readMoreNote(text.length, thread).trim()
  if (cutsSurrogatePair(text, end)) end--
  return text.slice(0, end) + readMoreNote(text.length - end, thread)
}

/**
 * A completed tool call as one person-visible line: who ran what, the key input when the title does
 * not already name it, and the status only when it did not complete. The full call stays in Claude's
 * context row and in Delta.
 */
function toolCallDisplay(item: WatchItem): string {
  const { name, detail, status } = toolCallParts(item)
  const fixed = `${itemAuthor(item)}: ${name}${status ? ` (${status})` : ''}`
  const shown = detail ? middleTruncate(detail, TOOL_LINE_LIMIT - fixed.length - 3) : ''
  return `${itemAuthor(item)}: ${name}${shown ? ` · ${shown}` : ''}${status ? ` (${status})` : ''}`
}

/**
 * A tool call's parts for its one-line row: the tool's title, its key input when the title does not
 * already name it, and its status unless it completed. Each is one line; the caller fits the detail
 * to the room it has, with `middleTruncate`.
 */
export function toolCallParts(item: WatchItem): { name: string; detail?: string; status?: string } {
  const tool = item.content
  const status = typeof tool.status === 'string' && tool.status !== 'completed' ? singleLine(tool.status) : undefined
  const title = singleLine(String([tool.title, tool.name].find((value) => typeof value === 'string' && value.trim()) ?? 'tool'))
  const input = toolInput(tool.rawInput)
  const detail = input && !describesInput(title, input) ? input : undefined
  return { name: middleTruncate(title, TOOL_NAME_LIMIT), detail, status }
}

/**
 * Whether a tool's title already names its key input: contains it, or names a path the input ends
 * with, since a producer may show a path relative to its own checkout.
 */
function describesInput(title: string, input: string): boolean {
  return title.includes(input) || title.split(' ').some((word) => word.includes('/') && input.endsWith(`/${word}`))
}

/**
 * `text` within `width` characters, its middle replaced by an ellipsis: the start says what kind of
 * thing it is, and the end names what it acts on (a path's file, a command's last argument), so the
 * end keeps the larger share. Empty when not even the ellipsis and a character of each side fit.
 */
export function middleTruncate(text: string, width: number): string {
  if (text.length <= width) return text
  if (width < 3) return ''
  let head = Math.floor((width - 1) * 0.4)
  let tail = width - 1 - head
  // Never split a surrogate pair at either cut.
  if (cutsSurrogatePair(text, head)) head--
  if (/[\uDC00-\uDFFF]/.test(text.charAt(text.length - tail))) tail--
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** The one part of a tool call's input a collaborator needs: a command, path or other key field, else its JSON. */
function toolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return
  if (typeof input === 'string') return singleLine(input) || undefined
  if (isJsonObject(input))
    for (const field of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
      const value = input[field]
      if (typeof value === 'string' && value.trim()) return singleLine(value)
    }
  return singleLine(jsonText(input))
}

/** Text flattened onto one line, since each `$.ui.log` call draws a single transcript line. */
function singleLine(text: string): string {
  return conversationText(text).replace(/\s+/g, ' ').trim()
}

/** The first eight bytes of the SHA-256 of `value`'s JSON, in hex: short, and stable across processes. */
async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(bytes).subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Identifies what Claude was shown for an item; attribution lookups and moves do not change it. */
export async function itemFingerprint(item: WatchItem): Promise<string> {
  return fingerprint({ kind: item.kind, content: item.content })
}

/**
 * Render a completed item as the text of a model-visible transcript row, or undefined for kinds
 * with nothing to say. The header names the author and kind alone: an item's id is the plugin's own
 * handle, so the model never reads one. Large sections and the row as a whole are truncated at a
 * marker that names the command for reading the full item.
 */
export function renderItem(item: WatchItem, thread: string, edited = false): string | undefined {
  if (item.kind === 'unknown' || item.kind === THOUGHT_KIND) return
  const clip = (text: string, limit: number) => clipForModel(text, limit, thread)
  let label: string
  let body: string
  if (item.kind === 'tool_call') {
    const tool = item.content
    const name = [tool.title, tool.name].find((value) => typeof value === 'string' && value.trim()) ?? 'tool'
    // The input section below carries the call's full arguments, so the label stays one bounded line.
    label = `tool call ${middleTruncate(singleLine(String(name)), TOOL_LINE_LIMIT)}${typeof tool.status === 'string' ? ` (${tool.status})` : ''}`
    const sections: string[] = []
    if (tool.rawInput !== undefined) sections.push(`Input: ${clip(jsonText(tool.rawInput), 2_000)}`)
    for (const entry of Array.isArray(tool.content) ? tool.content.filter(isJsonObject) : []) {
      if (entry.type === 'diff') {
        // An ACP v2 diff: `changes` names each file and `patch` optionally carries its git patch text.
        const paths = (Array.isArray(entry.changes) ? entry.changes : []).flatMap((change) =>
          isJsonObject(change) && typeof change.path === 'string' ? [change.path] : [])
        const patch = isJsonObject(entry.patch) && typeof entry.patch.text === 'string' ? entry.patch.text : ''
        sections.push(`Changed ${paths.join(', ') || 'a file'}:\n${clip(patch, SECTION_LIMIT)}`)
      } else if (entry.type === 'terminal') sections.push(`Terminal ${entry.terminalId ?? ''}`.trim())
      else if (entry.type === 'content') {
        const block = entry.content
        sections.push(clip(isJsonObject(block) && block.type === 'text' && typeof block.text === 'string'
          ? block.text : jsonText(block), SECTION_LIMIT))
      }
    }
    if (tool.rawOutput !== undefined && tool.rawOutput !== null) sections.push(`Output:\n${clip(jsonText(tool.rawOutput), SECTION_LIMIT)}`)
    body = sections.join('\n')
  } else {
    label = item.kind.replace(/_/g, ' ')
    const text = itemText(item)
    const details = Object.fromEntries(Object.entries(item.content).filter(([key]) => text === undefined || key !== 'text'))
    body = [text, Object.keys(details).length ? clip(jsonText(details), SECTION_LIMIT) : undefined]
      .filter((part) => part !== undefined).join('\n')
  }
  body = conversationText(body).trim()
  if (!body) return
  // The id is how a later correction or removal row names which earlier row it changes.
  const header = edited
    ? `[Delta] ${itemAuthor(item)} changed an earlier ${label} (item ${item.id}); it now reads:`
    : `[Delta] ${itemAuthor(item)}, ${label} (item ${item.id}):`
  return clip(`${header}\n${body}`, ROW_LIMIT)
}

/**
 * The person's notice that a snapshot's earlier items were not drawn; the oldest `omitted` of them
 * did not reach Claude's context either.
 */
export function earlierItemsNotice(count: number, thread: string, omitted = 0): string {
  const items = `${count} earlier item${count === 1 ? '' : 's'}`
  const where = omitted >= count ? `${count === 1 ? 'is' : 'are'} not shown here or in Claude's context`
    : omitted ? `${count === 1 ? 'is' : 'are'} not shown here, and the oldest ${omitted} ` +
      `${omitted === 1 ? 'is' : 'are'} not in Claude's context either`
    : `${count === 1 ? 'is' : 'are'} in Claude's context but not shown here`
  return `Continuing a Delta thread: ${items} ${where}. ` +
    `Read them with \`delta thread show ${thread} --format messages --messages 1-20\`.`
}

/** The model-visible row standing in for a snapshot's earlier items that were left out of Claude's context. */
export function omittedItemsRow(count: number, thread: string): string {
  return `[Delta] ${count} earlier item${count === 1 ? '' : 's'} of this shared thread (messages, tool calls ` +
    `and comments) ${count === 1 ? 'was' : 'were'} left out of your context to save room; the newest ones ` +
    'follow. If you need them, read ' +
    `them with \`delta thread show ${thread} --format messages --messages 1-20\`; messages are numbered from 1 ` +
    'across the whole thread, at most 20 per call; page forward (21-40, …).'
}

/** The model-visible row saying that an item Claude was shown no longer exists. */
export function removedItemRow(id: string, item?: WatchItem): string {
  return `[Delta] An earlier item (item ${id})${item ? ` from ${itemAuthor(item)}` : ''} was removed from the shared thread; disregard it.`
}

/** `text` cut at `limit` for a model-visible row, at a marker naming how to read the rest. */
function clipForModel(text: string, limit: number, thread: string): string {
  if (text.length <= limit) return text
  const end = cutsSurrogatePair(text, limit) ? limit - 1 : limit
  return text.slice(0, end) + `\n[… ${text.length - end} more characters not shown. Read the full text with ` +
    `\`delta thread show ${thread} --format messages --messages 1-20\`; messages are numbered from 1 across the ` +
    'whole thread, at most 20 per call; page forward (21-40, …).]'
}

/** Comments share the row queue, the ledger and the drawn rows with items, under their own keys. */
export function commentKey(id: string): string {
  return `comment:${id}`
}

export function keyedComment(key: string): string | undefined {
  return key.startsWith('comment:') ? key.slice('comment:'.length) : undefined
}

/** The creator, then anyone whose edits the comment kept. */
export function commentAuthor(comment: WatchComment): string {
  const creator = commentCreator(comment)
  const others = comment.co_authors.map((person) => conversationText(person.name ?? '').trim()).filter(Boolean)
  return [creator, ...others.filter((name) => name !== creator)].join(', ')
}

function filePlace(target: Extract<WatchCommentTarget, { kind: 'file' }>): string {
  const [first] = target.regions
  if (!first) return target.path
  const last = target.regions.at(-1)!
  const lines = first.first_line === last.last_line ? `${first.first_line}` : `${first.first_line}–${last.last_line}`
  return `${target.path}:${lines}`
}

/** A reply names whom it answers, not where its chain began, so one that lands turns later still makes sense. */
export function commentAction(comment: WatchComment, parent: WatchComment | undefined,
  target: WatchCommentTarget | null | undefined): string {
  if (comment.chain !== comment.id) return parent ? `replied to ${commentCreator(parent)}` : 'replied'
  if (target?.kind === 'file') return `commented on ${filePlace(target)}`
  return target?.kind === 'transcript' && target.quote.trim() ? 'commented on' : 'commented'
}

function commentCreator(comment: WatchComment): string {
  return conversationText(comment.author.name ?? '').trim() || (comment.agent ? 'Delta agent' : 'Someone in Delta')
}

/** Numbered, `+` when added and `-` when deleted, as the lines read when the comment was made. */
function commentContextLines(target: WatchCommentTarget | null | undefined): string[] {
  if (target?.kind !== 'file') return []
  return target.regions.flatMap((region) => {
    const mark = region.status === 'added' ? '+' : region.status === 'deleted' ? '-' : ' '
    return conversationText(region.text).split('\n').map((line, index) => `${region.first_line + index} ${mark} ${line}`)
  })
}

/** One line of quoted context; `marked` is the part a comment is about, when the line shows more. */
export type QuotedLine = { before: string; marked: string; after: string; emphasis: boolean }

const QUOTED_FILE_LINES = 2

/**
 * Quoted context is earlier material, so it is elided rather than wrapped. A short passage is shown in
 * the line it sits in, since a quote like `you` means nothing alone.
 */
export function commentQuote(comment: WatchComment, parent: WatchComment | undefined,
  target: WatchCommentTarget | null | undefined, items: ReadonlyMap<string, WatchItem>, width: number): QuotedLine[] {
  if (comment.chain !== comment.id && parent) return [plainLine(firstLine(parent.text))]
  if (target?.kind === 'file') {
    const lines = commentContextLines(target)
    return [...lines.slice(0, QUOTED_FILE_LINES), ...lines.length > QUOTED_FILE_LINES ? ['…'] : []]
      .map(plainLine)
  }
  if (target?.kind !== 'transcript' || !target.quote.trim()) return []
  const quote = conversationText(target.quote).trim()
  const item = target.item_id === null ? undefined : items.get(target.item_id)
  const source = item && itemText(item)
  const at = !quote.includes('\n') && source ? source.indexOf(quote) : -1
  if (!source || at < 0) return [{ ...plainLine(firstLine(quote)), emphasis: true }]
  const lineStart = source.lastIndexOf('\n', at - 1) + 1
  const lineEnd = source.indexOf('\n', at + quote.length)
  return [around(source.slice(lineStart, at).trimStart(), quote,
    source.slice(at + quote.length, lineEnd < 0 ? undefined : lineEnd).trimEnd(), width)]
}

function firstLine(text: string): string {
  const lines = conversationText(text).split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.length > 1 ? `${lines[0]} …` : lines[0] ?? ''
}

/** The terminal cuts what does not fit. */
function plainLine(text: string): QuotedLine {
  return { before: '', marked: text, after: '', emphasis: false }
}

/** The side after the passage gets the first half of the room, since a sentence reads forward. */
function around(before: string, marked: string, after: string, width: number): QuotedLine {
  if (marked.length >= width) return { before: '', marked, after: '', emphasis: true }
  const room = width - marked.length
  let afterRoom = Math.min(after.length, Math.ceil(room / 2))
  const beforeRoom = Math.min(before.length, room - afterRoom)
  afterRoom = Math.min(after.length, room - beforeRoom)
  return {
    before: before.length > beforeRoom ? (beforeRoom ? `…${before.slice(before.length - beforeRoom + 1)}` : '') : before,
    marked,
    after: after.length > afterRoom ? (afterRoom ? `${after.slice(0, afterRoom - 1)}…` : '') : after,
    emphasis: true,
  }
}

export function commentMarkdown(comment: WatchComment, thread: string): string {
  return clipWithNote(conversationText(comment.text).trim(), MARKDOWN_LIMIT, thread)
}

/** For a host that refuses the drawn row. */
export function commentDisplay(comment: WatchComment, parent: WatchComment | undefined,
  target: WatchCommentTarget | null | undefined, thread: string): string | undefined {
  const paragraphs = personParagraphs(comment.text)
  if (!paragraphs.length) return
  return personLines(`${commentAuthor(comment)} ${commentAction(comment, parent, target)}:`, paragraphs, thread)
}

/** What Claude was shown; who wrote it resolving later changes nothing. */
export async function commentFingerprint(comment: WatchComment, target: WatchCommentTarget | null | undefined): Promise<string> {
  // Which item a passage is in is the person's context; Claude's row never names it.
  const shown = target?.kind === 'transcript' ? { ...target, item_id: null } : target ?? null
  return fingerprint({ text: comment.text, target: shown, chain: comment.chain, routed_to: comment.routed_to })
}

/**
 * A comment in the `<comments>` shape Delta's own agents read. A reply carries its chain's target and
 * the comment it answers, so Claude follows the chain without finding earlier rows.
 */
export function renderComment(comment: WatchComment, target: WatchCommentTarget | null | undefined,
  thread: string, edited = false, parent?: WatchComment): string | undefined {
  const text = conversationText(comment.text).trim()
  if (!text) return
  const author = commentAuthor(comment)
  const reply = comment.chain !== comment.id
  const label = reply ? 'reply to a comment' : 'comment'
  const header = edited
    ? `[Delta] ${author} changed an earlier ${label} (comment ${comment.id}); it now reads:`
    : `[Delta] ${author}, ${label} (comment ${comment.id}):`
  const lines = [header]
  // A routed comment went to a subthread's agent; Claude reads it as context, not as a request.
  if (comment.routed_to) lines.push(`It was sent to the Delta subthread ${comment.routed_to}, not to you.`)
  lines.push('<comments>')
  if (target?.kind === 'file') {
    lines.push(`  <file>${escapeMarkup(target.path)}</file>`)
    const context = commentContextLines(target).join('\n')
    if (context) lines.push('  <context>', clipForModel(escapeMarkup(context), SECTION_LIMIT, thread), '  </context>')
    if (target.selected) lines.push(`  <selected>${escapeMarkup(clipForModel(target.selected, SECTION_LIMIT, thread))}</selected>`)
  } else if (target?.kind === 'transcript' && target.quote.trim()) {
    lines.push(`  <context><quote>${escapeMarkup(clipForModel(conversationText(target.quote).trim(), SECTION_LIMIT, thread))}</quote></context>`)
  }
  // The comment answered comes first, as in Delta's own groups; the last comment is the new one.
  const answered = reply && parent ? conversationText(parent.text).trim() : ''
  if (answered)
    lines.push(`  <comment from="${escapeMarkup(commentAuthor(parent!))}">${escapeMarkup(clipForModel(answered, SECTION_LIMIT, thread))}</comment>`)
  lines.push(`  <comment from="${escapeMarkup(author)}">${escapeMarkup(text)}</comment>`, '</comments>')
  return clipForModel(lines.join('\n'), ROW_LIMIT, thread)
}

function removedCommentRow(id: string, comment?: WatchComment): string {
  return `[Delta] An earlier comment (comment ${id})${comment ? ` from ${commentAuthor(comment)}` : ''} ` +
    'was withdrawn from the shared thread; disregard it.'
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Remote items already added to Claude's transcript, each with the fingerprint of what was added, or
 * `OMITTED` for a snapshot item left out of Claude's context, which is never added or corrected.
 */
export type Ledger = { thread: string; items: Record<string, string> }

export const OMITTED = 'omitted'

/** The id of the row standing in for a snapshot's omitted items; no item or comment has it. */
const OMITTED_ROW = 'delta:omitted'

/** A transcript row to add; `fingerprint` is recorded once it is added, or the item forgotten when absent. */
export type PendingRow = {
  id: string
  text: string
  fingerprint?: string
  /**
   * A completed message whose first appearance the host draws for the person as the output row of
   * the plugin's own `show <id>` command, so the person sees markdown. The id is the item's; the
   * host looks its content up when the command answers. The model's own copy is `text`, as ever.
   */
  commandItem?: string
  /**
   * A notice the person reads before this row: a newly completed item that is not drawn, or, before
   * a snapshot's first drawn item, how many earlier items reached Claude without being drawn.
   */
  announcement?: string
  /** A first row for an item that arrived in a snapshot; such rows are announced together. */
  quiet: boolean
  /** The snapshot items this row stands in for, recorded as omitted once it is added. */
  omits?: string[]
}

/** A change to reconcile with the ledger. A removed item or comment keeps its last known state. */
type Unsettled = { removed: boolean; last?: WatchItem | WatchComment; quiet: boolean }

/**
 * The watched thread's items, and the rows that bring Claude's transcript up to date with them.
 *
 * Each connection replaces the items with a fresh snapshot; the ledger remembers what Claude was
 * shown across connections and restarts, so a snapshot repeats nothing and corrects what changed.
 */
export class RemoteView {
  /** The thread's current items, in the order they first arrived. */
  items = new Map<string, WatchItem>()
  comments = new Map<string, WatchComment>()
  /** Whether the current connection's snapshot is complete. */
  snapshotDone = false
  /** Snapshot items added since they were last announced together. */
  quietlyAdded = 0
  private unsettled = new Map<string, Unsettled>()
  /** Recent explicit removals survive reconnects, but not a session restart. Older IDs use the placeholder. */
  private removed = new Set<string>()
  /** The snapshot's newest first-seen items, which alone are drawn for the person. */
  private tail = new Set<string>()
  /** First-seen snapshot items not drawn, until the notice naming them is offered. */
  private hidden = 0
  /** How many of the hidden items are not in Claude's context either. */
  private hiddenOmitted = 0
  /** First-seen snapshot items past the budget, which reach Claude only as one row. */
  private omitted = new Set<string>()
  /** The omitted items whose stand-in row has not been offered yet. */
  private omitting: string[] = []

  constructor(readonly thread: string, readonly ledger: Ledger, private readonly budget = SNAPSHOT_BUDGET) {}

  /** Start a connection's snapshot. */
  reset() {
    this.items = new Map()
    this.comments = new Map()
    this.unsettled.clear()
    this.snapshotDone = false
    this.tail.clear()
    this.hidden = 0
    this.hiddenOmitted = 0
    this.omitted.clear()
    this.omitting = []
  }

  upsert(item: WatchItem) {
    this.removed.delete(item.id)
    this.items.set(item.id, item)
    this.mark(item.id, { removed: false, quiet: !this.snapshotDone })
  }

  /** Apply `item.append`, returning the updated item. */
  appendText(id: string, text: string): WatchItem {
    const item = this.items.get(id)
    if (!item) throw new Error('Delta appended text to an unknown item')
    const updated = { ...item, content: { ...item.content, text: (itemText(item) ?? '') + text } }
    this.upsert(updated)
    return updated
  }

  remove(id: string) {
    const last = this.items.get(id)
    this.items.delete(id)
    this.forget(id, last)
  }

  upsertComment(comment: WatchComment) {
    const key = commentKey(comment.id)
    this.removed.delete(key)
    this.comments.set(comment.id, comment)
    this.mark(key, { removed: false, quiet: !this.snapshotDone })
  }

  removeComment(id: string) {
    const last = this.comments.get(id)
    this.comments.delete(id)
    this.forget(commentKey(id), last)
  }

  /** Also queues the correction Claude needs if it was shown the item or comment. */
  private forget(key: string, last: WatchItem | WatchComment | undefined) {
    this.removed.delete(key)
    this.removed.add(key)
    if (this.removed.size > 4096) this.removed.delete(this.removed.values().next().value!)
    this.mark(key, { removed: true, last, quiet: false })
  }

  /** The comment a reply answers, while this view holds it. */
  commentParent(comment: WatchComment): WatchComment | undefined {
    return comment.after_id === null ? undefined : this.comments.get(comment.after_id)
  }

  /** Only a chain's first comment carries the target. */
  commentTarget(comment: WatchComment): WatchCommentTarget | null | undefined {
    return comment.chain === comment.id ? comment.target : this.comments.get(comment.chain)?.target
  }

  /** Whether an item, or a comment by its key, was removed during this session. */
  wasRemoved(id: string): boolean { return this.removed.has(id) }

  /**
   * End the snapshot; items Claude was shown that it no longer has were removed meanwhile. Of the
   * items Claude has not seen, only the newest within the budget reach its context, and only the
   * newest few of those are drawn for the person, so joining a long thread does not replay it.
   */
  endSnapshot() {
    this.snapshotDone = true
    const unseen = [...this.unsettled].flatMap(([id, change]) => {
      if (!change.quiet || this.ledger.items[id] !== undefined) return []
      const commentId = keyedComment(id)
      if (commentId !== undefined) {
        const comment = this.comments.get(commentId)
        const text = comment && renderComment(comment, this.commentTarget(comment), this.thread)
        return text === undefined ? [] : [{ id, text, drawn: true }]
      }
      const item = this.items.get(id)
      const text = item && !item.open ? renderItem(item, this.thread) : undefined
      return text === undefined ? [] : [{ id, text, drawn: isDrawnItem(item!) }]
    })
    // The newest row always fits; everything older than the first row past the budget is left out.
    let used = 0
    let kept = unseen.length
    while (kept > 0 && (kept === unseen.length || used + unseen[kept - 1]!.text.length <= this.budget))
      used += unseen[--kept]!.text.length
    this.omitting = unseen.slice(0, kept).map(({ id }) => id)
    this.omitted = new Set(this.omitting)
    const drawn = unseen.filter((entry) => entry.drawn).map(({ id }) => id)
    this.tail = new Set(drawn.filter((id) => !this.omitted.has(id)).slice(-SNAPSHOT_TAIL))
    this.hidden = drawn.length - this.tail.size
    this.hiddenOmitted = drawn.filter((id) => this.omitted.has(id)).length
    for (const id of Object.keys(this.ledger.items)) {
      const commentId = keyedComment(id)
      if (commentId === undefined ? !this.items.has(id) : !this.comments.has(commentId))
        this.mark(id, { removed: true, quiet: false })
    }
  }

  /**
   * Whether no row is needed now. A snapshot adds nothing until it is complete, since which of its
   * items are drawn depends on which are the newest.
   */
  get settled(): boolean { return !this.snapshotDone || this.unsettled.size === 0 }

  /**
   * The next row Claude's transcript needs, oldest change first, or undefined when none is
   * needed yet. Open items wait for completion; a changed or removed item Claude was shown gets a
   * correction row.
   */
  async nextRow(): Promise<PendingRow | undefined> {
    if (this.snapshotDone && this.omitting.length) {
      const omits = this.omitting
      this.omitting = []
      return { id: OMITTED_ROW, text: omittedItemsRow(omits.length, this.thread), quiet: false, omits }
    }
    while (!this.settled) {
      const [id, change] = this.unsettled.entries().next().value!
      this.unsettled.delete(id)
      const known = this.ledger.items[id]
      // Claude never read an omitted item, so it gets no row and no correction; a removal forgets it.
      if (known === OMITTED || this.omitted.has(id)) {
        if (known === OMITTED && change.removed) delete this.ledger.items[id]
        continue
      }
      const commentId = keyedComment(id)
      if (commentId !== undefined) {
        const row = await this.commentRow(id, commentId, change, known)
        if (row) return row
        continue
      }
      const item = change.removed ? undefined : this.items.get(id)
      if (!item) {
        if (change.removed && known !== undefined)
          return { id, text: removedItemRow(id, change.last as WatchItem | undefined), quiet: false }
        continue
      }
      if (item.open) continue
      const fingerprint = await itemFingerprint(item)
      if (fingerprint === known) continue
      // Kinds Claude is never shown, such as thinking, get no row and no correction.
      const text = renderItem(item, this.thread, known !== undefined)
      if (text === undefined) continue
      const first = known === undefined
      // A message's first appearance is drawn for the person as the plugin's own command output,
      // beside the row every kind gets, so nothing about it is announced separately. Of a
      // snapshot, only the newest items are drawn, after a notice counting the ones that are not.
      const quiet = first && change.quiet
      const commandItem = first && isDrawnItem(item) && (!quiet || this.tail.has(id)) ? id : undefined
      let announcement = first && !change.quiet && !commandItem ? itemDisplay(item, this.thread) : undefined
      if (quiet && commandItem && this.hidden) {
        announcement = earlierItemsNotice(this.hidden, this.thread, this.hiddenOmitted)
        this.hidden = 0
      }
      return { id, text, fingerprint, commandItem, quiet, announcement }
    }
  }

  private async commentRow(key: string, id: string, change: Unsettled, known: string | undefined): Promise<PendingRow | undefined> {
    const comment = change.removed ? undefined : this.comments.get(id)
    if (!comment) {
      return change.removed && known !== undefined
        ? { id: key, text: removedCommentRow(id, change.last as WatchComment | undefined), quiet: false }
        : undefined
    }
    const target = this.commentTarget(comment)
    const fingerprint = await commentFingerprint(comment, target)
    if (fingerprint === known) return
    const text = renderComment(comment, target, this.thread, known !== undefined, this.commentParent(comment))
    if (text === undefined) return
    const first = known === undefined
    const quiet = first && change.quiet
    const commandItem = first && (!quiet || this.tail.has(key)) ? key : undefined
    let announcement: string | undefined
    if (quiet && commandItem && this.hidden) {
      announcement = earlierItemsNotice(this.hidden, this.thread, this.hiddenOmitted)
      this.hidden = 0
    }
    return { id: key, text, fingerprint, commandItem, quiet, announcement }
  }

  /** Record that a row was added to Claude's transcript. */
  commit(row: PendingRow) {
    for (const id of row.omits ?? []) this.ledger.items[id] = OMITTED
    if (row.fingerprint) this.ledger.items[row.id] = row.fingerprint
    else delete this.ledger.items[row.id]
  }

  private mark(id: string, change: Unsettled) {
    // Re-inserting keeps the queue in order of each item's latest change.
    this.unsettled.delete(id)
    this.unsettled.set(id, change)
  }
}

/** Where `addRows` adds rows, and how it reports; the plugin supplies Claude's host. */
export type RowSink = {
  /** Add one model-visible row to Claude's transcript; throws, or resolves with `deny`, when it is not added. */
  append(row: PendingRow): Promise<{ deny?: string }>
  /** Persist the ledger. */
  save(ledger: Ledger): Promise<void>
  /** Whether rows must wait, as while Claude's own turn runs or a prompt is entering. */
  held(): boolean
  /** Whether the watch that owns this view is still current; a stopped one adds no more rows. */
  current(): boolean
  /** Show a completed item to the person in the transcript. */
  announce(text: string): void
  debug(text: string): void
  /** Report a row that could not be added or a ledger that could not be saved. */
  fail(reason: string): void
}

/** A large snapshot batch saves its ledger this often, so stopping midway repeats few rows. */
export const LEDGER_SAVE_INTERVAL = 20

/**
 * Add the rows `view` needs to Claude's transcript until it is settled, rows are held, or the
 * watch stops. Every row actually added is committed and saved, even when the watch stopped
 * while it was being added, so a later watch never repeats it.
 */
export async function addRows(view: RemoteView, sink: RowSink): Promise<void> {
  let unsaved = 0
  const save = async () => {
    if (!unsaved) return
    unsaved = 0
    try { await sink.save(view.ledger) }
    catch (error) { if (sink.current()) sink.fail(`its record could not be saved (${errorText(error)})`) }
  }
  try {
    while (sink.current() && !view.settled && !sink.held()) {
      const row = await view.nextRow()
      if (!row || !sink.current()) continue
      if (row.announcement) sink.announce(row.announcement)
      sink.debug(`Adding a row to Claude's context: ${row.text.split('\n', 1)[0]}`)
      let result: { deny?: string }
      try { result = await sink.append(row) }
      catch (error) {
        if (sink.current()) sink.fail(errorText(error))
        continue
      }
      if (result.deny !== undefined) {
        if (sink.current()) sink.fail(`another plugin refused it (${result.deny})`)
        continue
      }
      view.commit(row)
      if (row.quiet) view.quietlyAdded++
      if (++unsaved >= LEDGER_SAVE_INTERVAL) await save()
    }
  } finally {
    await save()
    if (sink.current() && view.snapshotDone && view.quietlyAdded) {
      const count = view.quietlyAdded
      view.quietlyAdded = 0
      // Status, not content: the person's transcript gets nothing for it.
      sink.debug(`Added ${count} earlier Delta thread item${count === 1 ? '' : 's'} to Claude's context.`)
    }
  }
}
