---
category: Added
---

A Claude Desktop fork of a shared worktree session now records into its own subthread with its own checkout. Desktop gives such a fork a new Git worktree, which Delta now attaches to the fork's subthread instead of sharing the parent's, so the fork's file changes show up there. With a Delta build that can't yet fork without the parent's worktrees, the fork stays unrecorded and says so.
