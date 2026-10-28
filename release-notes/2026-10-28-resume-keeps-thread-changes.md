---
category: Fixed
---

Resuming a shared session with `claude --resume` no longer overwrites changes collaborators made to its thread while Claude was closed. An unchanged checkout catches up with them; if both the checkout and the thread changed, your folder keeps its changes and Claude moves to a separate checkout of the thread, or in Claude Code Desktop, Delta asks you to run `/delta-join` to continue there.
