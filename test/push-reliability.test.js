import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StateStore } from '../src/state-store.js';
import { EventBus } from '../src/event-bus.js';
import { PushManager } from '../src/push.js';
import { deliveryFailure } from '../src/push-worker.js';

function event(id, status = 'done', pane = 'pane-1') {
  return { event_id: id, event: 'pane.agent_status_changed', context: { pane_id: pane, agent_status: status, agent: 'test-agent', output: 'NEVER_PERSIST' } };
}

async function fixture(context, sender = async () => ({ status: 201 }), options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-reliable-'));
  let now = 1_000_000;
  const clock = () => now;
  const store = new StateStore({ stateDir: root, clock });
  await store.init();
  const subscription = await store.addSubscription({ endpoint: 'https://fcm.googleapis.com/test-device' });
  const manager = new PushManager({ store, sender, clock, random: () => 0.5, ...options });
  const bus = new EventBus({ store, pushManager: manager, clock });
  context.after(async () => { await manager.worker.close(); await rm(root, { recursive: true, force: true }); });
  return { root, clock, store, subscription, manager, bus, advance: (milliseconds) => { now += milliseconds; } };
}

async function drain(worker) {
  worker.stopped = false;
  await worker.pump();
  await Promise.all([...worker.active.values()]);
  clearTimeout(worker.timer);
}

test('accepted events persist before SSE and resume after restart', async (context) => {
  const sent = [];
  const setup = await fixture(context);
  let observed;
  setup.bus.subscribe(() => { observed = setup.store.eventSnapshot(); });
  const result = await setup.bus.processIncoming(event('first'));
  assert.deepEqual(result.push, { queued: 1 });
  assert.equal(observed.deliveries.length, 1);
  assert.doesNotMatch(await readFile(setup.store.dedupPath, 'utf8'), /NEVER_PERSIST|fcm.googleapis.com/);
  assert.equal((await stat(setup.store.dedupPath)).mode & 0o777, 0o600);
  await setup.store.clearRuntime();
  const restored = new StateStore({ stateDir: setup.root, clock: setup.clock });
  await restored.init();
  const manager = new PushManager({ store: restored, clock: setup.clock, sender: async (_subscription, payload) => { sent.push(payload); } });
  context.after(() => manager.worker.close());
  await drain(manager.worker);
  assert.equal(sent.length, 1);
  assert.equal(restored.deliveries.length, 0);
  assert.equal((await manager.worker.status(setup.subscription.id)).last_result, 'accepted');
  const duplicate = await new EventBus({ store: restored, pushManager: manager, clock: setup.clock }).processIncoming(event('first'));
  assert.equal(duplicate.duplicate, true);
});

test('events without a pane id do not create an undefined pane status', async (context) => {
  const setup = await fixture(context);
  const result = await setup.bus.processIncoming({ event: 'pane.closed', event_id: 'closed-without-pane' });
  assert.equal(result.accepted, true);
  assert.deepEqual(await setup.store.listPaneStatuses(), {});
  assert.equal(setup.store.deliveries.length, 0);
});

test('persistence failure does not commit dedup, pane status, or SSE', async (context) => {
  const setup = await fixture(context);
  const originalPath = setup.store.dedupPath;
  setup.store.dedupPath = setup.root;
  await assert.rejects(setup.bus.processIncoming(event('disk-failure')), { code: 'event_store_unavailable' });
  assert.equal(setup.store.dedup.size, 0);
  assert.deepEqual(await setup.store.listPaneStatuses(), {});
  assert.equal(setup.bus.events.length, 0);
  setup.store.dedupPath = originalPath;
  assert.equal((await setup.bus.processIncoming(event('disk-failure'))).duplicate, false);
});

test('transient failure retries only failed subscriptions and obeys remaining TTL', async (context) => {
  const calls = [];
  let failed = false;
  const setup = await fixture(context, async (subscription, payload) => {
    calls.push({ id: subscription.id, ttl: payload.ttl });
    if (!failed) { failed = true; throw Object.assign(new Error('private provider body'), { status: 429, headers: { 'retry-after': '30' } }); }
  });
  await setup.store.addSubscription({ endpoint: 'https://fcm.googleapis.com/other-device' });
  await setup.bus.processIncoming(event('retry'));
  await drain(setup.manager.worker);
  assert.equal(calls.length, 2);
  assert.equal(setup.store.deliveries.length, 1);
  assert.equal((await setup.manager.worker.status(setup.subscription.id)).retrying, 1);
  setup.advance(29_000);
  await drain(setup.manager.worker);
  assert.equal(calls.length, 2);
  setup.advance(1000);
  await drain(setup.manager.worker);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].ttl, 270);
  assert.equal(setup.store.deliveries.length, 0);
  assert.doesNotMatch(await readFile(setup.store.dedupPath, 'utf8'), /private provider body/);
});

test('permanent errors, expiry and deletion stop retries', async (context) => {
  for (const status of [400, 401, 403, 404, 410]) {
    const setup = await fixture(context, async () => { throw Object.assign(new Error('failed'), { status }); });
    await setup.bus.processIncoming(event(`failure-${status}`));
    await drain(setup.manager.worker);
    assert.equal(setup.store.deliveries.length, 0);
    assert.equal((await setup.store.listSubscriptions()).length, status === 404 || status === 410 ? 0 : 1);
  }
  const expired = await fixture(context, async () => { assert.fail('expired task sent'); });
  await expired.bus.processIncoming(event('expired'));
  expired.advance(300_000);
  await drain(expired.manager.worker);
  assert.equal(expired.store.deliveries.length, 0);
  assert.equal((await expired.manager.worker.status(expired.subscription.id)).last_result, 'expired');
  const removed = await fixture(context, async () => { assert.fail('removed subscription sent'); });
  await removed.bus.processIncoming(event('removed'));
  await removed.manager.remove({ id: removed.subscription.id });
  await drain(removed.manager.worker);
  assert.equal(removed.store.deliveries.length, 0);
});

test('new lifecycle cancels old pending notifications but allows done again', async (context) => {
  const setup = await fixture(context);
  await setup.bus.processIncoming(event('done-1'));
  await setup.bus.processIncoming(event('same-done'));
  assert.equal(setup.store.deliveries.length, 1);
  await setup.bus.processIncoming(event('working', 'working'));
  assert.equal(setup.store.deliveries.length, 0);
  await setup.bus.processIncoming(event('done-2'));
  assert.equal(setup.store.deliveries.length, 1);
  await setup.bus.processIncoming({ event: 'pane.agent_detected', event_id: 'released', context: { pane_id: 'pane-1', released: true } });
  assert.equal(setup.store.deliveries.length, 0);
  await setup.bus.processIncoming(event('done-3', 'blocked'));
  assert.equal(setup.store.deliveries.length, 1);
  await setup.bus.processIncoming({ event: 'pane.updated', event_id: 'new-agent', context: { pane_id: 'pane-1', agent: 'replacement' } });
  assert.equal(setup.store.deliveries.length, 0);
  await setup.bus.processIncoming({ ...event('replacement-done'), context: { pane_id: 'pane-1', agent: 'replacement', agent_status: 'done' } });
  assert.equal(setup.store.deliveries.length, 1);
});

test('slow sender does not block later events and concurrency stays bounded', async (context) => {
  const releases = [];
  const setup = await fixture(context, () => new Promise((resolve) => releases.push(resolve)));
  for (let index = 0; index < 5; index += 1) await setup.store.addSubscription({ endpoint: `https://fcm.googleapis.com/device-${index}` });
  await setup.bus.processIncoming(event('slow'));
  setup.manager.worker.stopped = false;
  await setup.manager.worker.pump();
  for (let attempt = 0; attempt < 100 && releases.length < 4; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(releases.length, 4);
  assert.equal(setup.manager.worker.active.size, 4);
  const result = await setup.bus.processIncoming(event('later', 'working'));
  assert.equal(result.accepted, true);
  assert.equal(setup.bus.events.length, 2);
  for (const release of releases) release({ status: 201 });
  await setup.manager.worker.close();
  assert.equal(setup.store.deliveries.length, 0);
});

test('queue saturation rejects the whole event without marking it seen', async (context) => {
  const setup = await fixture(context);
  await setup.bus.processIncoming(event('base'));
  await setup.store.transactEvents((next) => {
    const base = next.deliveries[0];
    next.deliveries = Array.from({ length: 1000 }, (_, index) => ({ ...base, id: `existing-${index}` }));
  });
  await assert.rejects(setup.bus.processIncoming(event('overflow', 'done', 'another-pane')), { status: 503, code: 'push_queue_full' });
  assert.equal(setup.store.dedup.size, 1);
  assert.equal(setup.bus.events.length, 1);
});

test('legacy files migrate with backup and corrupt or unsupported states fail closed', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-migration-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const legacy = JSON.stringify({ previous: Date.now() });
  await writeFile(join(root, 'dedup.json'), legacy);
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ pane_statuses: { pane: { agent_status: 'done', output: 'NEVER_PERSIST' } } }));
  const store = new StateStore({ stateDir: root });
  await store.init();
  assert.equal(await readFile(`${store.dedupPath}.v1.bak`, 'utf8'), legacy);
  assert.equal(await store.hasSeen('previous'), true);
  assert.equal((await store.listPaneStatuses()).pane.agent_status, 'done');
  assert.doesNotMatch(await readFile(store.dedupPath, 'utf8'), /NEVER_PERSIST/);
  await writeFile(store.dedupPath, '{broken');
  await assert.rejects(new StateStore({ stateDir: root }).init(), /durable event state/);
  await writeFile(store.dedupPath, '{"version":999}');
  await assert.rejects(new StateStore({ stateDir: root }).init(), /unsupported/);
});

test('forced process termination preserves a committed task', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-crash-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { StateStore } from './src/state-store.js';
    import { PushManager } from './src/push.js';
    import { EventBus } from './src/event-bus.js';
    const store = new StateStore({ stateDir: process.argv[1] });
    await store.addSubscription({ endpoint: 'https://fcm.googleapis.com/crash' });
    const bus = new EventBus({ store, pushManager: new PushManager({ store }) });
    const accepted = await bus.processIncoming({ event_id: 'crash', event: 'pane.agent_status_changed', context: { pane_id: 'pane', agent_status: 'done' } });
    if (!accepted.accepted) process.exit(2);
    process.kill(process.pid, 'SIGKILL');
  `, root], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const restored = new StateStore({ stateDir: root });
  await restored.init();
  assert.equal(restored.deliveries.length, 1);
  assert.equal(restored.dedup.size, 1);
});

test('retry classifier accepts HTTP dates and rejects permanent failures', () => {
  assert.equal(deliveryFailure({ status: 503, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' } }, 0).retryAt, 60_000);
  assert.equal(deliveryFailure({ status: 408 }, 0).retry, true);
  assert.equal(deliveryFailure({ status: 403 }, 0).retry, false);
});

test('success acknowledgement write failure retains task for restart, allowing duplicate delivery', async (context) => {
  let accepted = 0;
  let originalPath;
  const setup = await fixture(context, async () => {
    accepted += 1;
    originalPath = setup.store.dedupPath;
    setup.store.dedupPath = setup.root;
  }, { logger: { warn() {} } });
  await setup.bus.processIncoming(event('ack-crash'));
  await drain(setup.manager.worker);
  assert.equal(accepted, 1);
  assert.equal(setup.store.deliveries.length, 1);
  setup.store.dedupPath = originalPath;
  await setup.manager.worker.close();
  setup.advance(2000);
  const restored = new StateStore({ stateDir: setup.root, clock: setup.clock });
  const manager = new PushManager({ store: restored, clock: setup.clock, sender: async () => { accepted += 1; } });
  context.after(() => manager.worker.close());
  await drain(manager.worker);
  assert.equal(accepted, 2);
  assert.equal(restored.deliveries.length, 0);
});

test('never-settling sender is bounded and short remaining TTL is not raised to 30 seconds', async (context) => {
  const timedOut = await fixture(context, () => new Promise(() => {}), { timeoutMs: 15 });
  await timedOut.bus.processIncoming(event('timeout'));
  await drain(timedOut.manager.worker);
  assert.equal((await timedOut.manager.worker.status(timedOut.subscription.id)).last_result, 'retrying');
  const payloads = [];
  const setup = await fixture(context, undefined, {
    vapid: { publicKey: 'test', privateKey: 'test' },
    webPush: { async sendNotification(_subscription, _payload, options) { payloads.push(options); } },
  });
  setup.manager.sender = (subscription, payload) => setup.manager.sendHttp(subscription, payload);
  await setup.bus.processIncoming(event('short-ttl'));
  setup.advance(295_000);
  await drain(setup.manager.worker);
  assert.equal(payloads[0].TTL, 5);
});
