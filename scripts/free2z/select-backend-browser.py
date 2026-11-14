#!/usr/bin/env python3
"""Install browser dependencies only for the shard that actually collects them."""
import os
from pathlib import Path
import shlex

import pytest


BROWSER_NODES = frozenset({
    'dj/apps/dyte/test_producer.py::test_controlled_browser_real_django_flow',
    'dj/apps/dyte/test_producer_pooling.py::test_controlled_browser_roundtrip_through_transaction_pool',
})


class Selection:
    nodes = None

    def pytest_collection_finish(self, session):
        # pytest-split has already deselected every other shard here. Do not
        # guess assignment from file names, counts or uncommitted timings.
        self.nodes = [item.nodeid for item in session.items]


def selected_browser_nodes(command):
    runner = shlex.split(command)
    if runner[:3] != ['python', '-m', 'pytest']:
        raise ValueError('browser selection requires the exact backend pytest runner')
    selection = Selection()
    status = pytest.main([*runner[3:], '--collect-only', '-qq'], plugins=[selection])
    if status != pytest.ExitCode.OK or not selection.nodes:
        raise RuntimeError('backend browser dependency collection failed or selected no tests')
    return sorted(BROWSER_NODES.intersection(selection.nodes))


def main():
    nodes = selected_browser_nodes(os.environ['BACKEND_TEST_COMMAND'])
    print('Backend browser integration nodes: ' + (', '.join(nodes) or 'none in this shard'))
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write('required=' + str(bool(nodes)).lower() + '\n')


if __name__ == '__main__':
    main()
