---
category: Fixed
---

`/delta-join` now starts Claude in the thread's first worktree and adds the thread's other worktrees with `/add-dir`, instead of a folder of links. The project's `CLAUDE.md` loads, and isolated subagents work in joined sessions. A worktree attached mid-session is added once the current turn ends. `/delta-join` and `/delta-share` also run again in Claude Code Desktop, which keeps joining in the thread folder.
