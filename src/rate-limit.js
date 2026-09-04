import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Defaults for the request limiter used by the HTTP bridge.
 *
 * `ratePerMinute` is the refill rate, while `burst` is the maximum number of
 * tokens that can be held by one bucket.  Consequently a new bucket can
 * accept `burst` requests immediately and then refills at
 * `ratePerMinute / 60` requests per second.
 */
export const DEFAULT_RATE_PER_MINUTE = 120;
export const DEFAULT_RATE_LIMIT_BURST = 30;
export const DEFAULT_RATE_LIMIT_MAX_ENTRIES = 4096;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
// Descriptive aliases retained for embedders that prefer the longer names.
export const DEFAULT_RATE_LIMIT_PER_MINUTE = DEFAULT_RATE_PER_MINUTE;
export const DEFAULT_BURST = DEFAULT_RATE_LIMIT_BURST;
export const DEFAULT_MAX_ENTRIES = DEFAULT_RATE_LIMIT_MAX_ENTRIES;
// A caller may tune the map below the default, but never beyond this hard
// ceiling. Keeping the bound in the limiter itself prevents direct embedders
// (and the unauthenticated LAN proxy) from bypassing the config-loader cap.
export const MAX_RATE_LIMIT_ENTRIES = 65_536;
// The Bridge API consumes one source bucket and, after authentication, one
// credential/session bucket in the same atomic decision.  A configured map
// with fewer than two entries would therefore make every first authenticated
// request fail closed.  Keep the generic limiter implementation usable with a
// single descriptor, but let configuration-facing validators enforce this
// lower bound explicitly.
export const MIN_RATE_LIMIT_MAX_ENTRIES = 2;

/** The conservative profile used for credential/login attempts. */
export const DEFAULT_LOGIN_RATE_PROFILE = Object.freeze({
  ratePerMinute: 5,
  burst: 5,
  description: 'login attempts per source',
});

// A couple of descriptive aliases make the constants convenient for callers
// without changing the stable constructor API.
export const DEFAULT_API_RATE_PROFILE = Object.freeze({
  ratePerMinute: DEFAULT_RATE_PER_MINUTE,
  burst: DEFAULT_RATE_LIMIT_BURST,
  description: 'authenticated API requests',
});
export const RATE_LIMIT_PROFILES = Object.freeze({
  api: DEFAULT_API_RATE_PROFILE,
  login: DEFAULT_LOGIN_RATE_PROFILE,
});

function finitePositive(value, fallback, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return integer ? Math.max(1, Math.floor(number)) : number;
}

function normaliseRate(value, fallback) {
  // A fractional refill rate is useful to embedders with very small limits,
  // but zero/negative/NaN values must never disable the limiter.
  return finitePositive(value, fallback);
}

function normaliseBurst(value, fallback) {
  return finitePositive(value, fallback, { integer: true });
}

function normaliseMaxEntries(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_RATE_LIMIT_MAX_ENTRIES;
  return Math.min(MAX_RATE_LIMIT_ENTRIES, Math.max(1, Math.floor(number)));
}

function normaliseNow(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

/**
 * Return a stable textual key.  The limiter deliberately does not hash keys:
 * callers can use `canonicalizeAddress()` for IP keys and `hashCredential()`
 * for credential/session keys, while keeping those two policies explicit.
 */
export function normalizeKey(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parseIPv4Value(value) {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  let result = 0n;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

/** Parse an IPv6 literal into its 128-bit integer representation. */
function parseIPv6Value(value) {
  if (typeof value !== 'string' || !value || value.includes('%') || value.includes('[') || value.includes(']')) return undefined;
  let text = value.toLowerCase();
  // RFC 4291 permits a dotted-decimal IPv4 tail. Convert it to two hextets
  // before expanding `::`, which also canonicalizes mixed notation such as
  // `2001:db8::192.0.2.1`.
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    if (colon < 0) return undefined;
    const ipv4 = parseIPv4Value(text.slice(colon + 1));
    if (ipv4 === undefined) return undefined;
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    text = `${text.slice(0, colon)}:${high}:${low}`;
  }

  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1 && text.indexOf('::', doubleColon + 2) !== -1) return undefined;
  let groups;
  if (doubleColon === -1) {
    groups = text.split(':');
    if (groups.length !== 8) return undefined;
  } else {
    const leftText = text.slice(0, doubleColon);
    const rightText = text.slice(doubleColon + 2);
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    if (left.some((group) => group === '') || right.some((group) => group === '')) return undefined;
    if (left.length + right.length >= 8) return undefined;
    groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  }
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  return result;
}

function formatIPv4Value(value) {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

// RFC 5952-style lowercase compressed IPv6 rendering. A zero run is only
// compressed when it contains at least two groups; ties select the leftmost.
function formatIPv6Value(value) {
  const groups = [];
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    groups[index] = Number(remaining & 0xffffn);
    remaining >>= 16n;
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < groups.length && groups[index] === 0) index += 1;
    const length = index - start;
    if (length > bestLength && length >= 2) {
      bestStart = start;
      bestLength = length;
    }
  }
  if (bestStart === 0 && bestLength === groups.length) return '::';
  const rendered = [];
  for (let index = 0; index < groups.length; index += 1) {
    if (index === bestStart) {
      rendered.push('');
      index += bestLength - 1;
      if (index === groups.length - 1) rendered.push('');
    } else {
      rendered.push(groups[index].toString(16));
    }
  }
  let result = rendered.join(':');
  if (result.startsWith(':') && !result.startsWith('::')) result = `:${result}`;
  if (result.endsWith(':') && !result.endsWith('::')) result = `${result}:`;
  return result;
}

/**
 * Canonicalise the address shape returned by Node sockets.  In particular,
 * IPv4 clients can appear as `::ffff:192.0.2.1`; treating that as the same
 * source as `192.0.2.1` prevents a trivial representation-based bypass.
 *
 * The function intentionally does not parse X-Forwarded-For.  A caller must
 * establish a trusted proxy boundary before passing any forwarded address.
 */
export function canonicalizeAddress(address) {
  let value = normalizeKey(address);
  if (!value) return 'unknown';
  // Accept bracketed IPv6 notation when a caller obtains an address from a
  // URL-like source.  Node's remoteAddress itself is not bracketed.
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) {
    // Scope identifiers are meaningful for local interface addresses, but a
    // TCP remoteAddress does not include one. Rejecting them avoids creating
    // representation-specific buckets when a caller supplies an address from
    // a URL/parser rather than from Node's socket API.
    const parsed = parseIPv6Value(value);
    if (parsed === undefined) return 'unknown';
    // IPv4-mapped IPv6 addresses are normalized to the same dotted form as a
    // native IPv4 peer, preventing a representation-based bypass.
    if ((parsed >> 32n) === 0xffffn) return formatIPv4Value(parsed & 0xffffffffn);
    return formatIPv6Value(parsed);
  }
  // Do not collapse arbitrary malformed values into a caller-controlled set
  // of keys.  A single bounded `unknown` bucket is the safe fallback.
  return 'unknown';
}

export const canonicaliseAddress = canonicalizeAddress;

/** Hash a credential/session token before it can enter an in-memory map. */
export function hashCredential(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('base64url');
}

export const hashToken = hashCredential;

function descriptorKey(descriptor) {
  if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)) {
    return normalizeKey(descriptor.key);
  }
  return normalizeKey(descriptor);
}

function descriptorProfile(descriptor, fallback) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return fallback;
  const profile = descriptor.profile;
  const profileName = typeof profile === 'string'
    ? profile
    : (profile && typeof profile === 'object' && !Array.isArray(profile) && typeof profile.name === 'string'
      ? profile.name
      : undefined);
  const fixedLogin = profileName === 'login';
  // `api` means the limiter's configured base profile (which may be a
  // deployment-specific override).  `login` intentionally selects the
  // stricter built-in profile; arbitrary names fall back to the base profile.
  const source = typeof profile === 'string'
    ? (profile === 'api' ? {} : (RATE_LIMIT_PROFILES[profile] || {}))
    : (profile && typeof profile === 'object' && !Array.isArray(profile)
      ? {
        ...(typeof profile.name === 'string' ? (RATE_LIMIT_PROFILES[profile.name] || {}) : {}),
        ...profile,
      }
      : {});
  const sourceRate = normaliseRate(
    source.ratePerMinute ?? source.rate ?? source.limit,
    fallback.ratePerMinute,
  );
  const sourceBurst = normaliseBurst(source.burst ?? source.capacity, fallback.burst);
  // The named login profile is a security policy, not a hint.  Ignore
  // per-descriptor rate/burst overrides (including nested profile objects) so
  // an accidental or hostile caller cannot turn the five-attempt guard into
  // an effectively unlimited bucket.  The generic `api`/custom profiles
  // retain their documented override behaviour.
  const ratePerMinute = fixedLogin
    ? normaliseRate(RATE_LIMIT_PROFILES.login.ratePerMinute, sourceRate)
    : normaliseRate(descriptor.ratePerMinute, sourceRate);
  const burst = fixedLogin
    ? normaliseBurst(RATE_LIMIT_PROFILES.login.burst, sourceBurst)
    : normaliseBurst(descriptor.burst, sourceBurst);
  const description = typeof descriptor.description === 'string'
    ? descriptor.description
    : (typeof source.description === 'string' ? source.description : fallback.description);
  return { ratePerMinute, burst, description };
}

function profileFromOptions(options = {}) {
  const profile = typeof options.profile === 'string'
    ? (RATE_LIMIT_PROFILES[options.profile] || {})
    : (options.profile && typeof options.profile === 'object' && !Array.isArray(options.profile)
      ? {
        ...(typeof options.profile.name === 'string' ? (RATE_LIMIT_PROFILES[options.profile.name] || {}) : {}),
        ...options.profile,
      }
      : {});
  const profileRate = normaliseRate(
    profile.ratePerMinute ?? profile.rate ?? profile.limit,
    DEFAULT_RATE_PER_MINUTE,
  );
  const profileBurst = normaliseBurst(profile.burst ?? profile.capacity, DEFAULT_RATE_LIMIT_BURST);
  return {
    ratePerMinute: normaliseRate(options.ratePerMinute, profileRate),
    burst: normaliseBurst(options.burst, profileBurst),
    description: typeof options.description === 'string'
      ? options.description
      : (typeof profile.description === 'string' ? profile.description : undefined),
  };
}

function refill(state, profile, now) {
  const elapsed = Math.max(0, now - state.updatedAt);
  if (elapsed <= 0) return Math.min(profile.burst, Math.max(0, state.tokens));
  const perMs = profile.ratePerMinute / DEFAULT_RATE_LIMIT_WINDOW_MS;
  return Math.min(profile.burst, Math.max(0, state.tokens) + elapsed * perMs);
}

function waitForTokens(tokens, cost, profile) {
  // A bucket can never hold more than its capacity. Returning an infinite
  // retry interval is preferable to reporting a finite delay that can never
  // make an over-sized request admissible.
  if (cost > profile.burst) return Number.POSITIVE_INFINITY;
  const deficit = cost - tokens;
  if (!(deficit > 0)) return 0;
  const perMs = profile.ratePerMinute / DEFAULT_RATE_LIMIT_WINDOW_MS;
  if (!(perMs > 0) || !Number.isFinite(perMs)) return Number.POSITIVE_INFINITY;
  // Returning at least one millisecond makes `Retry-After` useful to callers
  // even when floating point arithmetic leaves a tiny positive deficit.
  return Math.max(1, Math.ceil(deficit / perMs));
}

function refillDurationMs(profile) {
  const perMs = profile.ratePerMinute / DEFAULT_RATE_LIMIT_WINDOW_MS;
  if (!(perMs > 0) || !Number.isFinite(perMs)) return DEFAULT_RATE_LIMIT_WINDOW_MS;
  return Math.max(DEFAULT_RATE_LIMIT_WINDOW_MS, Math.ceil(profile.burst / perMs));
}

/**
 * Small in-memory token-bucket limiter.
 *
 * The implementation is synchronous by design.  Node executes the whole
 * `tryConsume` call without yielding, so checking every bucket first and only
 * then committing updates gives an atomic multi-key decision (for example an
 * IP bucket plus a session bucket).
 */
export class TokenBucketLimiter {
  constructor(options = {}) {
    const base = profileFromOptions(options);
    this.ratePerMinute = base.ratePerMinute;
    this.burst = base.burst;
    this.maxEntries = normaliseMaxEntries(options.maxEntries);
    this.now = typeof options.now === 'function'
      ? options.now
      : (typeof options.clock === 'function' ? options.clock : () => Date.now());
    this.description = base.description;
    this.buckets = new Map();
    // Keep time monotonic even when a wall clock is adjusted backwards.  A
    // fake clock in tests can still move forwards and backwards safely.
    this.lastNow = undefined;
    // Idle entries are disposable after one standard window.  This bounds
    // memory even when a caller uses a very large, rotating key space.
    this.entryTtlMs = finitePositive(options.entryTtlMs, DEFAULT_RATE_LIMIT_WINDOW_MS, { integer: true });
  }

  get size() {
    return this.buckets.size;
  }

  /** Read-only-by-convention view useful for diagnostics and tests. */
  get entries() {
    return this.buckets;
  }

  _now() {
    const sampled = normaliseNow(this.now());
    if (this.lastNow === undefined || sampled > this.lastNow) this.lastNow = sampled;
    return this.lastNow;
  }

  _prune(now) {
    for (const [key, state] of this.buckets) {
      // Keep an idle bucket until it could naturally refill to capacity.  A
      // low configured rate with a large burst must not regain a fresh burst
      // merely because the memory TTL elapsed.
      const ttl = Math.max(this.entryTtlMs, refillDurationMs(state.profile));
      if (now - state.seenAt >= ttl) this.buckets.delete(key);
    }
  }

  _evictFor(count, now, protectedKeys = new Set()) {
    if (count <= 0) return true;
    this._prune(now);
    while (this.buckets.size + count > this.maxEntries) {
      let candidate;
      for (const [key, state] of this.buckets) {
        if (protectedKeys.has(key)) continue;
        if (!candidate || state.seenAt < candidate.state.seenAt) candidate = { key, state };
      }
      if (!candidate) return false;
      this.buckets.delete(candidate.key);
    }
    return this.buckets.size + count <= this.maxEntries;
  }

  /** Remove all buckets (useful on logout or a configuration reload). */
  clear() {
    this.buckets.clear();
  }

  delete(key) {
    return this.buckets.delete(normalizeKey(key));
  }

  has(key) {
    return this.buckets.has(normalizeKey(key));
  }

  /**
   * Attempt to spend `cost` tokens from every descriptor's bucket.
   *
   * A descriptor may override the base profile with `ratePerMinute`, `burst`,
   * or a nested `{ profile: { ... } }` object.  If any bucket is short, no
   * bucket receives a debit.  `retryAfterMs` is the longest wait among the
   * blocked buckets so a caller can retry when all of them are ready.
   */
  tryConsume(descriptors, cost = 1) {
    const amount = Number(cost);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new TypeError('rate-limit cost must be a positive number');
    }

    const list = Array.isArray(descriptors) ? descriptors : [descriptors];
    // Empty descriptor sets are useful for explicitly exempt routes.  They do
    // not consume anything and return the same decision shape as normal calls.
    if (list.length === 0) return { allowed: true, retryAfterMs: 0 };

    const unique = new Map();
    const base = {
      ratePerMinute: this.ratePerMinute,
      burst: this.burst,
      description: this.description,
    };
    for (const descriptor of list) {
      const key = descriptorKey(descriptor);
      if (!key) throw new TypeError('rate-limit descriptor key must be non-empty');
      // Repeated keys must only cost once.  Prefixing IP/session keys remains
      // the caller's responsibility; this map only deduplicates exact keys.
      if (!unique.has(key)) unique.set(key, descriptorProfile(descriptor, base));
    }

    const now = this._now();
    this._prune(now);
    const plans = [];
    let retryAfterMs = 0;
    let blocked = false;
    for (const [key, requestedProfile] of unique) {
      const state = this.buckets.get(key);
      // Once a bucket exists, retain its original profile.  A caller cannot
      // evade a restrictive profile merely by changing metadata on a retry.
      const profile = state?.profile || requestedProfile;
      const tokens = state ? refill(state, profile, now) : profile.burst;
      const wait = waitForTokens(tokens, amount, profile);
      plans.push({ key, state, profile, tokens, wait });
      if (wait > 0) {
        blocked = true;
        if (Number.isFinite(wait)) retryAfterMs = Math.max(retryAfterMs, wait);
        else retryAfterMs = Number.POSITIVE_INFINITY;
      }
    }

    if (blocked) {
      return {
        allowed: false,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : Number.POSITIVE_INFINITY,
      };
    }

    const missing = plans.filter((plan) => !plan.state).length;
    if (missing > this.maxEntries) {
      // A single call cannot atomically install more keys than the map can
      // hold.  Treat this as a bounded-capacity rejection without mutating any
      // existing bucket.  Normal HTTP calls use at most an IP + session key.
      return { allowed: false, retryAfterMs: this.entryTtlMs };
    }
    const protectedKeys = new Set(plans.map((plan) => plan.key));
    if (!this._evictFor(missing, now, protectedKeys)) {
      // Every existing entry may be one of the keys in this atomic operation;
      // evicting one would make the result surprising and could exceed the
      // configured bound.  Leave the map untouched and ask the caller to
      // retry after the normal idle window.
      return { allowed: false, retryAfterMs: this.entryTtlMs };
    }

    // Commit only after every descriptor passed the preflight above.
    for (const plan of plans) {
      const tokens = plan.tokens - amount;
      if (plan.state) {
        plan.state.tokens = tokens;
        plan.state.updatedAt = now;
        plan.state.seenAt = now;
        // Keep profile immutable, as noted above.
      } else {
        this.buckets.set(plan.key, {
          tokens,
          updatedAt: now,
          seenAt: now,
          profile: plan.profile,
        });
      }
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  // A concise alias for callers that use the conventional limiter vocabulary.
  consume(descriptors, cost = 1) {
    return this.tryConsume(descriptors, cost);
  }
}

// Historical/short aliases are harmless and make embedding easier while the
// canonical exported class remains TokenBucketLimiter.
export const RateLimiter = TokenBucketLimiter;

export function createRateLimiter(options = {}) {
  return new TokenBucketLimiter(options);
}
