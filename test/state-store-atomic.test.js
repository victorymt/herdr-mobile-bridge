import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-subscription-atomic-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore({ stateDir: root, maxSubscriptions: 1 });
  const original = await store.addSubscription({ endpoint: 'https://fcm.googleapis.com/original' });
  return { root, store, original, path: store.subscriptionsPath };
}

test('failed subscription registration does not publish or evict subscriptions', async (context) => {
  const { root, store, original, path } = await fixture(context);
  store.subscriptionsPath = root;
  const replacement = { endpoint: 'https://fcm.googleapis.com/replacement' };
  await assert.rejects(store.addSubscription(replacement));
  assert.deepEqual(await store.listSubscriptions(), [original]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [original]);
  store.subscriptionsPath = path;
  const registered = await store.addSubscription(replacement);
  assert.deepEqual(await store.listSubscriptions(), [registered]);
  assert.deepEqual(await new StateStore({ stateDir: root }).listSubscriptions(), [registered]);
});

test('failed subscription deletion stays registered and can be retried durably', async (context) => {
  const { root, store, original, path } = await fixture(context);
  store.subscriptionsPath = root;
  await assert.rejects(store.removeSubscription({ id: original.id }));
  assert.deepEqual(await store.listSubscriptions(), [original]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [original]);
  store.subscriptionsPath = path;
  assert.equal(await store.removeSubscription({ id: original.id }), true);
  assert.deepEqual(await store.listSubscriptions(), []);
  assert.deepEqual(await new StateStore({ stateDir: root }).listSubscriptions(), []);
});

test('concurrent subscription additions and removals retain every committed update', async (context) => {
  const { root, store, original } = await fixture(context);
  store.maxSubscriptions = 4;
  const [first, second] = await Promise.all([
    store.addSubscription({ endpoint: 'https://fcm.googleapis.com/first' }),
    store.addSubscription({ endpoint: 'https://fcm.googleapis.com/second' }),
  ]);
  assert.deepEqual(await store.listSubscriptions(), [original, first, second]);
  const [removed, third] = await Promise.all([
    store.removeSubscription({ id: original.id }),
    store.addSubscription({ endpoint: 'https://fcm.googleapis.com/third' }),
  ]);
  assert.equal(removed, true);
  assert.deepEqual(await store.listSubscriptions(), [first, second, third]);
  assert.deepEqual(await new StateStore({ stateDir: root }).listSubscriptions(), [first, second, third]);
});

test('uncertain subscription commit blocks further use until state is reloaded', async (context) => {
  const { root, store, original, path } = await fixture(context);
  const handle = await open(root, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const originalSync = prototype.sync;
  const sync = context.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isDirectory()) {
      throw Object.assign(new Error('directory sync failed'), { code: 'EIO' });
    }
    return originalSync.call(this);
  });
  await assert.rejects(store.removeSubscription({ id: original.id }));
  // The rename committed the deletion even though syncing its directory failed.
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  sync.mock.restore();
  const unavailable = { status: 503, code: 'subscription_store_unavailable' };
  await assert.rejects(store.listSubscriptions(), unavailable);
  await assert.rejects(store.addSubscription({ endpoint: 'https://fcm.googleapis.com/another' }), unavailable);
  await assert.rejects(store.removeSubscription({ id: original.id }), unavailable);
  await assert.rejects(store.transactEvents(() => assert.fail('events must not use uncertain subscriptions')), unavailable);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  const restored = new StateStore({ stateDir: root });
  assert.deepEqual(await restored.listSubscriptions(), []);
  const registered = await restored.addSubscription({ endpoint: 'https://fcm.googleapis.com/recovered' });
  assert.deepEqual(await restored.listSubscriptions(), [registered]);
});
