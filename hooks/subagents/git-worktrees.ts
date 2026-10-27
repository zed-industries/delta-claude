/**
 * What git says of the worktrees Claude makes for isolated subagents, read without the engine.
 */
import { samePath } from '../core/paths'

/** What Delta names the folder Claude's worktree is moved to while a link to a subagent's fork has its place. */
export const KEPT_SUFFIX = '.claude-worktree'

/**
 * The branch `git worktree list --porcelain` says `worktree` has checked out; undefined when the list
 * does not name it or it is detached.
 */
export function listedBranch(porcelain: string, worktree: string): string | undefined {
  for (const entry of porcelain.split(/\n\s*\n/)) {
    const lines = entry.split('\n').map((line) => line.trim())
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    if (path === undefined || !samePath(path, worktree)) continue
    return lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)
  }
}
