#!/usr/bin/env python3
"""Dispatch one host preparation from successful website publication metadata.

Only trusted default-branch code runs here. Release bytes, application modules,
package installers and build artifacts never execute with the Actions token.
The host producer independently verifies all release signatures and contents.
"""
import http.client
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = 'free2z/zuu'
PREFIX = '/repos/' + REPOSITORY
WEB = '.github/workflows/free2z-web-release.yml'
HOST = '.github/workflows/free2z-host-release.yml'
DISPATCH = '.github/workflows/free2z-web-host-dispatch.yml'


def api(method, path, body=None):
    """Fixed API origin, bounded response, no redirects or automatic POST retry."""
    if not path.startswith(PREFIX + '/'):
        raise ValueError('unexpected API scope')
    connection = http.client.HTTPSConnection('api.github.com', timeout=30)
    try:
        connection.request(method, path, None if body is None else json.dumps(body), {
            'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
            'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'free2z-paired-publication',
        })
        response = connection.getresponse()
        data = response.read(4 * 1024 ** 2 + 1)
        if response.status != 200 or len(data) > 4 * 1024 ** 2:
            raise ValueError('GitHub rejected bounded publication request')
        return json.loads(data)
    finally:
        connection.close()


def positive(value):
    return type(value) is int and 0 < value < 10 ** 16


def trusted_run(run):
    if (not positive(run.get('id')) or not positive(run.get('run_attempt'))
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('path') != WEB or run.get('event') not in ('push', 'workflow_dispatch')
            or run.get('head_branch') != 'main'
            or not re.fullmatch('[0-9a-f]{40}', run.get('head_sha', ''))
            or run.get('repository', {}).get('full_name') != REPOSITORY
            or run.get('head_repository', {}).get('full_name') != REPOSITORY
            or run.get('head_repository', {}).get('fork') is not False):
        raise ValueError('website run is not a successful trusted-main publication')
    return run['id'], run['run_attempt'], run['head_sha']


def current(commit, request):
    branch = request('GET', PREFIX + '/branches/main')
    if branch.get('name') != 'main' or branch.get('protected') is not True:
        raise ValueError('main must be protected')
    return branch.get('commit', {}).get('sha') == commit


def dispatch(event, environment, checkout, request=api):
    if (environment.get('GITHUB_REPOSITORY') != REPOSITORY
            or environment.get('GITHUB_EVENT_NAME') != 'workflow_run'
            or environment.get('GITHUB_REF') != 'refs/heads/main'
            or environment.get('GITHUB_REF_PROTECTED') != 'true'
            or environment.get('GITHUB_WORKFLOW_REF') != REPOSITORY + '/' + DISPATCH + '@refs/heads/main'
            or environment.get('GITHUB_SHA') != checkout
            or not re.fullmatch('[0-9a-f]{40}', checkout)
            or event.get('action') != 'completed'
            or event.get('repository', {}).get('full_name') != REPOSITORY
            or event.get('repository', {}).get('default_branch') != 'main'):
        raise ValueError('dispatcher requires its trusted protected-default-branch checkout')
    identifier, attempt, commit = trusted_run(event['workflow_run'])
    # Re-read the immutable attempt; a newer failed rerun cannot borrow its success.
    run = request('GET', PREFIX + f'/actions/runs/{identifier}/attempts/{attempt}')
    if trusted_run(run) != (identifier, attempt, commit):
        raise ValueError('website invocation differs from completion event')
    if checkout != commit or not current(commit, request):
        return 'Superseded website source; publish a complete website/host pair from current main.'
    tag = f'free2z-web-{commit}-{identifier}-{attempt}'
    release = request('GET', PREFIX + '/releases/tags/' + tag)
    assets = release.get('assets', [])
    matching = [a for a in assets if a.get('name') == 'free2z-release.zip']
    if (release.get('tag_name') != tag or release.get('target_commitish') != commit
            or release.get('draft') is not False or not release.get('published_at')
            or len(matching) != 1 or matching[0].get('state') != 'uploaded'
            or not positive(matching[0].get('size'))
            or not re.fullmatch('sha256:[0-9a-f]{64}', matching[0].get('digest', ''))):
        raise ValueError('website release evidence is missing or has a different source')
    ref = request('GET', PREFIX + '/git/ref/tags/' + tag)
    if ref.get('object') != {'type': 'commit', 'sha': commit, 'url': 'https://api.github.com' + PREFIX + '/git/commits/' + commit}:
        raise ValueError('website tag does not identify the exact source commit')
    artifacts = request('GET', PREFIX + f'/actions/runs/{identifier}/artifacts?per_page=100')
    if type(artifacts.get('total_count')) is not int or not 0 <= artifacts['total_count'] <= 100:
        raise ValueError('website artifact listing exceeds bounded inspection')
    name = f'free2z-release-{commit}-{identifier}-{attempt}'
    matching = [a for a in artifacts['artifacts'] if a.get('name') == name]
    if (len(matching) != 1 or matching[0].get('expired') is not False
            or matching[0].get('workflow_run', {}).get('id') != identifier
            or matching[0].get('workflow_run', {}).get('head_sha') != commit):
        raise ValueError('website invocation artifact is missing or mismatched')
    # The run title binds the exact web attempt, including on retries. Failed runs
    # also retain this identity: recovery explicitly re-runs that entire host run.
    runs = request('GET', PREFIX + '/actions/workflows/free2z-host-release.yml/runs'
                   + f'?event=workflow_dispatch&branch=main&head_sha={commit}&per_page=100')
    if type(runs.get('total_count')) is not int or not 0 <= runs['total_count'] <= 100:
        raise ValueError('host history exceeds bounded duplicate inspection')
    for run in runs['workflow_runs']:
        if run.get('display_title') != 'Free2Z host preparation ' + tag:
            continue
        if (run.get('path') != HOST or run.get('event') != 'workflow_dispatch'
                or run.get('head_sha') != commit or run.get('head_branch') != 'main'
                or run.get('repository', {}).get('full_name') != REPOSITORY
                or run.get('head_repository', {}).get('full_name') != REPOSITORY
                or not positive(run.get('id'))):
            raise ValueError('host run identity is inconsistent')
        return f"Host run {run['id']} already owns this website release; inspect it and re-run all jobs if recovery is needed."
    # Recheck after API reads. A move after this check fails the host's independent
    # exact-source check; it cannot create a mixed-source preparation.
    if not current(commit, request):
        return 'Main advanced before dispatch; publish a complete pair from current main.'
    accepted = request('POST', PREFIX + '/actions/workflows/free2z-host-release.yml/dispatches',
                       {'ref': 'main', 'inputs': {'web_release_tag': tag}})
    # API 2026-03-10 returns HTTP 200 plus the accepted run identity, not 204.
    run_id = accepted.get('workflow_run_id')
    if (not positive(run_id)
            or accepted.get('run_url') != 'https://api.github.com' + PREFIX + f'/actions/runs/{run_id}'
            or accepted.get('html_url') != f'https://github.com/{REPOSITORY}/actions/runs/{run_id}'):
        raise ValueError('dispatch acceptance has an invalid run identity; inspect host runs before retrying')
    return 'Dispatched host preparation for ' + tag + ': ' + accepted['html_url']


if __name__ == '__main__':
    path = Path(os.environ['GITHUB_EVENT_PATH'])
    if path.stat().st_size > 4 * 1024 ** 2:
        raise SystemExit('oversized completion event')
    checkout = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    result = dispatch(json.loads(path.read_bytes()), os.environ, checkout)
    print(result)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(result + '\n')
