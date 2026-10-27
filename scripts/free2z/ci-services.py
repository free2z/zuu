#!/usr/bin/env python3
"""Run owned CI databases only after hosted daemon trust has been refreshed."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time


def checked_id(value):
    if not re.fullmatch(r'[0-9a-f]{64}', value):
        raise RuntimeError('CI service did not supply a full container ID')
    return value


def docker(arguments):
    result = subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Owned CI service Docker command failed')
    return result.stdout


def cleanup(identifiers, execute=docker):
    values = [checked_id(value) for value in identifiers if value]
    for value in values:
        execute(['rm', '--force', '--volumes', value])


def start(postgres, redis, environment=os.environ, execute=docker, sleep=time.sleep):
    created = []
    try:
        for name, image, arguments in service_arguments(postgres, redis, environment):
            identifier = checked_id(execute(['run', '--detach', *arguments, image]).strip())
            created.append(identifier)
            # Publish ownership before waiting so always() cleanup covers failures.
            with Path(environment['GITHUB_OUTPUT']).open('a') as output:
                output.write(name + '_id=' + identifier + '\n')
            for attempt in range(60):
                state = json.loads(execute(['inspect', '--format', '{{json .State}}', identifier]))
                health = state.get('Health', {}).get('Status')
                if state.get('Status') != 'running' or health == 'unhealthy':
                    raise RuntimeError('Owned CI service exited or is unhealthy')
                if health == 'healthy':
                    break
                sleep(1)
            else:
                raise RuntimeError('Owned CI service health check timed out')
        return created
    except BaseException:
        cleanup(created, execute)
        raise


def service_arguments(postgres, redis, environment):
    services = []
    if postgres:
        arguments = ['--publish', '127.0.0.1:5432:5432', '--health-cmd', 'pg_isready',
                     '--health-interval', '5s', '--health-timeout', '5s', '--health-retries', '10',
                     '--tmpfs', '/var/lib/postgresql/data:rw,size=1073741824']
        for source, target in (('DBUSER', 'POSTGRES_USER'), ('DBPASS', 'POSTGRES_PASSWORD'), ('DBNAME', 'POSTGRES_DB')):
            value = environment.get(source)
            if not value or '\n' in value or '\r' in value:
                raise RuntimeError('Missing CI PostgreSQL fixture setting')
            arguments += ['--env', target + '=' + value]
        services.append(('postgres', 'pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a', arguments))
    if redis:
        services.append(('redis', 'redis:7-alpine@sha256:6ba19c50b56777f5c11c58eff8ddb69d0d5f27ba131cffb63f180ccfd43c66af', ['--publish', '127.0.0.1:6379:6379',
                         '--health-cmd', 'redis-cli ping', '--health-interval', '5s',
                         '--health-timeout', '5s', '--health-retries', '10']))
    if not services:
        raise RuntimeError('No owned CI services requested')
    return services


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('start', 'cleanup'))
    parser.add_argument('--postgres', action='store_true')
    parser.add_argument('--redis', action='store_true')
    options = parser.parse_args()
    try:
        if options.command == 'start':
            start(options.postgres, options.redis)
        else:
            cleanup([os.environ.get('CI_POSTGRES_CONTAINER_ID', ''), os.environ.get('CI_REDIS_CONTAINER_ID', '')])
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print('::error::CI service operation failed: ' + type(error).__name__)
        raise SystemExit(1)
