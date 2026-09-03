import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PushManager,
  MAX_PUSH_TIMEOUT_MS,
} from '../src/push.js';
import {
  StateStore,
  validSubscriptionShape,
} from '../src/state-store.js';

const keys = { p256dh: 'p', auth: 'a' };

test('push endpoint validation accepts known providers and rejects SSRF targets', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/device',
    'https://updates.push.services.mozilla.com/wpush/v2/device',
    'https://web.push.apple.com/3/device',
    'https://wns2.example.notify.windows.com/push',
  ]) {
    assert.equal(validSubscriptionShape({ endpoint, keys }), true, endpoint);
  }

  for (const endpoint of [
    'https://evil.example.test/push',
    'https://127.0.0.1:8787/internal/event',
    'https://2130706433/internal/event', // decimal IPv4 loopback
    'https://10.0.0.1/admin',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]:8787/internal/event',
    'https://metadata.google.internal/computeMetadata/v1/',
    'http://localhost:8787/internal/event',
  ]) {
    assert.equal(validSubscriptionShape({ endpoint, keys }), false, endpoint);
  }
});

test('custom push endpoints require an explicit opt-in but remain private-host safe', () => {
  assert.equal(validSubscriptionShape({ endpoint: 'https://relay.example.test/push', keys }, { allowCustomEndpoints: true }), true);
  assert.equal(validSubscriptionShape({ endpoint: 'https://8.8.8.8/push', keys }, { allowCustomEndpoints: true }), true);
  assert.equal(validSubscriptionShape({ endpoint: 'https://127.0.0.1:8787/push', keys }, { allowCustomEndpoints: true }), false);
  assert.equal(validSubscriptionShape({ endpoint: 'http://relay.example.test/push', keys }, { allowCustomEndpoints: true }), false);
});

test('StateStore applies endpoint policy when loading and registering subscriptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-push-policy-'));
  const store = new StateStore({ stateDir: root });
  await assert.rejects(
    () => store.addSubscription({ endpoint: 'https://127.0.0.1:8787/internal/event', keys }),
    /invalid push subscription/,
  );
  const accepted = await store.addSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/device', keys });
  assert.equal(accepted.endpoint, 'https://fcm.googleapis.com/fcm/send/device');

  const custom = new StateStore({ stateDir: join(root, 'custom'), allowCustomEndpoints: true });
  const customEntry = await custom.addSubscription({ endpoint: 'https://relay.example.test/push', keys });
  assert.equal(customEntry.endpoint, 'https://relay.example.test/push');
  await rm(root, { recursive: true, force: true });
});

test('web-push delivery passes a bounded timeout and rejects stalled adapters', async () => {
  const calls = [];
  const manager = new PushManager({
    allowCustomEndpoints: true,
    timeoutMs: 15,
    vapid: { publicKey: 'public', privateKey: 'private', subject: 'mailto:test@example.com' },
    webPush: {
      setVapidDetails() {},
      sendNotification(subscription, payload, options) {
        calls.push({ subscription, payload, options });
        return new Promise(() => {});
      },
    },
  });
  const started = Date.now();
  await assert.rejects(
    () => manager.sendHttp({ endpoint: 'https://relay.example.test/push', keys }, { ttl: 60 }),
    (error) => error?.code === 'push_timeout' && error?.status === 504,
  );
  assert.ok(Date.now() - started < 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 15);
  assert.ok(manager.timeoutMs <= MAX_PUSH_TIMEOUT_MS);
});

test('direct HTTP delivery rechecks endpoint policy before invoking fetch', async () => {
  let called = false;
  const manager = new PushManager({
    allowRelay: true,
    webPush: {},
    fetch: async () => { called = true; return { ok: true, status: 202 }; },
  });
  await assert.rejects(
    () => manager.sendHttp({ endpoint: 'https://127.0.0.1:8787/internal/event' }, {}),
    (error) => error?.status === 400 && /invalid push subscription endpoint/.test(error.message),
  );
  assert.equal(called, false);
});
