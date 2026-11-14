---
category: Added
---

`/delta pause` pauses Delta for the current session: it sends what it already recorded, then stops recording the conversation and syncing its checkout, also after you resume the session. Who can see the thread doesn't change. `/delta-share` syncs it again in the same thread and adds what was said while it was paused, unless Claude compacted the conversation in between.

When Delta can't recover a session on its own, such as a checkout it refuses to restore or a Delta CLI too old to record with, its message now suggests `/delta pause`.
