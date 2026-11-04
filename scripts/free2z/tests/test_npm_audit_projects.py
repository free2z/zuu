"""Check npm-only audit routing without network access or installed packages."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class NpmAuditProjects(unittest.TestCase):
    def test_each_registered_project_is_scanned_without_pip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            helpers = root / 'scripts/free2z'
            helpers.mkdir(parents=True)
            for name in ('run-dependency-audits.sh', 'check-dependency-audit.py'):
                shutil.copyfile(ROOT / 'scripts/free2z' / name, helpers / name)
            (root / '.github').mkdir()
            shutil.copyfile(ROOT / '.github/dependency-audit-baseline.json', root / '.github/dependency-audit-baseline.json')
            fakebin = root / 'bin'
            fakebin.mkdir()
            npm = fakebin / 'npm'
            report = json.dumps({'auditReportVersion': 2, 'vulnerabilities': {}, 'metadata': {'vulnerabilities': {'total': 0}}})
            npm.write_text('#!/bin/sh\npwd > "$SCANNED_PROJECT"\nprintf \'%s\\n\' \'%s\'\n' % ('%s', report))
            npm.chmod(0o755)
            for project in ('ts/svelte/free2z', 'ts/react/free2z', 'docs/about-free2z', 'docs/free2z/website'):
                with self.subTest(project=project):
                    (root / project).mkdir(parents=True)
                    record = root / 'scanned.txt'
                    env = {**os.environ, 'PATH': str(fakebin) + os.pathsep + os.environ['PATH'], 'PYTHON': sys.executable,
                           'NPM_AUDIT_PROJECT': project, 'DEPENDENCY_AUDIT_NPM_ONLY': '1', 'SCANNED_PROJECT': str(record)}
                    run = subprocess.run(['bash', str(helpers / 'run-dependency-audits.sh')], env=env, capture_output=True, text=True)
                    self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                    self.assertEqual(Path(record.read_text().strip()).resolve(), (root / project).resolve())
                    self.assertNotIn('pip audit', run.stdout + run.stderr)
            env['NPM_AUDIT_PROJECT'] = '../unregistered'
            run = subprocess.run(['bash', str(helpers / 'run-dependency-audits.sh')], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
            self.assertIn('unregistered application npm project', run.stderr)


if __name__ == '__main__':
    unittest.main()
