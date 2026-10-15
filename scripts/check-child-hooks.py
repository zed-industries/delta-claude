#!/usr/bin/env python3
"""Probe Claude Code's real child-agent hook contract behind a Seatbelt boundary.

Drives a real interactive `claude` whose plugin answers the model steps it is
asked, so the engine really spawns and runs a subagent. This is network
containment for trusted diagnostic code, not a filesystem or malicious-code
sandbox, and it is not a claim that every credential-read path is closed.

`--run` refuses programmatically unless a same-launcher preflight verifies the
boundary. The profile is passed in memory with `sandbox-exec -p` for every
launch (the saved copy in the evidence directory is a record, never authority),
with an environment built from scratch. All Unix network access is denied: live
`/private/tmp/cc-socks` inboxes are never touched.

Scenarios (exactly one per run; `--run` required):

  (default)             shared cwd, background child, production-shape observer
  --disable-background  the child runs in the foreground, inside `tool.call`
  --isolation worktree  the child uses `isolation: "worktree"`
  --message-child       a detached clock callback messages the child
  --nested              the child spawns a grandchild
  --restart             phase 1, then resume the same session in a new process

Without `--run` the script only prepares and prints the plan. `--evidence` must
be absent or empty; evidence is always kept. Evidence contains local,
machine-identifying paths (home/UID) and raw engine logs; only a normalized,
checked-in fixture would be safe to call sanitized.
"""

import argparse
import json
import os
from pathlib import Path
import pty
import pwd
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

CONTAINMENT_PROFILE = '''(version 1)
(allow default)
(deny network*)
(deny process-exec (literal "/usr/bin/security"))
(deny process-exec (literal "/usr/bin/open"))
(deny process-exec (literal "/usr/bin/osascript"))
'''


def managed_policy_paths():
    user = pwd.getpwuid(os.getuid()).pw_name
    return [
        "/Library/Application Support/ClaudeCode/managed-settings.json",
        "/Library/Application Support/ClaudeCode/managed-settings.d",
        "/Library/Managed Preferences/com.anthropic.claudecode.plist",
        f"/Library/Managed Preferences/{user}/com.anthropic.claudecode.plist",
    ]


# Runs under the same sandbox and clean env to prove the boundary. `control`
# runs unsandboxed to separate a sandbox denial from a host filter.
PREFLIGHT = r'''
import json, os, socket, subprocess, sys

results = []
def check(name, ok, detail): results.append({"check": name, "ok": bool(ok), "detail": detail})

def expect_denied(name, action):
    try:
        action(); check(name, False, "allowed")
    except PermissionError as error:
        check(name, True, "EPERM: " + repr(error))
    except OSError as error:
        check(name, False, "not EPERM: " + repr(error))

if sys.argv[1] == 'control':
    path = os.environ['CONTROL_SOCKET']
    server = socket.socket(socket.AF_UNIX); server.bind(path); server.listen(1)
    client = socket.socket(socket.AF_UNIX); client.connect(path)
    client.sendall(b"x"); conn, _ = server.accept(); conn.recv(1)
    check("control.unix", True, "own control socket connected")
    try:
        socket.create_connection(("127.0.0.1", 9), timeout=2)
        check("control.tcp", False, "a closed loopback port connected")
    except ConnectionRefusedError:
        check("control.tcp", True, "closed loopback port refused")
    except OSError as error:
        check("control.tcp", False, "inconclusive: " + repr(error))
else:
    control = os.environ['CONTROL_SOCKET']
    expect_denied("unix.connect", lambda: socket.socket(socket.AF_UNIX).connect(control))
    def bind():
        sock = socket.socket(socket.AF_UNIX); sock.bind(os.environ['SANDBOX_SOCKET'])
    expect_denied("unix.bind", bind)
    expect_denied("tcp.testnet", lambda: socket.create_connection(("192.0.2.1", 9), timeout=3))
    expect_denied("tcp.loopback", lambda: socket.create_connection(("127.0.0.1", 9), timeout=3))
    def ipv6():
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM); sock.settimeout(3); sock.connect(("::1", 9))
    expect_denied("tcp.ipv6", ipv6)
    expect_denied("udp.loopback", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("127.0.0.1", 9)))
    try:
        socket.getaddrinfo("example.com", 80); check("dns", False, "resolved")
    except OSError as error:
        check("dns", True, "failed: " + repr(error))
    for tool in ("security", "open", "osascript"):
        expect_denied("exec." + tool, lambda tool=tool: subprocess.run(["/usr/bin/" + tool, "-h"], timeout=5, capture_output=True))
print(json.dumps(results))
'''

SANDBOX_CHECKS = ["unix.connect", "unix.bind", "tcp.testnet", "tcp.loopback", "tcp.ipv6",
    "udp.loopback", "dns", "exec.security", "exec.open", "exec.osascript"]

# The probe hooks. Helpers that take `$` are module-level declarations: the
# hooks compiler only lets `$` be passed to a function declared at the top of
# the module (or imported). Each phase writes its own journal file.
HOOKS = r"""
const ANSWER_CHILD = 'CHILD_OK'
const ANSWER_GRAND = 'GRAND_OK'
const ANSWER_MAIN = 'MAIN_OK'
const ANSWER_RESUMED = 'RESUMED_OK'

const NESTED = __NESTED__
const MESSAGE_CHILD = __MESSAGE_CHILD__
const RESUMED = __RESUMED__
const PHASE = '__PHASE__'

const journal = []
let sequence = 0
let writeChain = Promise.resolve()

const flags = { spawned: false, messaged: false, grandSpawned: false, woken: false }
const agentOrder = []

function isWorktree(path) { return path.indexOf('/.claude/worktrees/') !== -1 }

function head(message, limit) {
  if (!message || !Array.isArray(message.content)) return null
  for (const block of message.content)
    if (block && block.type === 'text' && typeof block.text === 'string')
      return block.text.slice(0, limit)
  return null
}

// Stamp the entry synchronously so its order is when it was observed, then
// serialize the write. A failure leaves a marker the harness rejects.
function stamp($, name, data) {
  sequence += 1
  journal.push(Object.assign({ phase: PHASE, seq: sequence, t: Date.now(), name: name }, data))
  const text = journal.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  writeChain = writeChain.then(async () => {
    try {
      await $.fs.write((await $.env.get('PROBE_ROOT')) + '/events-' + PHASE + '.jsonl', text)
    } catch (error) {
      try { await $.fs.write((await $.env.get('PROBE_ROOT')) + '/EVIDENCE_FAILED.txt', String(error)) }
      catch (ignored) {}
    }
  })
}

async function agents($) {
  return (await $.agent.list()).map((agent) => ({
    id: agent.id, parentId: agent.parentId ?? null, status: agent.status,
    type: agent.type, description: agent.description,
  }))
}

async function history($, agentId) {
  const read = await $.session.messages({ agentId: agentId, as: 'api' })
  if ('deny' in read) return { deny: read.deny }
  return {
    count: read.length,
    roles: read.map((message) => message.role),
    agentToolUseIds: read.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block && block.type === 'tool_use' && block.name === 'Agent')
          .map((block) => block.id) : []),
  }
}

async function sampleInventory($, agentId, turnId, when) {
  try { stamp($, 'inventory', { agentId: agentId, turnId: turnId, when: when, agents: await agents($) }) }
  catch (error) { stamp($, 'inventory.error', { agentId: agentId, when: when, error: String(error) }) }
}

async function sampleHistory($, agentId, turnId, when) {
  try { stamp($, 'history', { agentId: agentId, turnId: turnId, when: when, read: await history($, agentId) }) }
  catch (error) { stamp($, 'history.error', { agentId: agentId, when: when, error: String(error) }) }
}

// Phase 2: read the child from the previous process before and after waking it.
async function wakeChild($) {
  const child = await $.env.get('PROBE_CHILD_ID')
  if (!child) { stamp($, 'wake.missing', {}); return }
  await sampleInventory($, child, null, 'before-wake')
  await sampleHistory($, child, null, 'before-wake')
  try {
    const sent = await $.session.send({ to: { agentId: child }, text: 'Say RESUMED_OK' })
    stamp($, 'wake.send', { agentId: child, result: JSON.stringify(sent).slice(0, 200) })
  } catch (error) { stamp($, 'wake.send.error', { agentId: child, error: String(error) }) }
}

async function isolate($) {
  const value = await $.env.get('PROBE_ISOLATION')
  return value || 'shared'
}

function depthOf(agentId) {
  if (agentOrder.indexOf(agentId) === -1) agentOrder.push(agentId)
  return agentOrder.indexOf(agentId)
}

function response(e, answer, toolUses, stopReason) {
  return { turnId: e.turnId, index: e.index, answer: answer,
    toolUses: toolUses || [], stopReason: stopReason || 'end_turn', usage: null }
}

export function register(on) {
  on('turn.step', async function* ($, e, next) {
    stamp($, 'turn.step', { agentId: e.agentId ?? null, turnId: e.turnId, index: e.index,
      messageCount: e.messageCount, model: e.model })
    if (RESUMED) {
      const answer = e.agentId === undefined ? ANSWER_MAIN : ANSWER_RESUMED
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return response(e, answer, [], 'end_turn')
    }
    if (e.agentId === undefined && e.index === 0 && !flags.spawned) {
      flags.spawned = true
      const input = { description: 'Child work', prompt: 'Say CHILD_OK', subagent_type: 'general-purpose' }
      if (await isolate($) === 'worktree') input.isolation = 'worktree'
      yield { kind: 'tool', index: 0, id: 'toolu_agent', name: 'Agent' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return response(e, '', [{ name: 'Agent', input: input }], 'tool_use')
    }
    if (e.agentId !== undefined) {
      const depth = depthOf(e.agentId)
      if (NESTED && depth === 0 && e.index === 0 && !flags.grandSpawned) {
        flags.grandSpawned = true
        const input = { description: 'Grandchild work', prompt: 'Say GRAND_OK', subagent_type: 'general-purpose' }
        yield { kind: 'tool', index: 0, id: 'toolu_grand', name: 'Agent' }
        yield { kind: 'input', index: 0, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return response(e, '', [{ name: 'Agent', input: input }], 'tool_use')
      }
      if (depth === 0 && e.index === 0) {
        const read = { file_path: 'readme.txt' }
        yield { kind: 'tool', index: 0, id: 'toolu_read', name: 'Read' }
        yield { kind: 'input', index: 0, json: JSON.stringify(read) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return response(e, '', [{ name: 'Read', input: read }], 'tool_use')
      }
      const answer = depth >= 1 ? ANSWER_GRAND : ANSWER_CHILD
      if (depth === 0) { try { await $.clock.sleep(500) } catch (error) {} }
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return response(e, answer, [], 'end_turn')
    }
    yield { kind: 'text', index: 0, text: ANSWER_MAIN }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return response(e, ANSWER_MAIN, [], 'end_turn')
  })

  on('turn.start', async ($, e, next) => {
    stamp($, 'turn.start', { agentId: e.agentId ?? null, turnId: e.turnId, text: e.text })
    const cwd = await $.session.cwd()
    stamp($, 'turn.start.meta', { agentId: e.agentId ?? null, turnId: e.turnId, cwd: cwd,
      session: await $.session.id() })
    if (RESUMED && e.agentId === undefined && !flags.woken) { flags.woken = true; await wakeChild($) }
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      try {
        stamp($, 'worktree.live', { agentId: agentId, cwd: cwd, isWorktree: isWorktree(cwd),
          gitFile: await $.fs.exists(cwd + '/.git') })
      } catch (error) {}
      $.clock.after(120, async () => {
        try { stamp($, 'child.timer.while-live', { agentId: agentId, cwd: await $.session.cwd() }) }
        catch (error) {}
      })
      $.clock.after(2000, async () => {
        try { stamp($, 'child.timer.after-exit', { agentId: agentId, cwd: await $.session.cwd() }) }
        catch (error) {}
      })
      await sampleInventory($, agentId, e.turnId, 'during')
      await sampleHistory($, agentId, e.turnId, 'during')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    stamp($, 'turn.complete', { agentId: e.agentId ?? null, turnId: e.turnId, reason: e.reason,
      isAborted: e.isAborted, answer: e.answer, durationMs: e.durationMs })
    const result = await next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const turnId = e.turnId
      $.clock.after(0, async () => {
        await sampleInventory($, agentId, turnId, 'after')
        await sampleHistory($, agentId, turnId, 'after')
        if (MESSAGE_CHILD && !flags.messaged) {
          flags.messaged = true
          try {
            const sent = await $.session.send({ to: { agentId: agentId }, text: 'Say CHILD_OK again' })
            stamp($, 'detached.send', { agentId: agentId, result: JSON.stringify(sent).slice(0, 200) })
          } catch (error) { stamp($, 'detached.send.error', { agentId: agentId, error: String(error) }) }
        }
      })
    }
    return result
  })

  on('session.append', async ($, e, next) => {
    stamp($, 'session.append', { agentId: e.agentId ?? null, door: e.door,
      role: e.message && e.message.role, uuid: e.uuid, origin: e.origin && e.origin.kind,
      text: head(e.message, 60) })
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    stamp($, 'session.start', { session: await $.session.id(), cwd: await $.session.cwd() })
    return next(e)
  })

  // __TOOLCALL__
  // __SPAWN__
}
"""

TOOLCALL_HOOKS = r"""
  on('tool.call', async ($, e, next) => {
    stamp($, 'tool.call', { agentId: e.agentId ?? null, tool: e.tool, toolUseId: e.tool_use_id ?? null })
    const result = await next(e)
    stamp($, 'tool.call.done', { agentId: e.agentId ?? null, tool: e.tool,
      toolUseId: e.tool_use_id ?? null, isError: result && result.isError,
      status: result && result.result && result.result.status,
      resultAgentId: result && result.result && result.result.agentId })
    return result
  })
"""

SPAWN_HOOKS = r"""
  on('agent.spawn', async ($, e, next) => {
    stamp($, 'agent.spawn', { toolUseId: e.tool_use_id, parentAgentId: e.parentAgentId ?? null,
      background: e.background, fork: e.fork, resumeAgentId: e.resume && e.resume.agentId })
    const result = await next(e)
    stamp($, 'agent.spawn.done', { model: result && result.model, agentId: result && result.agentId,
      deny: result && result.deny })
    return result
  })
"""

REGISTERED = ["turn.start", "turn.step", "turn.complete", "session.append", "session.start",
    "tool.call", "agent.spawn"]


def write_plugin(root, args, phase="1", resumed=False):
    source = HOOKS.replace("__NESTED__", "true" if args.nested else "false")
    source = source.replace("__MESSAGE_CHILD__", "true" if args.message_child else "false")
    source = source.replace("__RESUMED__", "true" if resumed else "false")
    source = source.replace("__PHASE__", phase)
    source = source.replace("  // __TOOLCALL__", TOOLCALL_HOOKS)
    source = source.replace("  // __SPAWN__", SPAWN_HOOKS)
    (root / "plugin" / "hooks" / "register.ts").write_text(source)


def resolve_claude():
    found = shutil.which("claude")
    if not found:
        raise SystemExit("claude is not on PATH")
    return os.path.realpath(found)


def clean_env(root, args, extra=None):
    """Built from scratch: no inherited key, token, proxy, provider or git setting."""
    env = {
        "PATH": os.path.dirname(resolve_claude()) + ":/usr/bin:/bin",
        "HOME": str(root / "home"),
        "TMPDIR": str(root / "home" / "tmp"),
        "CLAUDE_CONFIG_DIR": str(root / "config"),
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "PROBE_ROOT": str(root),
        "PROBE_ISOLATION": args.isolation,
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1",
        # 2.1.300 internal gate: disable cross-session inbox/ListAgents so the
        # engine skips its shared-socket listener entirely. Not a supported
        # cross-version API; own-agent SendMessage stays in process.
        "CLAUDE_CODE_HARBOR_KITE": "0",
    }
    if args.disable_background:
        env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] = "1"
    if extra:
        env.update(extra)
    return env


def git_env(root):
    return {"PATH": "/usr/bin:/bin", "HOME": str(root / "home"), "GIT_EDITOR": "true",
        "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}


def git(project, *arguments, env):
    subprocess.run(["git", "-C", str(project), "-c", "core.hooksPath=/dev/null",
            "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *arguments],
        check=True, timeout=30, capture_output=True, env=env)


def prepare(root, args):
    if root.exists() and any(root.iterdir()):
        raise SystemExit(f"--evidence directory is not empty: {root}")
    root.mkdir(parents=True, exist_ok=True)
    (root / "home" / "tmp").mkdir(parents=True)
    (root / "config").mkdir()
    (root / "plugin" / ".claude-plugin").mkdir(parents=True)
    (root / "plugin" / "hooks").mkdir()
    # A record only: every launch passes the profile in memory with `-p`.
    (root / "containment.sb").write_text(CONTAINMENT_PROFILE)
    project = root / "project"
    project.mkdir()
    (project / "readme.txt").write_text("PROBE-READ-ME 7923\n")
    environment = git_env(root)
    git(project, "init", "-q", env=environment)
    git(project, "add", "readme.txt", env=environment)
    git(project, "-c", "user.email=probe@example.com", "-c", "user.name=probe",
        "commit", "-q", "--no-verify", "-m", "probe", env=environment)
    (root / "config" / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True,
        "bypassPermissionsModeAccepted": True,
        "theme": "dark",
        "projects": {str(project.resolve()): {"hasTrustDialogAccepted": True}},
    }))
    (root / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({
        "name": "child-hooks-probe", "version": "0.0.1",
        "description": "Child hook contract probe", "author": {"name": "delta"}}))
    (root / "plugin" / "hooks" / "hooks.json").write_text('{"modules":["./register.ts"]}')
    write_plugin(root, args)
    return project


def sandboxed(arguments, env, timeout):
    return subprocess.run(["/usr/bin/sandbox-exec", "-p", CONTAINMENT_PROFILE, *arguments],
        env=env, timeout=timeout, capture_output=True, text=True)


def preflight(root):
    """Refuse to run unless the same-launcher boundary verifies."""
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise SystemExit("macOS sandboxing is unavailable; refusing to run")
    present = [path for path in managed_policy_paths() if Path(path).exists()]
    if present:
        raise SystemExit("managed Claude policy present, refusing to run: " + ", ".join(present))
    helper = root / "preflight.py"
    helper.write_text(PREFLIGHT)
    env = clean_env(root, argparse.Namespace(isolation="shared", disable_background=False),
        {"CONTROL_SOCKET": str(root / "control.sock"), "SANDBOX_SOCKET": str(root / "sandbox.sock")})

    def run(argv):
        done = subprocess.run(argv, env=env, timeout=120, capture_output=True, text=True)
        if done.returncode != 0:
            raise SystemExit(f"preflight failed to run: {done.stderr[-400:]}")
        return {item["check"]: item for item in json.loads(done.stdout)}

    control = run(["/usr/bin/python3", str(helper), "control"])
    sandbox = run(["/usr/bin/sandbox-exec", "-p", CONTAINMENT_PROFILE,
        "/usr/bin/python3", str(helper), "sandbox"])
    (root / "preflight.json").write_text(json.dumps({"control": control, "sandbox": sandbox}, indent=2))
    for name in ("control.unix", "control.tcp"):
        if not control.get(name, {}).get("ok"):
            raise SystemExit(f"inconclusive control {name}: {control.get(name)}")
    for name in SANDBOX_CHECKS:
        if not sandbox.get(name, {}).get("ok"):
            raise SystemExit(f"unexpected allow or inconclusive {name}: {sandbox.get(name)}")
    print("preflight passed (network denied, no Unix IPC allowed)", flush=True)


def read_journal(root, phase):
    path = root / f"events-{phase}.jsonl"
    if not path.exists():
        return []
    entries = []
    for line in path.read_text().splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return entries


def journal_is_strict(root, phase):
    path = root / f"events-{phase}.jsonl"
    if not path.exists():
        return False
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                json.loads(line)
            except json.JSONDecodeError:
                return False
    return True


def read_debug(root, phase):
    path = root / f"debug-{phase}.log"
    return path.read_text(errors="replace") if path.exists() else ""


def dispatched_models(log):
    return re.findall(r"dispatching to firstParty model=([A-Za-z0-9.\-]+)", log)


def observed_models(journal):
    """The models the scripted loop actually ran on, from its own events."""
    models = {e.get("model") for e in journal if e["name"] in ("turn.step", "agent.spawn.done")
        and e.get("model")}
    return models


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def evaluate(checks):
    results = []
    for name, check in checks:
        try:
            check(); results.append((name, True, ""))
        except Exception as error:  # a missing field during polling is a failure
            results.append((name, False, str(error)))
    return results


def common_checks(root, phase, log):
    """Checks every phase needs: a clean journal, gate off, and its model dispatch verdict."""
    return [
        (f"phase {phase}: journal is strict JSON", lambda: require(journal_is_strict(root, phase),
            "unparsable journal line")),
        (f"phase {phase}: no evidence write failure", lambda: require(
            not (root / "EVIDENCE_FAILED.txt").exists(), "evidence writes failed")),
        (f"phase {phase}: cross-session messaging gate off", lambda: require(
            "uds-messaging] Skipped" in log and "uds-messaging] Listening" not in log
            and "uds-messaging] Failed to start" not in log and "uds-messaging] Server error" not in log,
            "the cross-session messaging gate was not skipped/absent")),
    ]


def model_dispatch_check(phase, journal, log, expect_loop_dispatch):
    """The loop model's own dispatch verdict; auxiliary attempts stay separate."""
    observed = observed_models(journal)
    loop = [model for model in dispatched_models(log) if model in observed]
    label = f"phase {phase}: loop-model dispatch {'expected' if expect_loop_dispatch else 'absent'}"

    def check():
        require(observed, "no loop model was observed in turn.step/agent.spawn.done")
        if expect_loop_dispatch:
            require(loop, "the detached wake dispatched no loop-model request")
        else:
            require(not loop, f"a loop-model request was attempted: {loop}")

    return (label, check)


def phase1_checks(root, args):
    journal = read_journal(root, "1")
    log = read_debug(root, "1")
    checks = common_checks(root, "1", log)
    checks.append(model_dispatch_check("1", journal, log, expect_loop_dispatch=args.message_child))
    starts = [e for e in journal if e["name"] == "turn.start" and e.get("agentId")]
    checks.append(("child started", lambda: require(bool(starts), "no child turn.start")))
    if not starts:
        return checks
    child = starts[0]["agentId"]
    ends = [e for e in journal if e["name"] == "turn.complete" and e.get("agentId") == child]
    child_end = next((e for e in ends if e.get("answer") == "CHILD_OK" and e.get("reason") == "answer"), None)
    steps = [e for e in journal if e["name"] == "turn.step" and e.get("agentId") == child]
    meta = next((e for e in journal if e["name"] == "turn.start.meta" and e.get("agentId") == child), None)
    spawn = [e for e in journal if e["name"] == "agent.spawn.done" and e.get("agentId") == child]

    checks += [
        ("child metadata sample present", lambda: require(meta is not None and meta.get("cwd") and meta.get("session"),
            "no turn.start.meta sample for the child")),
        ("child spawn names the child", lambda: require(bool(spawn) and spawn[0].get("agentId") == child,
            "agent.spawn.done did not name the child")),
        ("child task prompt provenance", lambda: require(any(e["name"] == "session.append" and e.get("agentId") == child
            and e.get("door") == "prompt" and e.get("origin") == "coordinator" for e in journal),
            "no coordinator prompt row for the child")),
        ("child step and response provenance", lambda: require(len(steps) >= 2 and any(
            e["name"] == "session.append" and e.get("agentId") == child and e.get("door") == "response"
            and e.get("text") == "CHILD_OK" for e in journal), "child steps/response not observed")),
        ("child own tool call", lambda: require(any(e["name"] == "tool.call" and e.get("agentId") == child
            and e.get("tool") == "Read" for e in journal), "no child tool.call")),
        ("child succeeds with CHILD_OK", lambda: require(child_end is not None,
            "child did not finish CHILD_OK")),
        ("agent result carries the child id", lambda: require(any(e["name"] == "tool.call.done"
            and e.get("tool") == "Agent" and e.get("resultAgentId") == child for e in journal),
            "the Agent result did not carry the child id")),
        ("live cwd timer fired before completion", lambda: require(
            any(e["name"] == "child.timer.while-live" and e["seq"] < child_end["seq"] for e in journal),
            "the live cwd timer fired after the child completed")),
    ]
    project = str((root / "project").resolve())
    live = next((e for e in journal if e["name"] == "worktree.live" and e.get("agentId") == child), None)

    def timers_fall_back():
        require(live is not None, "no worktree.live sample")
        for name in ("child.timer.while-live", "child.timer.after-exit"):
            entry = next((e for e in journal if e["name"] == name), None)
            require(entry and entry.get("cwd") == project, f"{name} did not fall back to the main session cwd")

    checks.append(("deferred cwd falls back to the session dir", timers_fall_back))
    if args.isolation == "worktree":
        checks.append(("isolated cwd is a real worktree", lambda: require(
            live and live["cwd"] != project and "/.claude/worktrees/" in live["cwd"]
            and live.get("gitFile") is True, "child cwd is not a git worktree")))
    else:
        checks.append(("shared cwd is the project dir", lambda: require(live and live["cwd"] == project,
            "shared child cwd is not the project dir")))

    if args.disable_background:
        agent_done = next((e for e in journal if e["name"] == "tool.call.done" and e.get("tool") == "Agent"), None)

        def foreground_inside_call():
            require(agent_done is not None and agent_done.get("status") == "completed",
                f"foreground Agent status was {agent_done and agent_done.get('status')!r}")
            require(agent_done["seq"] > child_end["seq"], "foreground result did not arrive after child completion")
            require(all(e["seq"] < agent_done["seq"] for e in steps),
                "a foreground child step ran outside the awaited Agent call")

        checks.append(("foreground steps run inside the awaited Agent call", foreground_inside_call))
    else:
        def background_result():
            agent_done = next((e for e in journal if e["name"] == "tool.call.done" and e.get("tool") == "Agent"), None)
            require(agent_done is not None and agent_done.get("status") == "async_launched",
                f"background Agent status was {agent_done and agent_done.get('status')!r}")
            require(agent_done.get("resultAgentId") == child, "the Agent result did not carry the child id")

        checks.append(("background result is async_launched", background_result))

    if args.nested:
        def nested_parent_identity():
            grand = next((e for e in starts if e["agentId"] != child), None)
            require(grand is not None, "no grandchild turn.start")
            grand_id = grand["agentId"]
            require(any(e.get("answer") == "GRAND_OK" and e["name"] == "turn.complete"
                and e.get("agentId") == grand_id for e in journal), "grandchild did not finish GRAND_OK")
            spawns = [e for e in journal if e["name"] == "agent.spawn" and e.get("toolUseId") == "toolu_grand"]
            require(spawns and spawns[0].get("parentAgentId") == child,
                "grandchild spawn parentAgentId did not match the child")
            inventory = [e for e in journal if e["name"] == "inventory" and e.get("when") == "after"]
            require(any(a["id"] == grand_id and a["parentId"] == child for e in inventory for a in e["agents"]),
                "inventory parentId did not match the spawn's parentAgentId")

        checks.append(("nested parent identity matches", nested_parent_identity))

    if args.message_child:
        def detached_wake():
            send = next((e for e in journal if e["name"] == "detached.send"), None)
            require(send and '"isDelivered":true' in send.get("result", ""), "the child message was not delivered")
            woken = [e for e in ends if e["seq"] > send["seq"]]
            require(len(woken) == 1 and woken[0].get("reason") == "error",
                f"the detached wake's completion was {woken and woken[0].get('reason')!r}, not an error")
            log = read_debug(root, "1")
            for kind in ("tool.call", "agent.spawn", "turn.start", "turn.step"):
                require(f"{kind} skipped: re-entry" in log,
                    f"the detached wake did not skip the plugin's {kind} hook")

        checks.append(("detached wake is terminal error and fully re-entrant", detached_wake))

    return checks


def phase2_checks(root, args, session, child):
    journal = read_journal(root, "2")
    log = read_debug(root, "2")
    checks = common_checks(root, "2", log)
    checks += [
        ("resumed session id is unchanged", lambda: require(any(e["name"] == "session.start"
            and e.get("session") == session for e in journal), "the resumed session id differs")),
        model_dispatch_check("2", journal, log, expect_loop_dispatch=False),
    ]

    def before_wake():
        inventory = next((e for e in journal if e["name"] == "inventory" and e.get("when") == "before-wake"), None)
        history = next((e for e in journal if e["name"] == "history" and e.get("when") == "before-wake"), None)
        send = next((e for e in journal if e["name"] == "wake.send"), None)
        require(inventory is not None and inventory["agents"] == [],
            "the child was still listed before the wake")
        require(history is not None and history["read"].get("count", 0) > 0,
            "the child history was not readable before the wake")
        require(send is not None and '"isDelivered":true' in send.get("result", ""),
            "the wake was not delivered")

    def resumed_spawn():
        spawn = next((e for e in journal if e["name"] == "agent.spawn" and e.get("resumeAgentId") == child), None)
        require(spawn is not None, "no agent.spawn resumed the old child id")
        require(any(e["name"] == "agent.spawn.done" and e.get("agentId") == child for e in journal),
            "the resumed spawn did not report the old child id")
        require(any(e["name"] == "tool.call" and e.get("tool") == "SendMessage" and not e.get("agentId")
            for e in journal), "the wake did not surface as a main SendMessage tool.call")

    def resumed_scripted():
        require(any(e["name"] == "turn.step" and e.get("agentId") == child for e in journal),
            "the resumed child's steps were not observed")
        require(any(e["name"] == "turn.complete" and e.get("agentId") == child
            and e.get("answer") == "RESUMED_OK" and e.get("reason") == "answer" for e in journal),
            "the resumed child did not finish RESUMED_OK")
        require(not any(e["name"] == "turn.start" and e.get("agentId") == child for e in journal),
            "the nested turn.start was not skipped")

    def grew_after_wake():
        before = next((e for e in journal if e["name"] == "history" and e.get("when") == "before-wake"), None)
        after = [e for e in journal if e["name"] == "history" and e.get("when") == "after"]
        require(after and after[0]["read"].get("count", 0) > before["read"].get("count", 0),
            "the child history did not grow after the wake")
        inventory = [e for e in journal if e["name"] == "inventory" and e.get("when") == "after"]
        require(any(a["id"] == child and a["status"] == "completed" for e in inventory for a in e["agents"]),
            "the post-wake inventory did not list the completed child")

    checks += [
        ("child absent from inventory before the wake", before_wake),
        ("resumed spawn reports the old child id", resumed_spawn),
        ("resumed run is scripted and its start is skipped", resumed_scripted),
        ("history and inventory grow after the wake", grew_after_wake),
    ]
    return checks


def run_phase(root, project, args, phase, prompt, checks, resume=None, child_id=None):
    env = clean_env(root, args, {"PROBE_CHILD_ID": child_id} if child_id else None)
    argv = ["/usr/bin/sandbox-exec", "-p", CONTAINMENT_PROFILE, resolve_claude(),
        "--plugin-dir", str(root / "plugin"), "--tools", "Agent,Read,SendMessage",
        "--permission-mode", "bypassPermissions",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "", "--debug-file", str(root / f"debug-{phase}.log")]
    if resume:
        argv += ["--resume", resume]
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(project)  # pty.fork already made this child a session leader
        try:
            os.execve(argv[0], argv, env)
        except OSError:
            os._exit(127)
    os.set_blocking(terminal, False)
    screen = b""
    reaped = False
    deadline = time.monotonic() + args.timeout

    def read(seconds, until=lambda: False):
        nonlocal screen
        end = min(time.monotonic() + seconds, deadline)
        while time.monotonic() < end and not until():
            if select.select([terminal], [], [], 0.1)[0]:
                try:
                    screen += os.read(terminal, 65536)
                except (BlockingIOError, OSError):
                    return

    try:
        read(20, lambda: b"bypass permissions on" in screen.lower() or b"enter to confirm" in screen.lower())
        if b"enter to confirm" in screen.lower():
            raise AssertionError("unexpected consent prompt:\n" + screen.decode(errors="replace")[-1500:])
        print(f"phase {phase}: ready", flush=True)
        os.write(terminal, prompt.encode())
        read(0.5)
        os.write(terminal, b"\r")
        announced = None
        while time.monotonic() < deadline:
            read(1)
            failures = [item for item in evaluate(checks()) if not item[1]]
            if not failures:
                break
            if failures[0][2] != announced:
                announced = failures[0][2]
                print(f"phase {phase}: waiting ({failures[0][0]}: {failures[0][2]})", flush=True)
        else:
            raise AssertionError("expected evidence never arrived: "
                + "; ".join(f"{name}: {message}" for name, ok, message in evaluate(checks()) if not ok))
        print(f"phase {phase}: assertions satisfied", flush=True)
        os.write(terminal, b"/exit\r")
        read(3)
    finally:
        try:
            (root / f"screen-{phase}.txt").write_bytes(screen)
        except OSError:
            pass
        if not reaped:
            try:
                os.killpg(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            reaped = wait_reaped(pid, 3)
            if not reaped:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                reaped = wait_reaped(pid, 5)
        os.close(terminal)
    if not reaped:
        raise AssertionError(f"phase {phase}: the child survived cleanup; refusing to continue")
    try:
        os.killpg(pid, 0)
        raise AssertionError(f"phase {phase}: the child's process group is still present")
    except ProcessLookupError:
        pass
    # Final validation after shutdown: the polling loop ran before /exit, so this
    # is what actually verifies the settled, strict evidence.
    failures = [item for item in evaluate(checks()) if not item[1]]
    if failures:
        raise AssertionError("final validation failed: "
            + "; ".join(f"{name}: {message}" for name, ok, message in failures))
    print(f"phase {phase}: final validation passed", flush=True)


def wait_reaped(pid, seconds):
    """True once `pid` is reaped (or already gone); never signals."""
    stop = time.monotonic() + seconds
    while time.monotonic() < stop:
        try:
            if os.waitpid(pid, os.WNOHANG) != (0, 0):
                return True
        except ChildProcessError:
            return True
        time.sleep(0.05)
    return False


def report(root, args, version):
    print(f"claude: {version}")
    print("scenario: " + ("restart" if args.restart else
        " | ".join(name for name, on in (("foreground", args.disable_background),
            ("worktree", args.isolation == "worktree"), ("message-child", args.message_child),
            ("nested", args.nested)) if on) or "shared background"))
    print(f"registered hooks: {', '.join(REGISTERED)}")
    for phase in ("1", "2"):
        if not (root / f"events-{phase}.jsonl").exists():
            continue
        journal = read_journal(root, phase)
        dispatched = dispatched_models(read_debug(root, phase))
        observed = sorted(observed_models(journal))
        print(f"phase {phase}: events={len(journal)} observed_models={observed} "
              f"dispatch_attempts={dispatched} auxiliary={sorted(set(dispatched) - set(observed))}")
    if args.restart:
        journal = read_journal(root, "1")
        session = next((e["session"] for e in journal if e["name"] == "session.start"), "?")
        child = next((e["agentId"] for e in journal if e["name"] == "turn.start" and e.get("agentId")), "?")
        print(f"restart: session {session} child {child} preserved")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--isolation", choices=("shared", "worktree"), default="shared")
    parser.add_argument("--message-child", action="store_true")
    parser.add_argument("--disable-background", action="store_true")
    parser.add_argument("--nested", action="store_true")
    parser.add_argument("--restart", action="store_true")
    parser.add_argument("--evidence", help="Evidence directory; must be absent or empty")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--run", action="store_true",
        help="Execute the contained session; refuses unless the preflight verifies the boundary")
    args = parser.parse_args()
    if args.restart and (args.nested or args.message_child or args.disable_background or args.isolation != "shared"):
        raise SystemExit("--restart runs on its own scenario")

    root = Path(args.evidence or tempfile.mkdtemp(prefix="claude-child-hooks-")).resolve()
    project = prepare(root, args)
    print(f"Child hook evidence: {root}")
    if not args.run:
        print("prepared only; pass --run to execute behind the verified boundary")
        return

    preflight(root)
    env = clean_env(root, args)
    version = sandboxed([resolve_claude(), "--version"], env, 60)
    if version.returncode != 0 or not version.stdout.strip():
        raise SystemExit(f"claude --version failed under the sandbox: {version.stderr[-200:]}")
    (root / "version.txt").write_text(version.stdout.strip() + "\n")

    run_phase(root, project, args, "1", "run child hook probe", lambda: phase1_checks(root, args))
    if args.restart:
        journal = read_journal(root, "1")
        session = next(e["session"] for e in journal if e["name"] == "session.start")
        child = next(e["agentId"] for e in journal if e["name"] == "turn.start" and e.get("agentId"))
        write_plugin(root, args, phase="2", resumed=True)
        run_phase(root, project, args, "2", "restart check",
            lambda: phase2_checks(root, args, session, child), resume=session, child_id=child)
    report(root, args, version.stdout.strip())


if __name__ == "__main__":
    main()
