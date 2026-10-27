#!/usr/bin/env python3
"""Run the complete website gate when application or its CI inputs change."""
import os
import hashlib
import json
import re
import subprocess
from pathlib import Path

PREFIXES = ('py/free2z/', 'ts/svelte/free2z/', 'ts/react/free2z/', 'ts/free2z/bridge/', 'docs/about-free2z/', 'docs/free2z/website/', 'build/free2z/', 'scripts/free2z/', '.github/')
FILES = {'scripts/check-ci-trust.mjs', 'scripts/ci-trust-bootstrap.mjs', 'scripts/check-github-actions-pins.mjs', 'ruff.toml'}


def selected(paths):
    return any(p in FILES or p.startswith(PREFIXES) for p in paths)


def complete(root, base_has_application, scaffold=None):
    present = (root / 'py/free2z/requirements/main.txt').is_file()
    if base_has_application and not present:
        raise ValueError('application production lock cannot be removed')
    if present:
        required = ('py/free2z/requirements/main.in', 'py/free2z/requirements/test.txt', 'py/free2z/dj/free2z/manage.py', 'py/free2z/dj/free2z/openapi/f2z.yaml', 'py/free2z/pytest_settings.py', 'py/free2z/dj/apps/jobs/test_periodic_register_first.py', 'ts/free2z/bridge/site/free2z.html', 'docs/free2z/website/package.json', 'ts/svelte/free2z/src/routes/[username]/private/[secret]/+page.svelte')
        if any(not (root / name).is_file() for name in required):
            raise ValueError('partial application import cannot pass the full gate')
    else:
        expected = scaffold if scaffold is not None else json.loads(Path(__file__).with_name('bootstrap-scaffold.json').read_text())
        actual = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in (root / 'py/free2z').rglob('*') if path.is_file() and '__pycache__' not in path.parts}
        if actual != expected:
            raise ValueError('only the exact pre-import public scaffold may use bootstrap mode')
    return present


if __name__ == '__main__':
    event = os.environ['EVENT']
    base_has_application = False
    if event == 'pull_request':
        base = os.environ['BASE_SHA']
        head = os.environ['HEAD_SHA']
        if not all(re.fullmatch('[0-9a-f]{40}', x) for x in (base, head)):
            raise SystemExit('missing exact comparison commits')
        paths = subprocess.check_output(['git', 'diff', '--name-only', '-z', base, head], text=True).split('\0')
        base_has_application = subprocess.run(['git', 'cat-file', '-e', base + ':py/free2z/requirements/main.txt'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        result = selected(paths)
    else:
        result = True
    present = complete(Path.cwd(), base_has_application)
    result = result and present
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write('complete=' + str(present).lower() + '\n')
        output.write('application=' + str(result).lower() + '\n')
