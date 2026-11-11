#!/usr/bin/env python3
"""Check Free2Z's source census and preserve independently recorded triage."""
import argparse
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'docs/free2z/modernization/source-inventory.json'
SCOPE = ROOT / 'scripts/free2z/source-inventory-scope.json'


def validate_scope(scope):
    if set(scope) != {'version', 'roots', 'excluded_extensions', 'excluded_names'} or scope['version'] != 1:
        raise ValueError('invalid scope manifest')
    expected = {'django', 'svelte', 'react', 'docs'}
    if set(scope['roots']) != expected or any(not isinstance(v, str) or not v or v.startswith('/') or '..' in Path(v).parts for v in scope['roots'].values()):
        raise ValueError('invalid owned roots')
    if len(set(scope['roots'].values())) != len(expected) or any(not isinstance(v, list) or not all(isinstance(x, str) and x for x in v) for v in (scope['excluded_extensions'], scope['excluded_names'])):
        raise ValueError('invalid exclusions')


def classify(path, scope):
    parts = Path(path).parts
    p = Path(path)
    for name, root in scope['roots'].items():
        if path.startswith(root + '/'):
            break
    else:
        return None, None
    if any(x in parts for x in ('tests', '__tests__', 'migrations', '__pycache__')) or re.search(r'\.(test|spec)\.', p.name):
        return None, 'tests-or-migrations'
    if name == 'django' and 'templates' in parts:
        kind = 'django-template'
    elif name == 'django' and p.suffix == '.py':
        kind = 'django-python'
    elif name == 'svelte' and p.suffix in ('.svelte', '.ts', '.js'):
        kind = 'svelte-route-source' if '/routes/' in path else 'svelte-source'
    elif name == 'react' and p.suffix in ('.tsx', '.ts', '.jsx', '.js'):
        kind = 'classic-react-source'
    elif name == 'docs' and p.suffix in ('.md', '.mdx', '.html', '.svelte', '.tsx', '.jsx'):
        kind = 'public-documentation'
    elif p.suffix in scope['excluded_extensions'] or p.name in scope['excluded_names']:
        return None, 'non-inventory-asset'
    else:
        raise ValueError(f'unclassified file in {name} root: {path}')
    subsystem = parts[4] if name == 'django' and len(parts) > 4 and parts[3] == 'apps' else {'django': 'django-core', 'svelte': 'svelte', 'react': 'classic-react', 'docs': 'documentation'}[name]
    return {'path': path, 'subsystem': subsystem, 'kind': kind}, None


def facts(path, kind, content):
    result = []
    if kind == 'django-python':
        tree = ast.parse(content, filename=path)
        for node in ast.walk(tree):
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                bases = [ast.unparse(x) for x in getattr(node, 'bases', [])]
                decorators = [ast.unparse(x) for x in node.decorator_list]
                if any(re.search(r'(Model|ViewSet|APIView|View|Task)$', x) for x in bases) or any(re.search(r'(^|\.)(shared_task|task)(\(|$)', x) for x in decorators):
                    result.append({'type': 'declaration', 'name': node.name, 'line': node.lineno})
            if isinstance(node, ast.Call):
                name = ast.unparse(node.func)
                if name in ('path', 're_path', 'url', 'include') or name.endswith('.register'):
                    result.append({'type': 'registration', 'name': name, 'line': node.lineno})
    elif kind == 'svelte-route-source':
        result.append({'type': 'route-file', 'name': Path(path).name, 'line': 1})
    elif kind in ('svelte-source', 'classic-react-source') and Path(path).suffix in ('.svelte', '.tsx', '.jsx'):
        result.append({'type': 'component-candidate', 'name': Path(path).name, 'line': 1})
    return sorted(result, key=lambda x: (x['line'], x['type'], x['name']))


def validate_triage(t):
    if set(t) != {'owner', 'disposition', 'evidence', 'issue'} or not isinstance(t['owner'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._-]*', t['owner']):
        raise ValueError('invalid triage fields or owner')
    combinations = {'work-remaining': {'unreviewed-source', 'source-only', 'runtime', 'not-verifiable'}, 'reviewed': {'source-only', 'runtime'}, 'accepted-downstream': {'unreviewed-source', 'source-only', 'runtime', 'not-verifiable'}}
    if t['disposition'] not in combinations or t['evidence'] not in combinations[t['disposition']]:
        raise ValueError('invalid disposition/evidence')
    if not isinstance(t['issue'], str) or (t['issue'] and not re.fullmatch(r'https://github\.com/free2z/zuu/issues/[1-9][0-9]*', t['issue'])) or (t['disposition'] == 'accepted-downstream' and not t['issue']):
        raise ValueError('invalid downstream issue link')


def inventory(root, paths, scope, previous):
    validate_scope(scope)
    old = {}
    for row in previous.get('rows', []):
        if row['path'] in old:
            raise ValueError('duplicate inventory path')
        # Migrate the former generated product/subsystem label without changing
        # any disposition, evidence, issue, or independently assigned owner.
        triage = dict(row['triage'])
        if triage.get('owner') == 'free2z' + '/' + row['subsystem']:
            triage['owner'] = 'free2z'
        validate_triage(triage)
        old[row['path']] = {**row, 'triage': triage}
    rows, census = [], Counter()
    for path in sorted(set(paths)):
        row, excluded = classify(path, scope)
        if row is None and excluded is None:
            continue
        target = root / path
        if target.is_symlink() or any(p.is_symlink() for p in target.parents if p != root and root in p.parents):
            raise ValueError(f'symlink in owned scope: {path}')
        if excluded:
            census[excluded] += 1
            continue
        content = target.read_bytes()
        row['sha256'] = hashlib.sha256(content).hexdigest()
        row['facts'] = facts(path, row['kind'], content)
        prior = old.get(path, {})
        default = {'owner': 'free2z', 'disposition': 'work-remaining', 'evidence': 'unreviewed-source', 'issue': ''}
        row['triage'] = prior.get('triage', default) if prior.get('sha256') == row['sha256'] and prior.get('kind') == row['kind'] and prior.get('subsystem') == row['subsystem'] else default
        rows.append(row)
        census[row['kind']] += 1
    return {'version': 2, 'granularity': 'source-file', 'census': dict(sorted(census.items())), 'rows': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    try:
        scope = json.loads(SCOPE.read_text())
        previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {}
        if previous.get('version') == 1:
            previous = {}  # one-time migration from the original unreviewed seed
        paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
        paths = [p for p in paths if p and ((ROOT / p).exists() or (ROOT / p).is_symlink())]
        data = json.dumps(inventory(ROOT, paths, scope, previous), indent=2, ensure_ascii=False) + '\n'
        if args.write:
            OUTPUT.write_text(data)
            print(f'wrote {OUTPUT.relative_to(ROOT)}')
        elif not OUTPUT.exists() or OUTPUT.read_text() != data:
            print('Inventory differs from source; inspect changes and run --write.', file=sys.stderr)
            return 1
        else:
            print('Free2Z source inventory matches source')
    except (ValueError, KeyError, SyntaxError, OSError) as exc:
        print(f'inventory error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
