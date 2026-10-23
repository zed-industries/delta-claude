# Delta for Claude Code

[Delta](https://delta.dev) gives every agent thread a URL. With this plugin, your
Claude Code sessions are recorded to Delta along with the Git checkout they work
in. Anyone on your team can then open the thread and join it, from their
own Claude Code session, from [delta.dev](https://delta.dev), or from the Delta app.

## Installation

You need Claude Code **2.1.303 or newer**. Older versions show a warning but are
not blocked. Inside Claude Code, add the marketplace:

```text
/plugin marketplace add zed-industries/delta-claude
```

Then install the plugin:

```text
/plugin install delta@zed-industries
```

The plugin uses the `delta` CLI. If it isn't installed on macOS or Linux, the
plugin installs it the first time you set up syncing, share, or join, and Delta
offers to open your browser to sign in. You don't need to open the Delta app first.
On Windows, install Delta from [delta.dev](https://delta.dev) first.

At startup the plugin checks an existing Delta installation for updates in the
background, with a ten-second budget. It notifies you when an update is available;
it never installs updates or opens a browser as part of this check. A failed check
does not stop syncing or sharing.

Run `/delta-update` (or `/delta update`) to update the installed Delta app and CLI.
A running Delta app, including the one serving synced and shared sessions,
restarts to install the update; those sessions briefly disconnect and reconnect
on their own, and an app that had a window reopens. On Windows, the installer runs
after the Delta CLI exits, and the command waits up to ten more minutes for it;
approve the Windows prompt if one appears. If Windows reports that a restart is
required, restart Windows before using Delta. If the installer outlasts the wait,
it keeps running; let it finish, then run `delta update --check` before retrying.
Download and installation progress appears in the transcript
while the command runs. This does not update the Claude plugin itself.
The startup notice offers this command only when the CLI can install the update.
Otherwise, follow the CLI's platform-specific instructions: for example, run the
Windows installer, or update a package-managed installation through its package
manager. Older CLIs that lack the update command point to [delta.dev](https://delta.dev).

## Usage

### Setup

Run `/delta-setup` in a repository to choose its team and which sessions sync:

- **Private sync**: every new session syncs, and only you can see it until you
  share it.
- **Team sharing**: every new session syncs and is shared with your team.
- **Manual**: a session syncs only when you run `/delta-share`.

Setup can create a team and invite teammates by email. It saves your choice to
`.delta/settings.json` and keeps that file out of Git, since the choice is yours.

The plugin offers setup once per repository: right after you install it, or the
first time you start a session in a repository that isn't set up yet.

If automatic sync needs you to sign in, an interactive session asks before opening
your browser. If Delta's beta terms still need accepting, it offers to open them too.
You can keep working while you finish; that same session then syncs, including
messages recorded while it waited. To stop waiting, run `/delta-share` again.
Headless sessions never open a browser.

### Sharing

`/delta-share` asks who should see the session: your team, just you, or people
you name by email address. `/delta-share ada@example.com` invites them directly.

### Commands

Each command also works as `/delta <command>`, such as `/delta share`. `/delta` on
its own opens a menu of these actions.

| Command | Description |
| --- | --- |
| `/delta-share [<email>…]` | Sync the current session and its checkout, and choose who sees it |
| `/delta-join <link>` | Join a shared thread in a fresh session, in the thread's checkout |
| `/delta-setup` | Choose this repository's team and which sessions sync |
| `/delta-update` | Update the installed Delta app and CLI |
| `/delta-org list` | List your Delta teams |
| `/delta-org current` | Show the selected team |
| `/delta-org switch <ID>` | Select a different team |
| `/delta-org invite <email>…` | Invite people to the selected team |
| `/delta-org manage` | Open the selected team's members page on the dashboard |

Sharing and joining need an interactive Claude Code terminal or Desktop Code tab.

## Privacy

Delta stores what a recorded session contains: your conversation, including tool
inputs and outputs and Claude's thinking, plus the files in your checkout
(staged, unstaged, and untracked files that aren't ignored). Nothing is uploaded
until you share or join a session, or the repository's setting syncs it
automatically.

A shared or joined session shows you as connected through Claude Code. An open
Delta view takes precedence.

The plugin sends product telemetry to Delta: which integration ran each
command, the plugin version, and when turns start and finish and how they ended.
Telemetry events contain no messages, file paths, tool inputs, or error text.

Live activity telemetry also identifies the external source and the command-line
transport into Delta. It does not identify the person's interface. Several
updates can belong to one tool call, so event rows are not counts of tool calls
or edit operations. Historical imports do not produce these activity events.

## Development

Validate the plugin and run its tests:

```sh
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
npx --yes --package typescript@7.0.2 tsc -p . --verbatimModuleSyntax
python3 scripts/check-cli-setup.py
```

The type check reads the declarations Claude Code writes into `.claude-plugin/types/` whenever it loads
this folder, as `claude --plugin-dir .` below does.

To try your changes, start Claude Code with the plugin loaded from this checkout:

```sh
claude --plugin-dir .
```

## License

Copyright (C) 2026 Zed Industries.

Licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE).
