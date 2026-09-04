import test from 'node:test';
import assert from 'node:assert/strict';

import { isLoopback } from '../src/server.js';

test('server loopback guard accepts every valid loopback representation', () => {
  const accepted = [
    '127.0.0.1',
    '127.0.0.2',
    '127.255.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:2',
  ];
  for (const remoteAddress of accepted) {
    assert.equal(isLoopback({ socket: { remoteAddress } }), true, remoteAddress);
  }
  // Some embedders expose only the legacy connection property; it must use
  // the same strict parser and not silently become a remote request.
  assert.equal(isLoopback({ connection: { remoteAddress: '127.42.0.9' } }), true);
});

test('server loopback guard does not trust forwarded or malformed addresses', () => {
  assert.equal(isLoopback({
    socket: { remoteAddress: '192.168.1.20' },
    headers: { 'x-forwarded-for': '127.0.0.1' },
  }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:192.0.2.1' } }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1%lo' } }), false);
  const throwingSocket = {};
  Object.defineProperty(throwingSocket, 'remoteAddress', { get() { throw new Error('bad socket'); } });
  assert.equal(isLoopback({ socket: throwingSocket }), false);
  assert.equal(isLoopback({}), false);
});
