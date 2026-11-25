---
category: Fixed
---

Mentioning a settings file like `.claude/settings.json` in a message no longer stops Delta from sharing the rest of the conversation. Claude Code refuses to run a command that names a settings file, and Delta was retrying the refused send forever, so everything behind it stayed unsent. Delta now encodes the filename so the send goes through unchanged, and a send Claude Code still refuses pauses sharing with an explanation instead of retrying silently.
