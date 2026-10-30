---
category: Fixed
---

A synced session's Delta thread now takes Claude's title during the first turn, as soon as Claude replies, instead of showing "Recorded conversation" until the turn ends. A session whose first turn ends while Delta is still signing in or creating its thread keeps its title too: the title waits with the session's other records and is sent once the thread exists, rather than being dropped.
