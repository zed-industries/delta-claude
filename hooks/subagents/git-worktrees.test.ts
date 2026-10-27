import { expect, test } from 'claude-code/testing'
import { listedBranch } from './git-worktrees'

const porcelain = [
  'worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
  'worktree /repo/.claude/worktrees/agent-a1', 'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/claude/agent-a1', '',
  'worktree /repo/.claude/worktrees/agent-b2', 'HEAD 3333333333333333333333333333333333333333', 'detached', '',
].join('\n')

test("a worktree's branch is the one git lists for its path; a detached or unlisted one has none", () => {
  expect(listedBranch(porcelain, '/repo/.claude/worktrees/agent-a1')).toBe('claude/agent-a1')
  expect(listedBranch(porcelain, '/repo')).toBe('main')
  expect(listedBranch(porcelain, '/repo/.claude/worktrees/agent-b2')).toBeUndefined()
  expect(listedBranch(porcelain, '/repo/.claude/worktrees/agent-c3')).toBeUndefined()
})
