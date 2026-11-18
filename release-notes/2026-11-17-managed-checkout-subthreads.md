---
category: Added
---

A Claude Code session started in a Delta thread's checkout, such as a terminal opened in a desktop thread's folder, now asks how to work there. **Continue as a subthread** records the conversation as a subthread of that thread, visible to the same people, and moves Claude into its own checkout of the same files. **Don't sync this session** leaves it unrecorded. Sharing such a session with `/delta-share` no longer fails on every prompt: it offers the subthread and brings the conversation so far with it.
