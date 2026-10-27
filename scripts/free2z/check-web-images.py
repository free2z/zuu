#!/usr/bin/env python3
"""Exercise the actual release image under the deployed runtime restrictions."""
import argparse
import json
import subprocess
import time


def run(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=180)


def inspect(kind, image, commit):
    metadata = json.loads(run('image', 'inspect', image))[0]
    labels = metadata['Config'].get('Labels') or {}
    if labels.get('org.opencontainers.image.revision') != commit or labels.get('org.opencontainers.image.source') != 'https://github.com/free2z/zuu':
        raise ValueError('image source identity mismatch')
    options = ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs=/tmp:rw,noexec,nosuid,size=128m', '--user=1000:1000']
    if kind == 'backend':
        program = "import importlib.util,os; assert os.environ['BUILD_SHA']==" + repr(commit) + "; assert importlib.util.find_spec('pytest_settings') is None; assert importlib.util.find_spec('pytest') is None; import django; django.setup(); import dj.free2z.urls; import dj.apps.g12f.paymentd_runtime; import zcashrpc.nodewatch; from django.core.management import call_command; call_command('check')"
        print(run(*options, '-e', 'DJANGO_SETTINGS_MODULE=dj.free2z.settings', '-e', 'OPENAPI_GEN=1', '-e', 'SECRET_KEY=fixture-image-import-check-not-a-production-key', image, '-c', program))
    elif kind == 'web':
        print(run(*options, '--entrypoint=node', image, 'scripts/check-og-runtime.mjs'))
        print(run(*options, '--entrypoint=node', image, '-e', "const fs=require('fs');for(const p of ['/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/corepack','/usr/local/bin/yarn'])if(fs.existsSync(p))throw Error(p);if(process.env.PUBLIC_BUILD_SHA!=="+repr(commit)+")throw Error('source identity');import('./build/handler.js')"))
    elif kind == 'static':
        print(run(*options, '--entrypoint=/usr/sbin/nginx', image, '-t'))
        version = run(*options, '--entrypoint=sh', image, '-ec', '/usr/sbin/nginx -V 2>&1; test -s /base/build/index.html; test -s /base/docsbuild/index.html; test -d /base/dj/free2z/static/admin; test -s /base/bridge-pages/site/free2z.html')
        if '--add-module=/nginx-vod-module' not in version:
            raise ValueError('static server is missing VOD support')
        print(version)
    else:
        raise ValueError('unknown image kind')
    http_smoke(kind, image, commit, options)


def http_smoke(kind, image, commit, options):
    """Probe real listeners inside isolated containers, with no host port exposure."""
    launch = [argument for argument in options if argument != '--rm'] + ['--detach']
    if kind == 'backend':
        launch += ['-e', 'DJANGO_SETTINGS_MODULE=dj.free2z.settings', '-e', 'OPENAPI_GEN=1',
                   '-e', 'SECRET_KEY=fixture-image-http-check-not-a-production-key',
                   '-e', 'HOME=/tmp', image, '-m', 'gunicorn', 'dj.free2z.wsgi:application',
                   '--bind', '127.0.0.1:8000', '--workers', '1', '--no-control-socket']
        probe = ['python', '-c', "import json,urllib.request; v=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/healthz',timeout=3)); assert v['ok'] is True and v['commit']=="+repr(commit)]
    elif kind == 'web':
        launch += ['-e', 'HOST_HEADER=host', '-e', 'PROTOCOL_HEADER=x-forwarded-proto',
                   '-e', 'DEPLOYMENT_SHA=' + 'd' * 40, '-e', 'APP_RELEASE_ID=sha256:' + 'e' * 64, image]
        probe = ['node', '-e', "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(r.status!==200)throw Error(r.status);const v=await r.json();if(v.ok!==true||v.commit!=="+repr(commit)+"||v.deployment_commit!=='"+'d'*40+"'||v.release_id!=='sha256:"+'e'*64+"')throw Error('identity')}).catch(e=>{console.error(e);process.exit(1)})"]
    else:
        launch += [image]
        probe = ['sh', '-ec', r'''wget -qO- http://127.0.0.1:8080/healthz | grep -qx ok; wget -qO /tmp/docs.html http://127.0.0.1:8080/docs/; asset=$(grep -oE '/docs/assets/[^" ]+\.js' /tmp/docs.html | head -1); test -n "$asset"; wget -qO /tmp/asset.js "http://127.0.0.1:8080$asset"; test -s /tmp/asset.js; ! grep -q '<!doctype html' /tmp/asset.js; wget -qO /tmp/admin.css http://127.0.0.1:8080/djstatic/admin/css/base.css; test -s /tmp/admin.css; wget -qO /tmp/classic.html http://127.0.0.1:8080/; test -s /tmp/classic.html''']
    identifier = run(*launch).strip()
    try:
        for attempt in range(45):
            result = subprocess.run(['docker', 'exec', identifier, *probe], capture_output=True, text=True, timeout=20)
            if result.returncode == 0:
                print(kind + ' HTTP listener and content checks passed')
                return
            if attempt == 44:
                raise RuntimeError(kind + ' HTTP check failed: ' + result.stderr[-3000:])
            time.sleep(1)
    finally:
        run('rm', '--force', '--volumes', identifier)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('kind', choices=['backend', 'web', 'static'])
    p.add_argument('image')
    p.add_argument('commit')
    a = p.parse_args()
    inspect(a.kind, a.image, a.commit)
