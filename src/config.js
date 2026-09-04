import { chmod, mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, chmodSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { randomBytes, createECDH, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseAllowedCidrs } from './network-acl.js';
import {
  DEFAULT_RATE_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  MAX_RATE_LIMIT_ENTRIES,
  MIN_RATE_LIMIT_MAX_ENTRIES,
  canonicalizeAddress,
} from './rate-limit.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_LAN_PROXY_PORT = 18787;
export const DEFAULT_PUSH_TIMEOUT_MS = 5000;
export const MAX_PUSH_TIMEOUT_MS = 60_000;
export const DEFAULT_CONFIG_NAME = 'herdr-mobile-bridge';
export const DEFAULT_HERDR_SOCKET = '/tmp/herdr.sock';
export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 10_000;
export const MAX_REQUEST_BODY_TIMEOUT_MS = 60_000;
export const MAX_ALLOWED_CIDRS = 128;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Keep the Bridge itself on loopback.  LAN access is intentionally provided
 * by the separate forwarding listener; accepting a wildcard here would
 * bypass that boundary and expose the authenticated service directly.
 */
export function assertBridgeHost(host = DEFAULT_HOST) {
  const value = typeof host === 'string' ? host.trim() : '';
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('bridge host must be a loopback address');
  }
  if (value.toLowerCase() === 'localhost') return value;
  const family = isIP(value);
  if (family === 4 && Number(value.split('.')[0]) === 127) return value;
  if (family === 6) {
    // Accept expanded and IPv4-mapped spellings of loopback while retaining
    // the strict literal-IP boundary (no DNS names other than localhost).
    const canonical = canonicalizeAddress(value);
    if (canonical === '::1' || canonical.startsWith('127.')) return value;
  }
  throw new TypeError('bridge host must be a loopback address');
}

/** LAN proxy listeners must bind one explicit IP, never a wildcard. */
export function assertLanProxyHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.includes('%') || value.includes('[') || value.includes(']') || value === '*') {
    throw new TypeError('LAN proxy host must be an explicit interface address');
  }
  if (!isIP(value)) throw new TypeError('LAN proxy host must be an IP address');
  // Reject every textual spelling of an unspecified address, including an
  // expanded IPv6 wildcard and an IPv4-mapped `::ffff:0.0.0.0`. Comparing the
  // canonical form avoids accidentally binding the unauthenticated proxy to
  // all interfaces through an equivalent representation.
  const canonical = canonicalizeAddress(value);
  if (canonical === '0.0.0.0' || canonical === '::' || canonical === 'unknown') {
    throw new TypeError('LAN proxy host must be an explicit interface address');
  }
  return value;
}

/** Return the first non-empty value in an environment-like object. */
export function firstEnv(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

// Unlike firstEnv(), this helper intentionally preserves an explicitly empty
// environment value. It is used for settings where an embedder/launcher must
// be able to clear a value inherited from a config file (for example an empty
// allowed-origin override).
function envValue(env, names) {
  for (const name of names) {
    if (hasOwn(env, name)) return env[name];
  }
  return undefined;
}

function homePath(value, home = homedir()) {
  if (!value) return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

function xdgPath(env, key, fallback, home = homedir()) {
  const value = firstEnv(env, [key]);
  return resolve(homePath(value || fallback, home));
}

/**
 * Resolve filesystem locations without touching the filesystem. Keeping this
 * pure makes it useful to launchers and tests as well as the HTTP server.
 */
export function resolvePaths(env = process.env, options = {}) {
  const envHome = firstEnv(env, ['HOME', 'USERPROFILE']) || homedir();
  const configRoot = resolve(
    homePath(
      options.configDir ||
        firstEnv(env, ['HERDR_PLUGIN_CONFIG_DIR']) ||
        firstEnv(env, ['HERDR_MOBILE_BRIDGE_CONFIG_DIR', 'BRIDGE_CONFIG_DIR']) ||
        join(xdgPath(env, 'XDG_CONFIG_HOME', join(envHome, '.config'), envHome), DEFAULT_CONFIG_NAME),
      envHome,
    ),
  );
  const stateRoot = resolve(
    homePath(
      options.stateDir ||
        firstEnv(env, ['HERDR_PLUGIN_STATE_DIR']) ||
        firstEnv(env, ['HERDR_MOBILE_BRIDGE_STATE_DIR', 'BRIDGE_STATE_DIR']) ||
        join(xdgPath(env, 'XDG_STATE_HOME', join(envHome, '.local', 'state'), envHome), DEFAULT_CONFIG_NAME),
      envHome,
    ),
  );

  const herdrConfigRoot = resolve(
    homePath(
      firstEnv(env, ['HERDR_CONFIG_DIR']) ||
        join(xdgPath(env, 'XDG_CONFIG_HOME', join(envHome, '.config'), envHome), 'herdr'),
      envHome,
    ),
  );
  const socketOptionExplicit = hasExplicitOption(options, 'socketPath');
  let socketPath = socketOptionExplicit
    ? assertConfiguredSocketPath(options.socketPath, true)
    : firstEnv(env, ['HERDR_SOCKET_PATH', 'BRIDGE_SOCKET_PATH']);
  if (!socketPath) {
    const session = firstEnv(env, ['HERDR_SESSION']);
    socketPath = session && session !== 'default'
      ? join(herdrConfigRoot, 'sessions', session, 'herdr.sock')
      : join(herdrConfigRoot, 'herdr.sock');
  }

  const bridgeConfigPath = join(configRoot, 'bridge.json');
  const tokenPath = join(configRoot, 'token');
  const secretPath = join(configRoot, 'bridge-secret');
  const vapidPath = join(configRoot, 'vapid.json');
  // State-file overrides are primarily useful to embedders that inject a
  // configuration object into the detached launcher.  Keep them optional and
  // resolve them exactly like the other filesystem roots so parent and child
  // processes can share a custom (possibly relative) path without relying on
  // their different working directories.
  const pathOverride = (optionKey, envNames, fallback) => {
    const supplied = options[optionKey] || firstEnv(env, envNames) || fallback;
    return resolve(homePath(String(supplied), envHome));
  };
  const runtimePath = pathOverride('runtimePath', [
    'HERDR_BRIDGE_RUNTIME_PATH', 'HERDR_RUNTIME_PATH', 'BRIDGE_RUNTIME_PATH',
  ], join(stateRoot, 'runtime.json'));
  const runtimeLockPath = pathOverride('runtimeLockPath', [
    'HERDR_BRIDGE_RUNTIME_LOCK_PATH', 'HERDR_RUNTIME_LOCK_PATH', 'BRIDGE_RUNTIME_LOCK_PATH',
  ], join(stateRoot, 'runtime.lock'));
  const subscriptionsPath = pathOverride('subscriptionsPath', [
    'HERDR_BRIDGE_SUBSCRIPTIONS_PATH', 'HERDR_SUBSCRIPTIONS_PATH', 'BRIDGE_SUBSCRIPTIONS_PATH',
  ], join(stateRoot, 'subscriptions.json'));
  const dedupPath = pathOverride('dedupPath', [
    'HERDR_BRIDGE_DEDUP_PATH', 'HERDR_DEDUP_PATH', 'BRIDGE_DEDUP_PATH',
  ], join(stateRoot, 'dedup.json'));
  return {
    configDir: configRoot,
    stateDir: stateRoot,
    bridgeConfigPath,
    tokenPath,
    secretPath,
    vapidPath,
    runtimePath,
    runtimeLockPath,
    subscriptionsPath,
    dedupPath,
    socketPath: resolve(homePath(socketPath, envHome)),
  };
}

export function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || value === null) return fallback;
  let candidate = value;
  if (typeof candidate === 'string') {
    candidate = candidate.trim();
    // Preserve the historical empty-string fallback while treating strings
    // containing only whitespace the same way.  This is important for an
    // explicitly empty CLI/environment value and avoids Number(' ') becoming
    // the unrelated ephemeral port 0.
    if (candidate === '') return fallback;
  } else if (typeof candidate === 'boolean' || typeof candidate === 'bigint'
    || typeof candidate === 'symbol' || (typeof candidate === 'object' && candidate !== null)) {
    // JavaScript's Number() coercion would otherwise accept values such as
    // false (0), true (1), [] (0), or [8787] (8787).  Listener ports must be
    // explicit numeric values or numeric strings, never truthiness/coercion
    // accidents.
    throw new Error(`invalid bridge port: ${String(value)}`);
  }
  const number = Number(candidate);
  // Port 0 is useful for embedded callers/tests that ask the OS to allocate
  // an ephemeral listener; environment/configured production ports remain
  // constrained to the normal 1..65535 range by callers when needed.
  if (!Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`invalid bridge port: ${value}`);
  }
  return number;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseBoundedPositive(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  // Flooring a fractional positive value (for example `0.5`) used to yield
  // zero, which violates the "positive" contract and can disable timeout
  // safeguards. Clamp the lower bound after flooring as well as before it.
  const upper = Number.isFinite(Number(maximum)) ? Math.max(1, Math.floor(Number(maximum))) : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(1, Math.floor(number)), upper);
}

function hasOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

// An explicitly supplied empty CLI value is different from an omitted option:
// `--port` should continue using the normal default, while `--port=` should
// reach validation and produce a clear error.  Null/undefined retain the
// historical "not supplied" semantics for programmatic callers.
function hasExplicitOption(options, key) {
  return hasOwn(options, key) && options[key] !== undefined && options[key] !== null;
}

function parseConfiguredPort(value, fallback, label, explicit = false) {
  if (explicit && typeof value === 'string' && value.trim() === '') {
    throw new TypeError(`${label} must not be empty`);
  }
  return parsePort(value, fallback);
}

function assertConfiguredSocketPath(value, explicit = false) {
  if (explicit && (typeof value !== 'string' || value.trim() === '')) {
    throw new TypeError('socket path must not be empty');
  }
  return value;
}

/** Resolve a setting while preserving an explicitly supplied empty value. */
function configuredSetting(options, env, fileConfig, optionKey, envNames = [], fileKey = optionKey) {
  if (hasOwn(options, optionKey) && options[optionKey] !== undefined) {
    return { value: options[optionKey], explicit: true, source: 'options' };
  }
  for (const name of envNames) {
    if (hasOwn(env, name)) return { value: env[name], explicit: true, source: 'env' };
  }
  if (hasOwn(fileConfig, fileKey)) return { value: fileConfig[fileKey], explicit: true, source: 'file' };
  return { value: undefined, explicit: false, source: undefined };
}

function parseSecurityInteger(setting, fallback, maximum, label, minimum = 1) {
  if (!setting.explicit) return fallback;
  const number = Number(setting.value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    if (minimum > 1) {
      throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
    }
    if (!Number.isInteger(number) || number <= 0) {
      throw new TypeError(`${label} must be a positive integer`);
    }
    throw new TypeError(`${label} must be between 1 and ${maximum}`);
  }
  return number;
}

function securitySettings(options, env, fileConfig, lanProxyHost) {
  const aclSetting = configuredSetting(
    options,
    env,
    fileConfig,
    'lanProxyAllowedCidrs',
    ['HERDR_LAN_PROXY_ALLOWED_CIDRS', 'BRIDGE_LAN_PROXY_ALLOWED_CIDRS'],
  );
  const lanProxyAllowedCidrs = aclSetting.explicit
    ? parseAllowedCidrs(aclSetting.value, { maxEntries: MAX_ALLOWED_CIDRS })
    : undefined;
  if (lanProxyAllowedCidrs && !lanProxyHost) {
    throw new TypeError('lanProxyAllowedCidrs requires lanProxyHost');
  }

  const rateLimitPerMinute = parseSecurityInteger(
    configuredSetting(options, env, fileConfig, 'rateLimitPerMinute', [
      'HERDR_BRIDGE_RATE_LIMIT_PER_MINUTE', 'BRIDGE_RATE_LIMIT_PER_MINUTE',
    ]),
    DEFAULT_RATE_PER_MINUTE,
    10_000,
    'rateLimitPerMinute',
  );
  const rateLimitBurstSetting = configuredSetting(options, env, fileConfig, 'rateLimitBurst', [
      'HERDR_BRIDGE_RATE_LIMIT_BURST', 'BRIDGE_RATE_LIMIT_BURST',
    ]);
  const rateLimitBurst = parseSecurityInteger(
    rateLimitBurstSetting,
    Math.min(DEFAULT_RATE_LIMIT_BURST, rateLimitPerMinute),
    rateLimitPerMinute,
    'rateLimitBurst',
  );
  const rateLimitMaxEntries = parseSecurityInteger(
    configuredSetting(options, env, fileConfig, 'rateLimitMaxEntries', [
      'HERDR_BRIDGE_RATE_LIMIT_MAX_ENTRIES', 'BRIDGE_RATE_LIMIT_MAX_ENTRIES',
    ]),
    DEFAULT_RATE_LIMIT_MAX_ENTRIES,
    MAX_RATE_LIMIT_ENTRIES,
    'rateLimitMaxEntries',
    MIN_RATE_LIMIT_MAX_ENTRIES,
  );
  const requestBodyTimeoutMs = parseSecurityInteger(
    configuredSetting(options, env, fileConfig, 'requestBodyTimeoutMs', [
      'HERDR_BRIDGE_REQUEST_BODY_TIMEOUT_MS', 'BRIDGE_REQUEST_BODY_TIMEOUT_MS',
    ]),
    DEFAULT_REQUEST_BODY_TIMEOUT_MS,
    MAX_REQUEST_BODY_TIMEOUT_MS,
    'requestBodyTimeoutMs',
  );
  return {
    lanProxyAllowedCidrs,
    rateLimitPerMinute,
    rateLimitBurst,
    rateLimitMaxEntries,
    requestBodyTimeoutMs,
  };
}

function fingerprintPayload(config = {}) {
  const normalizeList = (value, { split = false, max = 128 } = {}) => {
    if (value === undefined || value === null) return split ? [] : null;
    // String-valued settings use commas as the documented list separator.
    // Keep that same interpretation when an embedder supplies an array: an
    // item such as `['https://a.example,https://b.example']` must fingerprint
    // identically to the serialized child environment value
    // `'https://a.example,https://b.example'`.
    const values = Array.isArray(value)
      ? (split ? value.flatMap((item) => String(item ?? '').split(',')) : value)
      : (split ? String(value).split(',') : [value]);
    return values
      .map((item) => String(item ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim())
      .filter(Boolean)
      .slice(0, max)
      .sort();
  };
  let allowedCidrs = null;
  if (config.lanProxyAllowedCidrs !== undefined) {
    // Fingerprint the effective policy rather than the JavaScript container
    // shape. This keeps equivalent array/string forms stable while ensuring a
    // malformed explicitly supplied value cannot collapse to the ACL-disabled
    // fingerprint and accidentally reuse an old process.
    try {
      allowedCidrs = parseAllowedCidrs(config.lanProxyAllowedCidrs, { maxEntries: MAX_ALLOWED_CIDRS }).sort();
    } catch {
      // Keep a directly injected malformed config distinguishable from an
      // omitted ACL without echoing an unbounded value into the fingerprint
      // payload. Normal loaders still throw the original validation error
      // before this helper is reached.
      allowedCidrs = { invalid: String(config.lanProxyAllowedCidrs).slice(0, 256) };
    }
  }
  // Fingerprints describe effective settings, rather than the incidental
  // shape of an object supplied by an embedder.  `loadConfig()` fills these
  // defaults already, but detached launchers may receive a minimal injected
  // config.  Applying the same defaults here keeps the parent marker and the
  // child process on one stable identity while preserving an explicit invalid
  // value as a distinct (non-reusable) sentinel.
  const blank = (value) => typeof value === 'string' && value.trim() === '';
  const effectiveNumber = (value, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
    if (value === undefined || value === null || blank(value)) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > maximum) {
      return { invalid: String(value).slice(0, 128) };
    }
    return number;
  };
  const effectiveInteger = (value, fallback, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) => {
    if (value === undefined || value === null) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      return { invalid: String(value).slice(0, 128) };
    }
    return number;
  };
  const effectiveRate = effectiveInteger(config.rateLimitPerMinute, DEFAULT_RATE_PER_MINUTE, 10_000);
  const effectiveBurst = config.rateLimitBurst === undefined || config.rateLimitBurst === null
    ? (typeof effectiveRate === 'number' ? Math.min(DEFAULT_RATE_LIMIT_BURST, effectiveRate) : effectiveRate)
    : effectiveInteger(config.rateLimitBurst, DEFAULT_RATE_LIMIT_BURST, 10_000);
  const effectiveLanHost = typeof config.lanProxyHost === 'string'
    ? config.lanProxyHost.trim() || null
    : (config.lanProxyHost || null);
  const proxyEnabled = Boolean(effectiveLanHost);
  const effectiveTargetHost = proxyEnabled
    ? (config.lanProxyTargetHost === undefined || config.lanProxyTargetHost === null || blank(config.lanProxyTargetHost)
      ? (config.host ?? DEFAULT_HOST)
      : config.lanProxyTargetHost)
    : null;
  const effectiveHost = config.host === undefined || config.host === null || blank(config.host)
    ? DEFAULT_HOST
    : config.host;
  // `parsePort()` intentionally permits zero for an ephemeral embedded
  // listener. Keep that value in the fingerprint so a marker created by an
  // embedder is identical to the detached child's resolved configuration.
  const effectivePort = config.port === undefined || config.port === null || blank(config.port)
    ? DEFAULT_PORT
    : (() => {
      const number = Number(config.port);
      return Number.isInteger(number) && number >= 0 && number <= 65_535
        ? number
        : { invalid: String(config.port).slice(0, 128) };
    })();
  const effectiveLanPort = proxyEnabled
    ? (config.lanProxyPort === undefined || config.lanProxyPort === null || blank(config.lanProxyPort)
      ? DEFAULT_LAN_PROXY_PORT
      : effectiveInteger(config.lanProxyPort, DEFAULT_LAN_PROXY_PORT, 65_535))
    : null;
  const effectiveSocketPath = config.socketPath === undefined || config.socketPath === null || blank(config.socketPath)
    ? DEFAULT_HERDR_SOCKET
    : config.socketPath;
  const effectiveRequestTimeout = effectiveNumber(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const effectiveMaxBody = effectiveNumber(config.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const effectiveSessionTtl = effectiveNumber(config.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  const effectiveBodyTimeout = effectiveInteger(config.requestBodyTimeoutMs, DEFAULT_REQUEST_BODY_TIMEOUT_MS, MAX_REQUEST_BODY_TIMEOUT_MS);
  const effectiveMaxEntries = effectiveInteger(config.rateLimitMaxEntries, DEFAULT_RATE_LIMIT_MAX_ENTRIES, MAX_RATE_LIMIT_ENTRIES, MIN_RATE_LIMIT_MAX_ENTRIES);
  const effectivePushTimeout = (() => {
    if (config.pushTimeoutMs === undefined || config.pushTimeoutMs === null || blank(config.pushTimeoutMs)) return DEFAULT_PUSH_TIMEOUT_MS;
    const number = Number(config.pushTimeoutMs);
    if (!Number.isFinite(number) || number <= 0) return DEFAULT_PUSH_TIMEOUT_MS;
    return Math.min(MAX_PUSH_TIMEOUT_MS, Math.max(1, Math.floor(number)));
  })();
  const effectiveAllowCustomPushEndpoints = config.allowCustomPushEndpoints !== undefined
    ? config.allowCustomPushEndpoints === true
    : config.allowCustomEndpoints === true;
  const effectiveAllowPushRelay = config.allowPushRelay !== undefined
    ? config.allowPushRelay === true
    : config.allowRelay === true;
  const effectivePushAllowlist = config.pushEndpointAllowlist
    ?? config.allowedPushEndpointHosts;
  const lanProxyHostRaw = effectiveLanHost;
  const canonicalAddress = (value) => {
    if (!value || typeof value !== 'string') return value;
    const normalized = canonicalizeAddress(value);
    return normalized === 'unknown' ? value : normalized;
  };
  const lanProxyHost = canonicalAddress(lanProxyHostRaw);
  const bridgeHost = canonicalAddress(effectiveHost);
  const targetHost = canonicalAddress(effectiveTargetHost);
  return {
    schema: 1,
    host: bridgeHost,
    port: effectivePort,
    socketPath: effectiveSocketPath,
    lanProxyHost,
    lanProxyPort: lanProxyHost ? effectiveLanPort : null,
    lanProxyAllowedCidrs: allowedCidrs,
    rateLimitPerMinute: effectiveRate,
    rateLimitBurst: effectiveBurst,
    rateLimitMaxEntries: effectiveMaxEntries,
    requestBodyTimeoutMs: effectiveBodyTimeout,
    requestTimeoutMs: effectiveRequestTimeout,
    maxBodyBytes: effectiveMaxBody,
    sessionTtlMs: effectiveSessionTtl,
    allowedOrigin: normalizeList(config.allowedOrigin, { split: true }),
    cookieSecure: config.cookieSecure === true,
    allowSseQueryToken: config.allowSseQueryToken === true,
    healthDetails: config.healthDetails === true,
    allowCustomPushEndpoints: effectiveAllowCustomPushEndpoints,
    allowPushRelay: effectiveAllowPushRelay,
    pushTimeoutMs: effectivePushTimeout,
    pushEndpointAllowlist: normalizeList(effectivePushAllowlist, { split: true }),
    lanProxyTargetHost: targetHost,
  };
}

/** Stable hash of non-secret settings that determine the running listener. */
export function configFingerprint(config = {}) {
  return createHash('sha256').update(JSON.stringify(fingerprintPayload(config))).digest('hex');
}

function pushEndpointAllowlistValue(options, env, fileConfig) {
  return options.pushEndpointAllowlist
    ?? options.allowedPushEndpointHosts
    ?? envValue(env, [
      'HERDR_BRIDGE_PUSH_ENDPOINT_ALLOWLIST',
      'BRIDGE_PUSH_ENDPOINT_ALLOWLIST',
      'HERDR_PUSH_ENDPOINT_ALLOWLIST',
    ])
    ?? fileConfig.pushEndpointAllowlist
    ?? fileConfig.allowedPushEndpointHosts;
}

function pushPolicyValues(options, env, fileConfig) {
  return {
    pushEndpointAllowlist: pushEndpointAllowlistValue(options, env, fileConfig),
    allowCustomPushEndpoints: parseBoolean(
      options.allowCustomPushEndpoints
        ?? options.allowCustomEndpoints
        ?? firstEnv(env, ['HERDR_BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS', 'BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS'])
        ?? fileConfig.allowCustomPushEndpoints
        ?? fileConfig.allowCustomEndpoints,
      false,
    ),
    allowPushRelay: parseBoolean(
      options.allowPushRelay
        ?? options.allowRelay
        ?? firstEnv(env, ['HERDR_BRIDGE_ALLOW_PUSH_RELAY', 'BRIDGE_ALLOW_PUSH_RELAY'])
        ?? fileConfig.allowPushRelay
        ?? fileConfig.allowRelay,
      false,
    ),
    pushTimeoutMs: parseBoundedPositive(
      options.pushTimeoutMs
        ?? firstEnv(env, ['HERDR_BRIDGE_PUSH_TIMEOUT_MS', 'BRIDGE_PUSH_TIMEOUT_MS'])
        ?? fileConfig.pushTimeoutMs,
      DEFAULT_PUSH_TIMEOUT_MS,
      MAX_PUSH_TIMEOUT_MS,
    ),
  };
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // chmod is not available on a few development filesystems (for example
    // Windows); directory creation still provides the required semantics.
  }
}

/**
 * Tighten credentials created by an older bridge release. `mode` on
 * writeFile only applies when a file is newly created, so an existing token,
 * secret, or VAPID file can otherwise remain world-readable forever. Skip
 * symlinks rather than following one into an unrelated user file.
 */
async function hardenPrivateFile(path) {
  if (!path) return;
  try {
    const info = await lstat(path);
    if (info.isFile()) await chmod(path, 0o600);
  } catch {
    // Missing files are generated below; permission changes are best effort on
    // filesystems without POSIX mode bits.
  }
}

function hardenPrivateFileSync(path) {
  if (!path) return;
  try {
    const info = lstatSync(path);
    if (info.isFile()) chmodSync(path, 0o600);
  } catch {
    // Best effort; see hardenPrivateFile.
  }
}

function ensurePrivateDirSync(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

async function writePrivate(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${value}\n`, { mode: 0o600 });
  try {
    await chmod(temporary, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  await rename(temporary, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // Best effort.
  }
}

function writePrivateSync(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Best effort.
  }
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
}

async function readText(path) {
  try {
    const value = await readFile(path, 'utf8');
    return value.trim() || undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function readTextSync(path) {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function generateVapid() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

function keyValue(value, names) {
  if (!value || typeof value !== 'object') return undefined;
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Resolve one explicit VAPID source without combining unrelated halves. */
function configuredVapidPair(options, env) {
  const optionSource = objectValue(options?.vapid);
  const optionPublic = keyValue({
    publicKey: optionSource.publicKey ?? optionSource.public_key ?? options?.vapidPublicKey,
  }, ['publicKey']);
  const optionPrivate = keyValue({
    privateKey: optionSource.privateKey ?? optionSource.private_key ?? options?.vapidPrivateKey,
  }, ['privateKey']);
  if (optionPublic || optionPrivate) {
    if (!optionPublic || !optionPrivate) throw new Error('VAPID publicKey and privateKey must be configured together');
    return { publicKey: optionPublic, privateKey: optionPrivate };
  }

  const envPublic = firstEnv(env, ['HERDR_BRIDGE_VAPID_PUBLIC_KEY', 'VAPID_PUBLIC_KEY']);
  const envPrivate = firstEnv(env, ['HERDR_BRIDGE_VAPID_PRIVATE_KEY', 'VAPID_PRIVATE_KEY']);
  if (envPublic || envPrivate) {
    if (!envPublic || !envPrivate) throw new Error('VAPID public key and private key environment variables must be configured together');
    return { publicKey: envPublic, privateKey: envPrivate };
  }
  return {};
}

/**
 * Resolve a complete VAPID key pair. A public key and private key are a
 * cryptographic unit: silently combining one configured half with a newly
 * generated half creates a pair that can never authenticate. Explicit partial
 * configuration therefore fails clearly; a partial on-disk file is replaced
 * with a fresh complete pair.
 */
function resolveVapid(fileVapid, explicit = {}) {
  const source = fileVapid && typeof fileVapid === 'object' && !Array.isArray(fileVapid) ? fileVapid : {};
  const explicitPublic = keyValue(explicit, ['publicKey', 'public_key', 'vapidPublicKey']);
  const explicitPrivate = keyValue(explicit, ['privateKey', 'private_key', 'vapidPrivateKey']);
  if (explicitPublic || explicitPrivate) {
    if (!explicitPublic || !explicitPrivate) {
      throw new Error('VAPID publicKey and privateKey must be configured together');
    }
    return {
      generated: false,
      vapid: { ...source, publicKey: explicitPublic, privateKey: explicitPrivate },
    };
  }

  const filePublic = keyValue(source, ['publicKey', 'public_key', 'vapidPublicKey']);
  const filePrivate = keyValue(source, ['privateKey', 'private_key', 'vapidPrivateKey']);
  if (filePublic && filePrivate) {
    return {
      generated: false,
      vapid: { ...source, publicKey: filePublic, privateKey: filePrivate },
    };
  }
  return { generated: true, vapid: { ...source, ...generateVapid() } };
}

function vapidSubjectValue(options, env, fileConfig, vapid) {
  return options.vapid?.subject || options.vapidSubject ||
    firstEnv(env, ['HERDR_BRIDGE_VAPID_SUBJECT', 'VAPID_SUBJECT']) ||
    keyValue(vapid, ['subject']) ||
    fileConfig.vapidSubject || keyValue(fileConfig.vapid, ['subject']) ||
    'mailto:herdr-mobile-bridge@localhost';
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

/**
 * Load bridge configuration and create missing local secrets. Secrets are
 * generated only once and written with owner-only permissions.
 */
export async function loadConfig(options = {}) {
  const env = options.env || process.env;
  const paths = resolvePaths(env, options);
  await ensurePrivateDir(paths.configDir);
  await ensurePrivateDir(paths.stateDir);
  const injected = options.ignoreFileConfig === true || firstEnv(env, ['HERDR_BRIDGE_CONFIG_INJECTED']) === '1';
  const fileConfig = injected ? {} : objectValue(await readJson(paths.bridgeConfigPath));

  const tokenFromEnv = firstEnv(env, ['HERDR_BRIDGE_TOKEN', 'BRIDGE_TOKEN']);
  let token = options.token || tokenFromEnv || (await readText(paths.tokenPath));
  await hardenPrivateFile(paths.tokenPath);
  if (!token) {
    token = randomBytes(32).toString('base64url');
    if (options.persistGenerated !== false) await writePrivate(paths.tokenPath, token);
  }
  const secretFromEnv = firstEnv(env, ['HERDR_BRIDGE_SECRET', 'BRIDGE_SECRET']);
  let secret = options.secret || secretFromEnv || (await readText(paths.secretPath));
  await hardenPrivateFile(paths.secretPath);
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    if (options.persistGenerated !== false) await writePrivate(paths.secretPath, secret);
  }

  let vapidFile = {};
  try {
    vapidFile = await readJson(paths.vapidPath);
  } catch (error) {
    // A malformed optional VAPID file should not prevent local control; report
    // it through the returned warning and regenerate below.
    if (options.strictVapid) {
      await hardenPrivateFile(paths.vapidPath);
      throw error;
    }
  }
  await hardenPrivateFile(paths.vapidPath);
  const resolvedVapid = resolveVapid(
    { ...objectValue(fileConfig.vapid), ...objectValue(vapidFile) },
    configuredVapidPair(options, env),
  );
  const vapid = resolvedVapid.vapid;
  if (resolvedVapid.generated && options.persistGenerated !== false) {
    await writePrivate(paths.vapidPath, JSON.stringify(vapid, null, 2));
  }

  const hostValue = hasExplicitOption(options, 'host')
    ? options.host
    : (firstEnv(env, ['HERDR_BRIDGE_HOST', 'BRIDGE_HOST']) || fileConfig.host || DEFAULT_HOST);
  const host = assertBridgeHost(hostValue);
  const portExplicit = hasExplicitOption(options, 'port');
  const portValue = portExplicit
    ? options.port
    : (firstEnv(env, ['HERDR_BRIDGE_PORT', 'BRIDGE_PORT']) ?? fileConfig.port);
  const port = parseConfiguredPort(portValue, DEFAULT_PORT, 'bridge port', portExplicit);
  const lanPortExplicit = hasExplicitOption(options, 'lanProxyPort');
  const lanPortValue = lanPortExplicit
    ? options.lanProxyPort
    : (firstEnv(env, ['HERDR_LAN_PROXY_PORT', 'BRIDGE_LAN_PROXY_PORT']) ?? fileConfig.lanProxyPort);
  const lanProxyPort = parseConfiguredPort(lanPortValue, DEFAULT_LAN_PROXY_PORT, 'LAN proxy port', lanPortExplicit);
  const lanHostExplicit = hasExplicitOption(options, 'lanProxyHost');
  const configuredLanProxyHost = lanHostExplicit
    ? options.lanProxyHost
    : (firstEnv(env, ['HERDR_LAN_PROXY_HOST', 'BRIDGE_LAN_PROXY_HOST']) || fileConfig.lanProxyHost);
  const lanProxyHost = lanHostExplicit
    ? assertLanProxyHost(configuredLanProxyHost)
    : (configuredLanProxyHost ? assertLanProxyHost(configuredLanProxyHost) : undefined);
  if (lanProxyHost && (lanProxyPort < 1 || lanProxyPort === port)) {
    throw new Error('LAN proxy port must be between 1 and 65535 and differ from bridge port');
  }
  const configuredTargetHost = options.lanProxyTargetHost
    ?? envValue(env, ['HERDR_BRIDGE_LAN_PROXY_TARGET_HOST', 'BRIDGE_LAN_PROXY_TARGET_HOST'])
    ?? fileConfig.lanProxyTargetHost;
  const lanProxyTargetHost = configuredTargetHost === undefined || configuredTargetHost === null || configuredTargetHost === ''
    ? undefined
    : assertBridgeHost(configuredTargetHost);
  const socketExplicit = hasExplicitOption(options, 'socketPath');
  const configuredSocketPath = socketExplicit
    ? assertConfiguredSocketPath(options.socketPath, true)
    : (firstEnv(env, ['HERDR_SOCKET_PATH', 'BRIDGE_SOCKET_PATH']) || fileConfig.socketPath || paths.socketPath);
  const socketPath = resolve(homePath(configuredSocketPath, firstEnv(env, ['HOME', 'USERPROFILE']) || homedir()));
  const allowedOrigin = options.allowedOrigin
    ?? envValue(env, ['HERDR_BRIDGE_ALLOWED_ORIGIN', 'BRIDGE_ALLOWED_ORIGIN'])
    ?? fileConfig.allowedOrigin
    ?? '';
  const sessionTtlMs = Number(options.sessionTtlMs
    ?? envValue(env, ['HERDR_BRIDGE_SESSION_TTL_MS', 'BRIDGE_SESSION_TTL_MS'])
    ?? fileConfig.sessionTtlMs
    ?? DEFAULT_SESSION_TTL_MS);
  const requestTimeoutMs = Number(options.requestTimeoutMs
    ?? envValue(env, ['HERDR_BRIDGE_REQUEST_TIMEOUT_MS', 'BRIDGE_REQUEST_TIMEOUT_MS'])
    ?? fileConfig.requestTimeoutMs
    ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const maxBodyBytes = Number(options.maxBodyBytes
    ?? envValue(env, ['HERDR_BRIDGE_MAX_BODY_BYTES', 'BRIDGE_MAX_BODY_BYTES'])
    ?? fileConfig.maxBodyBytes
    ?? DEFAULT_MAX_BODY_BYTES);
  const security = securitySettings(options, env, fileConfig, lanProxyHost);
  const pushPolicy = pushPolicyValues(options, env, fileConfig);
  const vapidSubject = vapidSubjectValue(options, env, fileConfig, vapid);
  const finalVapid = { ...vapid, subject: vapidSubject };
  const result = {
    ...paths,
    host,
    port,
    lanProxyHost,
    lanProxyPort,
    lanProxyTargetHost,
    socketPath,
    token,
    secret,
    vapid: finalVapid,
    allowedOrigin,
    sessionTtlMs: Number.isFinite(sessionTtlMs) && sessionTtlMs > 0 ? sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 5000,
    maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 1024 * 1024,
    ...security,
    ...pushPolicy,
    cookieSecure: parseBoolean(options.cookieSecure ?? firstEnv(env, ['HERDR_BRIDGE_COOKIE_SECURE', 'BRIDGE_COOKIE_SECURE']) ?? fileConfig.cookieSecure, false),
    healthDetails: parseBoolean(options.healthDetails ?? firstEnv(env, ['HERDR_BRIDGE_HEALTH_DETAILS', 'BRIDGE_HEALTH_DETAILS']) ?? fileConfig.healthDetails, false),
    allowSseQueryToken: parseBoolean(options.allowSseQueryToken ?? firstEnv(env, ['HERDR_BRIDGE_ALLOW_SSE_QUERY_TOKEN', 'BRIDGE_ALLOW_SSE_QUERY_TOKEN']) ?? fileConfig.allowSseQueryToken, false),
    version: options.version || fileConfig.version || '0.1.0',
    vapidSubject,
  };
  result.configFingerprint = configFingerprint(result);
  return result;
}

/** Synchronous counterpart used by launcher startup checks. */
export function loadConfigSync(options = {}) {
  const env = options.env || process.env;
  const paths = resolvePaths(env, options);
  ensurePrivateDirSync(paths.configDir);
  ensurePrivateDirSync(paths.stateDir);
  let fileConfig = {};
  const injected = options.ignoreFileConfig === true || firstEnv(env, ['HERDR_BRIDGE_CONFIG_INJECTED']) === '1';
  if (!injected && existsSync(paths.bridgeConfigPath)) {
    try {
      fileConfig = objectValue(JSON.parse(readFileSync(paths.bridgeConfigPath, 'utf8')));
    } catch (error) {
      throw new Error(`invalid JSON in ${paths.bridgeConfigPath}: ${error.message}`);
    }
  }
  const tokenFromEnv = firstEnv(env, ['HERDR_BRIDGE_TOKEN', 'BRIDGE_TOKEN']);
  let token = options.token || tokenFromEnv || readTextSync(paths.tokenPath);
  hardenPrivateFileSync(paths.tokenPath);
  if (!token) {
    token = randomBytes(32).toString('base64url');
    if (options.persistGenerated !== false) writePrivateSync(paths.tokenPath, token);
  }
  const secretFromEnv = firstEnv(env, ['HERDR_BRIDGE_SECRET', 'BRIDGE_SECRET']);
  let secret = options.secret || secretFromEnv || readTextSync(paths.secretPath);
  hardenPrivateFileSync(paths.secretPath);
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    if (options.persistGenerated !== false) writePrivateSync(paths.secretPath, secret);
  }
  let vapidFile = {};
  if (existsSync(paths.vapidPath)) {
    try {
      vapidFile = JSON.parse(readFileSync(paths.vapidPath, 'utf8'));
    } catch {
      vapidFile = {};
    }
  }
  hardenPrivateFileSync(paths.vapidPath);
  const resolvedVapid = resolveVapid(
    { ...objectValue(fileConfig.vapid), ...objectValue(vapidFile) },
    configuredVapidPair(options, env),
  );
  const vapid = resolvedVapid.vapid;
  if (resolvedVapid.generated && options.persistGenerated !== false) {
    writePrivateSync(paths.vapidPath, JSON.stringify(vapid, null, 2));
  }
  const hostValue = hasExplicitOption(options, 'host')
    ? options.host
    : (firstEnv(env, ['HERDR_BRIDGE_HOST', 'BRIDGE_HOST']) || fileConfig.host || DEFAULT_HOST);
  const host = assertBridgeHost(hostValue);
  const portExplicit = hasExplicitOption(options, 'port');
  const portValue = portExplicit
    ? options.port
    : (firstEnv(env, ['HERDR_BRIDGE_PORT', 'BRIDGE_PORT']) ?? fileConfig.port);
  const port = parseConfiguredPort(portValue, DEFAULT_PORT, 'bridge port', portExplicit);
  const lanPortExplicit = hasExplicitOption(options, 'lanProxyPort');
  const lanPortValue = lanPortExplicit
    ? options.lanProxyPort
    : (firstEnv(env, ['HERDR_LAN_PROXY_PORT', 'BRIDGE_LAN_PROXY_PORT']) ?? fileConfig.lanProxyPort);
  const lanProxyPort = parseConfiguredPort(lanPortValue, DEFAULT_LAN_PROXY_PORT, 'LAN proxy port', lanPortExplicit);
  const lanHostExplicit = hasExplicitOption(options, 'lanProxyHost');
  const configuredLanProxyHost = lanHostExplicit
    ? options.lanProxyHost
    : (firstEnv(env, ['HERDR_LAN_PROXY_HOST', 'BRIDGE_LAN_PROXY_HOST']) || fileConfig.lanProxyHost);
  const lanProxyHost = lanHostExplicit
    ? assertLanProxyHost(configuredLanProxyHost)
    : (configuredLanProxyHost ? assertLanProxyHost(configuredLanProxyHost) : undefined);
  if (lanProxyHost && (lanProxyPort < 1 || lanProxyPort === port)) {
    throw new Error('LAN proxy port must be between 1 and 65535 and differ from bridge port');
  }
  const configuredTargetHost = options.lanProxyTargetHost
    ?? envValue(env, ['HERDR_BRIDGE_LAN_PROXY_TARGET_HOST', 'BRIDGE_LAN_PROXY_TARGET_HOST'])
    ?? fileConfig.lanProxyTargetHost;
  const lanProxyTargetHost = configuredTargetHost === undefined || configuredTargetHost === null || configuredTargetHost === ''
    ? undefined
    : assertBridgeHost(configuredTargetHost);
  const home = firstEnv(env, ['HOME', 'USERPROFILE']) || homedir();
  const socketExplicit = hasExplicitOption(options, 'socketPath');
  const configuredSocketPath = socketExplicit
    ? assertConfiguredSocketPath(options.socketPath, true)
    : (firstEnv(env, ['HERDR_SOCKET_PATH', 'BRIDGE_SOCKET_PATH']) || fileConfig.socketPath || paths.socketPath);
  const socketPath = resolve(homePath(configuredSocketPath, home));
  const sessionTtlMs = Number(options.sessionTtlMs
    ?? envValue(env, ['HERDR_BRIDGE_SESSION_TTL_MS', 'BRIDGE_SESSION_TTL_MS'])
    ?? fileConfig.sessionTtlMs
    ?? DEFAULT_SESSION_TTL_MS);
  const requestTimeoutMs = Number(options.requestTimeoutMs
    ?? envValue(env, ['HERDR_BRIDGE_REQUEST_TIMEOUT_MS', 'BRIDGE_REQUEST_TIMEOUT_MS'])
    ?? fileConfig.requestTimeoutMs
    ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const maxBodyBytes = Number(options.maxBodyBytes
    ?? envValue(env, ['HERDR_BRIDGE_MAX_BODY_BYTES', 'BRIDGE_MAX_BODY_BYTES'])
    ?? fileConfig.maxBodyBytes
    ?? DEFAULT_MAX_BODY_BYTES);
  const security = securitySettings(options, env, fileConfig, lanProxyHost);
  const pushPolicy = pushPolicyValues(options, env, fileConfig);
  const vapidSubject = vapidSubjectValue(options, env, fileConfig, vapid);
  const finalVapid = { ...vapid, subject: vapidSubject };
  const result = {
    ...paths,
    host,
    port,
    lanProxyHost,
    lanProxyPort,
    lanProxyTargetHost,
    socketPath,
    token,
    secret,
    vapid: finalVapid,
    allowedOrigin: options.allowedOrigin
      ?? envValue(env, ['HERDR_BRIDGE_ALLOWED_ORIGIN', 'BRIDGE_ALLOWED_ORIGIN'])
      ?? fileConfig.allowedOrigin
      ?? '',
    sessionTtlMs: Number.isFinite(sessionTtlMs) && sessionTtlMs > 0 ? sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 5000,
    maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 1024 * 1024,
    ...security,
    ...pushPolicy,
    cookieSecure: parseBoolean(options.cookieSecure ?? firstEnv(env, ['HERDR_BRIDGE_COOKIE_SECURE', 'BRIDGE_COOKIE_SECURE']) ?? fileConfig.cookieSecure, false),
    healthDetails: parseBoolean(options.healthDetails ?? firstEnv(env, ['HERDR_BRIDGE_HEALTH_DETAILS', 'BRIDGE_HEALTH_DETAILS']) ?? fileConfig.healthDetails, false),
    allowSseQueryToken: parseBoolean(options.allowSseQueryToken ?? firstEnv(env, ['HERDR_BRIDGE_ALLOW_SSE_QUERY_TOKEN', 'BRIDGE_ALLOW_SSE_QUERY_TOKEN']) ?? fileConfig.allowSseQueryToken, false),
    version: options.version || fileConfig.version || '0.1.0',
    vapidSubject,
  };
  result.configFingerprint = configFingerprint(result);
  return result;
}

export { ensurePrivateDir, writePrivate, hardenPrivateFile, hardenPrivateFileSync };
