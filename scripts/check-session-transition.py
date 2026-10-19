#!/usr/bin/env python3
"""Probe installed Claude's idle clear/cd transition without making model requests."""

import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import tempfile
import time


HOOKS = r"""
export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({name: 'transition-probe', description: 'Probe clear/cd'})
    return next(e)
  })
  on('command.run', {command: 'transition-probe'}, async ($) => {
    const root = await $.env.get('TRANSITION_ROOT')
    const before = {id: await $.session.id(), cwd: await $.session.cwd()}
    $.clock.after(0, async () => {
      try {
        const clear = await $.command.run({command: 'clear'})
        const fresh = {id: await $.session.id(), cwd: await $.session.cwd()}
        const cd = await $.command.run({command: 'cd', args: root + '/target'})
        const after = {id: await $.session.id(), cwd: await $.session.cwd()}
        await $.fs.write(root + '/result.json', JSON.stringify({before, fresh, after, clear, cd}))
      } catch (error) {
        await $.fs.write(root + '/result.json', JSON.stringify({before, error: String(error)}))
      }
    })
    return {text: 'Transition probe queued'}
  })
}
"""


def plain(screen):
    """The screen's text without terminal escapes or whitespace, for matching prompts."""
    text = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", screen)
    return re.sub(rb"\s+", b"", text).decode(errors="replace")


def interactive(arguments, cwd, env, command, done, timeout=45, confirmation=None, ready=None, stall=20):
    """Run `command` in interactive Claude until `done` exists, answering its prompts as they appear.

    Each prompt is answered when it shows, in whatever order: the first folder trust prompt, the
    optional `confirmation` (a file the probe writes when a question is asked), and /cd's "move here".
    The run fails fast, with the screen, when output stops changing for `stall` seconds or a prompt
    nothing answers appears, rather than waiting out `timeout`.
    """
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(arguments[0], arguments, env)
    os.set_blocking(terminal, False)
    screen = b""
    started = time.monotonic()
    changed = started

    def log(text):
        print(f"[{time.monotonic() - started:5.1f}s] {text}", flush=True)

    def fail(reason):
        tail = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", screen.decode(errors="replace"))[-3000:]
        raise AssertionError(f"{reason}\n--- screen ---\n{tail}")

    def read(seconds, until=lambda: False):
        nonlocal screen, changed
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not until():
            if select.select([terminal], [], [], 0.1)[0]:
                try:
                    chunk = os.read(terminal, 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    fail("Claude exited")
                if chunk:
                    screen += chunk
                    changed = time.monotonic()

    def press(keys, why):
        log(why)
        for key in keys:
            os.write(terminal, key)
            read(0.5)

    try:
        read(6, lambda: "trust" in plain(screen) and "folder" in plain(screen))
        if "trust" in plain(screen) and "folder" in plain(screen):
            read(1)
            press([b"\x1b[B", b"\r"], "trusting the starting folder")
        if ready is not None:
            read(20, ready.exists)
            if not ready.exists():
                fail(f"{ready.name} never appeared: the probe plugin's session.start did not run")
        read(2)
        log(f"sending {command!r}")
        os.write(terminal, command.encode())
        read(1)
        os.write(terminal, b"\r")
        answered_confirmation = False
        # Each /cd asks again, so a "move here" prompt counts only in output after the last answer.
        moved_at = len(screen)
        deadline = started + timeout
        while not done.exists():
            read(0.5, done.exists)
            now = time.monotonic()
            recent = plain(screen[moved_at:])
            if confirmation is not None and not answered_confirmation and confirmation.exists():
                answered_confirmation = True
                read(1)
                press([b"\r"], f"answering the question in {confirmation.name}")
            elif "Yes,movehere" in recent:
                moved_at = len(screen)
                press([b"\x1b[B", b"\r"], 'choosing "Yes, move here"')
            elif "recordingsettoManual?" in recent:
                fail("The plugin asked to configure recording; the probe project needs a .delta/settings.json")
            elif now - changed > stall:
                fail(f"No progress for {stall}s and {done.name} was not written")
            elif now > deadline:
                fail(f"{done.name} was not written within {timeout}s")
        log(f"{done.name} written")
        read(1)
        os.write(terminal, b"/exit\r")
        read(5)
    finally:
        Path(done).with_suffix(".screen.txt").write_bytes(screen)
        # Claude's own children, such as Delta watchers, share its process group.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except (ProcessLookupError, PermissionError):
                break
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and os.waitpid(pid, os.WNOHANG) == (0, 0):
                time.sleep(0.05)
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        os.close(terminal)
    return screen


def main():
    with tempfile.TemporaryDirectory(prefix="claude-transition-") as directory:
        root = Path(directory).resolve()
        (root / "target").mkdir()
        plugin = root / "plugin"
        (plugin / ".claude-plugin").mkdir(parents=True)
        (plugin / "hooks").mkdir()
        (plugin / ".claude-plugin/plugin.json").write_text('{"name":"transition-probe","version":"0.0.1"}')
        (plugin / "hooks/hooks.json").write_text('{"modules":["./register.js"]}')
        (plugin / "hooks/register.js").write_text(HOOKS)
        result = root / "result.json"
        interactive(["claude", "--plugin-dir", str(plugin), "--tools", "",
                     "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                     "--setting-sources", "", "--debug-file", str(root / "debug.log")],
                    root, dict(os.environ, TRANSITION_ROOT=str(root)), "/transition-probe", result)
        value = json.loads(result.read_text())
        print(json.dumps(value, indent=2))
        assert "error" not in value, value
        assert value["fresh"]["id"] != value["before"]["id"], value
        assert value["after"]["id"] == value["fresh"]["id"], value
        assert value["after"]["cwd"] == str(root / "target"), value
        print("PASS fresh session ID and actual cwd after idle clear/cd")


if __name__ == "__main__":
    main()
