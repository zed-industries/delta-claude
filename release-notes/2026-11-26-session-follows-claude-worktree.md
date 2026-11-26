---
category: Fixed
---

A shared session that moves into a worktree with Claude Code's EnterWorktree tool now keeps sharing its file changes. Delta had kept syncing the checkout the session left, so edits made in the worktree never reached the thread. The thread's worktree now switches to Claude's worktree while the session works there, and switches back to the original checkout when the session leaves it with ExitWorktree. Delta takes in the worktree's last changes before Claude Code removes it.
