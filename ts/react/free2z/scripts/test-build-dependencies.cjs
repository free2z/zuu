const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Zod4 adapter preserves Formik validation and nested error paths', async () => {
  const { z } = require('zod');
  const { toFormikValidationSchema } = require('zod-formik-adapter');
  const schema = toFormikValidationSchema(z.object({ user: z.object({ password: z.string().min(8) }) }));
  await schema.validate({ user: { password: 'long-password' } });
  await assert.rejects(schema.validate({ user: { password: 'short' } }), (error) => {
    assert.equal(error.name, 'ValidationError');
    assert.equal(error.inner[0].path, 'user.password');
    return true;
  });
});

test('CommonJS SDK and bundler dependencies retain supported APIs', () => {
  const { v4, validate } = require('uuid');
  const serialize = require('serialize-javascript');
  const katex = require('katex');
  assert.equal(validate(v4()), true);
  assert.ok(!serialize({ value: '</script><script>alert(1)</script>' }).includes('</script>'));
  assert.match(katex.renderToString('x^2 + y^2'), /class="katex"/);
});

test('patched Axios preserves JSON transport and query parameters', async () => {
  const http = require('node:http');
  const axios = require('axios');
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ url: request.url, value: JSON.parse(body) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await axios.post(`http://127.0.0.1:${server.address().port}/fixture`, { amount: '1.25' }, { params: { page: 2 }, proxy: false });
    assert.deepEqual(response.data, { url: '/fixture?page=2', value: { amount: '1.25' } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('real development source endpoint validates Host before CRA middleware', { timeout: 30000 }, async () => {
  const { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  const http = require('node:http');
  const webpack = require('webpack');
  const DevServer = require('webpack-dev-server');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const createConfig = require('react-scripts/config/webpackDevServer.config');
  const configure = require('../config-overrides').devServer(createConfig);
  const options = configure(undefined, undefined);
  if (previous === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous;
  assert.equal(options.allowedHosts, 'auto', 'CRA no-proxy defaults must not disable validation');
  for (const present of [[], [{ name: 'host-header-check' }], [{ name: 'cross-origin-header-check' }]]) {
    assert.throws(() => options.setupMiddlewares(present, { stopCallback() {} }), /security guards are required/);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'free2z-classic-dev-'));
  let server;
  try {
    await writeFile(path.join(directory, 'fixture.js'), 'console.log("synthetic developer source");');
    const compiler = webpack({
      mode: 'development', context: directory, entry: './fixture.js',
      devtool: 'eval-source-map', output: { path: path.join(directory, 'output'), filename: 'bundle.js', publicPath: '/' },
      optimization: { moduleIds: 'named' }, infrastructureLogging: { level: 'none' },
    });
    const compiled = new Promise((resolve, reject) => {
      compiler.hooks.done.tap('free2z-security-test', (stats) => stats.hasErrors() ? reject(new Error(stats.toString())) : resolve());
      compiler.hooks.failed.tap('free2z-security-test', reject);
    });
    server = new DevServer({ ...options, host: '127.0.0.1', port: 0, client: false,
      hot: false, liveReload: false, webSocketServer: false, static: false,
      devMiddleware: { publicPath: '/', stats: 'none' } }, compiler);
    await server.start();
    await compiled;
    const port = server.server.address().port;
    function request(host, target) {
      return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: target, headers: { Host: host } }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        req.on('error', reject);
      });
    }
    const compilation = server.stats.compilation;
    const fixture = [...compilation.modules].find((module) => module.resource?.endsWith('/fixture.js'));
    assert.ok(fixture, 'webpack compiled the source fixture');
    const moduleId = compilation.chunkGraph.getModuleId(fixture);
    const endpoint = '/__get-internal-source?fileName=' + encodeURIComponent('webpack-internal:///' + moduleId);
    const blocked = await request('attacker.example', endpoint);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body, 'Invalid Host header');
    assert.ok(!blocked.body.includes('synthetic developer source'));
    const source = await request('localhost', endpoint);
    assert.equal(source.status, 200);
    assert.match(source.body, /synthetic developer source/);
    const bundle = await request('localhost', '/bundle.js');
    assert.equal(bundle.status, 200);
    assert.match(bundle.body, /synthetic developer source/);
  } finally {
    if (server) {
      if (typeof server.close === 'function') {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        assert.equal(server.server.listening, false, 'CRA close callback stops the listening server');
      } else {
        await server.stop();
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
