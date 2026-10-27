#!/usr/bin/env python3
"""Prepare and launch a macOS Desktop sandbox. Copied into each sandbox as desktop.py.

Only the fixture's subprocess environment is changed. Its commands, prompts and update flow are
the production code. The launcher never quits an app or edits normal settings or credentials.
"""

import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Fixture instrumentation no longer matches the plugin: {old}")
    return text.replace(old, new)


def app_executable(bundle):
    bundle = Path(bundle).resolve()
    with (bundle / "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    name = info.get("CFBundleExecutable")
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError("The Desktop app has an invalid executable name")
    executable = bundle / "Contents/MacOS" / name
    if not executable.is_file():
        raise ValueError(f"Desktop executable not found: {executable}")
    return str(executable)


def process_environment(root, cli):
    """A saved allowlist of test paths and controls, not a copy of the person's environment."""
    paths = [str(root / "bin"), str(Path(cli).parent)]
    for tool in ("git", "node"):
        if found := shutil.which(tool):
            paths.append(str(Path(found).parent))
    paths += ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    return {
        "CLAUDE_CONFIG_DIR": str(root / "config"),
        "CLAUDE_CODE_PLUGIN_CACHE_DIR": str(root / "config/plugins"),
        "PATH": os.pathsep.join(dict.fromkeys(paths)),
        "DISABLE_AUTOUPDATER": "1",
        "FORCE_AUTOUPDATE_PLUGINS": "0",
        "CLAUDE_CODE_PLUGIN_PREFER_HTTPS": "1",
        "GIT_CONFIG_COUNT": "3",
        "GIT_CONFIG_KEY_0": f"url.{(root / 'marketplace').as_uri()}.insteadOf",
        "GIT_CONFIG_VALUE_0": "https://github.com/zed-industries/delta-claude.git",
        "GIT_CONFIG_KEY_1": "protocol.file.allow",
        "GIT_CONFIG_VALUE_1": "always",
        "GIT_CONFIG_KEY_2": f"url.{(root / 'no-other-marketplaces').as_uri()}/.insteadOf",
        "GIT_CONFIG_VALUE_2": "https://github.com/",
    }


def prepare(root, fixture, cli, bundle, release_version):
    """Pin fixture subprocesses without changing hooks or adding commands."""
    root = root.resolve()
    descriptor = {
        "schema": 2, "root": str(root),
        "config": str(root / "config"), "cache": str(root / "config/plugins"),
        "project": str(root / "project"), "executable": app_executable(bundle),
        "releaseVersion": release_version, "processEnv": process_environment(root, cli),
    }
    register = fixture / "hooks/register.tsx"
    source = register.read_text()
    source = replace_once(source, "function hostOf($: EngineInterface): Host {\n",
                          "const desktopEnvironment = " + json.dumps(descriptor["processEnv"]) +
                          "\n\nfunction hostOf($: EngineInterface): Host {\n")
    # Desktop imports a login-shell PATH. Pin the fixture's subprocesses separately so it cannot
    # accidentally find the real Delta CLI or update a different Claude profile.
    source = replace_once(source, "run: (argv, init) => $.process.run(argv, init),",
                          "run: (argv, init) => $.process.run(argv, { ...init, env: { ...init?.env, ...desktopEnvironment } }),")
    source = replace_once(source, "spawn: (request) => $.process.spawn(request),",
                          "spawn: (request) => $.process.spawn({ ...request, env: { ...request.env, ...desktopEnvironment } }),")
    register.write_text(source)
    (root / "desktop.json").write_text(json.dumps(descriptor, indent=2) + "\n")
    shutil.copyfile(__file__, root / "desktop.py")
    return descriptor


def disable_auto_update(descriptor):
    path = Path(descriptor["config"]) / "settings.json"
    settings = json.loads(path.read_text())
    settings["extraKnownMarketplaces"]["zed-industries"]["autoUpdate"] = False
    path.write_text(json.dumps(settings, indent=2) + "\n")


def read_descriptor(root):
    descriptor = json.loads((root / "desktop.json").read_text())
    if descriptor.get("schema") != 2 or descriptor.get("root") != str(root):
        raise ValueError("Unsupported or moved sandbox. Prepare a fresh sandbox with the current helper.")
    for key, relative in [("config", "config"), ("cache", "config/plugins"), ("project", "project")]:
        if descriptor.get(key) != str(root / relative) or (root / relative).resolve() != root / relative:
            raise ValueError(f"The sandbox {key} path changed; prepare a fresh sandbox")
    for name, key in [("CLAUDE_CONFIG_DIR", "config"), ("CLAUDE_CODE_PLUGIN_CACHE_DIR", "cache")]:
        if descriptor.get("processEnv", {}).get(name) != descriptor[key]:
            raise ValueError(f"The launch environment's {name} changed; prepare a fresh sandbox")
    return descriptor


def launch_environment(descriptor, inherited):
    env = dict(inherited)
    # Let Desktop use its own sign-in and endpoint. Never reuse the terminal fixture's dummy key.
    for name in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_PLUGIN_DIRS",
                 "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        env.pop(name, None)
    env.update(descriptor["processEnv"])
    return env


def running_app(executable):
    """Inspect process names only: command-line arguments can contain personal information."""
    result = subprocess.run(["ps", "-axww", "-o", "pid=,comm="], capture_output=True, text=True, check=True, timeout=5)
    return [int(parts[0]) for line in result.stdout.splitlines()
            if len(parts := line.strip().split(None, 1)) == 2 and Path(parts[1]).name == Path(executable).name
            and Path(parts[1]).resolve() == Path(executable).resolve()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["launch"])
    parser.add_argument("--dry-run", action="store_true", help="Inspect launch parameters without opening Desktop")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    try:
        descriptor = read_descriptor(root)
        running = running_app(descriptor["executable"])
        if args.dry_run:
            print(json.dumps({"executable": descriptor["executable"], "config": descriptor["config"],
                              "cache": descriptor["cache"], "project": descriptor["project"],
                              "runningPids": running}, indent=2))
            return
        if running:
            raise ValueError("Claude Desktop is already running. Finish active work and quit it with Cmd+Q first. Nothing was stopped.")
        print(f"Open a NEW Code → Local session in {descriptor['project']} with Worktree OFF.", flush=True)
        print("Try the update notice or /delta-plugin-update. This terminal stays attached until Desktop quits.", flush=True)
        os.chdir(descriptor["project"])
        os.execve(descriptor["executable"], [descriptor["executable"]], launch_environment(descriptor, os.environ))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
