/**
 * Hands a join from Claude Code Desktop to a new Desktop session in the thread's code.
 *
 * The tab mounts the thread, records the hand-off in a file every Claude process on the machine can
 * read, and opens Desktop's new-session screen on the thread's first worktree's checkout with an
 * opening line filled in. Sending it starts a session there, which claims the record and joins in
 * place.
 *
 * The person sends the line because Desktop's own session tools refuse a session a plugin starts.
 * It is not `/delta join`, because Desktop breaks a command a link fills in, and it is not dropped,
 * because Desktop shows a dropped message as blocked; it becomes a one-word turn the thread never
 * records instead.
 */

/** A join handed from a Desktop tab to the session Desktop starts in the thread's code. */
export type Handoff = {
  /** The mount owner, which the new session takes over. */
  owner: string
  thread: string
  locator: string
  /**
   * The folder the new session starts in, as `thread mount` reported it: the thread's first
   * worktree's checkout.
   */
  directory: string
  created: number
}

/** The opening line filled in for the new session: sending it starts the session, which joins. */
export const HANDOFF_PROMPT = 'Join this Delta thread.'

/** What the opening line becomes for Claude: a reply short enough to cost next to nothing. */
export const HANDOFF_ACKNOWLEDGEMENT = 'This session just joined a Delta thread. Reply with exactly "Joined." and nothing else.'

/** How long an offered session may wait to be opened before its checkouts are released. */
export const HANDOFF_EXPIRY_MS = 5 * 60_000

/**
 * Desktop's link to its new-session screen on `folder`, with `prompt` filled in: the one Finder's
 * "New Claude Code Session Here" opens. A folder that is not a Git repository starts a plain
 * session, with no worktree of its own.
 */
export function newSessionLink(folder: string, prompt: string): string {
  return `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(prompt)}`
}

/** A hand-off record read back from disk, or undefined when it is not one. */
export function parseHandoff(text: string): Handoff | undefined {
  try {
    const value = JSON.parse(text)
    const strings = ['owner', 'thread', 'locator', 'directory'] as const
    if (!strings.every((name) => typeof value?.[name] === 'string' && value[name]) || typeof value.created !== 'number') return
    return value as Handoff
  } catch { return }
}
