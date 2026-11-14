import type { MountedThread, ThreadMount, ThreadState } from '../cli/thread-commands'
import { samePath } from '../core/paths'
import type { Host } from '../core/host'

/** Clearing and resuming switch sessions; only exiting releases their mounts. */
export function releasesMounts(reason: string): boolean {
  return ['prompt_input_exit', 'logout', 'other'].includes(reason)
}

/**
 * The surfaces the session draws on. Claude Code Desktop 5.11492 reports none for its Code tabs, as
 * a print-mode run does, so a session Desktop started counts as drawing on `desktop`.
 */
export async function sessionSurfaces(host: Host): Promise<readonly string[]> {
  const surfaces = await host.session.surfaces()
  if (surfaces.length || await host.env.entrypoint() !== 'claude-desktop') return surfaces
  return ['desktop']
}

/** Terminal and Desktop hosts provide interactive controls and the status band. */
export function hasInteractiveSurface(surfaces: readonly string[]): boolean {
  return surfaces.some((surface) => surface === 'terminal' || surface === 'desktop')
}

/** Return missing built-ins, never treating a plugin command as a host capability. */
export function missingJoinCommands(names: readonly string[], commands: readonly { name: string; source: string }[]): string[] {
  return names.filter((name) => !commands.some((entry) => entry.name === name && entry.source === 'builtin'))
}

/** Refuse inaccessible or empty threads before clearing the existing session. */
export function joinPreflight(status: ThreadState): 'access' | 'empty' | undefined {
  if (status.access.state !== 'granted') return 'access'
  if (status.worktrees.status === 'available' && !status.worktrees.items.length) return 'empty'
}

/** The directory a joined session works in, and the other checkouts it adds with `/add-dir`. */
export type SessionDirectories = { workingDirectory: string; additionalDirectories: string[] }

/**
 * Where a joined session works: its thread's first worktree's checkout, with the others added as
 * working directories, as Delta's own Claude sessions do. Claude Code only makes an isolated
 * subagent's worktree, and only loads a project's instructions, inside a checkout. Claude Code
 * Desktop has no `/cd`, so a Desktop session works where Desktop started it, `desktopRoot`: in one
 * of the thread's checkouts, with the others added, or else in the thread folder, which links to
 * every checkout. A session whose thread has no worktree left works in the thread folder.
 */
export function sessionDirectories(mounted: MountedThread, desktopRoot?: string): SessionDirectories {
  const own = desktopRoot === undefined ? mounted.worktrees[0]
    : mounted.worktrees.find((tree) => samePath(tree.directory, desktopRoot))
  if (!own) return { workingDirectory: mounted.directory, additionalDirectories: [] }
  return {
    workingDirectory: own.directory,
    additionalDirectories: mounted.worktrees.filter((tree) => tree !== own).map((tree) => tree.directory),
  }
}


/**
 * The worktrees a mount added and removed since `previous`, and, when the session in `directory`
 * has to change, how: where to be, and which checkouts to add. A move adds every other checkout
 * again; Claude adds one it already has without asking.
 */
export function worktreeChanges(
  previous: readonly ThreadMount[], directory: string | undefined, mounted: MountedThread, desktopRoot?: string,
): { added: ThreadMount[]; removed: ThreadMount[]; update?: SessionDirectories } {
  const added = mounted.worktrees.filter((tree) => !previous.some((mount) => mount.reference === tree.reference))
  const removed = previous.filter((mount) => !mounted.worktrees.some((tree) => tree.reference === mount.reference))
  const target = sessionDirectories(mounted, desktopRoot)
  const moves = directory !== undefined && !samePath(target.workingDirectory, directory)
  const missing = moves ? target.additionalDirectories
    : target.additionalDirectories.filter((path) => added.some((tree) => samePath(tree.directory, path)))
  if (!moves && !missing.length) return { added, removed }
  return { added, removed, update: { workingDirectory: target.workingDirectory, additionalDirectories: missing } }
}

/** A confirmation cannot proceed while any background agent is still active. */
export function activeBackgroundAgents(agents: readonly { status: string }[]): boolean {
  return agents.some((agent) => !['completed', 'failed', 'killed'].includes(agent.status))
}

/** Hold prompts during an incomplete join, restoration, or between-turn directory move. */
export function promptGate(state: {
  joining?: boolean; sharing?: boolean; transition?: boolean; snapshot?: boolean
  restoring?: boolean; movePending?: boolean; steering?: boolean
}): 'joining' | 'sharing' | 'transition' | 'restoring' | 'moving' | undefined {
  if (state.joining) return 'joining'
  if (state.sharing) return 'sharing'
  if (state.transition) return 'transition'
  if (!state.snapshot) return
  if (state.restoring) return 'restoring'
  if (state.movePending && !state.steering) return 'moving'
}

/** Steering belongs only to the exact live local execution. */
export function ownsSteering(
  execution: { turnId?: string; lost?: true; endSequence?: number } | undefined, turnId: string,
): boolean {
  return !!execution && execution.turnId === turnId && !execution.lost && !execution.endSequence
}
