#!/usr/bin/env python3
"""Test Desktop sandbox isolation without launching Desktop.

By default, build a private fixture from this checkout. Pass --sandbox <prepared sandbox> to test
a private copy of that installation instead. The Desktop surface is simulated, not a live E2E test.
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("desktop", Path(__file__).with_name("plugin-update-desktop.py"))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)

ENGINE_TESTS = r"""
import type { On } from 'claude-code'
import { expect, test as kitTest } from 'claude-code/testing'
import { fakeThreads, prompt, sessionEnd, sessionStart, shareCommand, testsWithHeldClockWait } from './testing/fake-thread-commands'

const test = testsWithHeldClockWait(kitTest)
const probe = __DESCRIPTOR__

function fixture(on: On) {
  const isolated = (env: any) => {
    expect(env.CLAUDE_CONFIG_DIR).toBe(probe.config)
    expect(env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe(probe.cache)
    expect(env.PATH).toBe(probe.processEnv.PATH)
    expect(env.GIT_CONFIG_VALUE_0).toBe('https://github.com/zed-industries/delta-claude.git')
  }
  const fake = fakeThreads(((event: any, ...args: any[]) => {
    if (event === 'process.run') on(event, ($, e, next) => {
      isolated(e.init?.env)
      return args[0]($, e, next)
    })
    else if (event === 'process.spawn') on(event, async function* ($, e, next) {
      isolated(e.env)
      return yield* args[0]($, e, next)
    })
    else (on as any)(event, ...args)
  }) as On)
  fake.cwd = probe.project
  fake.surfaces = ['desktop']
  fake.pluginInstalled = true
  fake.files.set(probe.project + '/.delta/settings.json', '{"threads":{"mode":"manual"}}')
  return fake
}
const start = { ...sessionStart, cwd: probe.project, surface: 'desktop' as const }
const command = (name: string) => ({ ...shareCommand, command: name, args: '' })

test('the production update works immediately with isolated subprocesses and no test-only unlock', async ($, on) => {
  const fake = fixture(on)
  await $.session.start(start)
  expect((await $.command.run(command('delta-plugin-update'))).text).toContain('Desktop may apply it automatically')
  await fake.advance(0)
  expect(fake.pluginUpdateCalls).toHaveLength(1)
  expect(fake.sessionCommands).toEqual([])
  await $.session.end(sessionEnd(fake.session))
})

test('the production attach hook discovers the release without a diagnostic command', async ($, on) => {
  const fake = fixture(on)
  fake.surfaces = []
  await $.session.start(start)
  await fake.advance(0)
  expect(fake.pluginHttpCalls).toEqual([])
  fake.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop' })
  await fake.advance(0)
  expect(fake.pluginHttpCalls).toHaveLength(1)
})

test('the fixture preserves production prompt admission and pins spawned Delta processes too', async ($, on) => {
  const fake = fixture(on)
  await $.session.start(start)
  expect((await $.prompt.submit({ ...prompt('hello'), origin: { kind: 'sdk' } })).drop).toBeUndefined()
  expect(fake.entered.map((entry) => entry.text)).toContain('hello')
  expect((await $.command.run(command('delta-update'))).text).toContain('Updated Delta')
  expect(fake.installUpdates.some((entry) => !entry.argv.includes('--check'))).toBe(true)
})
"""


def fake_bundle(root):
    bundle = root / "Claude Test.app"
    (bundle / "Contents/MacOS").mkdir(parents=True)
    with (bundle / "Contents/Info.plist").open("wb") as file:
        plistlib.dump({"CFBundleExecutable": "Claude"}, file)
    (bundle / "Contents/MacOS/Claude").write_text("Test fixture; never executed")
    return bundle


class DesktopControls(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="desktop probe ", dir=os.environ.get("DELTA_SCRATCH_DIR"))
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.descriptor = {
            "schema": 2, "root": str(self.root),
            "config": str(self.root / "config"), "cache": str(self.root / "config/plugins"),
            "project": str(self.root / "project"), "executable": "/Applications/Claude.app/Contents/MacOS/Claude",
            "releaseVersion": "0.0.2",
            "processEnv": desktop.process_environment(self.root, "/fake/bin/claude"),
        }
        (self.root / "desktop.json").write_text(json.dumps(self.descriptor))

    def test_configuration_is_allowlisted_and_shell_credentials_are_not_reused(self):
        parent = {"ANTHROPIC_API_KEY": "test-only-key", "ANTHROPIC_BASE_URL": "https://example.invalid",
                  "CLAUDE_CONFIG_DIR": "/real/config", "CLAUDE_CODE_PLUGIN_DIRS": "/real/plugin",
                  "CLAUDECODE": "1", "HTTPS_PROXY": "http://proxy.invalid"}
        with patch.dict(os.environ, parent):
            saved = desktop.process_environment(self.root, "/fake/bin/claude")
        self.assertNotIn("test-only-key", json.dumps(saved))
        self.assertNotIn("ANTHROPIC_API_KEY", saved)
        env = desktop.launch_environment(self.descriptor, parent)
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], self.descriptor["config"])
        self.assertEqual(env["HTTPS_PROXY"], parent["HTTPS_PROXY"])
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_PLUGIN_DIRS", "CLAUDECODE"):
            self.assertNotIn(key, env)
        self.assertEqual(parent["CLAUDE_CONFIG_DIR"], "/real/config")

    def test_moved_or_repointed_sandbox_is_rejected(self):
        self.assertEqual(desktop.read_descriptor(self.root), self.descriptor)
        self.descriptor["config"] = "/real/config"
        (self.root / "desktop.json").write_text(json.dumps(self.descriptor))
        with self.assertRaises(ValueError):
            desktop.read_descriptor(self.root)

    def test_repointed_process_environment_is_rejected(self):
        self.descriptor["processEnv"]["CLAUDE_CONFIG_DIR"] = "/real/config"
        (self.root / "desktop.json").write_text(json.dumps(self.descriptor))
        with self.assertRaises(ValueError):
            desktop.read_descriptor(self.root)

    def test_process_detection_handles_spaces_and_ignores_other_apps(self):
        executable = "/Applications/Claude Test.app/Contents/MacOS/Claude"
        output = f"  123 {executable}\n  456 /Applications/Other.app/Contents/MacOS/Other\n"
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)):
            self.assertEqual(desktop.running_app(executable), [123])

    def test_launch_refuses_a_running_app(self):
        with patch.object(desktop, "__file__", str(self.root / "desktop.py")), \
             patch.object(sys, "argv", ["desktop.py", "launch"]), \
             patch.object(desktop, "running_app", return_value=[123]), \
             patch.object(os, "execve") as execute, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                desktop.main()
        self.assertEqual(stopped.exception.code, 1)
        execute.assert_not_called()

    def test_launch_uses_the_sandbox_environment(self):
        with patch.object(desktop, "__file__", str(self.root / "desktop.py")), \
             patch.object(sys, "argv", ["desktop.py", "launch"]), \
             patch.object(desktop, "running_app", return_value=[]), \
             patch.object(os, "chdir") as chdir, \
             patch.object(os, "execve", side_effect=RuntimeError("simulated exec")) as execute, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "simulated exec"):
                desktop.main()
        chdir.assert_called_once_with(self.descriptor["project"])
        self.assertEqual(execute.call_args.args[2]["CLAUDE_CONFIG_DIR"], self.descriptor["config"])

    def test_disabling_native_auto_update_preserves_other_settings(self):
        config = self.root / "config"
        config.mkdir()
        path = config / "settings.json"
        path.write_text(json.dumps({"env": {"EXISTING": "kept"}, "model": "unchanged",
                                   "extraKnownMarketplaces": {"zed-industries": {"source": {"source": "github"}}}}))
        desktop.disable_auto_update(self.descriptor)
        saved = json.loads(path.read_text())
        self.assertEqual(saved["env"], {"EXISTING": "kept"})
        self.assertEqual(saved["model"], "unchanged")
        self.assertIs(saved["extraKnownMarketplaces"]["zed-industries"]["autoUpdate"], False)

    def test_app_bundle_is_resolved_without_launching_it(self):
        bundle = fake_bundle(self.root)
        self.assertEqual(desktop.app_executable(bundle), str(bundle / "Contents/MacOS/Claude"))

    def test_instrumentation_changes_only_the_subprocess_environment(self):
        project = Path(__file__).resolve().parent.parent
        fixture = self.root / "fixture"
        (fixture / "hooks/plugin-update").mkdir(parents=True)
        register = fixture / "hooks/register.tsx"
        original = (project / "hooks/register.tsx").read_text()
        register.write_text(original)
        updater = fixture / "hooks/plugin-update/updates.ts"
        updater.write_text((project / "hooks/plugin-update/updates.ts").read_text())
        original_updater = updater.read_text()
        descriptor = desktop.prepare(self.root, fixture, "/fake/bin/claude", fake_bundle(self.root), "0.0.2")
        restored = register.read_text().replace(
            "const desktopEnvironment = " + json.dumps(descriptor["processEnv"]) + "\n\n", "",
        ).replace(
            "$.process.run(argv, { ...init, env: { ...init?.env, ...desktopEnvironment } })",
            "$.process.run(argv, init)",
        ).replace(
            "$.process.spawn({ ...request, env: { ...request.env, ...desktopEnvironment } })",
            "$.process.spawn(request)",
        )
        self.assertEqual(restored, original)
        self.assertEqual(updater.read_text(), original_updater)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sandbox", type=Path, help="Test a private copy of this prepared fixture instead of the checkout")
    parser.add_argument("--claude", default="claude", help="Engine executable for the fixture tests")
    args = parser.parse_args()
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(DesktopControls))
    if not result.wasSuccessful():
        sys.exit(1)
    # Never edit a cache Desktop may be using.
    with tempfile.TemporaryDirectory(prefix="desktop-fixture-tests-", dir=os.environ.get("DELTA_SCRATCH_DIR")) as directory:
        root = Path(directory).resolve()
        copy = root / "config/plugins/cache/zed-industries/delta/0.0.1"
        cli = shutil.which(args.claude) or args.claude
        if args.sandbox:
            descriptor = desktop.read_descriptor(args.sandbox.resolve())
            installed = Path(descriptor["cache"]) / "cache/zed-industries/delta/0.0.1"
            if not installed.is_dir():
                parser.error("The sandbox has no initial fixture installation")
            shutil.copytree(installed, copy, ignore=shutil.ignore_patterns(".git", "types", "*.test.ts", "*.test.tsx"))
            copied_descriptor = {
                **descriptor, "root": str(root), "config": str(root / "config"),
                "cache": str(root / "config/plugins"), "project": str(root / "project"),
                "processEnv": desktop.process_environment(root, cli),
            }
            register = copy / "hooks/register.tsx"
            register.write_text(desktop.replace_once(
                register.read_text(), "const desktopEnvironment = " + json.dumps(descriptor["processEnv"]),
                "const desktopEnvironment = " + json.dumps(copied_descriptor["processEnv"]),
            ))
        else:
            project = Path(__file__).resolve().parent.parent
            shutil.copytree(project / "hooks", copy / "hooks", ignore=shutil.ignore_patterns("*.test.ts", "*.test.tsx"))
            shutil.copytree(project / ".claude-plugin", copy / ".claude-plugin", ignore=shutil.ignore_patterns("types"))
            copied_descriptor = desktop.prepare(root, copy, cli, fake_bundle(root), "0.0.2")
        test = copy / "hooks/desktop-isolation.test.ts"
        test.write_text(ENGINE_TESTS.replace("__DESCRIPTOR__", json.dumps(copied_descriptor)))
        subprocess.run([args.claude, "plugin", "test", str(copy)], check=True, timeout=120)
