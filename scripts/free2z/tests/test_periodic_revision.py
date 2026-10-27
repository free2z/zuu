"""Exercise registration order against real revisions without importing Django."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "scripts/free2z/check-periodic-register-first.py"
REGISTERED = '@app.task(name="example")\ndef work(timestamp):\n    pass\n'
SCHEDULED = '@app.periodic(cron="* * * * *")\n' + REGISTERED


class PeriodicRevisions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repository"
        self.root.mkdir()
        self.helper = self.root / "scripts/free2z/check-periodic-register-first.py"
        self.helper.parent.mkdir(parents=True)
        shutil.copyfile(HELPER, self.helper)
        self.source = self.root / "py/free2z/tasks.py"
        self.source.parent.mkdir(parents=True)
        self.git("init", "-q")

    def git(self, *args):
        env = {**os.environ, "GIT_AUTHOR_NAME": "Fixture", "GIT_COMMITTER_NAME": "Fixture",
               "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
        return subprocess.check_output(["git", *args], cwd=self.root, env=env, text=True).strip()

    def commit(self, source):
        self.source.write_text(source)
        self.git("add", ".")
        self.git("commit", "-qm", "fixture revision")
        return self.git("rev-parse", "HEAD")

    def check(self, base, head="HEAD", cwd=None):
        return subprocess.run([sys.executable, str(self.helper), "--base", base, "--head", head],
                              cwd=cwd or self.root, capture_output=True, text=True)

    def test_registered_task_can_be_scheduled_in_later_revision_from_other_cwd(self):
        base = self.commit(REGISTERED)
        self.commit(SCHEDULED)
        result = self.check(base, cwd=Path(self.temp.name))
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_first_registration_and_schedule_in_same_revision_fails(self):
        base = self.commit("# No task registered\n")
        self.commit(SCHEDULED)
        result = self.check(base)
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertIn("first registers", result.stdout)

    def test_empty_head_is_not_success(self):
        base = self.commit(REGISTERED)
        self.source.unlink()
        self.git("add", "-u")
        self.git("commit", "-qm", "remove application")
        result = self.check(base)
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertIn("contains no application Python modules", result.stderr)

    def test_unknown_base_is_not_success(self):
        self.commit(SCHEDULED)
        result = self.check("missing-base")
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertIn("CANNOT EVALUATE", result.stderr)


if __name__ == "__main__":
    unittest.main()
