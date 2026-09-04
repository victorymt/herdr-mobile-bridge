import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  compileAllowedCidrs,
  isAddressAllowed,
  isLocalAddress,
  parseAllowedCidrs,
} from '../src/network-acl.js';
import { LanProxy } from '../src/lan-proxy.js';

test('allowed CIDRs are normalized across IPv4, IPv6, and bare addresses', () => {
  assert.deepEqual(parseAllowedCidrs(' 192.168.1.42/24,2001:0DB8:0000:0000:0000:0000:0000:1/64 '), [
    '192.168.1.0/24',
    '2001:db8::/64',
  ]);
  assert.deepEqual(parseAllowedCidrs(['10.0.0.1', '::1']), ['10.0.0.1/32', '::1/128']);
  assert.deepEqual(parseAllowedCidrs('::FFFF:192.0.2.129'), ['::ffff:c000:281/128']);
  assert.equal(parseAllowedCidrs(undefined), undefined);
});

test('empty and malformed explicit ACL values fail closed at configuration time', () => {
  for (const value of [[], '', '   ', [''], '192.168.0.0/33', '2001:db8::/129', 'fe80::1%eth0', '[::1]', '1.2.3.4/']) {
    assert.throws(() => parseAllowedCidrs(value), /invalid LAN proxy allowed CIDR/);
  }
  assert.throws(() => parseAllowedCidrs(Array.from({ length: 129 }, () => '10.0.0.1')), /at most 128/);
});

test('matcher keeps IPv4 and native IPv6 families separate and handles mapped peers', () => {
  const ipv4 = compileAllowedCidrs('192.168.1.0/24');
  assert.equal(ipv4.allows('192.168.1.20'), true);
  assert.equal(ipv4.allows('::ffff:192.168.1.20'), true);
  assert.equal(ipv4.allows('::ffff:c0a8:0114'), true);
  assert.equal(ipv4.allows('192.168.2.20'), false);
  assert.equal(ipv4.allows('2001:db8::20'), false);

  const ipv6 = compileAllowedCidrs('2001:db8::/32');
  assert.equal(ipv6.allows('2001:db8:1::20'), true);
  assert.equal(ipv6.allows('192.168.1.20'), false);

  // An explicitly mapped IPv6 network is equivalent for a peer reported in
  // either spelling, while ::/0 remains native-IPv6-only for raw IPv4 peers.
  const mapped = compileAllowedCidrs('::ffff:192.168.1.0/120');
  assert.equal(mapped.allows('::ffff:192.168.1.20'), true);
  assert.equal(mapped.allows('192.168.1.20'), true);
  assert.equal(mapped.allows('192.168.2.20'), false);
  assert.equal(compileAllowedCidrs('::/0').allows('192.168.1.20'), false);
  assert.equal(isAddressAllowed('192.168.1.20', ipv4), true);
  assert.equal(isAddressAllowed(ipv4, '192.168.1.20'), true);
});

test('local source detection recognizes loopback and mapped listener spellings', () => {
  assert.equal(isLocalAddress('127.0.0.1', '192.168.1.20'), true);
  assert.equal(isLocalAddress('::1', '2001:db8::20'), true);
  assert.equal(isLocalAddress('192.168.1.20', '192.168.1.20'), true);
  assert.equal(isLocalAddress('::ffff:192.168.1.20', '192.168.1.20'), true);
  assert.equal(isLocalAddress('192.168.1.21', '192.168.1.20'), false);
});

class Socket extends EventEmitter {
  constructor({ remoteAddress, health = false } = {}) {
    super();
    this.remoteAddress = remoteAddress;
    this.health = health;
    this.destroyed = false;
    queueMicrotask(() => this.emit('connect'));
  }

  write() {
    if (this.health) queueMicrotask(() => this.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\nok')));
  }

  pipe(target) {
    this.pipedTo = target;
    return target;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

class Server extends EventEmitter {
  constructor(listener) {
    super();
    this.listener = listener;
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

  accept(socket) { this.listener(socket); }
}

test('LAN proxy rejects a disallowed peer before target connect without onError', async () => {
  let server;
  const connections = [];
  const errors = [];
  const rejected = [];
  const fakeNet = {
    createServer(listener) {
      server = new Server(listener);
      return server;
    },
    createConnection(options) {
      const socket = new Socket({ health: options.localAddress !== undefined });
      connections.push({ options, socket });
      return socket;
    },
  };
  const proxy = new LanProxy({
    host: '192.168.1.20',
    port: 18787,
    net: fakeNet,
    allowedCidrs: '192.168.1.0/24',
    onError: (error) => errors.push(error),
    onReject: (address) => rejected.push(address),
  });

  await proxy.start();
  assert.equal(connections[0].options.localAddress, '192.168.1.20');
  const before = connections.length;
  const denied = new Socket({ remoteAddress: '10.0.0.5' });
  denied.headers = { 'x-forwarded-for': '192.168.1.21' };
  server.accept(denied);
  assert.equal(denied.destroyed, true);
  assert.equal(connections.length, before, 'ACL denial must happen before backend connect');
  assert.deepEqual(rejected, ['10.0.0.5']);
  assert.deepEqual(errors, []);

  const allowed = new Socket({ remoteAddress: '::ffff:192.168.1.21' });
  server.accept(allowed);
  assert.equal(connections.length, before + 1);
  await proxy.close();
});

test('LAN proxy keeps the local health source exception when ACL is enabled', () => {
  const proxy = new LanProxy({
    host: '192.168.1.20',
    allowedCidrs: '10.0.0.0/8',
    net: { createServer() {}, createConnection() {} },
  });
  assert.equal(proxy.isClientAllowed({ remoteAddress: '192.168.1.20' }), true);
  assert.equal(proxy.isClientAllowed({ remoteAddress: '127.0.0.1' }), true);
  assert.equal(proxy.isClientAllowed({ remoteAddress: '10.1.2.3' }), true);
  assert.equal(proxy.isClientAllowed({ remoteAddress: '192.168.1.21' }), false);
  assert.equal(proxy.isClientAllowed({}), false);
  const strictProxy = new LanProxy({
    host: '192.168.1.20',
    lanProxyAllowedCidrs: '10.0.0.0/8',
    allowLocalSource: false,
    net: { createServer() {}, createConnection() {} },
  });
  assert.equal(strictProxy.isClientAllowed({ remoteAddress: '192.168.1.20' }), false);
});

test('LAN proxy applies the connection limiter after ACL and rejects without onError', async () => {
  let server;
  const calls = [];
  const rejects = [];
  const errors = [];
  let targetConnections = 0;
  const limiter = {
    tryConsume(descriptors) {
      calls.push(descriptors);
      return { allowed: descriptors[0].key.endsWith('192.168.1.22'), retryAfterMs: 0 };
    },
  };
  const fakeNet = {
    createServer(listener) {
      server = new Server(listener);
      return server;
    },
    createConnection(options) {
      if (options.localAddress !== undefined) return new Socket({ health: true });
      targetConnections += 1;
      return new Socket();
    },
  };
  const proxy = new LanProxy({
    host: '192.168.1.20',
    port: 18787,
    net: fakeNet,
    allowedCidrs: '192.168.1.0/24',
    connectionRateLimiter: limiter,
    onReject: (address, reason) => rejects.push({ address, reason }),
    onError: (error) => errors.push(error),
  });
  await proxy.start();

  // ACL denial must short-circuit the limiter and backend connection.
  server.accept(new Socket({ remoteAddress: '10.0.0.5' }));
  assert.equal(calls.length, 0);
  assert.equal(targetConnections, 0);
  assert.deepEqual(rejects.at(-1), { address: '10.0.0.5', reason: 'acl' });

  const deniedByRate = new Socket({ remoteAddress: '192.168.1.21' });
  server.accept(deniedByRate);
  assert.equal(targetConnections, 0);
  assert.deepEqual(rejects.at(-1), { address: '192.168.1.21', reason: 'rate_limit' });
  assert.match(calls.at(-1)[0].key, /^lan:connection:ip:192\.168\.1\.21$/);

  const accepted = new Socket({ remoteAddress: '192.168.1.22' });
  server.accept(accepted);
  assert.equal(targetConnections, 1);
  assert.deepEqual(errors, []);
  await proxy.close();
});
