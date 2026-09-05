import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager } from '../src/auth.js';
import { BridgeServer } from '../src/server.js';
import { loadConfigSync } from '../src/config.js';
import { pairBridge } from '../src/launcher.js';
import { TokenBucketLimiter } from '../src/rate-limit.js';

test('pairing codes are one-use, expire, rotate and issue ordinary sessions', () => {
  let now = 1000;
  const auth = new AuthManager({ token: 'owner', clock: () => now });
  const first = auth.createPairingCode();
  assert.match(first.code, /^\d{8}$/);
  assert.equal(JSON.stringify(auth.pairing).includes(first.code), false);
  const second = auth.createPairingCode();
  assert.equal(auth.pair({ code: first.code }).ok, false);
  const session = auth.pair({ code: second.code });
  assert.equal(session.ok, true);
  assert.equal(auth.authenticate({ headers: { authorization: `Bearer ${session.session}` } }).kind, 'session');
  assert.equal(auth.pair({ code: second.code }).ok, false);
  const expired = auth.createPairingCode();
  now += 300_000;
  assert.equal(auth.pair({ code: expired.code }).ok, false);
  assert.equal(auth.login({ token: 'owner' }).ok, true);
});

test('five wrong guesses invalidate globally and generation is rate limited', () => {
  const auth = new AuthManager();
  const issued = auth.createPairingCode();
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(auth.pair({ code: 'invalid' }).ok, false);
  assert.equal(auth.pair({ code: issued.code }).ok, false);
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(auth.createPairingCode().ok, true);
  assert.equal(auth.createPairingCode().ok, false);
  assert.equal(new AuthManager().pair({ code: issued.code }).ok, false);
});

test('pairing HTTP endpoints require owner Bearer to generate and protect sessions with CSRF', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-pairing-'));
  const server = new BridgeServer({ config: { host: '127.0.0.1', port: 0, stateDir: root, token: 'owner-token', secret: 'hook-secret', socketPath: '/tmp/pair-test.sock' }, herdrClient: { snapshot: async () => ({}) }, rateLimiter: false });
  context.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}, headers = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  for (const authorization of ['', 'Bearer hook-secret']) {
    assert.equal((await post('/api/auth/pairing-code', {}, { authorization })).status, 403);
  }
  assert.equal((await post('/api/auth/pairing-code', {}, { authorization: 'Bearer owner-token', origin: 'https://hostile.example' })).status, 403);
  const issued = await post('/api/auth/pairing-code', {}, { authorization: 'Bearer owner-token' });
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const { code } = await issued.json();
  const responses = await Promise.all([post('/api/auth/pair', { code }), post('/api/auth/pair', { code })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  const success = responses.find((response) => response.status === 200);
  const cookie = success.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.match(success.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);
  assert.equal((await post('/api/auth/pairing-code', {}, { cookie })).status, 403);
  assert.equal((await post('/api/auth/logout', {}, { cookie })).status, 403);
  const csrf = decodeURIComponent(cookie.match(/XSRF-TOKEN=([^;]+)/)[1]);
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } })).status, 200);
  assert.equal((await fetch(`${base}/api/push/status?subscription_id=test`)).status, 401);
  const status = await fetch(`${base}/api/push/status?subscription_id=test`, { headers: { authorization: 'Bearer owner-token' } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true, registered: false, pending: 0, retrying: 0 });
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await post('/api/auth/pairing-code', {}, { authorization: 'Bearer owner-token' })).status, 201);
  const limited = await post('/api/auth/pairing-code', {}, { authorization: 'Bearer owner-token' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  server.rateLimiter = new TokenBucketLimiter();
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await post('/api/auth/pair', { code: 'invalid' })).status, 401);
  assert.equal((await post('/api/auth/pair', { code: 'invalid' })).status, 429);
  let deniedStatus;
  const response = { writeHead(statusCode) { deniedStatus = statusCode; }, end() {} };
  await server.handlePairingCode({ headers: { authorization: 'Bearer owner-token' }, socket: { remoteAddress: '192.168.1.30' } }, response);
  assert.equal(deniedStatus, 403);
});

test('pair CLI checks live runtime and configuration without creating absent config', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-pair-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  await assert.rejects(pairBridge({ configDir, stateDir, env: {} }), /Bridge 未运行/);
  assert.deepEqual(await readdir(root), []);
  const config = loadConfigSync({ configDir, stateDir, token: 'cli-owner', secret: 'cli-hook', port: 0, env: {} });
  const server = new BridgeServer({ config, herdrClient: { snapshot: async () => ({}) } });
  context.after(() => server.close());
  await server.start();
  const issued = await pairBridge({ config, env: {}, processInspector: () => undefined });
  assert.match(issued.code, /^\d{8}$/);
  assert.equal(server.auth.pair({ code: issued.code }).ok, true);
  await assert.rejects(pairBridge({ config: { ...config, rateLimitBurst: config.rateLimitBurst + 1 }, env: {}, processInspector: () => undefined }), /配置不匹配/);
  const pending = await pairBridge({ config, env: {}, processInspector: () => undefined });
  await server.close();
  await server.start();
  assert.equal(server.auth.pair({ code: pending.code }).ok, false);
});
