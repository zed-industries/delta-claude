# Child agent hook contract on Claude Code 2.1.300

What the installed engine does when a turn spawns a subagent, measured with a
real interactive `claude` behind a Seatbelt boundary. The probe is
`scripts/check-child-hooks.py`.

**Environment.** macOS 27.0.1; Claude Code **2.1.300** (`claude --version`,
written to `<evidence>/version.txt` before phase 1). Launched as
`/usr/bin/sandbox-exec -p <profile> <resolved claude>` with the profile passed in
memory for every launch (the `<evidence>/containment.sb` copy is a record, never
authority) and an environment built from scratch: PATH limited to the executable
dir plus `/usr/bin:/bin`; synthetic `HOME`/`TMPDIR`/`CLAUDE_CONFIG_DIR`; fixed
`TERM`/`LANG`; no inherited key, token, proxy, provider or git setting; updater,
nonessential traffic, telemetry and error reporting off as hygiene. This bounds
network egress for trusted scripted diagnostic code; it is not a filesystem or
malicious-code sandbox, and not full same-user isolation.

## Containment (all Unix network denied)

```
(version 1)
(allow default)
(deny network*)
(deny process-exec (literal "/usr/bin/security"))
(deny process-exec (literal "/usr/bin/open"))
(deny process-exec (literal "/usr/bin/osascript"))
```

`--run` refuses programmatically unless a same-launcher preflight passes. It
checks macOS/`sandbox-exec`, no managed-policy path (including
`/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`, where the
user comes from `pwd.getpwuid(os.getuid())`), then runs the same environment
twice: an **unsandboxed control** (no profile applied, same environment) that
binds a socket it owns at `<evidence>/control.sock` and connects to it, and
refuses a closed loopback port; and the **sandboxed checks** with the profile:
`unix.connect` to that control socket EPERM, `unix.bind` EPERM,
`tcp.testnet`/`tcp.loopback`/`tcp.ipv6`/`udp.loopback` EPERM, `dns` failed, and
`exec.security`/`exec.open`/`exec.osascript` EPERM. Real `/private/tmp/cc-socks`
inboxes are never touched. This preflight is the boundary evidence; zero counters
are not.

The clean env sets `CLAUDE_CODE_HARBOR_KITE=0`, a 2.1.300 internal gate that
disables cross-session inbox/ListAgents. Each phase asserts its debug log holds
`[uds-messaging] Skipped: cross-session messaging gate off` and holds no
`[uds-messaging] Listening`, `Failed to start` or `Server error`. In the tested
build this gate avoids listener startup; `deny network*` remains the boundary.
Without the gate the listener failed (`Failed to listen at
/tmp/cc-socks/<pid>.sock`) while the child still ran. The gate is not a supported
cross-version API, and own-agent `SendMessage` stays in process.

Process-group cleanup reaps the launched child and requires its group gone before
another phase runs; it does **not** cover a descendant that deliberately calls
`setsid`. That is a limitation of this trusted-diagnostic harness, not a claim of
isolation.

## Evidence

Runs: `shared`, `foreground`, `worktree`, `nested`, `message-child`, `restart`
(and a re-run `restart2`) under `/tmp/child-hooks-evidence-contained2/`. Each
holds `containment.sb`, `preflight.json`, `preflight.py`, `version.txt`,
`events-<phase>.jsonl`, `screen-<phase>.txt`, `debug-<phase>.log`, `<name>.out`.

**Evidence is local and machine-identifying**: raw debug logs contain home/UID
paths. The script does not sanitize; `config/` and `home/` were removed by hand
for these runs only. Only a normalized, checked-in fixture should be called
sanitized.

## 1. Which child events the observer hears (engine-originated runs) **[obs]**

For an engine-originated spawn, a production-shaped observer (generic
`tool.call` calling `next(e)`, `turn.start`, `turn.step`, `turn.complete`,
`session.append`, plus `agent.list`/`session.messages`) hears the child's
`turn.start` (`text` = task prompt), `turn.step`, `turn.complete`
(`answer`/`reason`), `session.append` (coordinator prompt row; responses; tool
results) and child `tool.call`, each with `agentId`; `agent.spawn` and
`agent.spawn.done` too. The own-call wake caveats in §4 are outside this scope.

## 2. No wrapper suppresses engine-originated child events **[obs]**; reason **[inferred]**

The scenarios all heard the child's full lifecycle, including the foreground case
where the child loop runs inside the awaited `tool.call`. Re-entry is the likely
mechanism (running the Agent tool is the engine's work, not the hook's own `$`
call), but the implementation was not inspected, so it is **[inferred]**.

## 3. Ordering **[obs]** — not guaranteed

```
tool.call("Agent") -> agent.spawn -> child turn.start -> agent.spawn.done { agentId }
  background: tool.call.done { async_launched, agentId } -> main turn.step 1
              -> main turn.complete -> child turn.step/.../turn.complete
              -> task-notification starts a NEW main turn
  foreground: child turn.start -> child turn.step/.../turn.complete
              -> tool.call.done { completed, agentId } -> main turn.step 1
              -> main turn.complete
```

Under this socket-free profile the child's `turn.start` (seq 16) precedes
`agent.spawn.done` (17) and the Agent result (18); an earlier socket-permitted
run had them before the child's first row. **The relative order of spawn
resolution and the child's first row is not guaranteed**; only that
`agent.spawn.done` names the child. Background the Agent result is
`async_launched`; in foreground it is `completed` and arrives after the child's
`turn.complete` (39 vs 38), with every child step before it.

## 4. Inventory, history, nesting, wakes, restart **[obs]**

- `$.agent.list()`: `running` at the child's `turn.start`; after the completion
  handler it is `completed` (background), can still read `running` (worktree), or
  be absent (foreground). Drop window unmeasured.
- `$.session.messages({agentId})`: readable during and after a run; at the first
  `turn.start` it already held the task prompt, so it is not reliably empty.
- **Nested**: grandchild `agent.spawn` `parentAgentId` and `agent.list` parentId
  both equal the child id. The nested trace also shows the engine resuming the
  child from a `task-notification` (an `agent.spawn` with an empty `toolUseId`
  and `resumeAgentId` set) — an engine-originated resume, distinct from a plugin
  wake.
- **Detached wake** (`--message-child`, sent from a `$.clock.after` callback):
  delivered, and the engine skipped all four of the plugin's hooks for the woken
  run (`tool.call`, `agent.spawn`, `turn.start`, `turn.step` all
  `skipped: re-entry ... origin child-hooks-probe`). Only its `turn.complete`
  arrived, with `reason:"error"` and empty answer, because that unscripted run
  attempted a model request. A plugin cannot script a run it wakes this way.
- **Awaited wake** (`--restart` phase 2, `$.session.send` awaited in the main
  `turn.start`): the resumed session id equals phase 1; `agent.list` initially
  lists nothing for the child; `session.messages({agentId})` reads its transcript
  (count 4); the send is delivered and surfaces as a **main `SendMessage`
  tool.call**; `agent.spawn` carries `resumeAgentId` = the old child id and
  `agent.spawn.done` reports that same id; the resumed child `turn.step` is
  observed and scripted to `RESUMED_OK`, its `turn.complete` is
  `reason:"answer" answer:"RESUMED_OK"`; history grows 4 → 6 and the post-wake
  inventory lists the child `completed`. Only the nested `turn.start` is skipped
  (`turn.start skipped: re-entry`), and no model dispatch occurs.

So a plugin's own wake is not uniformly unobservable; it depends on the call
context (detached own-call vs awaited in a main hook).

## 5. Effective cwd **[obs]**

- Shared: child `turn.start` cwd is the project dir.
- Worktree-isolated: cwd is `<project>/.claude/worktrees/agent-<id>`, a real git
  worktree (`.git` present). The `worktree.live` sample is taken at `turn.start`;
  it is a time-specific snapshot, with no retention conclusion.
- A timer scheduled in the child's hook samples the **main session's** dir both
  while the child is held alive in its loop and after it exits.
- The cwd claim rests on the child's own `$.session.cwd()` (recorded in
  `turn.start.meta` and `worktree.live`) plus the worktree marker.

## Dispatch attempts **[obs]**

Phase 1 of every scenario except the detached wake logged one auxiliary
`[API:timing] dispatching to firstParty model=claude-haiku-5-5` attempt; the
restarted phase 2 logged none. Ordinary scenarios logged no dispatch of the
loop's own model; only `--message-child` logged a loop-model
(`model=claude-opus-5-5`) attempt, from the unscripted detached wake. These
observed attempts **failed at auth resolution** (`Could not resolve
authentication method`) because the clean env supplies no credentials — they did
not reach networking. Kernel preflight independently establishes socket-egress
denial; the logs do not demonstrate the sandbox blocking an actual network send.
The loop-model-dispatch verdict is derived from the models actually seen in
`turn.step.model`/`agent.spawn.done.model`, and auxiliary attempts are reported
separately; the `answered turn.step without next()` line is diagnostic only.

## Recommended capture strategy

- **Buffer early rows by `e.agentId` before a parent association exists**, then
  link on the spawn result and the Agent tool result, and reconcile with the
  supported APIs and persisted identities. A history read alone cannot invent a
  missing parent link: retain unresolved rows and report the inability rather
  than dropping or guessing.
- **Discover on `agent.spawn`**: it carries `parentAgentId` and a `resumeAgentId`
  for resumed/woken runs. Do not assume its resolution precedes the child's first
  row; the order varied.
- **A child may run multiple turns**, including an engine notification resume
  (nested trace: empty `toolUseId`, `resumeAgentId` set). Treat each run as a turn
  of the same child.
- **Record content from live rows** (`session.append`, `tool.call`); engine-
  originated runs were never suppressed.
- **Reconcile identity** with `session.messages({agentId})` after completion and
  after a restart; do not rely on `agent.list` for a dropped/terminal child.
- **cwd** from the child's own `turn.start`; not a deferred timer.
- **Keep three wake contexts distinct**: engine-originated spawns (fully
  observed), a wake awaited inside a main hook (`--restart`: child steps observed
  and scripted, only nested `turn.start` skipped), and a detached own-call wake
  (`--message-child`: all four hooks skipped, terminal `error`). There is no
  universal guarantee that a resumed `agent.spawn` reaches the observer.
- Debug logs are diagnostic only; no production logic should depend on them.

## Limitations

- Not exercised: teammates, forks, workflow agents, `isolation:"remote"`,
  concurrent siblings, the `agent.list` drop window, and the `background:false`
  rewrite on a model's Agent call.
- `CLAUDE_CODE_HARBOR_KITE=0` is a 2.1.300 internal gate; another version may
  listen differently, which would need a decision before any socket exception.
- A process/group surviving cleanup fails the run; a descendant that deliberately
  calls `setsid` is not covered.

## Probe shape

One scenario per run; six distinct scenarios; no cross-product. `--run` gated by
preflight. One ordered journal per phase, stamped before its cwd/id metadata;
common per-phase checks (strict journal, no `EVIDENCE_FAILED.txt`, gate off, the
loop-model dispatch verdict) plus scenario checks drive the wait loop, and are
re-evaluated after the child is reaped and its group is gone, so the strict final
validation is real. A resumed phase answers child steps `RESUMED_OK`, main steps
`MAIN_OK`.
