/**
 * The pure rules for treating Delta threads as Claude's own subagents: which thread a SendMessage
 * names, what Claude is told of the thread's history when it runs or resumes one, and what the
 * parent hears when Delta's agent ran a turn of one.
 */
import { isMessageItem, itemAuthor, renderItem } from './conversation'
import type { WatchChild, WatchItem } from './thread-commands'

/** How much of a thread's history a subagent is handed when Claude runs it: about 25k tokens. */
export const HISTORY_BUDGET = 100_000
/** How much of a Delta turn the parent is told about. */
export const REPORT_BUDGET = 12_000

/** A thread Claude can message: one in the session's tree, or one a link names. */
export type ThreadTarget = { reference: string; name: string; thread_id?: string }

/**
 * The thread in the session's tree a SendMessage's `to` names: by its name as Delta shows it, its
 * thread id, or its reference.
 */
export function namedThread(to: string, threads: readonly WatchChild[]): WatchChild | undefined {
  const wanted = to.trim()
  const named = threads.filter((thread) => thread.name.trim().toLowerCase() === wanted.toLowerCase())
  if (named.length === 1) return named[0]
  return threads.find((thread) => thread.thread_id === wanted || thread.reference === wanted)
}

/**
 * Whether `to` is a Delta thread link or reference rather than an agent's name: a URL, a share
 * reference, or a thread id, none of which an agent's name can be.
 */
export function looksLikeThreadLink(to: string): boolean {
  const value = to.trim()
  return /^https?:\/\/\S+$/.test(value) || /^thread_[0-9a-z]+(?:#\S*)?$/.test(value) || /^ksQQ[\w-]{20,}$/.test(value)
}

/**
 * Whether `actorId`, the actor Delta records a producer as, wrote an item. Another Claude, another
 * session, or a person is someone else, whatever name Delta shows for them.
 */
export function isOwnItem(item: WatchItem, actorId: string | undefined): boolean {
  return actorId !== undefined && item.author?.actor_id === actorId
}

/** The items after the last one `actorId` wrote: what happened in the thread since it last ran. */
export function itemsSince(items: readonly WatchItem[], actorId: string | undefined): WatchItem[] {
  let last = -1
  items.forEach((item, index) => { if (isOwnItem(item, actorId)) last = index })
  return items.slice(last + 1).filter((item) => !item.open)
}

/** Items as model-visible text, newest kept within `budget`, with how many older ones were left out. */
export function historyText(items: readonly WatchItem[], thread: string, budget: number): string {
  const rows: string[] = []
  let used = 0
  let omitted = 0
  for (const item of [...items].reverse()) {
    const row = renderItem(item, thread)
    if (row === undefined) continue
    if (used + row.length > budget) { omitted++; continue }
    rows.unshift(row)
    used += row.length
  }
  if (omitted) rows.unshift(`[Delta] ${omitted} earlier item${omitted === 1 ? '' : 's'} left out; read them with \`delta thread show ${thread} --format summarize\`.`)
  return rows.join('\n\n')
}

/** The prompt that starts Claude on a thread it never ran: the thread's history, then the message. */
export function adoptionPrompt(name: string, history: string, message: string): string {
  return withHistory(`You are continuing the Delta thread "${name}". Its conversation so far, as Delta recorded it:`, history, message)
}

/** A resumed run's message, after what happened in its thread in Delta since Claude last ran it. */
export function resumePrompt(name: string, history: string, message: string): string {
  return withHistory(`While you were stopped, this happened in your Delta thread "${name}":`, history, message)
}

function withHistory(intro: string, history: string, message: string): string {
  if (!history.trim()) return message
  return [intro, '', history, '', 'The new message for you:', '', message].join('\n')
}

/**
 * What the parent is told of a turn Delta's agent ran in one of its threads: the messages since
 * Claude's last run or the last report, newest kept, and how many tool calls ran meanwhile.
 */
export function deltaTurnReport(name: string, items: readonly WatchItem[], thread: string): string | undefined {
  const messages = items.filter(isMessageItem)
  if (!messages.length) return
  const tools = items.filter((item) => item.kind === 'tool_call').length
  const agent = [...messages].reverse().find((item) => item.kind === 'agent_message')
  const who = agent ? itemAuthor(agent) : 'Delta'
  return [
    `[Delta] ${who} ran a turn in the thread "${name}" in Delta${tools ? `, with ${tools} tool call${tools === 1 ? '' : 's'}` : ''}. Its messages:`,
    '',
    historyText(messages, thread, REPORT_BUDGET),
    '',
    `Send a message to "${name}" with SendMessage to continue it here.`,
  ].join('\n')
}

/** The parent's notice that a thread it ran finished, with the thread's reply. */
export function finishedReport(name: string, reply: string | undefined): string {
  return reply
    ? `The Delta thread "${name}" finished its turn. Its reply:\n\n${reply}`
    : `The Delta thread "${name}" finished its turn without a reply.`
}

/** The parent's note listing the threads it can message, when that list changed. */
export function threadsNote(threads: readonly { name: string; status: string }[]): string | undefined {
  if (!threads.length) return
  return [
    '[Delta] These threads belong to this Delta conversation. Send any of them a message with SendMessage, using its name, to run it here as a subagent:',
    // A thread Delta has not loaded yet reports `unknown`, which says nothing to the model.
    ...threads.map((thread) => `- "${thread.name}"${thread.status === 'unknown' ? '' : ` (${thread.status})`}`),
  ].join('\n')
}
