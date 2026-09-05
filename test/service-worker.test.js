import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SERVICE_WORKER_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function loadServiceWorker() {
  const listeners = new Map();
  const shown = [];
  const waits = [];
  let skipWaitingCalls = 0;
  const cache = {
    addAll: async () => {},
    put: async () => {},
  };
  const clients = {
    claim: async () => {},
    matchAll: async () => [],
    openWindow: async (url) => ({ url }),
  };
  const self = {
    location: { origin: 'https://bridge.example.test' },
    addEventListener(name, listener) { listeners.set(name, listener); },
    skipWaiting: async () => { skipWaitingCalls += 1; },
    clients,
    registration: {
      showNotification: async (title, options) => { shown.push({ title, options }); },
    },
  };
  const context = {
    self,
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    caches: {
      open: async () => cache,
      keys: async () => [],
      match: async () => undefined,
      delete: async () => true,
    },
    fetch: async () => ({ ok: true, clone: () => ({}) }),
  };
  vm.runInNewContext(SERVICE_WORKER_SOURCE, context, { filename: 'sw.js' });
  return { listeners, shown, waits, self, get skipWaitingCalls() { return skipWaitingCalls; } };
}

test('service worker keeps updates waiting until explicit user approval', async () => {
  const worker = loadServiceWorker();
  const installWaits = [];
  worker.listeners.get('install')({ waitUntil(promise) { installWaits.push(promise); } });
  await Promise.all(installWaits);
  assert.equal(worker.skipWaitingCalls, 0);

  worker.listeners.get('message')({ data: { type: 'SKIP_WAITING' } });
  assert.equal(worker.skipWaitingCalls, 1);
});

test('service worker push keeps only safe metadata in persisted notification data', async () => {
  const worker = loadServiceWorker();
  const push = worker.listeners.get('push');
  const event = {
    data: {
      json: () => ({
        title: 'Herdr · 需要介入',
        body: 'codex · p1 · blocked',
        url: '/?view=attention&pane=p1&status=blocked',
        view: 'attention',
        event: 'pane_agent_status_changed',
        status: 'blocked',
        pane_id: 'p1',
        workspace_id: 'w1',
        agent: 'codex',
        output: 'terminal secret must not persist',
        read: { text: 'terminal secret must not persist' },
      }),
    },
    waitUntil(promise) { worker.waits.push(promise); },
  };
  push(event);
  await Promise.all(worker.waits);

  assert.equal(worker.shown.length, 1);
  const notification = worker.shown[0];
  assert.equal(notification.options.data.url, '/?view=attention&pane=p1&status=blocked');
  assert.equal(notification.options.data.pane_id, 'p1');
  assert.equal(notification.options.data.agent, 'codex');
  assert.equal(notification.options.tag, 'herdr-p1');
  assert.equal(Object.hasOwn(notification.options.data, 'output'), false);
  assert.equal(Object.hasOwn(notification.options.data, 'read'), false);
  assert.doesNotMatch(JSON.stringify(notification.options.data), /terminal secret/);
});

test('service worker notification clicks preserve same-origin attention links and reject external targets', async () => {
  const worker = loadServiceWorker();
  const navigated = [];
  let focused = 0;
  worker.self.clients.matchAll = async () => [{
    async navigate(url) { navigated.push(url); },
    async focus() { focused += 1; },
  }];
  const click = worker.listeners.get('notificationclick');
  const waits = [];
  click({
    notification: {
      data: { url: '/?view=attention&pane=p1&event=pane_agent_detected' },
      close() {},
    },
    waitUntil(promise) { waits.push(promise); },
  });
  await Promise.all(waits);
  assert.deepEqual(navigated, ['/?view=attention&pane=p1&event=pane_agent_detected']);
  assert.equal(focused, 1);

  const rejectedWaits = [];
  click({
    notification: {
      data: { url: 'https://attacker.example.test/steal' },
      close() {},
    },
    waitUntil(promise) { rejectedWaits.push(promise); },
  });
  await Promise.all(rejectedWaits);
  assert.equal(navigated.at(-1), '/');
});

test('service worker shell cache includes the deep-link module and current version', () => {
  assert.match(SERVICE_WORKER_SOURCE, /herdr-mobile-v27/);
  assert.match(SERVICE_WORKER_SOURCE, /['"]\/icon-192\.png['"]/);
  assert.match(SERVICE_WORKER_SOURCE, /['"]\/deep-link\.js['"]/);
  assert.match(SERVICE_WORKER_SOURCE, /['"]\/ansi\.js['"]/);
});
