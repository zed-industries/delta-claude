#!/usr/bin/env python3
"""Exercise production setup shell with an isolated HOME and fake downloads."""
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import tempfile
import unittest


class CliSetup(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="delta setup ")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        for tool in ("sh", "mkdir", "rmdir", "rm", "mktemp"):
            (self.bin / tool).symlink_to(shutil.which(tool))
        self.env = {**os.environ, "HOME": str(self.home), "PATH": str(self.bin)}
        self.write(self.bin / "uname", '#!/bin/sh\nprintf "Linux\\n"\n')
        self.write(self.bin / "curl", '#!/bin/sh\necho called >> "$HOME/downloads"\nexit 22\n')
        source = (Path(__file__).resolve().parents[1] / "hooks/cli/cli.ts").read_text()
        def shell(name):
            text = re.search(rf"const {name} = `\n(.*?)\n`", source, re.S)[1]
            return text.replace("\\\\", "\\").replace("\\${", "${")
        locations = shell("installLocations")
        self.discover = shell("discover").replace("${installLocations}", locations)
        self.install = shell("install").replace("${installLocations}", locations)

    def write(self, path, text="#!/bin/sh\nexit 0\n"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)

    def run_shell(self, script):
        return subprocess.run(["/bin/sh", "-c", script], env=self.env, cwd=self.home,
                              capture_output=True, text=True, timeout=10)

    def test_lists_path_then_install_locations_and_rechecks_only_installs(self):
        fallback = self.home / ".local/delta.app/bin/delta"
        self.write(fallback)
        other = self.home / "other bin/delta"
        self.write(other)
        selected = self.bin / "delta"
        self.write(selected)
        self.write(self.home / "relative/delta")
        (self.home / "not executable").mkdir()
        (self.home / "not executable/delta").write_text("")
        self.env["PATH"] = f"relative:{self.bin}/:{self.home}/not executable:{other.parent}:{self.bin}"
        self.assertEqual(self.run_shell(self.discover).stdout,
                         f"path {selected}\npath {other}\npath {selected}\ninstalled {fallback}\n")
        # A delta on PATH was already passed over, so only an install location ends the install.
        result = self.run_shell(self.install)
        self.assertEqual((result.returncode, result.stdout), (0, f"{fallback}\n"))
        self.assertFalse((self.home / "downloads").exists())
        self.assertFalse((self.home / ".cache/delta-claude-install.lock").exists())
        fallback.unlink()
        self.assertEqual(self.run_shell(self.install).returncode, 22)
        self.write(self.bin / "uname", '#!/bin/sh\nprintf "Darwin\\n"\n')
        self.env["PATH"] = str(self.bin)
        selected.unlink()
        app = self.home / "Applications/Delta.app/Contents/MacOS/delta"
        self.write(app)
        self.assertEqual(self.run_shell(self.discover).stdout, f"installed {app}\n")

    def test_download_failure_cleans_lock(self):
        result = self.run_shell(self.install)
        self.assertEqual(result.returncode, 22)
        lock = self.home / ".cache/delta-claude-install.lock"
        self.assertFalse(lock.exists())

    def test_downloaded_installer_receives_noninteractive_flag(self):
        self.fake_download()
        self.write(self.home / "fixture", """#!/bin/sh
case "$1" in
  --locate-cli) exit 1 ;;
  --non-interactive) printf '%s\\n' "$HOME/installed delta";;
  *) exit 99 ;;
esac
""")
        result = self.run_shell(self.install)
        self.assertEqual((result.returncode, result.stdout),
                         (0, f"{self.home}/installed delta\n"))
        self.assertFalse((self.home / ".cache/delta-claude-install.lock").exists())

    def test_active_install_excludes_other_process_and_interrupt_cleans_up(self):
        self.fake_download()
        os.mkfifo(self.home / "blocked")
        self.write(self.home / "fixture", """#!/bin/sh
case "$1" in
  --locate-cli) exit 1 ;;
  --non-interactive)
    printf '%s\\n' "$0"
    read -r release < "$HOME/blocked"
    ;;
  *) exit 99 ;;
esac
""")
        process = subprocess.Popen(["/bin/sh", "-c", self.install], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 10)[0],
                            "fake installer did not reach its blocking step")
            installer = Path(process.stdout.readline().strip())
            self.assertTrue(installer.is_file())
            lock = self.home / ".cache/delta-claude-install.lock"
            self.assertTrue(lock.is_dir())
            competitor = self.run_shell(self.install)
            self.assertEqual(competitor.returncode, 1)
            self.assertTrue(lock.is_dir())
            self.assertIsNone(process.poll())
            self.assertEqual((self.home / "downloads").read_text(), "called\n")
            # Interrupt the entire invocation, including the active installer child.
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0)
            self.assertFalse(lock.exists())
            self.assertFalse(installer.parent.exists())
            # The interrupted owner must not prevent a subsequent host from retrying.
            self.write(self.home / "fixture", '#!/bin/sh\nprintf "%s\\n" "$HOME/recovered delta"\n')
            retry = self.run_shell(self.install)
            self.assertEqual((retry.returncode, retry.stdout),
                             (0, f"{self.home}/recovered delta\n"))
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=10)

    def fake_download(self):
        self.write(self.bin / "curl", """#!/bin/sh
echo called >> "$HOME/downloads"
while [ "$1" != "-o" ]; do shift; done
cat_source="$HOME/fixture"
# Use only shell builtins so the test PATH stays isolated.
while IFS= read -r line; do printf '%s\\n' "$line"; done < "$cat_source" > "$2"
""")


if __name__ == "__main__":
    unittest.main()
