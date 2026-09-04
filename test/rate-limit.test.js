import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOGIN_RATE_PROFILE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  DEFAULT_RATE_PER_MINUTE,
  MIN_RATE_LIMIT_MAX_ENTRIES,
  TokenBucketLimiter,
  canonicalizeAddress,
  hashCredential,
} from '../src/rate-limit.js';

test('token bucket exposes the documented defaults and supports an injected clock', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now });
  assert.equal(limiter.ratePerMinute, DEFAULT_RATE_PER_MINUTE);
  assert.equal(limiter.burst, DEFAULT_RATE_LIMIT_BURST);
  assert.equal(limiter.maxEntries, DEFAULT_RATE_LIMIT_MAX_ENTRIES);

  for (let index = 0; index < DEFAULT_RATE_LIMIT_BURST; index += 1) {
    assert.deepEqual(limiter.tryConsume([{ key: 'ip:192.0.2.1' }]), { allowed: true, retryAfterMs: 0 });
  }
  const blocked = limiter.tryConsume([{ key: 'ip:192.0.2.1' }]);
  assert.equal(blocked.allowed, false);
  // 120 tokens/minute is two tokens/second, so one missing token takes 500ms.
  assert.equal(blocked.retryAfterMs, 500);

  now += 500;
  assert.deepEqual(limiter.tryConsume([{ key: 'ip:192.0.2.1' }]), { allowed: true, retryAfterMs: 0 });
});

test('multiple descriptors are checked and committed atomically', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now, burst: 2, ratePerMinute: 60 });
  assert.equal(limiter.tryConsume([{ key: 'ip:a' }, { key: 'session:a' }]).allowed, true);
  assert.equal(limiter.tryConsume([{ key: 'ip:a' }]).allowed, true);

  // The IP bucket is empty while the session bucket still has one token.  A
  // rejected two-key operation must not spend the session token.
  const rejected = limiter.tryConsume([{ key: 'ip:a' }, { key: 'session:a' }]);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterMs, 1000);
  assert.equal(limiter.tryConsume([{ key: 'session:a' }]).allowed, true);
  assert.equal(limiter.tryConsume([{ key: 'session:a' }]).allowed, false);
});

test('descriptor profiles support the stricter five-per-minute login bucket', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now });
  for (let index = 0; index < DEFAULT_LOGIN_RATE_PROFILE.burst; index += 1) {
    assert.equal(limiter.tryConsume([{ key: 'ip:login', profile: 'login' }]).allowed, true);
  }
  const blocked = limiter.tryConsume([{ key: 'ip:login', profile: 'login' }]);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 12_000);

  now += 12_000;
  assert.equal(limiter.tryConsume([{ key: 'ip:login', profile: 'login' }]).allowed, true);
});

test('named login profile cannot be weakened by descriptor overrides', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.tryConsume([{
      key: 'ip:login-override',
      profile: 'login',
      ratePerMinute: 60_000,
      burst: 60_000,
    }]).allowed, true);
  }
  const blocked = limiter.tryConsume([{
    key: 'ip:login-override',
    profile: { name: 'login', ratePerMinute: 60_000, burst: 60_000 },
    ratePerMinute: 60_000,
    burst: 60_000,
  }]);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 12_000);
});

test('the API configuration requires room for source and credential buckets', () => {
  assert.equal(MIN_RATE_LIMIT_MAX_ENTRIES, 2);
});

test('the api profile label keeps deployment-specific constructor limits', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now, ratePerMinute: 1, burst: 1 });
  assert.equal(limiter.tryConsume([{ key: 'api:source', profile: 'api' }]).allowed, true);
  const blocked = limiter.tryConsume([{ key: 'api:source', profile: 'api' }]);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000);
});

test('the bucket map remains bounded and evicts the least recently seen key', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now, maxEntries: 2, burst: 1, ratePerMinute: 60 });
  assert.equal(limiter.tryConsume([{ key: 'a' }]).allowed, true);
  now += 1;
  assert.equal(limiter.tryConsume([{ key: 'b' }]).allowed, true);
  now += 1;
  assert.equal(limiter.tryConsume([{ key: 'c' }]).allowed, true);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.has('a'), false);
  assert.equal(limiter.has('b'), true);
  assert.equal(limiter.has('c'), true);
});

test('address canonicalisation and credential hashing are explicit helpers', () => {
  assert.equal(canonicalizeAddress('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(canonicalizeAddress('::ffff:c000:0207'), '192.0.2.7');
  assert.equal(canonicalizeAddress('0000:0000:0000:0000:0000:FFFF:C000:0207'), '192.0.2.7');
  assert.equal(canonicalizeAddress('[2001:DB8::1]'), '2001:db8::1');
  assert.equal(canonicalizeAddress('2001:0DB8:0000:0000:0000:0000:0000:1'), '2001:db8::1');
  assert.equal(canonicalizeAddress('2001:db8::192.0.2.1'), '2001:db8::c000:201');
  assert.equal(canonicalizeAddress('FE80::1%eth0'), 'unknown');
  assert.equal(canonicalizeAddress('not-an-address'), 'unknown');
  assert.equal(canonicalizeAddress(''), 'unknown');
  const digest = hashCredential('owner-token');
  assert.equal(digest, hashCredential('owner-token'));
  assert.notEqual(digest, 'owner-token');
  assert.match(digest, /^[A-Za-z0-9_-]+$/);
});

test('invalid costs and empty keys fail safely', () => {
  const limiter = new TokenBucketLimiter();
  assert.deepEqual(limiter.tryConsume([]), { allowed: true, retryAfterMs: 0 });
  assert.throws(() => limiter.tryConsume([{ key: '' }]), /key must be non-empty/);
  assert.throws(() => limiter.tryConsume([{ key: 'x' }], 0), /cost must be a positive number/);
  assert.throws(() => limiter.tryConsume([{ key: 'x' }], Number.NaN), /cost must be a positive number/);
});

test('a cost larger than a bucket capacity is permanently unavailable', () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now, ratePerMinute: 60, burst: 2 });
  const rejected = limiter.tryConsume([{ key: 'oversized' }], 3);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterMs, Number.POSITIVE_INFINITY);
  assert.equal(limiter.size, 0, 'an impossible request must not install a bucket');
  now += 60_000;
  const stillRejected = limiter.tryConsume([{ key: 'oversized' }], 3);
  assert.equal(stillRejected.retryAfterMs, Number.POSITIVE_INFINITY);
  assert.equal(limiter.size, 0);
});
