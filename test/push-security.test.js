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
    'https://localhost.../internal/event',
    'https://foo.localhost.../internal/event',
    'http://localhost:8787/internal/event',
  ]) {
    assert.equal(validSubscriptionShape({ endpoint, keys }), false, endpoint);
  }
});

test('custom push endpoints require an explicit opt-in but remain private-host safe', () => {
  assert.equal(validSubscriptionShape({ endpoint: 'https://relay.example.test/push', keys }, { allowCustomEndpoints: true }), true);
  assert.equal(validSubscriptionShape({ endpoint: 'https://8.8.8.8/push', keys }, { allowCustomEndpoints: true }), true);
  // Do not over-block unrelated public 192/8 addresses while rejecting the
  // precise IETF and documentation allocations below.
  assert.equal(validSubscriptionShape({ endpoint: 'https://192.2.1.1/push', keys }, { allowCustomEndpoints: true }), true);
  assert.equal(validSubscriptionShape({ endpoint: 'https://192.0.3.1/push', keys }, { allowCustomEndpoints: true }), true);
  for (const endpoint of [
    'https://127.0.0.1:8787/push',
    'https://192.0.0.1/push', // IETF protocol assignments
    'https://192.0.2.1/push', // TEST-NET-1
    'https://198.51.100.1/push', // TEST-NET-2
    'https://203.0.113.1/push', // TEST-NET-3
  ]) {
    assert.equal(validSubscriptionShape({ endpoint, keys }, { allowCustomEndpoints: true }), false, endpoint);
  }
  assert.equal(validSubscriptionShape({ endpoint: 'http://relay.example.test/push', keys }, { allowCustomEndpoints: true }), false);
});

test('push endpoint validation rejects expanded and compatible IPv6 local forms', () => {
  // URL.hostname normally compresses these values before validation. Keep the
  // expanded spellings here as a regression test for callers that construct a
  // subscription object directly (and for future URL/parser changes).
  for (const host of [
    '0:0:0:0:0:ffff:7f00:1', // IPv4-mapped 127.0.0.1
    '0:0:0:0:0:ffff:a9fe:a9fe', // IPv4-mapped 169.254.169.254
    '0:0:0:0:0:ffff:a00:1', // IPv4-mapped 10.0.0.1
    '0:0:0:0:0:ffff:c0a8:101', // IPv4-mapped 192.168.1.1
    '0:0:0:0:0:0:0:0', // unspecified
    '0:0:0:0:0:0:0:1', // loopback
    'fe80:0:0:0:0:0:0:1', // link-local
    'fd00:0:0:0:0:0:0:1', // ULA/private
    '::127.0.0.1', // deprecated IPv4-compatible loopback
    '64:ff9b::7f00:1', // NAT64 representation of 127.0.0.1
    '64:ff9b:1::a00:1', // local-use NAT64 representation of 10.0.0.1
    '2002:7f00:1::1', // 6to4 representation of 127.0.0.1
    'localhost...', // repeated trailing-dot local hostname
    'foo.localhost...',
    'localhost6',
    'localhost6.localdomain6',
    'ip6-allnodes',
    'ip6-allrouters',
    'broadcasthost',
  ]) {
    const endpoint = host.includes(':') ? `https://[${host}]/push` : `https://${host}/push`;
    assert.equal(
      validSubscriptionShape({ endpoint, keys }, { allowCustomEndpoints: true }),
      false,
      host,
    );
  }
});

test('push subscription metadata keeps expirationTime finite and scalar', async () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/metadata-bound';
  assert.equal(validSubscriptionShape({ endpoint, keys, expirationTime: 1_700_000_000_000 }), true);
  for (const expirationTime of [
    -1,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    {},
    [],
    '1700000000000',
  ]) {
    assert.equal(validSubscriptionShape({ endpoint, keys, expirationTime }), false, String(expirationTime));
  }

  const root = await mkdtemp(join(tmpdir(), 'herdr-push-metadata-bound-'));
  const store = new StateStore({ stateDir: root });
  const saved = await store.addSubscription({ endpoint, expirationTime: 42, metadata: { secret: 'must-drop' } });
  assert.equal(saved.expirationTime, 42);
  assert.equal(saved.metadata, undefined);
  await assert.rejects(
    () => store.addSubscription({ endpoint: `${endpoint}-object`, expirationTime: { nested: 'value' } }),
    /invalid push subscription/,
  );
  await rm(root, { recursive: true, force: true });
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

test('push manager accepts canonical configuration aliases when constructed directly', () => {
  const manager = new PushManager({
    allowPushRelay: true,
    allowCustomPushEndpoints: true,
    pushTimeoutMs: 17,
    webPush: {},
  });
  assert.equal(manager.allowRelay, true);
  assert.equal(manager.allowCustomEndpoints, true);
  assert.equal(manager.timeoutMs, 17);
});
