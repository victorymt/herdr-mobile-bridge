import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { LanProxy } from '../src/lan-proxy.js';

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit('connect'));
  }

  write() {
    queueMicrotask(() => this.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')));
  }

  destroy() { this.emit('close'); }
}

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.bound = null;
    this.closed = false;
  }

  listen(port, host) {
    this.bound = { address: host, port };
    queueMicrotask(() => this.emit('listening'));
  }
  address() { return this.bound; }
  close(callback) {
    this.closed = true;
    this.emit('close');
    callback?.();
  }
}

test('LAN proxy requires an explicit host and manages listener lifecycle', async () => {
  const servers = [];
  const fakeNet = {
    createServer() {
      const server = new FakeServer();
      servers.push(server);
      return server;
    },
    createConnection() { return new FakeConnection(); },
  };
  assert.throws(() => new LanProxy({ host: '0.0.0.0', net: fakeNet }), /explicit interface address/);
  assert.throws(() => new LanProxy({ host: ' 0.0.0.0 ', net: fakeNet }), /explicit interface address/);
  assert.throws(() => new LanProxy({ host: '', net: fakeNet }), /explicit interface address/);

  const proxy = new LanProxy({ host: '192.168.1.20', port: 18787, targetPort: 8787, net: fakeNet });
  assert.deepEqual(await proxy.start(), { host: '192.168.1.20', port: 18787 });
  assert.deepEqual(await proxy.start(), { host: '192.168.1.20', port: 18787 });
  assert.equal(servers.length, 1);
  await proxy.close();
  assert.equal(servers[0].closed, true);
  await proxy.close();
});

test('LAN proxy serializes concurrent starts and cancels a pending start on close', async () => {
  const servers = [];
  class DelayedServer extends FakeServer {
    listen(port, host) {
      this.bound = { address: host, port };
      setTimeout(() => this.emit('listening'), 25);
    }
  }
  const fakeNet = {
    createServer() {
      const server = new DelayedServer();
      servers.push(server);
      return server;
    },
    createConnection() { return new FakeConnection(); },
  };
  const proxy = new LanProxy({ host: '192.168.1.20', port: 18787, net: fakeNet });
  const first = proxy.start();
  const second = proxy.start();
  let secondSettled = false;
  second.finally(() => { secondSettled = true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondSettled, false);
  assert.deepEqual(await Promise.all([first, second]), [
    { host: '192.168.1.20', port: 18787 },
    { host: '192.168.1.20', port: 18787 },
  ]);
  await proxy.close();

  const pending = new LanProxy({ host: '192.168.1.20', port: 18787, net: fakeNet });
  const start = pending.start();
  await new Promise((resolve) => setImmediate(resolve));
  const close = pending.close();
  await assert.rejects(start, (error) => error?.code === 'ERR_LAN_PROXY_START_CANCELLED');
  await close;
  assert.equal(pending.server, null);
  assert.equal(servers.at(-1).closed, true);
});

test('LAN proxy tears down and reports an asynchronous listener error', async () => {
  const servers = [];
  const errors = [];
  let closes = 0;
  const fakeNet = {
    createServer() {
      const server = new FakeServer();
      servers.push(server);
      return server;
    },
    createConnection() { return new FakeConnection(); },
  };
  const proxy = new LanProxy({
    host: '192.168.1.20',
    port: 18787,
    net: fakeNet,
    onError: (error) => errors.push(error.message),
    onClose: () => { closes += 1; },
  });
  await proxy.start();
  servers[0].emit('error', new Error('listener failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['listener failed']);
  assert.equal(proxy.server, null);
  assert.equal(proxy.healthy, false);
  assert.equal(closes, 1);
  await proxy.close();
});

test('LAN proxy health probe fails promptly when the forwarded socket closes', async () => {
  const fakeNet = {
    createServer() { return new FakeServer(); },
    createConnection() {
      const socket = new EventEmitter();
      socket.write = () => queueMicrotask(() => socket.emit('close'));
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
  const proxy = new LanProxy({ host: '192.168.1.20', port: 18787, net: fakeNet });
  const started = Date.now();
  await assert.rejects(proxy.start(), /closed before a healthy response/);
  assert.ok(Date.now() - started < 500);
  assert.equal(proxy.server, null);
});
