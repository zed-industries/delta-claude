#!/usr/bin/env python3
"""Exercise /delta join in installed interactive Claude against an existing native shared thread.

No model requests are made. Requires a matching Delta CLI on PATH and its normal
sign-in/server environment. Mounts every worktree of the thread for a disposable Claude session and config;
exiting Claude releases the mounts.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("transition", Path(__file__).with_name("check-session-transition.py"))
transition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transition)

BOOTSTRAP = r"""
let command = 0
export function register(on) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const root = await $.env.get('JOIN_PROBE_ROOT')
    if (!await $.fs.exists(root + '/before.json')) {
      await $.fs.write(root + '/before.json', JSON.stringify({id: await $.session.id(), cwd: await $.session.cwd()}))
      await $.session.append({message: {type: 'user', content: [{type: 'text', text: 'PRIVATE-OLD-CONTEXT-7923'}]}})
    }
    return result
  })
  on('turn.start', async ($, e, next) => {
    const root = await $.env.get('JOIN_PROBE_ROOT')
    await $.fs.write(root + '/unexpected-turn.json', JSON.stringify(e))
    return next(e)
  })
  on('tool.call', {tool: 'AskUserQuestion'}, async ($, e, next) => {
    const root = await $.env.get('JOIN_PROBE_ROOT')
    await $.fs.write(root + '/confirmation.json', JSON.stringify(e))
    return next(e)
  })
  on('session.messages', async ($, e, next) => {
    if (next.origin.plugin === 'delta') {
      const root = await $.env.get('JOIN_PROBE_ROOT')
      await $.fs.write(root + '/unexpected-export.json', JSON.stringify(e))
    }
    return next(e)
  })
  on('store.set', async ($, e, next) => {
    const result = await next(e)
    if (e.value?.joined) {
      const root = await $.env.get('JOIN_PROBE_ROOT')
      await $.fs.write(root + '/binding.json', JSON.stringify(e.value))
    }
    return result
  })
  on('process.run', async ($, e, next) => {
    const root = await $.env.get('JOIN_PROBE_ROOT')
    await $.fs.write(root + '/commands/' + command++ + '.json', JSON.stringify(e.argv))
    return next(e)
  })
  on('process.spawn', async function* ($, e, next) {
    const root = await $.env.get('JOIN_PROBE_ROOT')
    await $.fs.write(root + '/commands/' + command++ + '.json', JSON.stringify(e.argv))
    return yield* next(e)
  })
  on('ui.log', async ($, e, next) => {
    const result = await next(e)
    const root = await $.env.get('JOIN_PROBE_ROOT')
    if (e.text.startsWith('Joined Delta in fresh Claude session') || e.text.startsWith('Delta join failed:')) {
      await $.fs.write(root + '/result.json', JSON.stringify({
        text: e.text, id: await $.session.id(), cwd: await $.session.cwd(), root: await $.session.root(),
      }))
    }
    return result
  })
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("thread", help="An already shared Delta link or thread")
    parser.add_argument("--directory", help="Evidence directory; default is a retained temporary directory")
    args = parser.parse_args()
    root = Path(args.directory or tempfile.mkdtemp(prefix="delta-join-probe-")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    project = root / "old-project"
    project.mkdir()
    # A configured policy keeps the onboarding question from taking the join's keystrokes.
    (project / ".delta").mkdir()
    (project / ".delta/settings.json").write_text('{"threads":{"mode":"manual"}}\n')
    (project / "precious.txt").write_text("old checkout stays intact\n")
    subprocess.run(["git", "init", str(project)], check=True, capture_output=True)
    config = root / "config"
    config.mkdir()
    # Isolated test setup: skip first-run appearance selection, never copy credentials.
    (config / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True, "theme": "dark"}))
    (root / "commands").mkdir()
    bootstrap = root / "bootstrap"
    (bootstrap / ".claude-plugin").mkdir(parents=True)
    (bootstrap / "hooks").mkdir()
    (bootstrap / ".claude-plugin/plugin.json").write_text('{"name":"join-probe","version":"0.0.1"}')
    (bootstrap / "hooks/hooks.json").write_text('{"modules":["./register.js"]}')
    (bootstrap / "hooks/register.js").write_text(BOOTSTRAP)
    plugin = Path(__file__).resolve().parent.parent
    env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config), JOIN_PROBE_ROOT=str(root))
    # No model calls are needed; an inherited key prompts for approval in a
    # fresh config and would consume the keystrokes intended for /delta join.
    env.pop("ANTHROPIC_API_KEY", None)
    # Run from inside Claude Code, the probe would inherit the marker that turns transcript saving off.
    env.pop("CLAUDE_CODE_CHILD_SESSION", None)
    print(f"Join evidence: {root}", flush=True)
    transition.interactive([
        "claude", "--plugin-dir", str(plugin), "--plugin-dir", str(bootstrap),
        "--tools", "AskUserQuestion", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "", "--debug-file", str(root / "debug.log"),
    ], project, env, "/delta join " + args.thread, root / "result.json",
        timeout=90, confirmation=root / "confirmation.json", ready=root / "before.json")
    before = json.loads((root / "before.json").read_text())
    result = json.loads((root / "result.json").read_text())
    print(json.dumps(result, indent=2))
    assert result["text"].startswith("Joined Delta in fresh Claude session"), result
    binding = json.loads((root / "binding.json").read_text())
    assert result["id"] != before["id"], result
    assert result["cwd"] == result["root"] == binding["directory"], result
    assert binding["locator"] == args.thread and binding["snapshot"] is True, binding
    assert binding["next"] == 1 and binding["pending"] == [], binding
    assert (project / "precious.txt").read_text() == "old checkout stays intact\n"
    assert not (root / "unexpected-turn.json").exists(), "Joining started a turn"
    assert not (root / "unexpected-export.json").exists(), "Joining exported conversation history"
    commands = [json.loads(path.read_text()) for path in (root / "commands").glob("*.json")]
    # The plugin runs the CLI by the path it resolved.
    delta = [argv for argv in commands if Path(argv[0]).name == "delta"]
    assert not any(argv[3] in {"attach", "create", "share", "append"} for argv in delta), delta
    assert sum(argv[3] == "mount" for argv in delta) == 1, delta
    assert any(argv[3] == "watch" and argv[4] == args.thread for argv in delta), delta
    old = [json.loads(line) for path in (config / "projects").glob(f"*/{before['id']}.jsonl") for line in path.read_text().splitlines()]
    new = [json.loads(line) for path in (config / "projects").glob(f"*/{result['id']}.jsonl") for line in path.read_text().splitlines()]
    assert any("PRIVATE-OLD-CONTEXT-7923" in json.dumps(row) for row in old), "Old transcript was not preserved"
    assert not any("PRIVATE-OLD-CONTEXT-7923" in json.dumps(row) for row in new), "Old context leaked into new session"
    print("PASS native join, fresh ID, exact cwd/root, preserved old checkout/context, no export or execution")


if __name__ == "__main__":
    main()
