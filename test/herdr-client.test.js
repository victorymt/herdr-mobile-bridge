import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HerdrApiError, HerdrSocketClient } from '../src/herdr-client.js';

async function makeSocketServer(context, prefix, onConnection) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const sockets = new Set();
  let server;
  context.after(async () => {
    try {
      for (const socket of sockets) socket.destroy();
      if (server) {
        await new Promise((resolve, reject) => server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        }));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  const socketPath = join(dir, 'herdr.sock');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return socketPath;
}

function clientForResponseChunks(chunks, options = {}) {
  return new HerdrSocketClient({
    ...options,
    net: {
      createConnection() {
        const socket = new EventEmitter();
        socket.setTimeout = () => socket;
        socket.destroy = () => { socket.destroyed = true; };
        socket.write = (_request, callback) => {
          callback();
          for (const chunk of chunks) {
            if (socket.destroyed) break;
            socket.emit('data', chunk);
          }
        };
        queueMicrotask(() => socket.emit('connect'));
        return socket;
      },
    },
  });
}

test('Herdr socket responses preserve UTF-8 characters split across chunks', async () => {
  const expected = { text: '中文🙂 e\u0301' };
  const response = Buffer.from(`${JSON.stringify({ result: expected })}\r\n`);
  const chunks = Array.from(response, (_byte, index) => response.subarray(index, index + 1));
  const client = clientForResponseChunks(chunks);
  assert.deepEqual((await client.request('session.snapshot')).result, expected);
});

test('fragmented Herdr responses enforce the byte limit and stop at the first line', async () => {
  const expected = { text: '中文🙂' };
  const response = Buffer.from(`${JSON.stringify({ result: expected })}\n`);
  const chunks = Array.from(response, (_byte, index) => response.subarray(index, index + 1));
  const bounded = clientForResponseChunks(chunks, { maxResponseBytes: response.length - 1 });
  await assert.rejects(() => bounded.request('session.snapshot'), /exceeded the size limit/);
  const exact = clientForResponseChunks(chunks, { maxResponseBytes: response.length });
  assert.deepEqual((await exact.request('session.snapshot')).result, expected);
  const multiple = clientForResponseChunks([Buffer.concat([response, Buffer.from('not JSON\n')])]);
  assert.deepEqual((await multiple.request('session.snapshot')).result, expected);
});

test('Herdr socket client round trips the allowlisted read, focus, and control methods', async (context) => {
  const methods = [];
  const reads = [];
  const socketPath = await makeSocketServer(context, 'herdr-socket-test-', (socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index));
      methods.push(request.method);
      let result;
      if (request.method === 'session.snapshot') result = { type: 'session_snapshot', snapshot: { panes: [] } };
      else if (request.method === 'pane.read') {
        reads.push(request.params);
        result = { type: 'pane_read', read: { pane_id: request.params.pane_id, text: 'ok' } };
      }
      else if (request.method === 'agent.prompt') result = { type: 'agent_prompted', agent: { pane_id: request.params.target } };
      else if (request.method === 'pane.send_input') result = { type: 'ok' };
      else result = { type: request.method === 'pane.focus' ? 'pane_info' : 'workspace_info' };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  const client = new HerdrSocketClient({ socketPath, timeoutMs: 1000 });
  assert.deepEqual(await client.snapshot(), { panes: [] });
  assert.equal((await client.readPane('w1:p1', 5)).text, 'ok');
  assert.deepEqual(reads[0], {
    pane_id: 'w1:p1', source: 'recent', lines: 5, format: 'text', strip_ansi: true,
  });
  assert.equal((await client.readPane('w1:p1', 6, {
    source: 'recent-unwrapped', format: 'ansi', stripAnsi: false,
  })).text, 'ok');
  assert.deepEqual(reads[1], {
    pane_id: 'w1:p1', source: 'recent_unwrapped', lines: 6, format: 'ansi', strip_ansi: false,
  });
  await assert.rejects(() => client.readPane('w1:p1', 6, { format: 'html' }), /unsupported read format/);
  await assert.rejects(() => client.readPane('w1:p1', 6, { stripAnsi: 'maybe' }), /stripAnsi must be a boolean/);
  await assert.rejects(() => client.readPane('w1:p1', 6, []), /read options must be an object/);
  await client.focusPane('w1:p1');
  await client.focusWorkspace('w1');
  await client.promptAgent('w1:p1', 'check this');
  await client.sendPaneInput('w1:p1', { text: 'yes', keys: ['enter'] });
  assert.deepEqual(methods, ['session.snapshot', 'pane.read', 'pane.read', 'pane.focus', 'workspace.focus', 'agent.prompt', 'pane.send_input']);
  await assert.rejects(() => client.request('server.stop', {}), (error) => error instanceof HerdrApiError && error.code === 'method_not_allowed');
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

test('Herdr API errors are surfaced without allowing arbitrary socket writes', async (context) => {
  const socketPath = await makeSocketServer(context, 'herdr-socket-error-', (socket) => {
    socket.once('data', () => socket.end(JSON.stringify({ id: 'other', error: { code: 'pane_not_found', message: 'gone' } }) + '\n'));
  });
  const client = new HerdrSocketClient({ socketPath, timeoutMs: 1000 });
  await assert.rejects(() => client.readPane('w1:p1'), (error) => error instanceof HerdrApiError && error.code === 'pane_not_found');
});
