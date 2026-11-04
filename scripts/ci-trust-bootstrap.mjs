// Reviewed pre-checkout execution program. Update the immutable source and hash
// together after independently reviewing and testing the shared helper.
export const helperCommit = '086efd078bf7179df466449f194d716916e11305';
export const helperSha256 = 'ba1fe4e0b829fdb18dd619751479fbafdd791ecc51b834f3399cb972d8ddf167';
export const bootstrapStep = `      - name: Select verified CI trust before clients
        shell: bash
        working-directory: \${{ runner.temp }}
        env:
          CI_TRUST_CONTAINER: \${{ job.container.id != '' && '1' || '0' }}
        run: |
          if [[ "$RUNNER_OS" == Windows ]]; then ci_python=python; else ci_python=python3; fi
          "$ci_python" -I - <<'PY'
          import hashlib, os, pathlib, subprocess, sys, urllib.request
          url = 'https://raw.githubusercontent.com/corpora-inc/encorpora/${helperCommit}/.github/scripts/ci_trust.py'
          opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
          with opener.open(url, timeout=30) as response:
              if response.url != url: raise SystemExit('Unexpected CI helper redirect')
              data = response.read(50001)
          if len(data) > 50000 or hashlib.sha256(data).hexdigest() != '${helperSha256}':
              raise SystemExit('CI helper checksum mismatch')
          mode = os.environ['CI_TRUST_CONTAINER']
          if mode not in ('0', '1'): raise SystemExit('Unclassified CI container context')
          path = pathlib.Path(os.environ['RUNNER_TEMP']) / 'corpora-ci-trust-bootstrap.py'
          with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
              output.write(data)
          subprocess.run([sys.executable, '-I', str(path), '--source-commit', '${helperCommit}'] + (['--clients-only'] if mode == '1' else []), check=True)
          PY
`;
