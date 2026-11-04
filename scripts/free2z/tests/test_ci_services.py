"""Service failures are diagnosable without disclosing daemon arguments."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "ci-services.py"
spec = importlib.util.spec_from_file_location("owned_ci_services", SCRIPT)
services = importlib.util.module_from_spec(spec)
spec.loader.exec_module(services)


class ServiceDiagnostics(unittest.TestCase):
    def test_nonzero_docker_error_keeps_only_static_reason_and_status(self):
        for output, category in (
            ('bind: address already in use', 'port unavailable'),
            ('Cannot connect to the Docker daemon', 'daemon unavailable'),
            ('x509: certificate signed by unknown authority', 'certificate verification failed'),
            ('unauthorized: authentication required', 'registry authorization failed'),
            ('an unrecognized daemon response', 'unclassified failure'),
        ):
            with self.subTest(category=category):
                result = subprocess.CompletedProcess([], 125, stdout='sensitive-fixture-value', stderr=output + ' sensitive-fixture-value')
                with patch.object(services.subprocess, 'run', return_value=result) as run:
                    with self.assertRaises(services.ServiceFailure) as failure:
                        services.docker(['run', '--env', 'PASSWORD=sensitive-fixture-value'])
                self.assertEqual(str(failure.exception), f'Docker run exited 125: {category}')
                self.assertEqual(run.call_count, 1)

    def test_timeout_never_echoes_command_or_captured_output(self):
        failure = subprocess.TimeoutExpired(['docker', 'run', 'sensitive-fixture-value'], 60, output='sensitive-fixture-value')
        with patch.object(services.subprocess, 'run', side_effect=failure):
            with self.assertRaisesRegex(services.ServiceFailure, '^Docker inspect timed out after 60 seconds$'):
                services.docker(['inspect', 'sensitive-fixture-value'])

    def test_process_launch_failure_never_echoes_os_message(self):
        with patch.object(services.subprocess, 'run', side_effect=OSError('sensitive-fixture-value')):
            with self.assertRaisesRegex(services.ServiceFailure, '^Docker rm could not start$'):
                services.docker(['rm', 'sensitive-fixture-value'])

    def test_success_returns_identifier_without_diagnostic_output(self):
        identifier = 'a' * 64
        result = subprocess.CompletedProcess([], 0, stdout=identifier + '\n', stderr='')
        with patch.object(services.subprocess, 'run', return_value=result):
            self.assertEqual(services.docker(['run']), identifier + '\n')

    def test_unknown_created_container_is_never_discovered_or_removed(self):
        calls = []
        def execute(arguments):
            calls.append(arguments)
            raise services.ServiceFailure('Docker run exited 125: unclassified failure')
        with tempfile.TemporaryDirectory() as directory:
            environment = {'DBUSER': 'fixture', 'DBPASS': 'fixture', 'DBNAME': 'fixture', 'GITHUB_OUTPUT': str(Path(directory) / 'outputs')}
            with self.assertRaises(services.ServiceFailure):
                services.start(True, False, environment, execute=execute)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], 'run')

    def test_unhealthy_service_cleans_up_only_returned_identifier(self):
        identifier = 'b' * 64
        calls = []
        def execute(arguments):
            calls.append(arguments)
            if arguments[0] == 'run': return identifier
            if arguments[0] == 'inspect': return '{"Status":"exited"}'
            return ''
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'outputs'
            environment = {'GITHUB_OUTPUT': str(output)}
            with self.assertRaisesRegex(services.ServiceFailure, 'redis exited or is unhealthy'):
                services.start(False, True, environment, execute=execute)
            self.assertEqual(output.read_text(), f'redis_id={identifier}\n')
        self.assertEqual(calls[-1], ['rm', '--force', '--volumes', identifier])
        self.assertEqual(len(calls), 3)


if __name__ == '__main__':
    unittest.main()
