import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  PushManager,
  makePushPayload,
} from '../src/push.js';

test('detected events use final_status and keep the pane URL encoded', () => {
  const payload = makePushPayload({
    event: 'pane.agent_detected',
    context: {
      pane_id: 'workspace/pane?1',
      workspace_id: 'workspace-1',
      // A hook context may carry the pane's current status as well as the
      // detected terminal result. The latter is authoritative here.
      agent_status: 'working',
      final_status: 'blocked',
      agent: 'codex',
      read: { text: 'must never be copied into a notification' },
    },
  });

  assert.equal(payload.event, 'pane_agent_detected');
  assert.equal(payload.data.event, 'pane_agent_detected');
  assert.equal(payload.view, 'attention');
  assert.equal(payload.data.view, 'attention');
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.url, '/?view=attention&pane=workspace%2Fpane%3F1&workspace=workspace-1&event=pane_agent_detected&status=blocked&agent=codex');
  assert.match(payload.body, /blocked/);
  assert.doesNotMatch(JSON.stringify(payload), /must never be copied/);
});

test('push TTL is finite, bounded, and normalized from status aliases', () => {
  const invalid = makePushPayload(
    { event: 'pane_agent_status_changed', context: { agent_status: 'error' } },
    { ttl: Number.NaN },
  );
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.ttl, DEFAULT_TTL_SECONDS);
  assert.equal(makePushPayload({ context: { agent_status: 'needs-intervention' } }).status, 'blocked');
  assert.equal(makePushPayload({ context: { agent_status: 'processing' } }).status, 'working');

  const short = makePushPayload({}, { ttl: 1 });
  assert.equal(short.ttl, MIN_TTL_SECONDS);
  const long = makePushPayload({}, { ttl: Number.MAX_SAFE_INTEGER });
  assert.equal(long.ttl, MAX_TTL_SECONDS);
});

test('attention links encode only bounded metadata and omit arbitrary context', () => {
  const payload = makePushPayload({
    event: 'pane-agent-status-changed',
    context: {
      pane_id: 'pane&one=two#fragment',
      workspace_id: 'workspace/one',
      agent_status: 'done',
      agent: 'codex\nmobile',
      read: { text: 'terminal secret' },
      output: 'terminal secret',
      nested: { output: 'terminal secret' },
    },
  });

  assert.equal(payload.url, '/?view=attention&pane=pane%26one%3Dtwo%23fragment&workspace=workspace%2Fone&event=pane_agent_status_changed&status=done&agent=codexmobile');
  assert.equal(payload.data.url, payload.url);
  assert.doesNotMatch(JSON.stringify(payload), /terminal secret/);
  assert.ok(payload.url.length < 2048);
});

test('partial status events without a pane or workspace fall back to the root URL', () => {
  const payload = makePushPayload({ event: 'pane_agent_status_changed', context: { agent_status: 'blocked' } });
  assert.equal(payload.url, '/');
  assert.equal(payload.data.url, '/');
});

test('attention links accept sanitized camel-case metadata from event envelopes', () => {
  const payload = makePushPayload({
    event: 'pane.agent_status_changed',
    context: { paneId: 'p2', workspaceId: 'w2', display_agent: 'codex-ui', agent_status: 'done' },
  });
  assert.equal(payload.pane_id, 'p2');
  assert.equal(payload.workspace_id, 'w2');
  assert.equal(payload.agent, 'codex-ui');
  assert.match(payload.url, /pane=p2/);
  assert.match(payload.url, /workspace=w2/);
  assert.match(payload.url, /agent=codex-ui/);
});

test('relay delivery sends the normalized TTL and removes expired subscriptions', async () => {
  const calls = [];
  const removed = [];
  const subscriptions = [
    { id: 'sub-1', endpoint: 'https://push.example.test/one' },
  ];
  const manager = new PushManager({
    store: {
      async listSubscriptions() { return subscriptions; },
      async removeSubscription(criteria) { removed.push(criteria); return true; },
    },
    // A truthy empty adapter disables the optional web-push dependency so the
    // explicit relay path is exercised deterministically.
    webPush: {},
    allowRelay: true,
    fetch: async (endpoint, options) => {
      calls.push({ endpoint, options });
      return { ok: true, status: 202 };
    },
  });

  const result = await manager.notify(
    { event: 'pane_agent_status_changed', context: { pane_id: 'p1', agent_status: 'done' } },
    { ttl: 1 },
  );
  assert.equal(result.delivered, 1);
  assert.equal(calls[0].options.headers.ttl, String(MIN_TTL_SECONDS));
  assert.equal(JSON.parse(calls[0].options.body).ttl, MIN_TTL_SECONDS);

  manager.sender = async () => {
    const error = new Error('gone');
    error.status = 410;
    throw error;
  };
  const expired = await manager.notify({ event: 'pane_agent_status_changed', context: { pane_id: 'p1', agent_status: 'done' } });
  assert.equal(expired.delivered, 0);
  assert.deepEqual(removed, [{ id: 'sub-1' }]);
});
