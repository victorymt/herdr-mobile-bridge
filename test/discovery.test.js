import test from 'node:test';
import assert from 'node:assert/strict';

import { collectLanAddresses } from '../src/server.js';

test('LAN discovery prefers IPv4 and keeps candidate addresses bounded', () => {
  const interfaces = {
    vpn0: [
      { address: 'fd00::10', family: 'IPv6', internal: false },
      { address: '10.0.0.8', family: 'IPv4', internal: false },
    ],
    wlan0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: '192.168.1.21', family: 'IPv4', internal: false },
      { address: '192.168.1.22', family: 'IPv4', internal: false },
      { address: '192.168.1.23', family: 'IPv4', internal: false },
      { address: '192.168.1.24', family: 'IPv4', internal: false },
      { address: '192.168.1.25', family: 'IPv4', internal: false },
      { address: '192.168.1.26', family: 'IPv4', internal: false },
      { address: '192.168.1.27', family: 'IPv4', internal: false },
      { address: '192.168.1.28', family: 'IPv4', internal: false },
    ],
  };
  const addresses = collectLanAddresses({}, interfaces);
  assert.equal(addresses.length, 8);
  assert.deepEqual(addresses.slice(0, 3), ['10.0.0.8', '192.168.1.20', '192.168.1.21']);
  assert.ok(addresses.every((address) => !address.includes(':')));
});

test('LAN discovery includes an explicit configured address before interface candidates', () => {
  const addresses = collectLanAddresses(
    { lanProxyHost: '192.168.50.4' },
    { wlan0: [{ address: '192.168.50.5', family: 'IPv4', internal: false }] },
  );
  assert.deepEqual(addresses, ['192.168.50.4', '192.168.50.5']);
});
