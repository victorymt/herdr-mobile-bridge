import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeServer } from '../src/server.js';
import { StateStore } from '../src/state-store.js';

async function makeServer(context, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-hardening-'));
  let server;
  context.after(async () => {
    try {
      await server?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const stateDir = join(root, 'state');
  const paths = {
    stateDir,
    runtimePath: join(stateDir, 'runtime.json'),
    subscriptionsPath: join(stateDir, 'subscriptions.json'),
    dedupPath: join(stateDir, 'dedup.json'),
  };
  const store = new StateStore(paths);
  const herdrClient = {
    async snapshot() { return { version: 'test', protocol: 1, workspaces: [], panes: [] }; },
    setSocketPath() {},
  };
  server = new BridgeServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      socketPath: '/tmp/herdr-hardening.sock',
      token: 'owner-token',
      secret: 'hook-secret',
      maxBodyBytes: 1024,
      allowedOrigin: '*',
      vapid: { publicKey: 'public', privateKey: 'private' },
      ...config,
      ...paths,
    },
    store,
    herdrClient,
  });
  await server.start();
  return { server, root, base: `http://127.0.0.1:${server.address().port}` };
}

test('protected API requests consume IP/session buckets while discovery remains exempt', async (context) => {
  const fixture = await makeServer(context, { rateLimitPerMinute: 1, rateLimitBurst: 1 });
  const headers = { authorization: 'Bearer owner-token' };
  const first = await fetch(`${fixture.base}/api/state`, { headers });
  assert.equal(first.status, 200);
  const second = await fetch(`${fixture.base}/api/state`, { headers });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'rate_limited');
  assert.equal(second.headers.get('retry-after'), '60');
  const discovery = await fetch(`${fixture.base}/api/discovery`);
  assert.equal(discovery.status, 200);
});

test('login keeps the fixed five-attempt profile independently of the general API rate', async (context) => {
  const fixture = await makeServer(context, { rateLimitPerMinute: 1, rateLimitBurst: 1 });
  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(`${fixture.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    assert.equal(response.status, 401);
  }
  const blocked = await fetch(`${fixture.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'rate_limited');
});

function slowRequest(context, base, pathname, bodyPrefix, bodySuffix, delayMs, contentLength) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const request = http.request(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer owner-token',
        'content-type': 'application/json',
        'content-length': String(contentLength),
        connection: 'close',
      },
    });
    let timer;
    context.after(() => {
      clearTimeout(timer);
      request.destroy();
    });
    request.once('close', () => clearTimeout(timer));
    let response;
    const chunks = [];
    request.once('response', (res) => {
      response = res;
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', (error) => {
      if (response) return;
      reject(error);
    });
    request.write(bodyPrefix);
    timer = setTimeout(() => {
      try { request.end(bodySuffix); } catch (error) { reject(error); }
    }, delayMs);
  });
}

test('slow JSON bodies return 408 and close the request connection', async (context) => {
  const fixture = await makeServer(context, { requestBodyTimeoutMs: 50, rateLimitPerMinute: 1000, rateLimitBurst: 1000 });
  const body = JSON.stringify({ pane_id: 'p1' });
  const response = await slowRequest(context, fixture.base, '/api/control/input', body.slice(0, 2), body.slice(2), 120, Buffer.byteLength(body));
  assert.equal(response.status, 408);
  assert.equal(response.headers.connection, 'close');
  assert.match(response.body, /request_body_timeout/);
});

test('declared oversized bodies return 413 before authentication body parsing', async (context) => {
  const fixture = await makeServer(context, { maxBodyBytes: 8, rateLimitPerMinute: 1000, rateLimitBurst: 1000 });
  const body = JSON.stringify({ token: 'owner-token', extra: 'too-large' });
  const response = await fetch(`${fixture.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body,
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('connection'), 'close');
  assert.equal((await response.json()).error.code, 'body_too_large');
});

test('SSE rejects a body-bearing GET before entering the long-lived stream', async (context) => {
  const fixture = await makeServer(context, { requestBodyTimeoutMs: 50, rateLimitPerMinute: 1000, rateLimitBurst: 1000 });
  const response = await new Promise((resolve, reject) => {
    const request = http.request(new URL('/api/stream', fixture.base), {
      method: 'GET',
      headers: {
        authorization: 'Bearer owner-token',
        'content-type': 'application/json',
        'content-length': '100',
        connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    context.after(() => request.destroy());
    request.once('error', (error) => reject(error));
    request.end('{');
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.connection, 'close');
  assert.match(response.body, /request_body_not_allowed/);
});
