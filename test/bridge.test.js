import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeServer } from '../src/server.js';
import { StateStore } from '../src/state-store.js';

let root;
let server;
let base;
let authHeader;
let authCookie;
let csrfToken;
let pushes;

const fakeClient = {
  calls: [],
  async snapshot() {
    this.calls.push(['snapshot']);
    return {
      version: 'test',
      protocol: 99,
      focused_workspace_id: 'w1',
      focused_pane_id: 'w1:p1',
      workspaces: [{ workspace_id: 'w1', label: 'demo' }],
      panes: [],
    };
  },
  async readPane(paneId, lines) {
    this.calls.push(['read', paneId, lines]);
    return { pane_id: paneId, text: `line ${lines}\n`, revision: 7 };
  },
  async focusPane(paneId) {
    this.calls.push(['focusPane', paneId]);
    return { type: 'pane_info', pane: { pane_id: paneId } };
  },
  async focusWorkspace(workspaceId) {
    this.calls.push(['focusWorkspace', workspaceId]);
    return { type: 'workspace_info', workspace: { workspace_id: workspaceId } };
  },
  async promptAgent(paneId, text) {
    this.calls.push(['promptAgent', paneId, text]);
    return { type: 'agent_prompted', agent: { pane_id: paneId } };
  },
  async sendPaneInput(paneId, input) {
    this.calls.push(['sendPaneInput', paneId, input]);
    return { type: 'ok' };
  },
  setSocketPath(path) {
    this.socketPath = path;
  },
};

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.auth !== false) {
    if (authHeader) headers.authorization = authHeader;
    if (authCookie) headers.cookie = authCookie;
    if (csrfToken && ['POST', 'DELETE', 'PUT', 'PATCH'].includes(String(options.method || 'GET').toUpperCase())) headers['x-csrf-token'] = csrfToken;
  }
  return fetch(`${base}${path}`, { ...options, headers });
}

function collectCookies(header) {
  if (!header) return '';
  return String(header).split(/,(?=[^;,]+=)/).map((part) => part.split(';', 1)[0].trim()).filter((part) => part && !part.endsWith('=')).join('; ');
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'herdr-bridge-test-'));
  const store = new StateStore({ stateDir: join(root, 'state') });
  pushes = [];
  server = new BridgeServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      stateDir: join(root, 'state'),
      runtimePath: join(root, 'state', 'runtime.json'),
      subscriptionsPath: join(root, 'state', 'subscriptions.json'),
      dedupPath: join(root, 'state', 'dedup.json'),
      socketPath: '/tmp/herdr-test.sock',
      token: 'owner-token',
      secret: 'hook-secret',
      maxBodyBytes: 1024 * 1024,
      allowedOrigin: '*',
      vapid: { publicKey: 'test-public-key', privateKey: 'test-private-key', subject: 'mailto:test@example.com' },
    },
    store,
    herdrClient: fakeClient,
    pushSender: async (subscription, payload) => {
      pushes.push({ subscription, payload });
      return { status: 201 };
    },
  });
  await server.start();
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request('/api/auth/login', {
    method: 'POST',
    auth: false,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'owner-token' }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  if (loginBody.access_token) authHeader = `Bearer ${loginBody.access_token}`;
  authCookie = collectCookies(login.headers.get('set-cookie'));
  const csrfCookie = authCookie.split('; ').find((entry) => entry.startsWith('XSRF-TOKEN='));
  if (csrfCookie) csrfToken = decodeURIComponent(csrfCookie.slice('XSRF-TOKEN='.length));
});

after(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

test('health is public and protected routes reject missing auth', async () => {
  const health = await request('/healthz', { auth: false });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const state = await request('/api/state', { auth: false });
  assert.equal(state.status, 401);
  const queryToken = await request('/api/stream?token=owner-token', { auth: false });
  assert.equal(queryToken.status, 401, 'long-lived credentials must not authenticate through an SSE URL by default');
});

test('state, output and focus routes use only the injected Herdr client', async () => {
  fakeClient.calls.length = 0;
  const state = await request('/api/state');
  assert.equal(state.status, 200);
  const stateBody = await state.json();
  assert.equal(stateBody.snapshot.focused_pane_id, 'w1:p1');
  assert.equal(stateBody.focused_workspace_id || stateBody.focused?.workspace_id, 'w1');

  const output = await request('/api/panes/w1%3Ap1/output?lines=12');
  assert.equal(output.status, 200);
  const outputBody = await output.json();
  assert.equal(outputBody.output, 'line 12\n');
  assert.equal(outputBody.read, undefined);
  assert.equal(outputBody.result, undefined);

  const encodedSlash = await request(`/api/panes/${encodeURIComponent('workspace/pane?1')}/output?lines=4`);
  assert.equal(encodedSlash.status, 200);
  assert.equal((await encodedSlash.json()).pane_id, 'workspace/pane?1');

  const paneFocus = await request('/api/focus/pane', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pane_id: 'w1:p1' }),
  });
  assert.equal(paneFocus.status, 200);
  assert.deepEqual(await paneFocus.json(), { ok: true, accepted: true, pane_id: 'w1:p1' });
  const workspaceFocus = await request('/api/focus/workspace', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'w1' }),
  });
  assert.equal(workspaceFocus.status, 200);
  assert.deepEqual(await workspaceFocus.json(), { ok: true, accepted: true, workspace_id: 'w1' });
  assert.deepEqual(fakeClient.calls.slice(-4), [
    ['read', 'w1:p1', 12], ['read', 'workspace/pane?1', 4], ['focusPane', 'w1:p1'], ['focusWorkspace', 'w1'],
  ]);
});

test('internal events require the hook secret, persist statuses and push only terminal states once', async () => {
  const denied = await request('/internal/event', {
    method: 'POST', auth: false, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } }),
  });
  assert.equal(denied.status, 401);

  const working = await request('/internal/event', {
    method: 'POST', auth: false,
    headers: { 'content-type': 'application/json', 'x-herdr-bridge-secret': 'hook-secret' },
    body: JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' } }),
  });
  assert.equal(working.status, 202);
  const doneBody = { event: 'pane_agent_status_changed', context: { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'done', agent: 'codex' } };
  const done = await request('/internal/event', {
    method: 'POST', auth: false,
    headers: { 'content-type': 'application/json', 'x-herdr-bridge-secret': 'hook-secret' },
    body: JSON.stringify(doneBody),
  });
  assert.equal(done.status, 202);
  assert.equal((await done.json()).push.delivered, 0);
  assert.equal(pushes.length, 0, 'without a subscription no sender should run');

  const add = await request('/api/push/subscriptions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push.example.test/device-1', keys: { p256dh: 'p', auth: 'a' } }),
  });
  assert.equal(add.status, 201);
  const duplicate = await request('/internal/event', {
    method: 'POST', auth: false,
    headers: { 'content-type': 'application/json', 'x-herdr-bridge-secret': 'hook-secret' },
    body: JSON.stringify(doneBody),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(pushes.length, 0, 'deduped event must not notify twice');

  const detected = await request('/internal/event', {
    method: 'POST', auth: false,
    headers: { 'content-type': 'application/json', 'x-herdr-bridge-secret': 'hook-secret' },
    body: JSON.stringify({ event: 'pane_agent_detected', context: { pane_id: 'w1:p1', workspace_id: 'w1', final_status: 'blocked', agent: 'codex' } }),
  });
  assert.equal(detected.status, 202);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.status, 'blocked');
});

test('push key and subscription deletion are authenticated', async () => {
  const key = await request('/api/push/key');
  assert.equal(key.status, 200);
  assert.equal((await key.json()).publicKey, 'test-public-key');
  const add = await request('/api/push/subscriptions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push.example.test/device-2' }),
  });
  const id = (await add.json()).subscription.id;
  const removed = await request(`/api/push/subscriptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);
});

test('control routes submit prompts and pane input without exposing raw Herdr results', async () => {
  fakeClient.calls.length = 0;
  const prompt = await request('/api/control/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pane_id: 'w1:p1', text: 'Please inspect the failing test.' }),
  });
  assert.equal(prompt.status, 202);
  assert.deepEqual(await prompt.json(), { ok: true, accepted: true, pane_id: 'w1:p1' });

  const input = await request('/api/control/input', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pane_id: 'w1:p1', text: 'yes', keys: ['enter'] }),
  });
  assert.equal(input.status, 202);
  assert.deepEqual(await input.json(), { ok: true, accepted: true, pane_id: 'w1:p1' });
  assert.deepEqual(fakeClient.calls, [
    ['promptAgent', 'w1:p1', 'Please inspect the failing test.'],
    ['sendPaneInput', 'w1:p1', { text: 'yes', keys: ['enter'] }],
  ]);
});

test('control mutations reject overlapping requests for the same pane', async () => {
  const originalPrompt = fakeClient.promptAgent;
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  fakeClient.promptAgent = async (...args) => {
    started();
    await gate;
    return originalPrompt.apply(fakeClient, args);
  };
  try {
    const firstPromise = request('/api/control/prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pane_id: 'w1:p1', text: 'first request' }),
    });
    await startedPromise;
    const second = await request('/api/control/input', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pane_id: 'w1:p1', text: 'duplicate request' }),
    });
    assert.equal(second.status, 429);
    const secondBody = await second.json();
    assert.equal(secondBody.error.code, 'control_in_flight');
    release();
    const first = await firstPromise;
    assert.equal(first.status, 202);
  } finally {
    release?.();
    fakeClient.promptAgent = originalPrompt;
  }
});

test('control routes reject malformed input and retain CSRF protection', async () => {
  const noCsrf = await fetch(`${base}/api/control/prompt`, {
    method: 'POST',
    headers: { authorization: authHeader, cookie: authCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ pane_id: 'w1:p1', text: 'unsafe' }),
  });
  assert.equal(noCsrf.status, 403);

  const empty = await request('/api/control/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pane_id: 'w1:p1', text: '   ' }),
  });
  assert.equal(empty.status, 400);

  const invalidKeys = await request('/api/control/input', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pane_id: 'w1:p1', keys: ['ctrl+q'] }),
  });
  assert.equal(invalidKeys.status, 400);
});

test('unsupported routes and malformed input fail closed', async () => {
  const proxy = await request('/api/proxy', { method: 'POST', body: JSON.stringify({ method: 'server.stop' }) });
  assert.equal(proxy.status, 404);
  const malformed = await request('/api/focus/pane', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
});
