---
category: Fixed
---

`/delta pause` now works while a subagent is running. It used to refuse until every subagent had finished, which left a long session with background work no way to stop Delta from holding back its prompts.
