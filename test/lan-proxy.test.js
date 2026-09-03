import test from 'node:test';
import assert from 'node:assert/strict';

import { LanProxy } from '../src/lan-proxy.js';

class FakeServer {
  constructor() {
    this.listeners = new Map();
    this.bound = null;
    this.closed = false;
  }

  once(name, callback) { this.listeners.set(name, callback); }
  off(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  listen(port, host) {
    this.bound = { address: host, port };
    queueMicrotask(() => this.listeners.get('listening')?.());
  }
  address() { return this.bound; }
  close(callback) { this.closed = true; callback?.(); }
}

test('LAN proxy requires an explicit host and manages listener lifecycle', async () => {
  const servers = [];
  const fakeNet = {
    createServer() {
      const server = new FakeServer();
      servers.push(server);
      return server;
    },
    createConnection() {
      throw new Error('connection should not be opened during startup');
    },
  };
  assert.throws(() => new LanProxy({ host: '0.0.0.0', net: fakeNet }), /explicit interface address/);
  assert.throws(() => new LanProxy({ host: '', net: fakeNet }), /explicit interface address/);

  const proxy = new LanProxy({ host: '192.168.1.20', port: 18787, targetPort: 8787, net: fakeNet });
  assert.deepEqual(await proxy.start(), { host: '192.168.1.20', port: 18787 });
  assert.deepEqual(await proxy.start(), { host: '192.168.1.20', port: 18787 });
  assert.equal(servers.length, 1);
  await proxy.close();
  assert.equal(servers[0].closed, true);
  await proxy.close();
});
