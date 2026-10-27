---
category: Added
---

Delta now checks for Claude Code plugin updates at startup and hourly, independently of marketplace auto-update. A compact status-band row offers Update, Later, and Mute; `/delta-plugin-update` updates manually. Terminal sessions request an immediate reload. Desktop may apply the update when idle; otherwise Delta explains how to activate it in a new session. Snooze notices for a day or turn them off with `/delta-plugin-update notifications off`. A standalone `claude` CLI on PATH is required. `/delta-update` still updates the Delta app and CLI separately, and the two updaters cannot run together.
