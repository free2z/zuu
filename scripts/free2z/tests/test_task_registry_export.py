"""Release task inventories must describe the exact committed application tree."""
from pathlib import Path
import json
import shutil
import subprocess
import sys

from test_periodic_revision import PeriodicRevisions, REGISTERED, SCHEDULED, ROOT


class TaskRegistryExport(PeriodicRevisions):
    def setUp(self):
        super().setUp()
        for name in ('export-task-registry.py', 'release-manifest.py'):
            shutil.copyfile(ROOT / 'scripts/free2z' / name, self.helper.parent / name)
        self.output = Path(self.temp.name) / 'registry.json'

    def export(self, commit):
        return subprocess.run([sys.executable, str(self.helper.parent / 'export-task-registry.py'),
                               '--commit', commit, '--output', str(self.output)],
                              cwd=Path(self.temp.name), capture_output=True, text=True)

    def test_exact_committed_registry_from_unrelated_cwd(self):
        head = self.commit(SCHEDULED)
        result = self.export(head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.output.read_text()), {
            'source': {'repository': 'free2z/zuu', 'commit': head},
            'task_registry': {'schema_version': 1, 'registered': ['example'], 'scheduled': ['example']},
        })

    def test_wrong_commit_and_dirty_or_untracked_source_are_rejected(self):
        head = self.commit(REGISTERED)
        self.assertNotEqual(self.export('a' * 40).returncode, 0)
        self.source.write_text(SCHEDULED)
        self.assertNotEqual(self.export(head).returncode, 0)
        head = self.commit(SCHEDULED)
        (self.source.parent / 'extra.py').write_text(REGISTERED)
        self.assertNotEqual(self.export(head).returncode, 0)

    def test_unresolved_schedule_cannot_enter_signed_inventory(self):
        head = self.commit(REGISTERED + 'app.periodic(cron="* * * * *")(work)\n')
        self.assertNotEqual(self.export(head).returncode, 0)
        self.assertFalse(self.output.exists())
