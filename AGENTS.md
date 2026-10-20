This repository is Delta's Claude Code plugin. See [Development](README.md#development) for
validating it, running its tests, and loading it from a checkout.

## Landing changes

`main` is what installed plugins update from, so a commit reaches `main` only after CI has passed
on that exact commit: `main` requires the `CI Pass` check. Members of the zed-industries GitHub
organization may push a tested commit to `main` directly; everyone else opens a pull request. Read
`.agents/skills/land/SKILL.md` for the flow, including its permission gate: never modify `main`
without the user's explicit permission to land the specific change.
