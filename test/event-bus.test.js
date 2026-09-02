import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/event-bus.js';
import { BridgeServer, sseFrame } from '../src/server.js';

test('SSE Last-Event-ID is the monotonic sequence, not the envelope UUID', () => {
  const event = {
    id: '8c7f5b84-2c98-4f07-bf73-3e13d8f76c72',
    seq: 42,
    event: 'pane_agent_status_changed',
    context: { pane_id: 'w1:p1', agent_status: 'working' },
    received_at: '2026-09-02T00:00:00.000Z',
  };

  const frame = sseFrame(event);
  assert.match(frame, /^id: 42\n/);
  assert.doesNotMatch(frame, /^id: 8c7f5b84-/m);
  assert.match(frame, /\nevent: pane_agent_status_changed\n/);

  // Non-replay markers (for example the stream's `ready` event) must not
  // overwrite a browser's cursor with a UUID or a reset sequence number.
  const ready = sseFrame({
    id: 'ready-8c7f5b84-2c98-4f07-bf73-3e13d8f76c72',
    event: 'ready',
    context: { connected: true },
  });
  assert.doesNotMatch(ready, /^id:/m);
});

test('EventBus replays only events newer than the numeric SSE sequence', () => {
  const bus = new EventBus({ maxReplay: 8 });
  const first = bus.publish({
    id: 'event-a',
    event: 'pane_updated',
    context: { pane_id: 'w1:p1' },
  });
  const second = bus.publish({
    id: 'event-b',
    event: 'pane_focused',
    context: { pane_id: 'w1:p1' },
  });

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(bus.getSince(String(first.seq)).map((event) => event.id), ['event-b']);
  assert.deepEqual(bus.getSince(String(second.seq)), []);
});

test('status metadata changes are not collapsed by deduplication', async () => {
  const seen = new Set();
  const storedStatuses = {};
  const bus = new EventBus({
    store: {
      async markSeen(key) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
      async listPaneStatuses() { return storedStatuses; },
      async setPaneStatus(paneId, value) { storedStatuses[paneId] = value; },
    },
  });

  const first = await bus.processIncoming({
    event: 'pane.agent_status_changed',
    context: {
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent_status: 'working',
      agent: 'codex',
      title: 'first task',
      state_labels: { working: 'Working' },
    },
  });
  const second = await bus.processIncoming({
    event: 'pane.agent_status_changed',
    context: {
      // Deliberately reorder fields and labels to ensure the fingerprint is
      // canonical while still treating the changed title as a new event.
      state_labels: { working: 'Processing' },
      title: 'second task',
      agent: 'codex',
      agent_status: 'working',
      workspace_id: 'w1',
      pane_id: 'w1:p1',
    },
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(bus.events.length, 2);
});

test('equivalent metadata with different object order is deduplicated', async () => {
  const seen = new Set();
  const bus = new EventBus({
    store: {
      async markSeen(key) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
      async listPaneStatuses() { return {}; },
      async setPaneStatus() {},
    },
  });
  const payload = {
    event: 'pane.agent_status_changed',
    context: {
      pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working', agent: 'codex',
      state_labels: { working: 'Working', blocked: 'Blocked' },
    },
  };
  const reordered = {
    event: 'pane.agent_status_changed',
    context: {
      state_labels: { blocked: 'Blocked', working: 'Working' }, agent: 'codex',
      agent_status: 'working', workspace_id: 'w1', pane_id: 'w1:p1',
    },
  };
  const first = await bus.processIncoming(payload);
  const second = await bus.processIncoming(reordered);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(bus.events.length, 1);
});

test('terminal notifications fire again after a non-terminal lifecycle transition', async () => {
  const seen = new Set();
  const statuses = {};
  const notifications = [];
  const bus = new EventBus({
    store: {
      async markSeen(key) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
      async listPaneStatuses() { return statuses; },
      async setPaneStatus(paneId, value) {
        statuses[paneId] = { ...(statuses[paneId] || {}), ...value };
      },
    },
    pushManager: {
      async notify(event) {
        notifications.push(event);
        return { attempted: 0, delivered: 0 };
      },
    },
  });
  const makeEvent = (eventId, status) => ({
    event: 'pane.agent_status_changed',
    event_id: eventId,
    context: { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: status, agent: 'codex' },
  });

  const firstDone = await bus.processIncoming(makeEvent('done-1', 'done'));
  const working = await bus.processIncoming(makeEvent('working-1', 'working'));
  const secondDone = await bus.processIncoming(makeEvent('done-2', 'done'));

  assert.equal(firstDone.push.delivered, 0);
  assert.equal(working.push, null);
  assert.equal(secondDone.push.delivered, 0);
  assert.equal(notifications.length, 2);
});

test('detector release clears a previously persisted terminal result', async () => {
  const seen = new Set();
  const statuses = {};
  const bus = new EventBus({
    store: {
      async markSeen(key) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
      async listPaneStatuses() { return statuses; },
      async setPaneStatus(paneId, value) {
        const previous = statuses[paneId] || {};
        const next = { ...previous, ...value };
        for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
        statuses[paneId] = next;
      },
    },
  });

  await bus.processIncoming({
    event: 'pane.agent_detected',
    event_id: 'detected-done',
    context: { pane_id: 'w1:p1', final_status: 'done', agent: 'codex' },
  });
  await bus.processIncoming({
    event: 'pane.agent_detected',
    event_id: 'detected-release',
    context: { pane_id: 'w1:p1', released: true, agent: 'codex' },
  });

  assert.equal(statuses['w1:p1'].final_status, undefined);
  assert.equal(statuses['w1:p1'].agent, 'codex');
});

test('stream replay queues events published during the replay snapshot', async () => {
  const server = new BridgeServer({ config: {}, herdrClient: {} });
  const replayed = {
    id: 'event-a',
    seq: 1,
    event: 'pane_updated',
    context: { pane_id: 'w1:p1' },
    received_at: '2026-09-02T00:00:00.000Z',
  };
  const concurrent = {
    id: 'event-b',
    seq: 2,
    event: 'pane_focused',
    context: { pane_id: 'w1:p1' },
    received_at: '2026-09-02T00:00:01.000Z',
  };
  let listener;
  server.eventBus = {
    subscribe(callback) {
      listener = callback;
      return () => { listener = undefined; };
    },
    getSince() {
      // Simulate an event arriving after subscription but while replay is
      // being collected. The live event must follow the older replay frame.
      listener(concurrent);
      return [replayed];
    },
  };

  const requestListeners = {};
  const request = {
    headers: { 'last-event-id': '0' },
    on(name, callback) { requestListeners[name] = callback; },
  };
  const response = {
    writableEnded: false,
    chunks: [],
    writeHead() {},
    write(chunk) { this.chunks.push(String(chunk)); },
    end() { this.writableEnded = true; },
  };

  try {
    await server.handleStream(request, response, new URL('http://127.0.0.1/api/stream'));
    const events = response.chunks.join('').split('\n\n')
      .filter((frame) => frame.includes('data: '))
      .map((frame) => JSON.parse(frame.match(/^data: (.*)$/m)[1]));
    assert.deepEqual(events.slice(0, 2).map((event) => event.id), ['event-a', 'event-b']);
    assert.match(events[2].id, /^ready-/);
    assert.equal(events[2].event, 'ready');
  } finally {
    requestListeners.close?.();
  }
});
