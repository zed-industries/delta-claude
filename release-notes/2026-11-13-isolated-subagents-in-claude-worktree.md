---
category: Fixed
---

Isolated subagents now work in the git worktree Claude Code makes for them, which Delta records as the subagent's own worktree, instead of in a Delta fork linked in its place. Claude Code can resume them after `claude --resume`, keeps and removes their worktrees itself, and their work merges back through git. A resumed subagent waits until Delta has brought in changes made to its worktree elsewhere, such as from Delta, before it starts.
