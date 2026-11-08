---
category: Added
---

Use `/delta stop` to pause syncing for a repository and the session you run it in. New sessions there don't sync until `/delta start`. The current session sends what it already recorded, then stops recording and keeps its thread. `/delta start`, or `/delta share` in that session, resumes it into the same thread, and what was said while it was stopped stays out.
