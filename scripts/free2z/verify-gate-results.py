#!/usr/bin/env python3
"""Require every selected application check to succeed, including all matrix legs."""
import json
import os


def verify(results):
    if not isinstance(results, dict) or len(results) < 2:
        raise ValueError('required job results are missing')
    changes = results.get('changes', {})
    if changes.get('result') != 'success':
        raise ValueError('application selection failed')
    selected = changes.get('outputs', {}).get('application')
    if selected not in ('true', 'false'):
        raise ValueError('application selection is not an exact boolean')
    expected = 'success' if selected == 'true' else 'skipped'
    for name, result in results.items():
        if name != 'changes' and result.get('result') != expected:
            raise ValueError(f'{name}: expected {expected}, received {result.get("result")}')


if __name__ == '__main__':
    verify(json.loads(os.environ['RESULTS']))
    print('Every selected application check passed')
