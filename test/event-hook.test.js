import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { boundPayload, endpointFromEnv, parseEvent, sendEvent, validateEventEndpoint } from '../src/event-hook.js';

test('event hook maps Herdr EventEnvelope data into bridge context', () => {
  const payload = parseEvent({
    HERDR_PLUGIN_EVENT: 'pane_agent_status_changed',
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1' }),
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
  });
  assert.deepEqual(payload, {
    event: 'pane_agent_status_changed',
    context: { pane_id: 'w1:p1', agent_status: 'done', workspace_id: 'w1' },
    socket_path: '/tmp/herdr.sock',
    event_id: undefined,
  });
});

test('event hook posts only the bounded event payload with the bridge secret', async () => {
  let call;
  const result = await sendEvent({ event: 'pane_agent_detected', context: { pane_id: 'p1', final_status: 'blocked' } }, {
    secret: 'secret', endpoint: 'http://127.0.0.1:8787/internal/event',
    fetch: async (url, options) => {
      call = { url: String(url), options };
      return { ok: true, status: 202 };
    },
  });
  assert.equal(result.delivered, true);
  assert.equal(call.options.headers['x-herdr-bridge-secret'], 'secret');
  assert.equal(JSON.parse(call.options.body).context.final_status, 'blocked');
  assert.equal(JSON.parse(call.options.body).context.read, undefined);
});

test('event hook strips terminal output and caps arbitrary context before sending', () => {
  const bounded = boundPayload({
    event: 'pane.agent_status_changed',
    context: {
      pane_id: 'p1',
      agent_status: 'working',
      read: { text: 'secret terminal output' },
      output: 'another secret',
      title: 'safe title',
    },
  });
  assert.deepEqual(bounded.context, {
    pane_id: 'p1',
    agent_status: 'working',
    title: 'safe title',
  });
  assert.doesNotMatch(JSON.stringify(bounded), /secret terminal output|another secret/);
});

test('event URL defaults to the local gateway and supports an explicit base URL', () => {
  assert.equal(endpointFromEnv({}), 'http://127.0.0.1:8787/internal/event');
  assert.equal(endpointFromEnv({ HERDR_BRIDGE_URL: 'http://127.0.0.1:9999' }), 'http://127.0.0.1:9999/internal/event');
  assert.equal(endpointFromEnv({ HERDR_BRIDGE_EVENT_URL: 'http://127.0.0.1:9999/internal/event' }), 'http://127.0.0.1:9999/internal/event');
});

test('event URL follows a propagated custom runtime marker path', () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-event-runtime-'));
  const runtimePath = join(root, 'nested', 'bridge-runtime.json');
  try {
    // The launcher writes the marker before the hook runs; create the nested
    // directory here to model an embedder-owned custom state layout.
    const nested = join(root, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(runtimePath, JSON.stringify({ host: '127.0.0.1', port: 49123 }));
    assert.equal(
      endpointFromEnv({ HERDR_BRIDGE_RUNTIME_PATH: runtimePath }),
      'http://127.0.0.1:49123/internal/event',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('event delivery rejects remote cleartext and requires an HTTPS allowlist', async () => {
  assert.throws(
    () => validateEventEndpoint('http://example.test/internal/event', {}),
    /non-loopback bridge event URL must use HTTPS/,
  );
  assert.throws(
    () => validateEventEndpoint('https://example.test/internal/event', {}),
    /not in the HTTPS allowlist/,
  );
  const allowed = validateEventEndpoint('https://example.test/internal/event', {
    HERDR_BRIDGE_EVENT_ALLOWED_ORIGINS: 'https://example.test',
  });
  assert.equal(allowed.origin, 'https://example.test');

  let request;
  await sendEvent({ event: 'pane_agent_status_changed', context: { pane_id: 'p1', agent_status: 'done' } }, {
    secret: 'secret',
    endpoint: 'https://example.test/internal/event',
    env: { HERDR_BRIDGE_EVENT_ALLOWED_ORIGINS: 'https://example.test' },
    fetch: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 202 };
    },
  });
  assert.equal(request.options.redirect, 'error');
});
