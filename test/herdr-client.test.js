import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HerdrApiError, HerdrSocketClient } from '../src/herdr-client.js';

test('Herdr socket client round trips the allowlisted read, focus, and control methods', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-socket-test-'));
  const socketPath = join(dir, 'herdr.sock');
  const methods = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index));
      methods.push(request.method);
      let result;
      if (request.method === 'session.snapshot') result = { type: 'session_snapshot', snapshot: { panes: [] } };
      else if (request.method === 'pane.read') result = { type: 'pane_read', read: { pane_id: request.params.pane_id, text: 'ok' } };
      else if (request.method === 'agent.prompt') result = { type: 'agent_prompted', agent: { pane_id: request.params.target } };
      else if (request.method === 'pane.send_input') result = { type: 'ok' };
      else result = { type: request.method === 'pane.focus' ? 'pane_info' : 'workspace_info' };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = new HerdrSocketClient({ socketPath, timeoutMs: 1000 });
  assert.deepEqual(await client.snapshot(), { panes: [] });
  assert.equal((await client.readPane('w1:p1', 5)).text, 'ok');
  await client.focusPane('w1:p1');
  await client.focusWorkspace('w1');
  await client.promptAgent('w1:p1', 'check this');
  await client.sendPaneInput('w1:p1', { text: 'yes', keys: ['enter'] });
  assert.deepEqual(methods, ['session.snapshot', 'pane.read', 'pane.focus', 'workspace.focus', 'agent.prompt', 'pane.send_input']);
  await assert.rejects(() => client.request('server.stop', {}), (error) => error instanceof HerdrApiError && error.code === 'method_not_allowed');
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('control input validation rejects empty, oversized, and unsupported values before socket access', async () => {
  const client = new HerdrSocketClient({
    socketPath: '/definitely/not-used.sock',
    timeoutMs: 50,
    net: { createConnection() { throw new Error('socket must not be opened'); } },
  });
  await assert.rejects(() => client.promptAgent('w1:p1', '   '), /prompt must not be empty/);
  await assert.rejects(() => client.promptAgent('w1:p1', 'x'.repeat(32 * 1024 + 1)), /at most 32768/);
  await assert.rejects(() => client.sendPaneInput('w1:p1', {}), /requires text or at least one key/);
  await assert.rejects(() => client.sendPaneInput('w1:p1', { keys: ['ctrl+q'] }), /unsupported input key/);
  await assert.rejects(() => client.sendPaneInput('w1:p1', { keys: Array(9).fill('enter') }), /at most 8/);
});

test('Herdr socket client rejects explicit blank or non-string socket overrides', async () => {
  for (const value of ['', ' ', false, 0, 'relative.sock']) {
    assert.throws(
      () => new HerdrSocketClient({ socketPath: value }),
      /Herdr socket path must be an absolute path/,
      `constructor socketPath=${String(value)}`,
    );
  }
  const client = new HerdrSocketClient({ socketPath: '/tmp/herdr-client-default.sock' });
  for (const value of ['', ' ', false, 0, 'relative.sock']) {
    await assert.rejects(
      () => client.request('session.snapshot', {}, { socketPath: value }),
      /Herdr socket path must be an absolute path/,
      `request socketPath=${String(value)}`,
    );
  }
});

test('Herdr API errors are surfaced without allowing arbitrary socket writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-socket-error-'));
  const socketPath = join(dir, 'herdr.sock');
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end(JSON.stringify({ id: 'other', error: { code: 'pane_not_found', message: 'gone' } }) + '\n'));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = new HerdrSocketClient({ socketPath, timeoutMs: 1000 });
  await assert.rejects(() => client.readPane('w1:p1'), (error) => error instanceof HerdrApiError && error.code === 'pane_not_found');
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});
