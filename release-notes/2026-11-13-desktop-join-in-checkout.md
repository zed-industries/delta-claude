---
category: Fixed
---

`/delta-join` in Claude Code Desktop now starts the new session in the thread's first worktree, instead of a folder of links, so the project's `CLAUDE.md` loads and isolated subagents work. Desktop doesn't let the plugin add the thread's other worktrees, so the transcript gives the `/add-dir` command to run for each, on joining, on resuming, and when a worktree is attached later.
