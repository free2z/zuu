import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('paired', ROOT / 'scripts/free2z/dispatch-host-release.py')
paired = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paired)


class PairedPublication(unittest.TestCase):
    def setUp(self):
        self.commit = 'a' * 40
        self.tag = f'free2z-web-{self.commit}-123-2'
        self.run = dict(id=123, run_attempt=2, status='completed', conclusion='success',
                        path=paired.WEB, event='push', head_branch='main', head_sha=self.commit,
                        repository={'full_name': paired.REPOSITORY},
                        head_repository={'full_name': paired.REPOSITORY, 'fork': False})
        self.event = dict(action='completed', workflow_run=copy.deepcopy(self.run),
                          repository={'full_name': paired.REPOSITORY, 'default_branch': 'main'})
        self.environment = dict(GITHUB_REPOSITORY=paired.REPOSITORY,
                                GITHUB_EVENT_NAME='workflow_run', GITHUB_REF='refs/heads/main',
                                GITHUB_REF_PROTECTED='true', GITHUB_SHA=self.commit,
                                GITHUB_WORKFLOW_REF=paired.REPOSITORY + '/' + paired.DISPATCH + '@refs/heads/main')
        self.branch = dict(name='main', protected=True, commit={'sha': self.commit})
        self.release = dict(tag_name=self.tag, target_commitish=self.commit, draft=False,
                            published_at='2026-01-01T00:00:00Z', assets=[
                                dict(name='free2z-release.zip', state='uploaded', size=123,
                                     digest='sha256:' + 'b' * 64)])
        self.ref = dict(object={'type': 'commit', 'sha': self.commit,
                               'url': 'https://api.github.com' + paired.PREFIX + '/git/commits/' + self.commit})
        self.artifacts = dict(total_count=1, artifacts=[
            dict(name=f'free2z-release-{self.commit}-123-2', expired=False,
                 workflow_run=dict(id=123, head_sha=self.commit))])
        self.runs = dict(total_count=0, workflow_runs=[])
        self.accepted = dict(workflow_run_id=456,
                             run_url='https://api.github.com' + paired.PREFIX + '/actions/runs/456',
                             html_url='https://github.com/' + paired.REPOSITORY + '/actions/runs/456')
        self.calls = []
        self.advance_on_final_check = False

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == 'POST':
            return self.accepted
        if path.endswith('/branches/main'):
            if self.advance_on_final_check and sum(p.endswith('/branches/main') for _, p, _ in self.calls) > 1:
                return {**self.branch, 'commit': {'sha': 'b' * 40}}
            return self.branch
        if '/attempts/' in path:
            return self.run
        if '/releases/tags/' in path:
            return self.release
        if '/git/ref/' in path:
            return self.ref
        if '/artifacts?' in path:
            return self.artifacts
        if '/workflows/free2z-host-release.yml/runs?' in path:
            return self.runs
        raise AssertionError(path)

    def invoke(self):
        return paired.dispatch(self.event, self.environment, self.commit, self.request)

    def posts(self):
        return [c for c in self.calls if c[0] == 'POST']

    def test_success_dispatches_exact_tag_to_main_once(self):
        self.assertIn('Dispatched', self.invoke())
        self.assertEqual(self.posts(), [('POST', paired.PREFIX + '/actions/workflows/free2z-host-release.yml/dispatches',
                                        {'ref': 'main', 'inputs': {'web_release_tag': self.tag}})])

    def test_manual_web_publication_is_supported(self):
        self.event['workflow_run']['event'] = self.run['event'] = 'workflow_dispatch'
        self.invoke()
        self.assertEqual(len(self.posts()), 1)

    def test_untrusted_dispatcher_context_never_dispatches(self):
        for key, value in [('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_REF', 'refs/heads/branch'),
                           ('GITHUB_REF_PROTECTED', 'false'), ('GITHUB_REPOSITORY', 'fork/zuu'),
                           ('GITHUB_SHA', 'b' * 40), ('GITHUB_WORKFLOW_REF', 'other/workflow@main')]:
            with self.subTest(key=key):
                self.setUp()
                self.environment[key] = value
                with self.assertRaises(ValueError):
                    self.invoke()
                self.assertFalse(self.calls)

    def test_untrusted_upstream_event_and_live_run_never_dispatch(self):
        mutations = [lambda r: r.update(conclusion='failure'), lambda r: r.update(status='in_progress'),
                     lambda r: r.update(event='pull_request'), lambda r: r.update(head_branch='branch'),
                     lambda r: r.update(path='.github/workflows/impostor.yml'),
                     lambda r: r['head_repository'].update(full_name='fork/zuu'),
                     lambda r: r['head_repository'].update(fork=True),
                     lambda r: r.update(head_sha='not-a-sha'), lambda r: r.update(id=True),
                     lambda r: r.update(run_attempt=0)]
        for location in ('event', 'live'):
            for mutation in mutations:
                with self.subTest(location=location, mutation=mutation):
                    self.setUp()
                    mutation(self.event['workflow_run'] if location == 'event' else self.run)
                    with self.assertRaises(ValueError):
                        self.invoke()
                    self.assertFalse(self.posts())

    def test_attempt_or_source_substitution_never_dispatch(self):
        for field, value in [('run_attempt', 3), ('id', 456), ('head_sha', 'b' * 40)]:
            with self.subTest(field=field):
                self.setUp()
                self.run[field] = value
                with self.assertRaises(ValueError):
                    self.invoke()
                self.assertFalse(self.posts())

    def test_missing_mismatched_or_expired_evidence_never_dispatch(self):
        mutations = [lambda: self.release.update(assets=[]), lambda: self.release.update(draft=True),
                     lambda: self.release.update(target_commitish='main'),
                     lambda: self.release.update(tag_name='other'),
                     lambda: self.release['assets'][0].update(state='new'),
                     lambda: self.ref['object'].update(sha='b' * 40),
                     lambda: self.artifacts.update(artifacts=[]),
                     lambda: self.artifacts['artifacts'][0].update(expired=True),
                     lambda: self.artifacts['artifacts'][0].update(name='wrong-attempt'),
                     lambda: self.artifacts['artifacts'][0]['workflow_run'].update(head_sha='b' * 40),
                     lambda: self.artifacts.update(total_count=101)]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.setUp()
                mutation()
                with self.assertRaises(ValueError):
                    self.invoke()
                self.assertFalse(self.posts())

    def test_unprotected_main_is_rejected(self):
        self.branch['protected'] = False
        with self.assertRaises(ValueError):
            self.invoke()
        self.assertFalse(self.posts())

    def test_superseded_main_is_skipped_before_and_after_reads(self):
        self.branch['commit']['sha'] = 'b' * 40
        self.assertIn('Superseded', self.invoke())
        self.assertFalse(self.posts())
        self.setUp()
        self.advance_on_final_check = True
        self.assertIn('advanced', self.invoke())
        self.assertFalse(self.posts())

    def test_duplicate_retry_reuses_existing_run_including_failed_runs(self):
        for status, conclusion in [('queued', None), ('in_progress', None), ('completed', 'success'),
                                   ('completed', 'failure'), ('completed', 'cancelled')]:
            with self.subTest(status=status, conclusion=conclusion):
                self.setUp()
                host = {**self.run, 'id': 456, 'event': 'workflow_dispatch', 'path': paired.HOST,
                        'display_title': 'Free2Z host preparation ' + self.tag,
                        'status': status, 'conclusion': conclusion}
                self.runs = dict(total_count=1, workflow_runs=[host])
                self.assertIn('456 already owns', self.invoke())
                self.assertFalse(self.posts())

    def test_different_web_attempt_does_not_suppress_fresh_pair(self):
        self.runs = dict(total_count=1, workflow_runs=[dict(display_title='Free2Z host preparation ' + self.tag[:-1] + '1')])
        self.invoke()
        self.assertEqual(len(self.posts()), 1)

    def test_unbounded_history_and_inconsistent_duplicate_fail_closed(self):
        self.runs['total_count'] = 101
        with self.assertRaises(ValueError):
            self.invoke()
        self.assertFalse(self.posts())
        self.setUp()
        self.runs = dict(total_count=1, workflow_runs=[dict(display_title='Free2Z host preparation ' + self.tag)])
        with self.assertRaises(ValueError):
            self.invoke()
        self.assertFalse(self.posts())

    def test_dispatch_transport_failure_is_not_retried(self):
        def request(method, path, body=None):
            result = self.request(method, path, body)
            if method == 'POST':
                raise TimeoutError('outcome uncertain')
            return result
        with self.assertRaises(TimeoutError):
            paired.dispatch(self.event, self.environment, self.commit, request)
        self.assertEqual(len(self.posts()), 1)

    def test_dispatch_acceptance_requires_exact_returned_run_identity(self):
        for changes in [{'workflow_run_id': True}, {'run_url': 'https://evil.invalid/456'},
                        {'html_url': 'https://github.com/other/repo/actions/runs/456'}]:
            with self.subTest(changes=changes):
                self.setUp()
                self.accepted.update(changes)
                with self.assertRaises(ValueError):
                    self.invoke()
                self.assertEqual(len(self.posts()), 1)

    def test_raw_api_2026_dispatch_response_and_error_contract(self):
        # Exercise the transport adapter, not only dispatch()'s request stub.
        for status, payload, valid in [(200, self.accepted, True), (204, None, False),
                                       (302, {}, False), (403, {}, False), (500, {}, False)]:
            with self.subTest(status=status), patch.object(paired.http.client, 'HTTPSConnection') as connection, \
                    patch.dict(paired.os.environ, {'GH_TOKEN': 'test-placeholder'}):
                client = connection.return_value
                response = client.getresponse.return_value
                response.status = status
                response.read.return_value = b'' if payload is None else json.dumps(payload).encode()
                if valid:
                    self.assertEqual(paired.api('POST', paired.PREFIX + '/actions/workflows/free2z-host-release.yml/dispatches', {'ref': 'main'}), payload)
                else:
                    with self.assertRaises(ValueError):
                        paired.api('POST', paired.PREFIX + '/actions/workflows/free2z-host-release.yml/dispatches', {'ref': 'main'})
                self.assertEqual(client.request.call_count, 1)
                self.assertEqual(client.request.call_args.args[3]['X-GitHub-Api-Version'], '2026-03-10')
                connection.assert_called_once_with('api.github.com', timeout=30)
                client.close.assert_called_once()

    def test_workflow_privilege_and_source_boundary(self):
        workflow = (ROOT / paired.DISPATCH).read_text()
        self.assertIn('types: [completed]', workflow)
        self.assertIn('group: free2z-paired-publication-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}', workflow)
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertEqual(workflow.count('actions: write'), 1)
        for forbidden in ('secrets.', 'npm ', 'pip ', 'download-artifact', 'workflow_run.head_sha }}', 'id-token:', 'packages:'):
            self.assertNotIn(forbidden, workflow)
        release = (ROOT / paired.WEB).read_text()
        for path in ('rs/zcash-payment-hooks/**', 'rust-toolchain.toml', 'LICENSE', paired.HOST):
            self.assertIn('      - ' + path + '\n', release)
        host = (ROOT / paired.HOST).read_text()
        self.assertIn('run-name: Free2Z host preparation ${{ inputs.web_release_tag || github.ref }}', host)


if __name__ == '__main__':
    unittest.main()
