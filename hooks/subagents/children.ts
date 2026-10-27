/**
 * What a recorded subagent keeps between hooks and across restarts, and the pure rules for recording
 * it. Each recorded subagent is its own Delta child thread, under the thread of the loop that
 * spawned it, recorded through an outbox of its own exactly as the session's conversation is.
 */
import type { Update } from '../recording/content'
import { isJsonObject } from '../core/json'

/** One staged record: its outbox files, in order, and the digest that guards them. */
export type Entry = { sequence: number; files: string[]; digest: string }

/** A recorded subagent, keyed by its session and agent id. */
export type ChildBinding = {
  session: string
  agentId: string
  /**
   * The producer external ID of the loop that spawned the child: the session's own ID, or a recorded
   * parent subagent's agent ID. Its thread is the child's parent, and its agent sends the prompt.
   */
  parent: string
  /** The child's display name: the spawn's name, or its description of the task. */
  name: string
  thread?: string
  /** Where later commands find the child, from its creation receipt. */
  reference?: string
  /** The actor Delta records the child's output as on this device, which its items name. */
  actorId?: string
  next: number
  pending: Entry[]
  /**
   * The child's running turn: its scoped start's sequence and Claude's turn id, which is absent for a
   * run that was already going when the session started recording.
   */
  execution?: { sequence: number; turnId?: string }
  lastTurnSequence?: number
  /**
   * Whether the child works in its parent's checkout, so its thread shares the parent's worktrees.
   * Decided at its first turn, or from its spawn for a child found already running or finished;
   * its thread is created once this is known.
   */
  sharesParentCheckout?: boolean
  /**
   * Where the child works: the directories of the parent it shares, or its own. Its paths are
   * recorded relative to the first, and a child it spawns shares when it works in any of them.
   */
  directories?: string[]
  /** A checkout of the child's own, such as an isolated worktree, attached while the child runs there. */
  checkout?: string
  checkoutReference?: string
  /**
   * Found running when the session started recording: its transcript is recorded whole when this run
   * finishes, and its live rows until then are left to that read.
   */
  awaitingSnapshot?: true
  /**
   * The thread was Delta's before Claude ran it: Claude runs it where its worktrees already are, so
   * no thread is created and no checkout is attached for it.
   */
  adopted?: true
  /**
   * The owner Delta mounted the child's own worktrees under, an adopted thread's or an isolated child's
   * fork, released when the session ends.
   */
  mountOwner?: string
  /**
   * The git worktree Claude made for an isolated child, which a link to the child's fork stands in for
   * while the session runs, so the child works in the fork under the path Claude gave it. Claude's
   * worktree itself waits beside it, `.claude-worktree` appended, until the session ends.
   */
  claudeWorktree?: string
  /**
   * The parent waits on this thread's turn, so it is told the reply when the turn ends: `claude` for
   * a thread the plugin started Claude on, which Claude itself reports nothing of, and `delta` for a
   * turn Delta took over from Claude.
   */
  awaited?: 'claude' | 'delta'
  /** The last item of the thread the parent was told about. */
  reportedItem?: string
}

/**
 * Whether an agent `$.agent.list()` names is an ordinary subagent. Forks and teammates keep running in
 * Claude without a child thread of their own, as do workflow agents, which the list never names.
 */
export function recordsSubagent(agent: { type: string; teammateId?: string }): boolean {
  return agent.teammateId === undefined && agent.type !== 'fork' && agent.type !== 'teammate'
}

/** Whether `tool` is the one that starts subagents: `Agent`, which a transcript from an older Claude names `Task`. */
export function isAgentTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}

export function childKey(session: string, agentId: string): string {
  return `child:${session}:${agentId}`
}

/** The child's outbox folder, which outbox cleanup accepts only as a plain name. */
export function childOutbox(session: string, agentId: string): string {
  return `${session}-${agentId}`.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function childName(spawn: { name?: string; description: string }): string {
  const name = (spawn.name ?? '').trim() || spawn.description.trim()
  return name || 'Subagent'
}

/**
 * Attribute a recorded prompt to the recorded conversation that sent it, so Delta shows it as that
 * agent's words rather than the person's.
 */
export function sentBy(update: Update, sender: string): Update {
  if (update.sessionUpdate !== 'user_message') return update
  const metadata = isJsonObject(update._meta) ? update._meta : {}
  const delta = isJsonObject(metadata.delta) ? metadata.delta : {}
  return { ...update, _meta: { ...metadata, delta: { ...delta, sender: { external_id: sender } } } }
}

