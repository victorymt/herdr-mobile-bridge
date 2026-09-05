import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthManager } from '../src/auth.js';
import { MAX_PANE_STATUSES, StateStore } from '../src/state-store.js';
import { processMatchesRuntime } from '../src/launcher.js';

test('internal bridge secret is not accepted as a browser login token', () => {
  const auth = new AuthManager({ token: 'owner-token' });
  assert.equal(auth.login({ secret: 'owner-token' }).ok, false);
  assert.equal(auth.login({ token: 'owner-token' }).ok, true);
  assert.equal(new AuthManager().login({ token: '' }).ok, false);
  assert.equal(new AuthManager().verifyOwnerToken(''), false);
});

test('secure cookie policy can be overridden for an explicitly detected HTTP request', () => {
  const auth = new AuthManager({ token: 'owner-token', cookieSecure: true, random: () => 'session' });
  assert.match(auth.sessionCookie('session'), /; Secure$/);
  assert.doesNotMatch(auth.sessionCookie('session', undefined, false), /; Secure$/);
  assert.match(auth.csrfCookie('csrf', undefined, true), /; Secure$/);
  assert.doesNotMatch(auth.clearCookie(false), /; Secure$/);
  assert.doesNotMatch(auth.clearCsrfCookie(false), /; Secure$/);
});

test('pane status fields can be explicitly cleared without losing unrelated metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-state-clear-'));
  const store = new StateStore({ stateDir: root });
  await store.setPaneStatus('pane-1', {
    workspace_id: 'workspace-1',
    agent: 'codex',
    agent_status: 'done',
    final_status: 'blocked',
    title: 'old task',
    state_labels: { blocked: 'Blocked' },
  });
  const cleared = await store.setPaneStatus('pane-1', {
    final_status: null,
    state_labels: {},
    title: 'new task',
  });
  assert.equal(cleared.workspace_id, 'workspace-1');
  assert.equal(cleared.final_status, undefined);
  assert.equal(cleared.state_labels, undefined);
  assert.equal(cleared.title, 'new task');
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  const persisted = JSON.parse(await readFile(join(root, 'dedup.json'), 'utf8'));
  assert.equal(persisted.pane_statuses['pane-1'].final_status, undefined);
  await rm(root, { recursive: true, force: true });
});

test('state loading strips terminal output and unknown runtime fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-state-sanitize-'));
  await writeFile(join(root, 'runtime.json'), JSON.stringify({
    pid: 123,
    socket_path: '/tmp/herdr.sock',
    lan_proxy_running: true,
    lan_proxy_host: '192.168.1.20',
    lan_proxy_port: 18787,
    lan_proxy_error: 'temporary listener error',
    output: 'must not survive',
    pane_statuses: {
      'pane-1': {
        pane_id: 'pane-1',
        agent_status: 'done',
        output: 'terminal secret',
        title: 'safe title',
      },
    },
  }));
  const store = new StateStore({ stateDir: root });
  const runtime = await store.getRuntime();
  const statuses = await store.listPaneStatuses();
  assert.equal(runtime.output, undefined);
  assert.equal(runtime.lan_proxy_running, true);
  assert.equal(runtime.lan_proxy_host, '192.168.1.20');
  assert.equal(runtime.lan_proxy_port, 18787);
  assert.equal(runtime.lan_proxy_error, 'temporary listener error');
  assert.equal(statuses['pane-1'].output, undefined);
  assert.equal(statuses['pane-1'].title, 'safe title');
  await rm(root, { recursive: true, force: true });
});

test('clearRuntime works even before the store has been initialized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-state-clear-runtime-'));
  const store = new StateStore({ stateDir: root });
  await store.setPaneStatus('pane-1', { agent_status: 'done' });
  const fresh = new StateStore({ stateDir: root });
  await fresh.clearRuntime();
  assert.deepEqual(await fresh.listPaneStatuses(), {});
  assert.deepEqual(await fresh.getRuntime(), { pane_statuses: {} });
  await rm(root, { recursive: true, force: true });
});

test('state loading and pane updates stay within the status count bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-state-count-bound-'));
  const paneStatuses = Object.fromEntries(Array.from({ length: MAX_PANE_STATUSES + 20 }, (_, index) => [
    `pane-${index}`,
    { agent_status: 'working', title: `task-${index}` },
  ]));
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ pane_statuses: paneStatuses }));
  const store = new StateStore({ stateDir: root, maxPaneStatuses: MAX_PANE_STATUSES + 100 });
  assert.equal(Object.keys(await store.listPaneStatuses()).length, MAX_PANE_STATUSES);
  const longId = 'x'.repeat(1000);
  const updated = await store.setPaneStatus(longId, null);
  assert.equal(updated.pane_id.length, 256);
  assert.equal(Object.keys(await store.listPaneStatuses()).length, MAX_PANE_STATUSES);
  await rm(root, { recursive: true, force: true });
});

test('runtime process identity mismatch is refused before signalling a PID', () => {
  const processApi = { kill() { return true; } };
  const runtime = { pid: 4242, entry: '/opt/herdr-mobile-bridge/src/index.js', process_start_time: '10' };
  const mismatch = processMatchesRuntime(runtime, {
    processApi,
    processInspector: () => ({ startTime: '11', cmdline: 'node /other/service.js' }),
  });
  assert.equal(mismatch, false);
  const match = processMatchesRuntime(runtime, {
    processApi,
    processInspector: () => ({ startTime: '10', cmdline: 'node /opt/herdr-mobile-bridge/src/index.js' }),
  });
  assert.equal(match, true);
});
