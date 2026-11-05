---
category: Fixed
---

Automatic syncing now preserves its thread, worktree identity, and queued records if attaching or mounting the checkout fails after thread creation. Permanent failures pause automatic retries, and `/delta-share` retries the saved setup instead of creating a conflicting second worktree.
