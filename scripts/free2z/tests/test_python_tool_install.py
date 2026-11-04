"""Tool acceptance verifies artifacts even when bootstrap already installed them."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('tool_installer', SCRIPTS / 'install-python-tool-lock.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ToolInstallation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.requirements = self.root / 'py/free2z/requirements'
        self.requirements.mkdir(parents=True)
        self.wheel = self.root / 'locked_fixture-1.0-py3-none-any.whl'
        entries = {
            'locked_fixture.py': 'VALUE = 1\n',
            'locked_fixture-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: locked-fixture\nVersion: 1.0\n',
            'locked_fixture-1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
        }
        entries['locked_fixture-1.0.dist-info/RECORD'] = ''.join(f'{name},,\n' for name in entries) + 'locked_fixture-1.0.dist-info/RECORD,,\n'
        with zipfile.ZipFile(self.wheel, 'w') as wheel:
            for name, data in entries.items(): wheel.writestr(name, data)
        self.digest = hashlib.sha256(self.wheel.read_bytes()).hexdigest()
        self.environment = patch.dict(os.environ, {'RUNNER_TEMP': str(self.root), 'PIP_NO_INDEX': '1', 'PIP_FIND_LINKS': str(self.root)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.commands = []

    def execute(self, arguments, **kwargs):
        self.commands.append(arguments)
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        result = subprocess.run(arguments, **kwargs)
        if arguments[1:4] == ['-I', '-m', 'venv']:
            # Reproduce a package supplied by venv/bootstrap before acceptance.
            python = Path(arguments[-1]) / 'bin/python'
            subprocess.run([str(python), '-m', 'pip', 'install', '--no-index', str(self.wheel)], check=True, capture_output=True, timeout=30)
        return result

    def lock(self, digest):
        (self.requirements / 'ci-policy.txt').write_text(f'locked-fixture==1.0 --hash=sha256:{digest}\n')

    def test_correct_hash_reinstalls_and_checks_consistency(self):
        self.lock(self.digest)
        python = installer.install('ci-policy', root=self.root, execute=self.execute)
        self.assertTrue(python.is_file())
        install_command = self.commands[1]
        self.assertIn('--ignore-installed', install_command)
        self.assertIn('--require-hashes', install_command)
        self.assertIn('--only-binary=:all:', install_command)
        self.assertEqual(self.commands[-1][-3:], ['-m', 'pip', 'check'])

    def test_bad_hash_of_already_installed_package_fails_and_cleans(self):
        self.lock('0' * 64)
        with self.assertRaises(subprocess.CalledProcessError) as error:
            installer.install('ci-policy', root=self.root, execute=self.execute)
        self.assertIn(b'DO NOT MATCH THE HASHES', error.exception.stderr)
        self.assertEqual(list(self.root.glob('free2z-ci-policy-*')), [])
        self.assertEqual(len(self.commands), 2)

    def test_verify_only_removes_successful_environment(self):
        self.lock(self.digest)
        self.assertIsNone(installer.install('ci-policy', verify_only=True, root=self.root, execute=self.execute))
        self.assertEqual(list(self.root.glob('free2z-ci-policy-*')), [])

    def test_unknown_kind_never_executes(self):
        with self.assertRaises(ValueError):
            installer.install('../main', root=self.root, execute=self.execute)
        self.assertEqual(self.commands, [])


if __name__ == '__main__':
    unittest.main()
