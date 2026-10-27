---
category: Fixed
---

On a Team or Enterprise account, or a machine with managed settings, Delta now starts recording, picks up `/clear`, continues a conversation Claude moves to a new session, records session titles and subagents, and gives an isolated subagent its own copy of the session's worktrees again. Claude no longer reports any of Delta's hooks as skipped. Claude Code's built-in organization guard keeps settings-hook events, the rows Claude adds for the model, and the start of an agent the organization provides from the plugins people install. Delta used to wait for those events, so it did nothing in those sessions; it now learns the same things from events the guard lets through.

On macOS and Linux, an isolated subagent's copy is a fork of the session's worktrees, uncommitted changes included, which the session merges back with `delta thread merge`. That holds whether the Agent call or the subagent's own definition asks for isolation: the path Claude gives the subagent leads to its fork until the session ends. A subagent of a type the organization provides, or one on Windows, works in Claude's own git worktree, which Delta records as that subagent's checkout.
