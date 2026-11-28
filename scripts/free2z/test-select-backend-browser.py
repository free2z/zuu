#!/usr/bin/env python3
"""Exercise browser dependency selection through real pytest-split collection."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SELECTOR = Path(__file__).with_name('select-backend-browser.py')
NODES = (
    'dj/apps/dyte/test_producer.py::test_controlled_browser_real_django_flow',
    'dj/apps/dyte/test_producer_pooling.py::test_controlled_browser_roundtrip_through_transaction_pool',
)


class BackendBrowserSelection(unittest.TestCase):
    def test_actual_collection_tracks_both_browser_nodes_when_assignment_moves(self):
        with tempfile.TemporaryDirectory(prefix='backend-browser-collection-') as directory:
            root = Path(directory)
            (root / 'pytest.ini').write_text('[pytest]\n')
            for node in (*NODES, 'test_plain.py::test_other'):
                file, name = node.split('::')
                path = root / file
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f'def {name}():\n    raise AssertionError("collection must never execute tests")\n')

            def select(group, durations):
                (root / 'durations.json').write_text(json.dumps(durations))
                output = root / f'output-{group}'
                output.unlink(missing_ok=True)
                env = {**os.environ, 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
                       'GITHUB_OUTPUT': str(output),
                       'BACKEND_TEST_COMMAND': f'python -m pytest -p pytest_split.plugin --splits 2 --group {group} --splitting-algorithm least_duration --durations-path durations.json'}
                result = subprocess.run([sys.executable, str(SELECTOR)], cwd=root, env=env,
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return output.read_text(), result.stdout

            durations = {NODES[0]: 10, NODES[1]: 10, 'test_plain.py::test_other': 1000}
            output, log = select(1, durations)
            self.assertEqual(output, 'required=false\n')
            output, log = select(2, durations)
            self.assertEqual(output, 'required=true\n')
            for node in NODES:
                self.assertIn(node, log)
            durations[NODES[0]] = 2000
            output, log = select(1, durations)
            self.assertEqual(output, 'required=true\n')
            self.assertIn(NODES[0], log)
            output, log = select(2, durations)
            self.assertEqual(output, 'required=true\n')
            self.assertIn(NODES[1], log)
            # Failed collection must never turn into a false/no-browser result.
            (root / 'test_plain.py').write_text('this is invalid python !\n')
            with self.assertRaises(AssertionError):
                select(1, durations)

    def test_other_runner_cannot_report_a_successful_selection(self):
        with tempfile.TemporaryDirectory(prefix='backend-browser-invalid-') as directory:
            output = Path(directory) / 'output'
            result = subprocess.run([sys.executable, str(SELECTOR)],
                                    env={**os.environ, 'BACKEND_TEST_COMMAND': 'echo no-tests', 'GITHUB_OUTPUT': str(output)},
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
