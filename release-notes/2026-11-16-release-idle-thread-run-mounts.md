---
category: Improved
---

When Claude runs another Delta thread as a subagent in a checkout of its own, Delta now releases that checkout 5 minutes after the subagent's run ends, instead of keeping it until the session ends. Messaging the subagent again mounts the checkout again before it resumes. Each run is also told to work in the thread's worktree checkout, since Claude Code otherwise starts it in the session's directory.
