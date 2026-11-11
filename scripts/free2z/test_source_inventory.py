import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('inventory', HERE / 'source-inventory.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SCOPE = json.loads((HERE / 'source-inventory-scope.json').read_text())


class InventoryTest(unittest.TestCase):
    def test_classifications_and_scope(self):
        for path, kind in [
            ('py/free2z/dj/apps/ledger/models/entry.py', 'django-python'),
            ('py/free2z/dj/apps/ledger/templates/a.html', 'django-template'),
            ('ts/svelte/free2z/src/routes/new/+page.svelte', 'svelte-route-source'),
            ('ts/svelte/free2z/src/lib/components/New.svelte', 'svelte-source'),
            ('ts/react/free2z/src/New.tsx', 'classic-react-source'),
            ('docs/about-free2z/new.md', 'public-documentation'),
        ]:
            self.assertEqual(module.classify(path, SCOPE)[0]['kind'], kind)
        self.assertEqual(module.classify('ts/svelte/free2z/src/New.test.ts', SCOPE)[1], 'tests-or-migrations')
        with self.assertRaises(ValueError):
            module.classify('ts/react/free2z/src/unknown.xyz', SCOPE)
        with self.assertRaises(ValueError):
            module.validate_scope({'version': 1})
        with self.assertRaises(ValueError):
            module.validate_triage({'owner': '', 'disposition': 'reviewed', 'evidence': 'unreviewed-source', 'issue': ''})
        with self.assertRaises(ValueError):
            module.validate_triage({'owner': 'free2z', 'disposition': 'accepted-downstream', 'evidence': 'source-only', 'issue': ''})

    def test_triage_and_facts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = 'py/free2z/dj/apps/ledger/urls.py'
            target = root / path
            target.parent.mkdir(parents=True)
            target.write_text('path("x", view)\nclass Entry(models.Model): pass\n')
            first = module.inventory(root, [path], SCOPE, {})
            row = first['rows'][0]
            self.assertEqual(len(row['facts']), 2)
            row['triage'] = {'owner': 'ledger-team', 'disposition': 'reviewed', 'evidence': 'source-only', 'issue': ''}
            self.assertEqual(module.inventory(root, [path], SCOPE, first)['rows'][0]['triage'], row['triage'])
            target.write_text('path("y", view)\n')
            self.assertEqual(module.inventory(root, [path], SCOPE, first)['rows'][0]['triage']['evidence'], 'unreviewed-source')
            target.unlink()
            target.symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                module.inventory(root, [path], SCOPE, first)

    def test_command_detects_add_change_and_bad_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / 'scripts/free2z'
            scripts.mkdir(parents=True)
            output = root / 'docs/free2z/modernization'
            output.mkdir(parents=True)
            for name in ('source-inventory.py', 'source-inventory-scope.json'):
                shutil.copy(HERE / name, scripts / name)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            target = root / 'ts/svelte/free2z/src/routes/+page.svelte'
            target.parent.mkdir(parents=True)
            target.write_text('one')
            def run(*args):
                return subprocess.run(['python3', str(scripts / 'source-inventory.py'), *args], cwd=root, capture_output=True).returncode
            self.assertEqual(run('--write'), 0)
            self.assertEqual(run(), 0)
            target.write_text('two')
            self.assertNotEqual(run(), 0)
            self.assertEqual(run('--write'), 0)
            (target.parent / '+layout.svelte').write_text('new')
            self.assertNotEqual(run(), 0)
            self.assertEqual(run('--write'), 0)
            inventory = output / 'source-inventory.json'
            data = json.loads(inventory.read_text())
            data['rows'][0]['triage']['evidence'] = 'fabricated'
            inventory.write_text(json.dumps(data))
            self.assertNotEqual(run('--write'), 0)
            (scripts / 'source-inventory-scope.json').write_text('{}')
            self.assertNotEqual(run(), 0)


if __name__ == '__main__':
    unittest.main()
