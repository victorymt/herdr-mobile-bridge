import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeServer } from '../src/server.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests = [];
  let listener;
  const bridge = new BridgeServer({
    config: { token: 'test-token', secret: 'test-secret' },
    store: {
      async getRuntime() { return {}; },
      async listPaneStatuses() { return {}; },
    },
    herdrClient: {
      snapshot() {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    },
    eventBus: { subscribe(callback) { listener = callback; return () => {}; } },
  });
  return { bridge, requests, emit: () => listener({ event: 'pane_changed' }) };
}

// Advance the asynchronous runtime lookup without depending on wall-clock delays.
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (version) => ({ version, workspaces: [], panes: [] });

test('concurrent state reads share one Herdr snapshot and reuse the cached result', async () => {
  const { bridge, requests } = fixture();
  const pending = Array.from({ length: 12 }, () => bridge.readState());
  await nextTurn();
  assert.equal(requests.length, 1);
  requests[0].resolve(snapshot('current'));
  const results = await Promise.all(pending);
  assert.ok(results.every((body) => body === results[0]));
  assert.equal(await bridge.readState(), results[0]);
  assert.equal(requests.length, 1);
});

for (const source of ['control', 'event']) {
  test(`${source} invalidation prevents a pending old snapshot from replacing fresh state`, async () => {
    const { bridge, requests, emit } = fixture();
    const oldRead = bridge.readState();
    await nextTurn();
    if (source === 'event') emit();
    else bridge.invalidateStateCache();

    const freshRead = bridge.readState();
    await nextTurn();
    assert.equal(requests.length, 2);
    requests[1].resolve(snapshot('fresh'));
    const fresh = await freshRead;
    requests[0].resolve(snapshot('old'));
    assert.equal((await oldRead).version, 'old');
    assert.equal(await bridge.readState(), fresh);
    assert.equal(requests.length, 2);
  });
}

test('an invalidated read cannot populate an empty cache or clear a newer pending read', async () => {
  const { bridge, requests } = fixture();
  const oldRead = bridge.readState();
  await nextTurn();
  bridge.invalidateStateCache();
  const freshRead = bridge.readState();
  await nextTurn();
  requests[0].resolve(snapshot('old'));
  await oldRead;
  const joinedRead = bridge.readState();
  await nextTurn();
  assert.equal(requests.length, 2);
  requests[1].resolve(snapshot('fresh'));
  assert.equal(await joinedRead, await freshRead);
});

test('a failed snapshot releases all waiting readers and allows a retry', async () => {
  const { bridge, requests } = fixture();
  const first = bridge.readState();
  const second = bridge.readState();
  const failed = Promise.all([
    assert.rejects(first, /unavailable/),
    assert.rejects(second, /unavailable/),
  ]);
  await nextTurn();
  assert.equal(requests.length, 1);
  requests[0].reject(new Error('unavailable'));
  await failed;
  const retry = bridge.readState();
  await nextTurn();
  assert.equal(requests.length, 2);
  requests[1].resolve(snapshot('recovered'));
  assert.equal((await retry).version, 'recovered');
});

test('cache lifetime starts when a slow snapshot completes', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const { bridge, requests } = fixture();
  const first = bridge.readState();
  await nextTurn();
  now += 2_000;
  requests[0].resolve(snapshot('slow'));
  const body = await first;
  now += 749;
  const cached = bridge.readState();
  await nextTurn();
  assert.equal(requests.length, 1);
  assert.equal(await cached, body);
  now += 1;
  const expired = bridge.readState();
  await nextTurn();
  assert.equal(requests.length, 2);
  requests[1].resolve(snapshot('updated'));
  assert.equal((await expired).version, 'updated');
});
