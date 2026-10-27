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

The plugin uses the `delta` CLI. If it isn't installed on macOS, Linux, or Windows, the
plugin installs it the first time you set up syncing, share, or join, and Delta
offers to open your browser to sign in. You don't need to open the Delta app first.
When Delta is missing on Windows, setup first asks you in Claude whether to install it.
Only choosing **Install Delta** downloads and runs the official stable installer for your native architecture.
Choosing **Not now** leaves it uninstalled; retry setup, share, or join when ready, or install from [delta.dev](https://delta.dev).
It uses the installer's default scope; approve a Windows permission prompt if one
appears. If Windows requires a restart, restart before retrying setup. The plugin
finds the installed CLI through the registry, without requiring a PATH refresh.
Background discovery never installs Delta.

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

### Plugin updates

The Claude Code plugin checks for new releases in the background at startup and
hourly in interactive terminal and Desktop sessions. These checks are read-only
and work even when the marketplace's native auto-update setting is off. They
read the published manifest from GitHub, use a shared one-hour cache, and never
block your work when the network is unavailable.

When an update is available, a compact row inside the status band offers **Update**,
**Later** (24 hours), and **Mute** (turn off update notifications). Notifications are on
by default; your choice persists across repositories and sessions. They never
install anything without your action. If Claude Code already downloaded an
update, the notice turns green and offers **Reload** in a terminal or **Details**
with activation guidance in Desktop. On very narrow
terminals, secondary buttons give way before the update action; the commands
below always remain available.

- `/delta-plugin-update` updates the plugin and requests activation where supported.
- `/delta-plugin-update check` checks manually without installing.
- `/delta-plugin-update notifications off` stops background checks and notices.
  Use `notifications on` to enable them again.

These also work as `/delta plugin-update …`. The `/delta` menu's **More actions**
includes the plugin updater and the separate Delta app/CLI updater.

Discovery and installation use Claude Code's terminal CLI, so a standalone
`claude` (2.1.303 or newer) must be on PATH. Desktop's bundled engine is not a
substitute: Desktop-only users need to install the terminal CLI and restart
Desktop so it can find it. Organization policy still applies.

In a terminal, an update immediately requests `/reload-plugins --force` without
another confirmation. This reloads all enabled plugins, not just Delta, and a
change to MCP tools can invalidate the prompt cache. A returned command message
does not count as proof that the new version loaded.

Desktop cannot run that interactive slash command. Its own watcher may apply an
installed update when the session is idle, but feature gates and managed MCP policy
can disable that behavior. If the old plugin is still running after 15 seconds,
it reports that activation is pending and tells you to start a new Code session.
It does not bypass policy or promise an immediate Desktop reload.
Within a plugin host, app/CLI updates and plugin installation/activation run one
at a time. This does not control reloads initiated externally by Claude Code.

Normal Zed marketplace installs follow `main`; installs added with `#develop`
follow `develop`. Local development copies, other marketplace sources, and refs
other than `main` and `develop` are left unchanged. Background checks do not run
in headless sessions or when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is nonempty.
Manual commands remain available when notifications are off.
The 24-hour reminder cooldown is shared across sessions, including restarts.

If you installed an older plugin without this updater, refresh the marketplace
before updating from your shell; otherwise a stale catalog can report “already latest”:

```sh
claude plugin marketplace update zed-industries && claude plugin update delta@zed-industries --scope user
```

For project or local installations, run this from the relevant project and replace
`--scope user` with `--scope project` or `--scope local`. Then run `/reload-plugins`
in terminal Claude Code, or start a new Desktop Code session.

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
| `/delta-plugin-update [check \| notifications on\|off]` | Update the Claude Code plugin and reload, check its version, or control update notifications |
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

On macOS, Linux, or WSL, exercise the real plugin install → update → immediate
reload workflow without changing your installed plugins or making model requests:

```sh
python3 scripts/check-plugin-update.py
```

The check creates a disposable Git marketplace and Claude configuration, redirects
the marketplace's GitHub clone URL to that local fixture, and verifies that the
new version loads in the same session and directory. Pass `--claude <executable>`
to check another Claude Code version.

To include the startup notification and its real read of GitHub's public release
manifest, run `python3 scripts/check-plugin-update.py --notifications`. The local
fixture uses that release's version number, but still installs only code from
this checkout. This mode needs network access; the default check does not.

For hands-on testing in your own terminal:

```sh
python3 scripts/check-plugin-update.py --manual
```

Accept trust for the disposable project and wait for the update notice. Try the
notice's buttons, `/delta-plugin-update check`, and the notification preference.
After `/exit`, press Enter to reopen the same isolated configuration and verify
that your preference or snooze persists; enter `q` to remove only that sandbox.
Run the script again for a fresh scenario. The script does not change the one-hour
check interval or 24-hour snooze. Use only slash commands: model requests and real
Delta operations are unavailable. Neither this mode nor the automated check
tests a live shared Delta session.

For hands-on testing in **Claude Desktop's Code tab on macOS**:

```sh
python3 scripts/check-plugin-update.py --desktop
```

This prepares a fresh, retained sandbox without opening or quitting Desktop or
starting a terminal Claude session. It prints the project path and exact launch
command; the instructions are also saved in `DESKTOP-TEST.txt`
inside the sandbox. Use `--desktop-app /path/to/Claude.app` for a nonstandard app
location, or `--directory /path/to/a-new-folder` to choose the sandbox location.
The directory must not already exist.

1. Finish active work and quit Claude Desktop with **Cmd+Q**.
2. Run the printed `desktop.py launch` command. It refuses to launch while that
   app is running and never stops existing sessions. Keep that terminal open.
3. Start a **new Code → Local session**, select the printed project directory,
   and leave **Worktree off**. Launching Desktop does not change an existing
   session's folder: do not resume one for your normal repository. Do not use
   Cowork, Cloud, or the integrated terminal.
4. Wait for the update notice, or run `/delta-plugin-update check`. Confirm the
   running fixture version is `0.0.1`, then try **Update**, **Later**, and **Mute**.
   After updating, allow Desktop to apply it while idle. If it does not, expect
   new-session guidance after 15 seconds and open a new Code session in the same
   sandbox project. Run `/delta-plugin-update check` again to inspect the running
   version. Same-session activation proves Desktop's watcher worked, not that
   the plugin can force a Desktop reload.

There is no test-only unlock command, update gate, or prompt interception.
Desktop must bundle Claude Code 2.1.303 or newer (`/status`).
After changing the test helper, prepare a **new sandbox**; an old launcher still
loads the old copied plugin.

Native auto-update is disabled. Both version labels contain this checkout's code;
the available version number comes from the public GitHub manifest, while plugin
installation fetches only the local fixture. Plugin subprocesses use the isolated
config/cache, Git redirection, and stub Delta CLI even if Desktop replaces `PATH`
with its login-shell environment. For persistence checks, close and reopen the local Code session
in the same sandbox; prepare a **new** sandbox for an independent scenario.

This isolates **plugin state, not the Desktop account or app profile**. Desktop
uses its normal sign-in; ordinary model prompts can use your plan, and the test
session may appear in its sidebar. Stick to the test commands. Do not use
`/delta-share`, `/delta-setup`, or the plugin browser's updater. Managed restrictions
still apply; the helper does not bypass them.

To return to normal, close the test session, quit Desktop, and reopen it normally
from the Dock—not through the launcher. Archive the test session if desired.
After quitting the test app, delete the printed sandbox directory when no longer
needed. No shell profile, Desktop preference, or normal plugin installation needs
restoring. The sandbox is intentionally **not** deleted when preparation finishes.

Test the launcher, subprocess isolation, and production hook paths without opening Desktop or
using the network (also run by CI):

```sh
python3 scripts/check-plugin-update-desktop.py
```

Run the shell setup check on macOS, Linux, or WSL. On Windows, also exercise the
PowerShell installation orchestration with mocked downloads and installer processes:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File scripts/check-windows-setup.ps1
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
