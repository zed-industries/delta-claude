---
category: Fixed
---

A shared session whose checkout Delta refuses to restore for good, such as a folder Delta manages for another thread, now reports it once instead of after every prompt. Prompts keep recording locally, and the restore is tried again when you run `/delta-share` or resume the session. For a folder Delta manages for another thread, the message and `/delta-share` both point to `/delta-join`.
