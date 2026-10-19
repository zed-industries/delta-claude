# Delta for Claude Code

Share a Claude Code conversation and its Git checkout with your Delta organization.

## Requirements and installation

Claude Code **2.1.287 or newer** with function hooks enabled is required.
On the first `/delta share` or `/delta join <link>`, the plugin uses `delta`
from `PATH`, then checks for an existing stable app on macOS/Linux. On macOS,
this includes `Delta.app` in `/Applications` and `~/Applications`; the bundled
CLI works directly, without the app's **Install CLI** menu action.

If Delta is missing on macOS/Linux, the plugin installs the **full stable app
and windowless client** for the current user using https://delta.dev/install.sh.
Setup requires `curl`, network access, and writable user directories. Progress
and errors appear in Claude; retry share/join after resolving an installation error.

On Windows, install Delta from https://delta.dev and put `delta.exe` on `PATH`
before running Claude Code.

Each explicit `/delta share` or `/delta join <link>` checks sign-in after finding
or installing Delta. If needed, Delta opens your browser and Claude shows a
sign-in link. Finish signing in there; the command waits and then continues
automatically. The link expires after 15 minutes; retry the command if sign-in
expires or is cancelled.
Loading or resuming the plugin never installs Delta or
starts sign-in. Changing Claude sessions stops the command, not a sign-in another
Delta client may also be using.

If Delta asks for an organization, run `/delta org list`, select one with
`/delta org switch <ID>`, and retry. `/delta org current` shows the current
selection. These commands use the same system-wide selection as `delta org`
in your terminal.
If access is denied, resolve the approval or terms requirement at the shown URL,
then run the displayed `auth login` command to refresh sign-in before retrying.
Delta's common, windowless client owns the account store, synchronization, and
checkout mounts. No GUI window is required; the plugin's watcher is only an
observer, not an authentication service or mount owner.

If the plugin reports an incompatible CLI, update Delta and retry. Restart
Claude Code after changing which executable is on `PATH`.
If setup reports another installation in progress, wait for it to finish and retry.
After an interrupted installation, remove `~/.cache/delta-claude-install.lock`
only after confirming no installation is running.

The checkout must have its real upstream Git remote; for disposable tests, use
a worktree of a remote-backed repository rather than one created only with `git init`.

Install from inside Claude Code:

```text
/plugin marketplace add zed-industries/delta-claude
/plugin install delta@zed-industries
```

For local development:

```sh
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
python3 scripts/check-cli-setup.py
claude --plugin-dir .
```

Loading the plugin generates declarations for the installed Claude version.
With TypeScript available, `tsc -p tsconfig.json` checks hooks and tests against
those declarations. Generated files are ignored. The marketplace is
`zed-industries`, its plugin is `delta`, and its entry points at this repository.

## Share and resume

Each `/delta` action is also its own command, so all of them appear in Claude's
slash-command menu: `/delta-share`, `/delta-join <link>`, `/delta-setup`, and
`/delta-org list | current | switch <ID> | invite <email>…` run exactly what `/delta share`,
`/delta join <link>`, `/delta setup`, and `/delta org …` run. Claude Code plugin
commands cannot declare subcommands, which is why both forms exist.

From a Claude session inside the intended Git checkout, run `/delta share`.
On an interactive host it first asks who should see the session, after checking the CLI and
before staging anything:

- **Share with <team>**: publish to the organization (described below). Not offered for a
  personal organization, which has nobody to share with, or a thread already shared with its
  organization.
- **Just me (sync privately)**: create the thread with a private upload intent
  (`thread create --organization ORG --visibility private`, the repository's saved team, else the
  selected organization), attach the checkout, and hand the session to Delta's background
  uploader exactly as Private sync does. Nothing is published. Offered only before the session
  syncs; a synced session is offered **Keep current sharing** instead, which reconnects it
  without changing who sees it.
- **Typed email addresses**: `thread invite THREAD -- EMAIL…`, which uploads a thread not yet on
  the server privately and invites each address; the transcript names who was invited and who
  was not, and why. Requires contract version 5.

`/delta share ada@example.com bo@example.com` skips the question and invites those addresses.
Dismissing the question shares nothing. A Claude without the question API can only invite
typed addresses. The band's share control and setup's offer share with the organization without
asking: their labels already name it.

The plugin's own questions run as `AskUserQuestion` tool calls; they are never recorded into the
thread.

It stages the complete bounded, normalized post-compaction conversation locally
(the newest up to 4096 Messages API messages) before contacting Delta. It then
explicitly creates the thread without running a model, attaches the checkout
root, publishes to your organization, starts the read-only watcher, and drains
the immutable outbox. Success returns the organization-shared URL only after
the watcher's initial snapshot and server-confirmed delivery.

The command returns immediately and the status band reports progress and the result.
Sharing and joining need an interactive Claude Code terminal or Desktop Code tab; print
mode, SDK sessions, and cloud runners aren't supported, and both commands refuse there
before contacting Delta.

Repeating `/delta share` finishes an interrupted operation using the same session
binding and staged records. It never resets sequence numbers or reimports a
changed export. Creation is idempotent even if its response or the local binding
write is lost; a confirmed binding is saved before attachment or publication.
Failures retain the binding and unacknowledged suffix for retry.

Ordinary session resume observes the existing thread and checks its attachment.
It does not create, publish, or reattach. Detached, inactive, missing, or local-only
state pauses participation and leaves new records queued until the next
prompt's checkout check passes again or an explicit `/delta share` repairs it. Explicit re-sharing validates the target checkout again: unrelated
or divergent checkouts must be refused rather than overwritten. Participation
requires authenticated `access.state: "granted"`, not ownership: accessible
nonowners can read and append, and missing owner metadata is allowed. Only the
explicit share command requests organization publication, which the server
authorizes; a URL alone proves neither access nor organization sharing. A
session this plugin created itself also participates while its thread is still
`local_only` (see Automatic recording below).

## Automatic recording and the project policy

A checkout's Delta setting lives at its Git checkout root, `.delta/settings.json`:

```json
{ "threads": { "mode": "manual" | "private" | "organization", "organization": "<organization id from `delta --json org list`>" } }
```

- No file, or no `threads` key, is unconfigured and behaves as `manual`: recording
  only through `/delta share` or `/delta join`. An explicit `manual` behaves the
  same but counts as configured, which suppresses the onboarding offer.
- `private` and `organization` require `organization`; `manual` may name one, which `/delta share` shares to. They make every **new**
  session in the checkout record automatically; `private` uploads for you alone
  until you share it, and `organization` shares with the organization.
- A malformed file or an invalid value behaves as `manual`, shows the problem
  once, and is never overwritten without explicit confirmation.
- A write preserves unknown top-level and nested keys. The setting is personal:
  the wizard adds `/.delta/settings.json` to the repository's
  `$GIT_COMMON_DIR/info/exclude`, as the Delta app keeps its own machine-local
  `.delta/` directories out of Git, so it is never committed by accident. A file
  someone already committed stays tracked, and then applies to everyone who opens
  the repository with the plugin.

Run `/delta setup` for an interactive wizard. It settles the team first, because
a thread's organization never changes once it syncs and a personal organization
has nobody to share with. It always asks: up to three teams by name from
`delta --json org list`, then "Create a new organization"; an account with only
its personal organization is offered "Create a new organization" (or a typed
name) and "Skip: keep sessions in my personal organization". A personal
organization is the one the CLI flags `personal`, or, from CLIs that don't
report it, the one named `<login>'s Organization` after `delta auth status`'s
login, as Delta names it and never lets it be renamed. A new team is created
with `delta org create` under the typed name; a failed creation is reported and
never retried, since it may have succeeded, and a created one offers to invite
teammates by email with `delta org invite`. Setup then shows the current mode,
explains that syncing stores the conversation and a copy of the checkout's code,
including uncommitted changes, in DeltaDB, and offers Private sync (`private`),
Organization sharing (`organization`, not offered for a personal organization),
or Manual (`manual`), each labelled with what it syncs and who sees it. Every
mode saves the team as `organization`: the automatic modes sync to it, and
`/delta share` creates its thread under it (`thread create --organization ORG
--visibility private`), so the share publishes there rather than to the
organization selected in Delta. Setup then saves the
choice without a further confirmation and says what it saved ("Saved Private
sync with Zed to .delta/settings.json"). Cancelling or dismissing any question leaves
the file untouched. Print and SDK
sessions get a clear refusal instead. The policy applies to sessions started
afterwards, so after saving Organization sharing the wizard offers to sync the
current session to the organization, as `/delta share` does, unless it is already
shared. Private sync and Manual offer nothing, since a share would publish to the
organization.

When an interactive session starts as a **new** session in a checkout with no
policy, the plugin offers once, in the background, to set up Delta syncing;
choosing yes opens the same wizard. A decision ("Not now", or a written policy)
records a local marker keyed by the repository's Git common directory, so linked
worktrees share it and it is never offered again automatically. A setup left
unfinished records nothing, so the next new session offers it again from the
start: the offer dismissed or answered with typed text, the wizard cancelled or
failed partway, or the session ending while it was open. That last case relies on
Claude's session-end hook; if the Claude process is killed instead, the offer
stays consumed until the marker is cleared. It is never offered in a joined
session, during a join, or headless, and it never delays a prompt beyond the
dialog.

The status band above the prompt is Delta's one indicator, and it always shows
the current state. A synced session (automatic, shared with `/delta share`, or
joined) reads `Delta · Syncing` with who can see it. An interactive session in a
session Delta does not sync reads `○ Delta · Not syncing  /delta-share` in a
checkout with any setting, or `○ Delta · Not set up  /delta-setup` in one never
set up. It switches to `Not syncing` as soon as a setup saves a setting (which
applies from the next session), and to `Syncing` as soon as the session is
shared. A running share or join, a failure, or an unfinished join takes the
reminder's place. Nothing is written to the transcript, so no line goes stale. A
headless session and a session outside a Git checkout show no reminder.

Automatic activation applies only to new sessions — `classic.SessionStart` with
source `startup` or `clear`, never `resume`, `compact`, or `fork`, and never a
joined session or one with a pending join transition. A resumed or forked session
that predates the policy is not converted; use `/delta share` for it. Because the
session is new, its snapshot is taken with no history to export, and live capture
starts with the first row. In the background it creates the thread with its upload
intent (`thread create --source claude-code --external-id SESSION --organization ORG
--visibility private|organization`), attaches the checkout, starts the read-only
watcher without blocking, and drains the outbox. Records queue durably until each step
succeeds, and a failure shows in the band and retries. The watcher inspection accepts an
intent-only `local_only` thread for these sessions, because the upload intent is what
makes the checkout recorded.

A session this plugin created itself — auto-activated or an explicit
`/delta share` — records offline. It appends with
`--acknowledge local`, so `prompt.submit` and
`turn.start` do not drop a prompt or abort a Claude turn merely because the
watcher is not live or the server is unreachable. Retryable failures keep records
queued and retry with backoff while Claude keeps working; the band shows the
pending or offline state. A pause stops delivery, not Claude: the next prompt is
accepted and retries delivery and any unfinished activation once, so a repaired
cause recovers without a command while a poison record simply stays queued, its
reason shown once. Recovery advice for an automatic session never names
`/delta share`, which stays the explicit publish action; a manual session keeps
its `/delta share` recovery. Local persistence failures still stop the prompt, and
fenced or superseded turns are still honored. A joined session
keeps its current, server-confirmed behavior.

A session this plugin created itself never exports a half-initialized binding: its
thread and checkout become visible to delivery and verification only after
`thread create` and `worktree attach` both succeed, so a prompt or
row arriving mid-activation records locally and is never blocked by a checkout
that is not attached yet.

The plugin store keeps a session's binding and row ledger so it can resume into
its thread. Bounded cleanup removes them only for a session that really ended more
than 30 days ago, holds no queued records, no capture failure, and no unfinished
join transition, and is not active in this process. A session live in another
Claude terminal has no end marker and is never pruned; a pruned session can no
longer resume into its thread, and a later `/delta share` starts a new one. Because
the store is shared and has no transactions, pruning reads, checks, and deletes one
session at a time, so a session another process resumes can only be lost in that
session's own read-to-delete window.

The band shows the thread's link whenever status reports one (a URL alone does not
mean others can see the thread), its audience apart from the link (`Synced with
<organization name>` for a private thread or any thread in a personal
organization, which also offers no share control, `Shared with <organization name>`, or
`Unlisted`; an automatic session names the organization its setting uploads to),
and an automatic session's
background upload as the band's running operation, drawn on its row like a share's
steps: `Waiting to sync…` or `Syncing to DeltaDB…`, then `Synced to DeltaDB`, or
`Sync failed: <reason>`. Activation returns before Delta registers the thread, and
Delta registers it a moment before it confirms the content, so the operation runs
until status reports the link **and** the upload is `uploaded`; the link is drawn dim
until then, and later per-turn syncs are not shown. The plugin re-reads status on a
backoff, on its own timer rather than waiting for the watcher. When the server
rejected a recorded thread's local changes, an append fails with `reload_required`
and keeps failing until it is resolved: the plugin pauses delivery, keeps Claude
working, and shows the situation in the band with two controls, **Fork & Restore**
and **Discard**. Fork & Restore runs `thread fork` then `thread discard --force`,
copying the refused state into a "<name> (local changes)" thread that inherits
the original's upload intent and then resets the original to the server's view;
the plugin names the fork once and drains the queued records into the original.
Discard runs `thread discard --force`, dropping the refused changes and draining.
Either choice, or resolving it in the Delta app (the next prompt retries
delivery), ends the pause; on failure the plugin shows the error and keeps the
controls. A private thread gets a
"Share with <organization>" control that runs the same publication flow as
`/delta share`. `/delta share` on an auto-activated session publishes the existing
thread in place: no re-export and no new thread. The link no longer waits for an
explicit share.

## Join an existing shared thread

In an idle Claude session in a **POSIX terminal or Desktop Code tab**, run:

```text
/delta join https://delta.dev/join/thread_...
/delta join ksQQ...
```

A bare cloud share ID also works. Joining asks no question of its own: it starts a
fresh Claude session, and the previous one stays resumable. Running agents or
teammates refuse the transition, and background shell tasks from the old session keep
running, because `/clear` does not stop detached processes. Print and SDK joins are refused:
they have no interactive surface. Before clearing, the plugin checks the host's
actual built-in `/clear` and `/cd` commands, rather than inferring their availability
from the surface, and that the thread has at least one worktree.
Claude asks whether to trust the new directory, and the plugin first explains that
prompt in the transcript: choose **Yes, move here** to finish joining. Declining
leaves the transition paused and recoverable. Claude Code Desktop has no `/cd`, so a
Desktop join starts a new session instead (below).

### Joining from Claude Code Desktop

Desktop's own folder tool applies a move only when a model turn ends, which a join run
from `/delta join` never has, and Desktop never moves a session that runs in a worktree
it set up. So a join from any Desktop Code tab, worktree or not, opens the thread in a
new session, and the tab itself stays as it is:

1. The tab mounts the thread under an owner of its own, `desktop-<uuid>`, passing
   `--folder` for a one-worktree thread. Desktop opens a Git checkout as a project and would
   make yet another worktree of it, but opens a thread folder, which is not a repository, as
   a plain folder.
2. It records the hand-off in `delta-plugin/handoffs/<owner>.json` under Claude's
   configuration, where every Claude process on the machine can read it, and opens
   `claude://code/new?folder=<thread folder>&q=Join this Delta thread.`, the link Finder's
   "New Claude Code Session Here" uses. Desktop shows its new-session screen on that folder
   with the line filled in, and may ask the person to trust the folder; the folder is not a
   Git repository, so the session gets no worktree of its own. Where `open` cannot run, the
   transcript carries the link instead. The person sends the line themselves, because
   Desktop's own session tools (`spawn_task`, `start_session`) refuse a session a plugin
   starts. The line is not `/delta join`, because Desktop breaks a command a link fills in
   (`/ delta`).
3. Sending the line starts the session. Within `session.start`, which Claude waits for
   before the first prompt, the plugin finds the record for the session's folder, removes
   it, mounts again under the same owner so Delta follows its own Claude process from then
   on, and joins without clearing or moving. The line, sent unchanged, then becomes a
   one-word turn ("Joined.") that is left out of the thread; dropping it instead would show
   as blocked. An edited line is the person's own message. `/delta join` typed in that
   folder joins the same way.
4. A hand-off no session joins within five minutes is released: its checkouts are
   released, and the tab says to run `/delta join <link>` again to bring it back. The tab
   exiting releases it too.

A thread can have any number of worktrees. Joining clears Claude into a new session,
then asks Delta to mount every worktree for that session with
`delta thread mount THREAD --owner SESSION`, where the owner is the new Claude
session ID. Delta chooses where the checkouts go, so the plugin keeps nothing of
its own on disk for them. The result names the directory Claude works in: the
worktree's own checkout when the thread has one worktree, otherwise a thread
folder that holds one link per worktree, named after it. The plugin changes
Claude's directory there with `/cd` and verifies the new session ID and both
Claude's cwd and project root before enabling recording. It never creates a Delta
thread, attaches the old checkout, republishes the thread, or exports either
conversation's history. The previous folder and Claude transcript remain intact;
the success notice gives their resume command.

The new session has its own context and producer sequence. Incoming activity
uses the status band above the prompt and idle context-row handoff:
joining and remote updates start no Claude turn. Only your next prompt does.
The binding keeps the thread, the original link, the owner, the directory Claude
works in, and each worktree's checkout. Before every prompt and delivery the plugin
requires that directory to be Claude's project root, with Claude's shell in it or below it
(Claude's own `cd` within the checkout is fine), and each worktree's checkout to be active;
otherwise the prompt is refused and the band names the worktree that is not ready.
`/delta share` refuses a joined session; repeat `/delta join <link>` to recover
participation. A link or ID resolving to the same bound thread
reconnects in the existing session: it mounts again, moves Claude back to its
directory if it is elsewhere, and never clears, resets the producer sequence, or
discards pending records. A different thread follows the confirmed fresh-session
transition.

Failures before `/clear` preserve the old session. The mount happens after `/clear`,
because only the fresh session ID can own it, so a mount failure or a declined trust
prompt leaves the fresh session with its saved transition, recording disabled and
prompts blocked; `/delta join` with the original link retries it without clearing
again. A mount or watcher failure is shown in the transcript and the status band, never
reported as success.

### Mounts follow the thread and end with the session

- **Worktrees change.** The watch sends a `worktrees` event when a worktree is
  attached to or removed from the thread. The plugin asks Delta to mount again for the
  new paths, adds a hidden context row for Claude (held until a turn ends, so it never
  lands inside one) and shows the person a band notice. When Claude is in a worktree's
  own checkout and the thread now has several, the plugin moves it with `/cd` to the
  thread folder between turns; a session already in the thread folder stays there,
  including when the thread shrinks back to one worktree. Prompts wait while that
  move is pending. A reconnect sends the current list again, which changes nothing.
- **Exit.** When a joined session ends with reason `prompt_input_exit`, `logout` or
  `other`, the plugin runs `delta thread unmount THREAD --owner SESSION`. That command
  returns once the release is recorded; Delta then uploads each checkout's changes and
  deletes it, so the hook never waits for synchronization. The plugin does wait for
  the request itself, for at most five seconds: Claude kills a request still running
  when it exits (a 0.3 second command was lost in a probe), while a hook that waits is
  allowed a full second and more. A session end with reason `clear` (the join's own
  transition) or `resume` (switching sessions) releases nothing. Delta also releases a
  group whose owner process is gone, so a request lost to a crash only costs time.
  Ignored files such as `target/` and local Git state such as branches are lost with
  the checkout; changes to tracked and eligible untracked files are uploaded first.
- **Resume.** Claude resumes in the directory it was launched from. On session start
  with a saved joined binding the plugin mounts again, `/cd`s to the returned directory
  if Claude is elsewhere, verifies, and then watches the thread. Prompts are refused
  with "restoring" until that finishes, and the status band shows the progress. If restoring
  fails, prompts stay blocked with the reason until `/delta join <link>` succeeds.
- **Owner process.** `thread mount` records the owner process so Delta can release
  the group when Claude is gone. The plugin API exposes no process ID, so it passes no
  `--owner-pid` and relies on the CLI's default, its parent process. In an interactive
  terminal session a command run through `$.process.run` or `$.process.spawn` has the
  `claude` process itself as its parent, which is the right owner. The Desktop app has
  not been checked.

### CLI boundary

The adapter uses ordinary short write/read commands and one JSONL observer:

```sh
delta --json thread contract
delta --json org list
delta --json thread create --source claude-code --external-id SESSION --organization ORG --visibility private|organization
delta --json worktree attach PATH --thread THREAD
delta --json thread share THREAD --visibility organization
delta --json thread invite THREAD -- EMAIL...
delta --json thread append THREAD --source claude-code --external-id SESSION [--acknowledge local|server]
delta --json thread watch THREAD --source claude-code --external-id SESSION
delta --json thread status THREAD --source claude-code --external-id SESSION
delta --json thread mount THREAD --owner SESSION
delta --json thread unmount THREAD --owner SESSION
delta --json thread fork THREAD
delta --json thread discard THREAD --force
```

`thread contract` reports the recording-output contract versions the CLI build speaks
(`{"operation":"contract","min":1,"max":5}`), answered locally without starting delta-app; the
plugin calls it once per session before its first recording command, and `/delta setup` before its
first question. The plugin speaks versions `PLUGIN_CONTRACT_MIN` through `PLUGIN_CONTRACT_MAX`,
currently 4 through 5: nothing older is supported, because neither the plugin nor the CLI has
shipped. Version 5 adds `thread invite`; with a version 4 CLI, `/delta share` offers no email
invitations and setup's personal-organization option doesn't mention them. When the ranges don't overlap, the plugin refuses to set up, share, join, or resume and says
to update Delta (the CLI is older) or the plugin (the CLI is newer); a CLI that predates the
subcommand is treated as an older Delta. The plugin remembers the newest version both speak for each
session, so a capability a later version adds can be gated on it until `PLUGIN_CONTRACT_MIN` reaches
that version.

`thread create` records a durable upload intent when given `--organization` and
`--visibility private|organization`, without waiting for the network. It is idempotent by external
id: re-running it returns the same thread, keeps the first accepted intent, and retries a parked
upload. A different organization from an existing intent fails with a non-retryable
`organization_mismatch`; an already-registered thread records no intent. Delta then uploads in the background, retrying after a reconnect or restart.

`append` takes `--acknowledge local` or `server` (the default). `local` is accepted for a registered
thread or one with an upload intent and acknowledges each record once it is durable locally, without
waiting for the server; if the thread must catch up while Delta is offline, it fails promptly with a
retryable error, which the plugin's envelope-driven retry handles.

`org list` returns `{"operation":"listed","organizations":[{"id","name","current"}]}` and carries
the typed error envelope.

The plugin passes `thread mount --join` only while completing a requested `/delta join`, not while
restoring a session or refreshing worktrees in the background, so background maintenance adds no
join telemetry.

`append` accepts ACP's `session_info_update`, carrying the session's title, which Delta makes the thread's name in place of "Recorded conversation".
When a shared session's turn ends, the plugin reads the title from that session's own transcript
file, whose path the turn's end names: Claude's own `ai-title` row, or a `/rename`'s `custom-title`
row, which wins. Claude writes a title row when the title is chosen or changed and repeats it as the
transcript grows, so the plugin reads only what the file gained since its last read (the last 256 KiB
the first time, or after compaction rewrites the file), with `tail -c +OFFSET`, or on Windows a
PowerShell stream seeked to the offset, given the path as JSON on stdin, skipping every row
that does not open like a title row. Either reader can be missing or refused (no `tail` on PATH,
PowerShell in Constrained Language Mode under AppLocker or WDAC); after one failure the session
reads its transcript whole with `$.fs.read` instead, up to that call's 4 MiB limit. A title that
still cannot be read or staged is skipped and tried again at the next turn's end; it goes only to
the debug log and never pauses sharing. The turn's end does not wait for it. The plugin appends the title
once per change. It sends
titles only to a CLI that reports version 2, since an older one refuses the update and sharing would
pause. A joined session never renames the thread it joined.

`thread mount` mounts every worktree of the thread for the owner, repeating it is safe,
and its result names where Claude works and each worktree's checkout:
`{"operation":"mounted","thread_id","owner","directory","worktrees":[{"reference","name","directory","state"}]}`.
`thread unmount` releases the owner's group once the release is recorded. See
`docs/thread-mounts.md` in the Delta repository.

`worktree attach` attaches a local checkout to the thread without publishing it.
An explicit attach also requests safe, lossless reattachment; it needs no extra
flag. This is distinct from `thread mount`, which brings the thread's shared files
local for a joining session. Attach returns the standard mounted receipt:
`{"operation":"mounted","reference":"HISTORY_UUID#t=TIMELINE","directory":"..."}`.
The adapter requires a nonempty reference and the expected canonical checkout
directory and persists both in the session binding. Explicit status reads
select that exact reference plus directory from the thread's worktree inventory,
independent of inventory order or other checkouts. A joined binding instead checks every
worktree it holds: each must appear in the inventory with its mounted directory, active.
An older directory-only binding
can adopt a reference only when this same thread has exactly one matching attached
checkout; adoption preserves the outbox and producer frontier and never attaches
or shares. Ambiguity or a reference mismatch fails without switching the binding. Failures
use typed `{"error":{"code":"...","message":"..."}}` replies, with no assumption
that one particular nonzero exit code identifies attachment failure.

`append` reads JSONL envelopes on stdin for both content and lifecycle. An actual
Claude turn starts with a scoped ACP state update, using its next sequence:

```json
{"schemaVersion":1,"sequence":1,"turnSequence":1,"update":{"sessionUpdate":"state_update","state":"running"}}
```

Completion uses the next available `sequence`, the original `turnSequence`, and
`state: "idle"`. Output can carry the same `turnSequence` to fence stale content.
Unscoped state updates are historical content only; they never start or finish
generation. The native client preserves its file-before-finish barrier, Stop,
and takeover behavior.

Every `appended` receipt reports `recorded`, `fenced`, or `duplicate`, plus
`thread_id`, `sequence`, `next_sequence`, `duplicate`, `version`, and
`turn_sequence` (a number or null). When the server rejected the thread's local
changes, the append fails with `reload_required` and keeps failing until the person
resolves it. `thread fork THREAD` copies the refused state into a "<name> (local
changes)" thread that inherits the original's upload intent and leaves the original
unchanged, answering a pretty-printed summary
`{"source_thread_id":"<original>","thread_id":"<fork>","name":"..."}`.
`thread discard THREAD --force` resets the original to the server's view, dropping
the refused local changes. Failures use the typed error envelope. Valid matching
receipts release only the durable pending prefix. They acknowledge recording, not
permission to execute.

Older outbox controls and output associations are translated to lifecycle/content
envelopes when sent, preserving their sequence numbers and immutable files.
Saved journals must retain their `JSON.stringify`-plus-newline format; strict
shape and roundtrip checks reject corrupt records, including duplicate JSON keys,
before translation. This formatting check does not apply to public append input
or command receipts.

All reviewed native thread commands accept a pasted Delta link, a bare cloud share
ID, or the canonical underlying thread ID. Their `thread_id` is always the
canonical ID (the `ksQQ...` identity), even after sharing. The cloud `thread_...`
ID appears only in share URLs; the adapter never changes its binding to that ID.

`status` has one native shape for every producer:

```text
{
  operation: "status", thread_id, url: null | string,
  visibility: "private" | "organization" | "unlisted" | null,
  upload: null | { state: "queued" | "uploading" | "uploaded" | "failed",
                    organization_id: string | null,
                    error: null | { code, reason, message } },
  access: {state: "local_only" | "granted", is_owner: null | boolean},
  worktrees: {status: "available",
              items: [{reference: "HISTORY_UUID#t=TIMELINE",
                       checkouts: [{directory, state: "attached" | "inactive" | "detached" | "missing", active: boolean}]}]}
          | {status: "unavailable", error: {code, message}},
  producer: null | {source, external_id, next_sequence, turn: null | {sequence, status}}
}
```

`visibility` is null until a cloud record exists; `upload` is null until an upload intent exists.
Status answers from local state, probing the server for the thread's access metadata, so a locally
known thread is still readable when the server is unreachable. An intent-only, not-yet-registered
thread reports `access.state: "local_only"` with a non-null `upload`; a session this plugin created
itself accepts that state as valid for participation, while other bindings require `granted`.

Unregistered local threads report `local_only` and `is_owner: null`. Registered
threads verify authenticated backend access; a denial returns a typed error instead of
inferring access from a URL. The adapter checks the
producer's `source: "claude-code"` and actual Claude session `external_id`;
`producer: null` is valid native observer output but cannot participate or supply
a synthetic empty ledger. Supplying a new producer identity reports its native
empty frontier (`next_sequence: 1`, `turn: null`); joining needs no registration
append. A joined binding requires `active: true` for each worktree's exact reference and
mounted directory, including a mount whose ownership state is `detached`.
Ordinary shared bindings still require `attached`, never adopting a mount. Worktree inspection is explicitly tagged: `available`
with empty `items` means there are no attachments, while `unavailable` means
inspection failed. The adapter surfaces that typed error and pauses participation
without replacing the binding, dropping pending records, or attaching or sharing.

`watch` prints JSON Lines: `ready {thread_id, producer}`, the thread's current
`item`s, `live`, and then changes: `item` (the whole item, by `id`), `item.append`
(a text suffix), `remove`, `turn` (the thread's coalesced generation state and who
started it), `producer.turn` (this producer's turn, ordered), and `presence`
(everyone connected), `worktrees` (`{"worktrees":[{"reference","name"}]}`, the
thread's current worktrees, sent after `live` and whenever the list changes), and `comment` and
`comment.remove` (a delivered comment, whole, by `id`, after the `user_message` it was delivered
with; see Comments below). Items carry `kind`, `author`, `open`, and `content`; a tool
call's content is an ACP `ToolCallUpdate`, including diffs with patches. Delta
excludes this producer's own records. The adapter skips unknown event types and
`unknown` items. It validates readiness's identity and producer frontier, then reads
`status` off the watch loop for access and checkout checks; participation is ready
once that check passes and the snapshot is `live`. Every connection starts with a
new snapshot; there is no replay position. Terminal errors use the typed envelope: an
envelope whose `retryable` is `false` — `not_visible` for a deleted thread or ended
access, `incompatible_app`, or a non-retryable `failed` — pauses participation with its
reason until explicit share/join recovery, while a retryable envelope such as
`watch_reset`, and any process exit or malformed line, reconnects with backoff capped at
thirty seconds.
Status reads stream with a 16 MiB bound and a two-minute timeout. Watching has no
create, attachment, or publication side effects.

Mounts remain owned by the common client after the watcher ends, and a joined
session's end the way described above. Inspect them with thread status or
`delta worktree list`; `delta worktree unmount REFERENCE DIRECTORY --thread THREAD`
detaches one explicitly.

## Privacy and durability

Nothing is exported before `/delta share`, a completed `/delta join`, or the
automatic activation a repository's policy asks for. Automatic activation records
only new activity from a new session: it never exports historical context. Joining
records only new local activity, never a bulk export of old context. Organization sharing includes conversation
tool inputs/outputs, images and thinking text, plus staged, unstaged and eligible
untracked checkout files. Draft text is not exported.

The plugin persists immutable records in
`$CLAUDE_CONFIG_DIR/delta-plugin/outbox` (default `~/.claude/delta-plugin/outbox`)
and its durable manifest in Claude's plugin store. Keep these and Delta's common
account store: deleting either can lose pending content or retry identity.
Cleanup removes only known record files below the durably acknowledged prefix;
pending records, uncommitted staging files, links, and unknown names are retained.
Cleanup failure is visible but does not block delivery.
A failed or timed-out delivery shows `Couldn't send message to Delta: <code>: <message>`
in the transcript (once per distinct reason) and in the status band, and keeps the
records queued unchanged. The recording command's error envelope decides: `retryable:
true` retries indefinitely with backoff of 2 to 30 seconds, honoring `retry_after_ms`
as the next delay, and `retryable: false` pauses sharing. Its `reason` names the
specific cause and is carried in the message. Only the plugin's own local
`process_failed` and `timeout` codes, which never come with an envelope, are retried
without that verdict; its local `command_failed` and `invalid_acknowledgment` codes
pause. A pause says why. A pause after a failed checkout check is lifted by the
next passing checkout check (a prompt or explicit share/join recovery); one set because the
watcher disconnected lifts when it reconnects; and one set because Delta refused a
record lifts only on an explicit `/delta share`, or `/delta join <link>` in a joined session.

Live capture uses row type, metadata, and engine-stamped provenance to exclude
command output, reminders, and injected context, not text matching. Literal human
lookalikes and tool results survive. The initial bulk export lacks provenance;
the plugin does not guess which historical text to discard or rewrite transcripts.

A failed live-row save pauses sharing. Unsaved rows remain in memory for retry
during that process. If it exits first, the plugin cannot recover those contents;
a persisted fault flag prevents claiming completeness on resume. After recovery,
forking into a fresh Claude session permits a new bounded export.

### Product telemetry

Each Delta CLI thread command receives `DELTA_CLI_INTEGRATION=claude_code`.
Delta uses that command's marker for `integration` on thread creation, sharing,
sharing failures, joining, joining failures, and external-turn starts. It does not infer this value from a thread's
creation or its latest producer. Older Delta clients ignore the environment
marker and remain usable; their events keep unknown integration values.

Live turn starts include the installed plugin's release version from
`.claude-plugin/plugin.json`, in `update._meta.delta.producer_version`.
Only numeric `major.minor.patch` versions within 32 bytes are sent.
A missing or invalid version leaves the recording usable without that property.
The metadata is optional. It uses ACP's existing `_meta` field, so older Delta
clients can still record the turn.

Confirmed main-turn completions send a fixed `stopReason`: Claude's `answer`
maps to `end_turn`, an aborted turn maps to `cancelled`, and `refusal` and
`error` keep those categories. An error carries only a fixed diagnostic, not
Claude's error text. A recovery finish, an unrecognized completion reason,
or a finish without a completion event stays unknown.

Delta emits `External Turn Started` and `External Turn Finished` with a shared
opaque ID for a newly recorded live turn. Duplicate and superseded records do
not add events. The finish can join to the start's plugin version. These events
do not contain messages, paths, tool inputs, or error text.

Live starts also report `execution_location` when Claude supplies an explicit
`CLAUDE_CODE_REMOTE` flag: `true` maps to `remote`, and `false` maps to `local`.
Missing or unrecognized values stay unknown. This describes the Claude execution
host, not the model's inference server. The flag does not identify the host owner,
so `runner_host` is not sent. Neither the interactive surface nor the background
Delta process is used to infer these values. DEL-3530 tracks the remaining
per-action origin measures. The new event and properties also need typed
warehouse publication before Hex can query them.

## Incoming activity and execution

On interactive hosts, sharing, joining or resuming shows its status in the band above the prompt.
Repeating `/delta share` or `/delta join <link>` re-reports it and recovers the same
operation. The band is the only ongoing status surface: nothing about presence or turns is
written to the transcript. It is one row:

```text
● Delta  https://delta.dev/join/thread_…  copy link                  Maya, Sam, Lee
```

On the terminal the row is a shaded status bar, a step off the background for a light or a
dark theme, so it reads as part of the input area rather than a transcript row; a terminal
that cannot show the shade shows a plain row. The desktop's own card sets it apart, so there
it draws the same parts unshaded. The mark is the connection: a green `●`
while the watch is live and this session's records are being delivered, a yellow `◌` while
it connects, retries a send, or a share or join runs, a red `✕` when something fails or
sharing is paused, and a dim `○` when not connected. A lost connection that comes back
within a few seconds is never shown; past that grace the mark turns yellow and the people
the band last saw dim. A failure, or a send being retried, adds a second row with the
reason and what to do.

The thread's link follows the mark whenever status reports one, whether or not a
share published it: on the terminal the URL
itself, as an unlabelled hyperlink, and on the desktop a link labelled with its short form. A
labelled terminal link would print the URL twice where Claude does not treat the terminal as
hyperlink-capable; an unlabelled one prints it once, as a hyperlink where the terminal supports
them. Beside it
is a copy control, which a click presses, or Enter once the band has the focus (ctrl+x tab
lands on it), and which confirms only once the clipboard took the link. The thread's
audience sits beside the link (`Synced with <organization name>`, `Shared with
<organization name>`, or `Unlisted`), and Delta's background upload takes a row of its own while it is queued,
uploading, or failed. A private thread also offers a "Share with <organization>"
control that runs the same publication flow as `/delta share`. While a share
or join still runs, the link shows dimmed and is not offered; before status reports
one, the band says the link appears when ready. It is never written to the transcript.

The right side says who is here: everyone settled in the thread, by first name (with a last
initial where two share one) in the color their user id gives them, which their transcript
rows also use; past three the rest are counted (`+2`). An arrival counts only after a peer's
connection has held for a few seconds and is highlighted briefly; a departure stays listed,
dim, through a grace period, so a peer's flickering connections while `/delta join` runs
show one arrival. Presence lists people rather than clients, so your own name shows while
another client of yours is in the thread. A running share or join shows its step there
(a share's five steps are counted), and a finished one shows its result briefly.

When another participant's agent is working, a line of its own above the band says so, the way
Claude's own working line does: a spinner in their color, the agent, and what it is doing.

```text
⠹ Maya's agent › cargo test -p thread  (1m 12s · 2 more running)
```

What it is doing is its newest tool call, by the title its transcript row will carry, or
`thinking` for a thought, with how long that has been open and how many other calls are; with
neither, the line says how long the turn has run. A call or thought shows only once it has been
open half a second, so a burst of quick calls never flickers through the line; it goes straight
to the transcript instead, which is also where a slow call lands when it completes. A turn with
nothing open and no activity for 30 seconds says it has gone quiet instead of spinning. This
session's own turn changes nothing, as Claude already shows it.

The band also shows child threads and subagents from Delta's `children` watch snapshot,
even when the parent is idle. Active, failed or unknown children get a compact activity
line when there is room; settled children stay on the band's right side. With one row,
the summary keeps separate counts of differing states (for example, `1 failed · 1 running`)
rather than letting an older failure hide a running child. Queued, running, syncing,
completed, stopped, failed and unknown remain distinct.
After the parent transcript becomes live, child discovery sends a full `children`
snapshot replacing the inventory. Sharing/joining does not wait for child discovery
or for child statuses to resolve. Subsequent
`child` events insert or replace one entry by `thread_id`; `child.remove` events remove
one entry. Unchanged siblings are not resent. Reconnection starts with a fresh snapshot,
not a replay of transitions missed while disconnected. After a disconnect the last inventory is dimmed
as unknown until the new snapshot arrives. Child status never starts a Claude
turn or adds a transcript message; newer statuses display as unknown, and newer
child kinds display as a generic child without interrupting the watch.

Child entries carry an opaque `reference` for CLI commands, separate from the
canonical `thread_id` used to identify the child. The plugin preserves it but
does not open or execute child conversations.

As the row narrows, parts give way in a fixed order: the copy label shortens, the URL moves
to a row of its own below (whole, so it stays clickable and easy to select), other
people become initials and the working agent's owner loses "'s agent", and then the others go.
When child status needs that last space, the copy control remains but the desktop's
short link may also give way to the child state counts.
The mark, the link and whoever is working stay. Only a band
of one row with no room for the URL drops its text, leaving the copy control to copy it. Rows
go to the band's row first, then a failure's reason, then the working agent's line, then the
URL; with no row for the agent's line, the agent takes its owner's place on the band's row
with how long its turn has run. The desktop keeps its short link on the one row. The band
yields to a survey and never exceeds the host's row budget. Remote content lives in the
transcript and on the web; the band only says what is running.

Each remote item is added to Claude's transcript when it completes and never starts a
Claude turn: Claude uses it with the person's next prompt. The model reads one user-role
row for it, a `[Delta]` row naming the author and kind over the whole content, exactly as
for every other kind: a tool call's name, status, input, output and patches, or another
kind's fields, with the item's id, which a later correction or removal row names.

Tool input rows and unpaired call-hook results stay `in_progress`. The result row
closes the call with both Claude's output text and any cached structured output or
patches, so a receiver does not draw a provisional result and then correct it when
the output text arrives. A call whose result row never arrives stays open.

The person's copy of a message is drawn beside it, as the output row of the plugin's own
hidden `/delta show <item-id>` command, under its echo. The plugin's `ui.render` hook for
that command's `CommandOutput` site draws the author in bold colour, tone apart for a
person and another agent, over the message's own markdown, from its own item data rather
than the row's stored text. The command's rows carry as little as the engine accepts: the
echo stores nothing and the output row only the `local-command-stdout` wrapper the engine
draws it from, around the least text that shape accepts, so the model reads no command
name, no command argument, and no second copy of the message. The engine's own local-command
caveat above them survives untouched. A remote agent's thinking is for the person only:
it is announced when it completes, but never becomes a row for Claude.

A message row is drawn from a redraw: the engine answers a plugin's own command only
inside a hook context, so the plugin queues the row and a `ui.render` hook releases it.
A host that never redraws (or that refuses the command) makes the plugin fall back: the
message is shown as a dim notice, and the model's own row is offered as usual. A drawn
item is drawn once per session, so a row offered again, as after a refused append, draws
nothing twice. After a restart the engine draws the stored rows again and the watch
snapshot re-sends the item, so the drawing is rebuilt from the plugin's data; an item the
session no longer holds draws a short placeholder, never the near-empty stored text.

Each large section, and the row as a whole, is truncated at a marker that says how to read the
full text: `delta thread show THREAD --format messages --messages 1-20`, with messages
numbered from 1 across the whole thread, at most 20 per call, paging forward.
If an item Claude was shown is later edited or removed, a correction row says so.
Rows wait while a local prompt enters and while Claude's own turn runs, so they never
land inside a turn.

The plugin store records each added item's id and content fingerprint per session,
so reconnects and restarts add nothing twice and correct what changed or
disappeared meanwhile. It is saved after each batch of rows: a crash in between
can repeat rows, never lose them. Large batches save every 20 rows, and rows added
just as the watcher stops are still recorded. A row that cannot be added is reported
once and offered again by the next connection's snapshot.

The person sees each completed remote message in the transcript as a drawn markdown row
under its author, in arrival order, preceded by the plugin's echo of the command that drew
it (`/delta show <item-id>`), which the engine draws from the run itself and the plugin
cannot hide there. A remote agent's thinking is the exception: it stays a dim
notice, one entry per paragraph under "<author> (thinking)", with markdown markers stripped
and no empty entries, and never reaches Claude. A tool call is drawn the same way as a
message, as one line: who ran it in colour, the tool in bold, its key input dim, and a status
other than completed (red when it failed). A notice longer than one line can carry ends at a
marker naming how to read the rest. Status is the band's job, not the transcript's: the band
lists who is here and highlights an arrival briefly, animates another participant's turn while
it runs, and reports a finished, reconnected or cancelled join; the session ids of a join go only to the
debug log (`claude --debug`).

### Comments

Comments made in Delta reach Claude once they are delivered: sent with a message, by whoever sends
next from Delta. A pending comment is a draft and never reaches the plugin, and a Claude Code
prompt does not deliver anyone's comments: the person typing it never saw them. Each delivered
comment is its own row for Claude, after the message that carried it: a `[Delta]` header naming
its authors and the comment's id, then the comment in the `<comments>` shape Delta's own agents
read, with the file and its numbered lines (`+` added, `-` deleted, as they read when the comment
was made) or the quoted passage it was made on. A reply carries its chain's target too. A comment
sent to a subthread says so, since it was not addressed to Claude. The person sees each comment
drawn the way a message is, as the output row of the plugin's own `/delta show comment:<id>`:
the author in colour, what they commented on (`commented on src/main.rs:4–5`, or the start of the
quoted passage, or `replied on …`), up to three of its lines dim, and the comment's markdown. A
message that only carried comments has no text, so it adds no row and draws nothing: the person
sees just its comments. The plugin store records each comment as it does an item, under
`comment:<id>`, so a restart repeats none; an edit corrects Claude's row, and a comment that is
withdrawn, as when its message is restored to a draft in Delta, gets a row telling Claude to
disregard it.

Joining a long thread does not replay it. A snapshot's newest items reach Claude's context in
full, up to about 400,000 characters of rows (roughly 100k tokens), newest first; the newest one
always does. Older items are left out behind one row telling Claude how many there are and to
read them with `delta thread show THREAD --format messages --messages 1-20` if it needs them.
Claude never read a left-out item, so its later edit or removal adds no correction row, and a
reconnect adds it nothing; if the standing-in row is refused, the next snapshot offers them again.
Only the newest five messages and tool calls are drawn for the person, after one dim notice:
`Continuing a Delta thread: N earlier items are in Claude's context but not shown here`, or, when
some were left out, how many of those are not in Claude's context either, with the
`delta thread show` command that reads them. A reconnect's snapshot is handled the same way,
counting only items this session has not seen; items that complete live always reach Claude and
are always drawn.

As with a native Delta send, a local prompt takes over another participant's running
turn; prompts are refused only while checkout sharing is paused.

After the prompt enters, actual `turn.start` saves its scoped running record and
local Claude ID before correlated output, then schedules delivery without waiting
for server permission. Completion likewise stages its idle finish and clears the
execution locally before returning, then delivers in the background: Claude skips
a hook that runs past its budget, and a CLI turn end waits for the checkout
upload, so waiting would lose the hook and let the next turn's output be
attributed to the turn before it. Output that reaches a hook before its own
turn's start record is written waits for that start rather than naming the turn
before it. A superseded watch event aborts only the matching local
Claude turn; a `fenced` receipt for the running turn stops it the same way, even
when the watcher is lagging or disconnected. Late tool output retains its
original start sequence and is fenced.
Observer disconnection or capture failure also stops that local turn. Recovery
finishes a known abandoned start using its saved sequence, never by stopping a
different or newer turn.

Clients may briefly overlap before replication exposes a conflict. Cancellation
cannot undo tool side effects or guarantee termination of detached processes.

## Verification and limits

`claude plugin test .` checks explicit commands and observer-only resume alongside
durable retries, metadata filtering, exact turn cancellation, late-output fencing,
reconnect/shutdown, and safe outbox cleanup; watch decoding; row rendering,
truncation, deduplication and corrections; the status band (including child snapshots,
compact layout and disconnected status), visible rows, and the
handling of watch errors. It also checks the project policy (parsing, round-trip
over unknown keys, invalid values), the setup wizard (writing only after
confirmation, and leaving the file untouched on cancel), the one-time onboarding
offer per repository, automatic activation only for startup/clear sessions, a
prompt and rows arriving during each activation step without a pause or a dropped
prompt, private mode issuing no `thread share`, offline recording keeping prompts
and turns and draining after reconnect, a refused offline append showing the
Fork & Restore/Discard choice and draining after either, the band's link,
audience, waiting and uploading state, and share control, the bounded store
cleanup that never removes a pending or live session, and the organization picker
for more than three organizations. The test host keeps no rows: a plugin's own `session.append`
still fails, and those tests observe each attempted row through its debug log line. The
host also records every row a plugin passes down to `session.append`, after the plugin's
own hook rewrote it, which is how the tests check what the model would read; unit tests
drive the same row-adding loop with a working append to check that rows are recorded,
saved and announced, and the handoff check below runs it in Claude. A message row is
drawn by a `ui.render` hook, so those tests render the band again to
release it, as a live host redraws; a test that never redraws checks the fallback
notice instead.

Join fixtures additionally check fresh-session isolation, one- and three-worktree
mounts, the prompt gate naming an unmounted worktree, live worktree changes including
the move to the thread folder, unmounting on exit for each counted reason and not for
`clear` or `resume`, resume from another directory, no export or automatic execution,
mount and directory-transition retries, same-thread recovery with pending producer
records, cancellation, running agents, terminal/Desktop orchestration, the Desktop
hand-off (the offer, the in-place join and unrecorded opening turn in the new session, an
edited opening line, a link the plugin cannot open, expiry and the offering tab exiting),
and hosts without an interactive surface or required built-in commands. The fixture's `thread mount`,
`thread unmount` and `worktrees` event follow `docs/thread-mounts.md`; they are not a
real Delta daemon, and these are host fixtures, not real Desktop workflow verification. `python3 scripts/check-session-transition.py` probes installed Claude's
idle `/clear` and `/cd` behavior without a model request. Against a matching native
CLI and an already shared thread, `python3 scripts/check-join.py SHARED_LINK`
exercises the production plugin in a real terminal with isolated Claude config.
It retains its evidence; the probe's `/exit` releases the mounts. Neither check makes
model requests.

**Supported surfaces.** The plugin targets the terminal TUI and Claude Code in the
desktop app. Print mode (`claude -p`) and SDK sessions are not supported yet: they
refuse the rows that carry remote activity ("this session keeps no conversation"),
and the plugin says so once instead of falling back. Every API the plugin relies on is declared for both surfaces: the
`AbovePrompt` and `CommandOutput` render sites and the `Box`, `Text` and
`Markdown` elements are
raised on every surface, and `ui.log`, `ui.status`, `command.run`,
`session.append` and
`/delta` commands carry no surface restriction. Drawing a message as a command output
row needs the host to redraw after the plugin asks; a host that does not falls back
to the dim notice. The status band is raised on both surfaces in an interactive
session; a host that never redraws it leaves only the transcript rows.

The desktop app cannot be automated here. Check these by hand in its Code tab, in a
checkout with a real upstream remote, with a second Delta client on the same thread:

1. `/delta share` adds no transcript row; the status band
   above the prompt immediately walks through preparing, exporting,
   attaching, publishing and uploading (counted 1/5 to 5/5), then shows "Shared", and the
   link becomes clickable; press Enter with the band focused (ctrl+x tab) or click "copy link"
   and paste it;
   repeat `/delta share` to recover it without importing history again.
   In a separate Code tab, worktree or not, `/delta join <link>` reports in the band at
   once, mounts the thread, leaves the tab as it is and opens Desktop's new-session
   screen on the thread folder with "Join this Delta thread." filled in. Trust the folder
   if Desktop asks, then press Enter: the new session joins in place, its cwd and project
   root are the thread folder, and it answers "Joined.", which the other client never
   sees; the offering tab's band reads "Opened the thread in a new session". Repeat
   `/delta join <link>` in the new session: the session, mounts and producer sequence stay
   unchanged while the band reports the rejoin. Offer again and send nothing for five
   minutes: the tab says the checkouts were released and how to bring the thread back.
   Exit the joined session and resume it: the band shows the worktrees being restored
   in the thread folder.
2. With Claude idle, send a message from the other client: no Claude turn starts, and
   the transcript draws its author in bold over the message's markdown, under the echo
   of the command that drew it (`/delta show <item-id>`).
   Then ask Claude what was said: it answers from its own row for the message. A
   "Couldn't add Delta activity to Claude's context" row instead means the desktop
   host refuses rows as print mode does, and a dim `Ada:` block means the host never
   redrew, so the plugin fell back to the notice.
3. Stream a remote agent reply with thinking: the band shows the remote person's agent
   with a spinner in their color and a running time; completed thinking is a dim notice, one entry per
   paragraph, labelled, and
   Claude cannot quote it. Each completed remote tool call is one drawn line.
4. Join and leave from the other client, and run a remote turn that edits files: the
   band lists the new arrival once it settles, highlights the name, and shows that
   person's agent working; the leaver's name dims, then goes. Nothing about presence
   or the turn reaches the transcript. Narrow the terminal: the copy label shortens, the URL
   moves to its own row below, then names become initials and go.
5. Prompt Claude while the remote agent runs: the prompt is accepted and the band
   drops the remote agent, back to who is here. Send from the other client while Claude runs:
   Claude's turn stops with a transcript notice.
6. Edit and then delete a remote message: Claude, asked, knows the new text and that
   the message was removed.
7. Resume the session: no remote content is added again; a forced delivery failure
   (stop the Delta app) shows in the status band.
8. Attach a worktree to the joined thread from the other client: the band says it was
   added and Claude, asked, knows its path; from a single worktree's checkout the
   session moves to the thread folder between turns. Quit Claude and check the
   checkouts are deleted once uploaded.

A manual check with Claude Code 2.1.290 confirmed that `session.append` of a user
row while idle starts no turn, that the model reads it with the next prompt, and
that the transcript does not draw it. A manual probe with 2.1.291 confirmed that a
plugin's own `$.command.run` draws the echo and the output row, starts no turn, and
reaches the plugin's `command.run` hook only from inside a hook — a call from the
plugin's background code is refused as re-entry and no hook answers it — and that a
`CommandOutput` hook may draw the row's own tree with `Markdown` working there. It also
confirmed through `$.session.messages({ as: 'api' })` that a run's stored rows are what
the model reads, that an echo row rewritten to empty and an output row rewritten without
the `local-command-stdout` wrapper reach the model unchanged, but that the engine stops
drawing the output row altogether once its wrapper is gone: only the wrapper, around at
least one character, keeps the row drawn, and `CommandOutput` still reports the run's own
`args` after a resume. The engine's `<local-command-caveat>` above a run's rows names no
command and survives every rewrite.
Print mode (`claude -p`) refuses the append ("this session keeps no conversation to
append to"). Whether the desktop app's host accepts it is check 2 above.

`scripts/check-handoff.py` optionally makes three real Haiku requests through the
production hooks in interactive Claude sessions, with a disposable CLI fixture and a
seeded session binding. It requires `ANTHROPIC_API_KEY` in the environment, never in
a file. It checks that remote facts reach the model, that a restarted session adds
no rows again, that an edit adds a correction, that rows are not recorded back to
Delta, acknowledged-file collection, and idle-watcher shutdown. It retains a named
Claude test session. This fixture is not a real native Delta workflow; the
common-owner path and competing-client execution still require native end-to-end
verification.

A probe against Claude Code 2.1.291 in a terminal found that a command started
with `$.process.run` or `$.process.spawn` has the `claude` process as its parent, that
the plugin API has no process ID, that `/cd` from a clock timer at session start works
before the first prompt and leaves cwd and project root equal even outside a Git
checkout, and that Claude kills a request still running when it exits. A real terminal
session with the production plugin and a stub of the `thread` commands covered a
two-worktree thread folder of links: join, exit unmounting, and resume from another
directory mounting and moving Claude again.

The adapter captures only the main conversation and current checkout. Claude's
mod API lacks a reliable inventory of `--add-dir` roots; additional roots are not
attached. Historical provenance, inbound images, and typing presence remain open;
the plugin store is bounded by the retention described above. The status band's
rendering above the prompt was confirmed in Claude Code
2.1.292 with a plugin that draws there. Mods are enabled
by default in 2.1.287, subject to organization policy, and their API can change.

## License

Copyright (C) 2026 Zed Industries.

This project is licensed under the GNU Affero General Public License, version 3
only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full license text.
