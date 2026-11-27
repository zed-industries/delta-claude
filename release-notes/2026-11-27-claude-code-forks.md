---
category: Added
---

Forks now travel between Claude Code and Delta. Forking a shared session in Claude Code with `/fork`, or resuming it with `--fork-session`, records the fork as a subthread of the session's thread, holding the conversation up to the fork point. A subthread created in Delta shows **Open in Claude Code** on its Delta activity row: pressing it joins the subthread in that terminal and keeps the previous conversation running in the background, where Claude's agent view lists it and it keeps syncing.
