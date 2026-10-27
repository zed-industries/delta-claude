#!/usr/bin/env python3
"""Exercise plugin updates in an isolated terminal.

Requires macOS, Linux, or WSL, Git and Claude Code. Uses a disposable Git marketplace and configuration,
redirects that marketplace's GitHub clone URL to the local fixture, and makes no model requests.
No installed user plugins, settings, credentials or Delta sessions are changed.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.request


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("transition", Path(__file__).with_name("check-session-transition.py"))
transition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transition)

# Instrument only the fixture, after command registration. A second marker proves the new
# cached module actually loaded in the same session, not merely that the updater downloaded it.
MARKER = r"""
    const probeRoot = __PROBE_ROOT__
    const probeManifest = JSON.parse(await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json'))
    await $.fs.write(probeRoot + '/loaded-' + probeManifest.version + '.json', JSON.stringify({
      session: await $.session.id(), cwd: await $.session.cwd(), pluginRoot: $.plugin.root,
    }))
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", default=shutil.which("claude"), help="Claude executable to exercise")
    parser.add_argument("--notifications", action="store_true",
                        help="Also check the real startup notification against the public GitHub release manifest")
    args = parser.parse_args()
    if not args.claude:
        parser.error("Claude Code is not on PATH")
    notifications = args.notifications
    release_version = "0.0.2"
    if notifications:
        # The notification reads the real public manifest. Give the local release that same version,
        # so the offered update and the installed fixture agree without mocking the HTTP response.
        with urllib.request.urlopen(
            "https://raw.githubusercontent.com/zed-industries/delta-claude/main/.claude-plugin/plugin.json",
            timeout=10,
        ) as response:
            public = json.loads(response.read(16 * 1024))
        release_version = public.get("version")
        if public.get("name") != "delta" or not isinstance(release_version, str) or not re.fullmatch(
            r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?", release_version
        ) or release_version == "0.0.1":
            raise AssertionError("The public release manifest has no usable fixture version")
    claude = str(Path(args.claude).resolve())
    plugin = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="delta-plugin-update-", dir=os.environ.get("DELTA_SCRATCH_DIR")) as directory:
        root = Path(directory).resolve()
        config = root / "config"
        config.mkdir()
        fixture = root / "marketplace"
        fixture.mkdir()
        shutil.copytree(plugin / "hooks", fixture / "hooks", ignore=shutil.ignore_patterns("*.test.ts", "*.test.tsx"))
        shutil.copytree(plugin / ".claude-plugin", fixture / ".claude-plugin", ignore=shutil.ignore_patterns("types"))
        register = fixture / "hooks/register.tsx"
        original = register.read_text()
        marker_site = "    await registerCommands(host)\n"
        assert original.count(marker_site) == 1
        register.write_text(original.replace(marker_site, marker_site + MARKER.replace("__PROBE_ROOT__", json.dumps(str(root)))))
        notification_marker = root / "notification.json"
        if notifications:
            # Observe the real check's decision without changing its HTTP request, cadence or UI.
            updater = fixture / "hooks/plugin-update/updates.ts"
            source = updater.read_text()
            site = "    showPluginUpdateNotice(host, notice)\n"
            assert source.count(site) == 1
            updater.write_text(source.replace(site, site +
                f"    await host.fs.write({json.dumps(str(notification_marker))}, JSON.stringify(notice))\n"))
        manifest_path = fixture / ".claude-plugin/plugin.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["version"] = "0.0.1"
        manifest_path.write_text(json.dumps(manifest))
        project = root / "project"
        (project / ".delta").mkdir(parents=True)
        (project / ".delta/settings.json").write_text('{"threads":{"mode":"manual"}}\n')
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (bin_dir / "claude").write_text(f"#!/bin/sh\nexec {shlex.quote(claude)} \"$@\"\n")
        # Startup's separate Delta-app checker must not contact the person's real Delta installation.
        (bin_dir / "delta").write_text("""#!/bin/sh
printf '%s\\n' '{"schema_version":1,"status":"up_to_date","current_version":"0.0.0","latest_version":"0.0.0","channel":"stable","can_install":false,"message":"Fixture CLI"}'
""")
        for executable in bin_dir.iterdir():
            executable.chmod(0o755)
        key = "sk-ant-api03-plugin-update-probe-not-a-secret"
        (config / ".claude.json").write_text(json.dumps({
            "hasCompletedOnboarding": True, "theme": "dark",
            "customApiKeyResponses": {"approved": [key[-20:]], "rejected": []},
        }))
        env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config), CLAUDE_CODE_PLUGIN_CACHE_DIR=str(config / "plugins"),
                   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1",
                   CLAUDE_CODE_PLUGIN_PREFER_HTTPS="1",
                   ANTHROPIC_API_KEY=key, ANTHROPIC_BASE_URL="http://127.0.0.1:1",
                   PATH=str(bin_dir) + os.pathsep + os.environ["PATH"], GIT_EDITOR="true")
        for name in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_PLUGIN_DIRS",
                     "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"):
            env.pop(name, None)
        # Keep the declared source realistic while every Git fetch stays on disk.
        env.update({
            "GIT_CONFIG_COUNT": "3",
            "GIT_CONFIG_KEY_0": f"url.{fixture.as_uri()}.insteadOf",
            "GIT_CONFIG_VALUE_0": "https://github.com/zed-industries/delta-claude.git",
            "GIT_CONFIG_KEY_1": "protocol.file.allow", "GIT_CONFIG_VALUE_1": "always",
            # Any optional discovery of another GitHub marketplace must fail locally, not clone it.
            "GIT_CONFIG_KEY_2": f"url.{(root / 'no-other-marketplaces').as_uri()}/.insteadOf",
            "GIT_CONFIG_VALUE_2": "https://github.com/",
        })

        def run(*argv, cwd=fixture):
            result = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=60)
            if result.returncode:
                raise AssertionError(f"{argv}: {result.stdout}\n{result.stderr}")
            return result.stdout

        run("git", "init", "-b", "main")
        run("git", "config", "user.name", "Plugin update fixture")
        run("git", "config", "user.email", "fixture@example.invalid")
        run("git", "config", "commit.gpgSign", "false")
        run("git", "add", ".")
        run("git", "commit", "-m", "Initial fixture")
        run("git", "init", str(project))
        print(run("claude", "plugin", "marketplace", "add", "zed-industries/delta-claude#main", "--json", cwd=project))
        print(run("claude", "plugin", "install", "delta@zed-industries", "--json", cwd=project))
        # Exercise manual updating with notifications off as well as the native auto-updater off.
        # Only an explicit marketplace refresh may fetch the local fixture; no run sends a model prompt.
        if not notifications:
            print(run("claude", "-p", "/delta-plugin-update notifications off", "--setting-sources", "user", cwd=project))
        else:
            # Background notification checks need network access, unlike the fully local default run.
            # This is the disposable child's environment, never a change to the caller's settings.
            env.pop("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
            env.update(DISABLE_TELEMETRY="1", DISABLE_ERROR_REPORTING="1")
        manifest["version"] = release_version
        manifest_path.write_text(json.dumps(manifest))
        run("git", "add", ".")
        run("git", "commit", "-m", "Release fixture update")
        before, after = root / "loaded-0.0.1.json", root / f"loaded-{release_version}.json"
        before.unlink(missing_ok=True)
        arguments = [
            "claude", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "user", "--debug-file", str(root / "debug.log"),
        ]
        try:
            transition.interactive(arguments, project, env, "/delta-plugin-update", after,
                                   ready=notification_marker if notifications else before, timeout=75)
        except Exception:
            debug = root / "debug.log"
            if debug.exists():
                for line in debug.read_text().splitlines():
                    if any(word in line for word in ("[ERROR]", "hooks module delta", "[delta]", "Plugin autoupdate")):
                        print(line)
            raise
        initial, updated = json.loads(before.read_text()), json.loads(after.read_text())
        assert initial["session"] == updated["session"], (initial, updated)
        assert initial["cwd"] == updated["cwd"] == str(project), (initial, updated)
        assert initial["pluginRoot"].endswith("/0.0.1"), initial
        assert updated["pluginRoot"].endswith("/" + release_version), updated
        if notifications:
            notice = json.loads(notification_marker.read_text())
            assert notice["version"] == release_version and not notice["ready"], notice
            print("PASS: startup discovered the public release and offered the update with native auto-update disabled")
        print(f"PASS: native marketplace update loaded {release_version} immediately in the same Claude session and directory")


if __name__ == "__main__":
    main()
