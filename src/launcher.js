import {
  readFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  writeFileSync,
  chmodSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  loadConfigSync,
  configFingerprint,
  resolvePaths,
  assertBridgeHost,
  assertLanProxyHost,
  parsePort,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_LAN_PROXY_PORT,
  DEFAULT_PUSH_TIMEOUT_MS,
  MAX_PUSH_TIMEOUT_MS,
  DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  MAX_REQUEST_BODY_TIMEOUT_MS,
} from './config.js';
import {
  DEFAULT_RATE_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  MAX_RATE_LIMIT_ENTRIES,
  MIN_RATE_LIMIT_MAX_ENTRIES,
} from './rate-limit.js';

const LOCK_MAX_AGE_MS = 30_000;

function authorityHost(host) {
  const value = String(host ?? '').trim();
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function httpUrl(host, port) {
  return `http://${authorityHost(host)}:${Number(port)}`;
}

function readJson(path, fallback = {}) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export function processAlive(pid, processApi = process) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    processApi.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Read the Linux process identity used by runtime markers. The bridge is a
 * Linux-only plugin, but keeping this probe best-effort preserves compatibility
 * with injected process APIs and older markers on non-/proc filesystems.
 */
function inspectProcess(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return undefined;
  let startTime;
  let cmdline;
  try {
    const stat = readFileSync(`/proc/${numeric}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen >= 0) {
      const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
      // After the comm field, index 19 is field 22 (starttime).
      if (fields[19]) startTime = fields[19];
    }
  } catch {
    // /proc may be unavailable in a test or restricted container.
  }
  try {
    cmdline = readFileSync(`/proc/${numeric}/cmdline`, 'utf8');
  } catch {
    // Best effort; start time is sufficient when available.
  }
  if (!startTime && !cmdline) return undefined;
  return { startTime, cmdline };
}

function safeInspectProcess(pid, inspector) {
  try {
    return (inspector || inspectProcess)(pid);
  } catch {
    return undefined;
  }
}

/**
 * Check a runtime marker's optional process identity after checking liveness.
 * Markers written by older releases have no identity fields and retain the
 * historical PID-only behaviour; new markers are protected against PID reuse
 * when Linux process metadata is available.
 */
export function processMatchesRuntime(runtime, options = {}) {
  const processApi = options.processApi || process;
  const pid = Number(runtime?.pid);
  if (!processAlive(pid, processApi)) return false;
  const expectedStart = runtime?.process_start_time;
  const expectedEntry = runtime?.entry;
  if (!expectedStart && !expectedEntry) return true;
  const actual = safeInspectProcess(pid, options.processInspector);
  // Keep old/injected environments working when /proc cannot be inspected.
  if (!actual) return true;
  if (expectedStart && actual.startTime && String(expectedStart) !== String(actual.startTime)) return false;
  if (expectedStart && !actual.startTime) return false;
  if (expectedEntry && actual.cmdline && !actual.cmdline.includes(String(expectedEntry))) return false;
  if (expectedEntry && !actual.cmdline) return false;
  return true;
}

function lockIsStale(path, now = Date.now()) {
  try { return now - statSync(path).mtimeMs > LOCK_MAX_AGE_MS; } catch { return false; }
}

function acquireLock(path, now = Date.now()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${process.pid} ${now}\n`);
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST' || !lockIsStale(path, now)) return false;
    try { unlinkSync(path); } catch { return false; }
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${process.pid} ${now}\n`);
      closeSync(fd);
      return true;
    } catch { return false; }
  }
}

function releaseLock(path) {
  try { unlinkSync(path); } catch { /* another launcher owns/replaced it */ }
}

function writeRuntime(path, value) {
  // Injected embedders may place the marker outside `stateDir` (for example
  // `<state>/sessions/<name>/runtime.json`). Ensure the containing directory
  // exists before creating the temporary file; `ensureBridge()` only creates
  // the configured state root.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function resolvedFingerprint(config) {
  // Recompute from the effective object instead of trusting a cached field.
  // Embedders commonly mutate an options object between ensure calls; using
  // its stale `configFingerprint` would incorrectly reuse a process whose
  // security settings changed.
  return configFingerprint(config);
}

function serializeAllowedCidrs(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    // A comma is the wire-level separator.  Re-serialising an array item that
    // contains one would silently turn a malformed direct-injection value
    // into two valid rules in the detached child, diverging from the parent's
    // strict array semantics and its configuration fingerprint. Reject before
    // spawning so no partially configured child can be published.
    if (value.some((item) => typeof item !== 'string' || item.includes(','))) {
      throw new TypeError('lanProxyAllowedCidrs array entries must be strings without commas');
    }
    return value.join(',');
  }
  return String(value);
}

function serializeList(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.join(',') : String(value);
}

function httpBoolean(value) {
  return value === true ? 'true' : 'false';
}

function vapidConfigValue(config, name, alias) {
  const vapid = config?.vapid;
  if (vapid && typeof vapid === 'object' && !Array.isArray(vapid)) {
    const value = vapid[name] ?? vapid[alias];
    if (value !== undefined && value !== null) return value;
  }
  const value = config?.[name === 'publicKey' ? 'vapidPublicKey' : 'vapidPrivateKey'];
  return value !== undefined && value !== null ? value : undefined;
}

function vapidSubjectValue(config) {
  const vapid = config?.vapid;
  if (vapid && typeof vapid === 'object' && !Array.isArray(vapid)) {
    const value = vapid.subject;
    if (value !== undefined && value !== null) return value;
  }
  return config?.vapidSubject;
}

function hasOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

// Match config.js credential precedence without accepting arbitrary values.
// Environment credentials are intentionally limited to non-empty strings;
// this keeps a numeric/object test value from becoming a surprising secret
// after spawn() stringifies the environment object.
function firstCredential(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function credentialValue(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.trim() === '' ? undefined : text;
}

/**
 * Detached launchers normally receive a fully resolved object from
 * loadConfigSync().  Embedders may instead inject a deliberately small
 * config object; in that case resolve the socket exactly once here and pass
 * the resulting absolute path to the child.  Without this normalization the
 * parent fingerprint could use one fallback while loadConfigSync() in the
 * child picked up a different HOME/session or an inherited socket alias.
 */
function normalizeInjectedConfig(config, options = {}) {
  if (!config || typeof config !== 'object') return config;
  const blank = (value) => typeof value === 'string' && value.trim() === '';
  // A directly injected object is an explicit configuration source, just like
  // the object passed to BridgeServer. Do not turn a caller's empty listener
  // value into a default here: doing so would let ensureBridge() publish a
  // process whose effective settings differ from the value the caller asked
  // it to validate. `null`/`undefined` remain omission sentinels.
  if (hasOwn(config, 'host') && blank(config.host)) {
    throw new TypeError('bridge host must be a loopback address');
  }
  if (hasOwn(config, 'port') && blank(config.port)) {
    throw new TypeError('bridge port must not be empty');
  }
  if (hasOwn(config, 'lanProxyHost') && blank(config.lanProxyHost)) {
    throw new TypeError('LAN proxy host must be an explicit interface address');
  }
  if (hasOwn(config, 'lanProxyPort') && blank(config.lanProxyPort)) {
    throw new TypeError('LAN proxy port must not be empty');
  }
  if (hasOwn(config, 'socketPath') && config.socketPath !== undefined && config.socketPath !== null
    && (typeof config.socketPath !== 'string' || config.socketPath.trim() === '')) {
    throw new TypeError('socket path must not be empty');
  }
  const suppliedEnv = options.env && typeof options.env === 'object' ? options.env : {};
  const env = { ...process.env, ...suppliedEnv };
  const pathEnv = { ...env };
  // A detached child runs with `options.cwd` (when supplied), so relative
  // paths in a directly injected object must be anchored there as well.  The
  // regular config loader has already resolved its roots; this branch is the
  // only place where a caller can hand us raw relative paths.  Resolve them
  // once before computing the marker and before exporting child env values so
  // parent, child, and later status/stop calls all address the same files.
  const envHome = (typeof env.HOME === 'string' && env.HOME.trim())
    || (typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim())
    || homedir();
  const pathBase = resolve(options.cwd || process.cwd());
  const resolveInjectedPath = (value) => {
    if (typeof value !== 'string' || value === '') return value;
    const expanded = envHome && value === '~'
      ? envHome
      : (envHome && value.startsWith('~/') ? join(envHome, value.slice(2)) : value);
    return resolve(pathBase, expanded);
  };
  const effectivePathValue = (key) => {
    const configValue = config[key];
    if (configValue !== undefined && configValue !== null && !blank(configValue)) return configValue;
    const optionValue = options[key];
    if (optionValue !== undefined && optionValue !== null && !blank(optionValue)) return optionValue;
    return undefined;
  };
  const pathOptions = {};
  for (const key of [
    'configDir', 'stateDir', 'runtimePath', 'runtimeLockPath',
    'subscriptionsPath', 'dedupPath', 'socketPath',
  ]) {
    const value = effectivePathValue(key);
    if (value !== undefined) pathOptions[key] = resolveInjectedPath(value);
  }
  // State-file aliases are launcher-internal.  Do not let a Herdr process
  // environment left over from another bridge session silently select paths
  // for a deliberately injected config.  An explicit options.env alias is
  // still honored when the injected object omits that path, preserving the
  // useful embedding override without inheriting ambient state.
  const statePathAliases = [
    ['runtimePath', ['HERDR_BRIDGE_RUNTIME_PATH', 'HERDR_RUNTIME_PATH', 'BRIDGE_RUNTIME_PATH']],
    ['runtimeLockPath', ['HERDR_BRIDGE_RUNTIME_LOCK_PATH', 'HERDR_RUNTIME_LOCK_PATH', 'BRIDGE_RUNTIME_LOCK_PATH']],
    ['subscriptionsPath', ['HERDR_BRIDGE_SUBSCRIPTIONS_PATH', 'HERDR_SUBSCRIPTIONS_PATH', 'BRIDGE_SUBSCRIPTIONS_PATH']],
    ['dedupPath', ['HERDR_BRIDGE_DEDUP_PATH', 'HERDR_DEDUP_PATH', 'BRIDGE_DEDUP_PATH']],
  ];
  for (const [optionKey, names] of statePathAliases) {
    for (const name of names) delete pathEnv[name];
    if (hasOwn(config, optionKey)) {
      const value = config[optionKey];
      if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) {
        pathEnv[names[0]] = String(value);
      }
    } else {
      for (const name of names) {
        if (hasOwn(suppliedEnv, name)) {
          // `options.env` is an explicit embedding override. Resolve a
          // relative alias against the detached child's cwd just like a path
          // supplied on the injected config object; ambient process.env
          // aliases were removed above and must not influence this branch.
          const value = suppliedEnv[name];
          pathEnv[name] = typeof value === 'string' ? resolveInjectedPath(value) : value;
        }
      }
    }
  }
  // Only explicit options.env socket aliases should influence an injected
  // object.  Values inherited from the launcher's own Herdr session are not
  // part of that object's configuration and can otherwise win by precedence.
  const suppliedHerdrSocket = hasOwn(suppliedEnv, 'HERDR_SOCKET_PATH')
    ? suppliedEnv.HERDR_SOCKET_PATH
    : undefined;
  const suppliedBridgeSocket = hasOwn(suppliedEnv, 'BRIDGE_SOCKET_PATH')
    ? suppliedEnv.BRIDGE_SOCKET_PATH
    : undefined;
  delete pathEnv.HERDR_SOCKET_PATH;
  delete pathEnv.BRIDGE_SOCKET_PATH;
  if (hasOwn(config, 'socketPath')) {
    // An injected value is authoritative (explicit blanks were rejected
    // above). Do not let a stale alias win.
    if (config.socketPath !== undefined && config.socketPath !== null && String(config.socketPath).trim() !== '') {
      pathEnv.HERDR_SOCKET_PATH = resolveInjectedPath(String(config.socketPath));
    }
  } else if (options.socketPath !== undefined && options.socketPath !== null && String(options.socketPath).trim() !== '') {
    // Keep direct-injection options compatible with loadConfigSync(options)
    // when the object itself omits a socket path.
    pathEnv.HERDR_SOCKET_PATH = resolveInjectedPath(String(options.socketPath));
  } else if (hasOwn(suppliedEnv, 'HERDR_SOCKET_PATH') || hasOwn(suppliedEnv, 'BRIDGE_SOCKET_PATH')) {
    if (suppliedHerdrSocket !== undefined) pathEnv.HERDR_SOCKET_PATH = resolveInjectedPath(String(suppliedHerdrSocket));
    if (suppliedBridgeSocket !== undefined) pathEnv.BRIDGE_SOCKET_PATH = resolveInjectedPath(String(suppliedBridgeSocket));
  }
  const paths = resolvePaths(pathEnv, pathOptions);
  const socketPath = paths.socketPath;
  const fallbackPositive = (value, fallback, { integer = false, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
    if (value === undefined || value === null || blank(value)) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    const normalized = integer ? Math.max(1, Math.floor(number)) : number;
    return Math.min(normalized, maximum);
  };
  const strictInteger = (value, fallback, maximum, label) => {
    if (value === undefined) return fallback;
    const number = Number(value);
    const minimum = label === 'rateLimitMaxEntries' ? MIN_RATE_LIMIT_MAX_ENTRIES : 1;
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new TypeError(`${label} must be a positive integer between ${minimum} and ${maximum}`);
    }
    return number;
  };
  const booleanValue = (value, fallback = false) => {
    if (value === undefined || value === null || blank(value)) return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  };

  // Keep the detached child on the same effective values as loadConfigSync.
  // This matters for embedders that pass a small object instead of the fully
  // resolved loader result (where fields such as `''` otherwise acquire
  // different meanings in the two processes).
  const normalized = { ...config };
  normalized.configDir = paths.configDir;
  normalized.stateDir = paths.stateDir;
  normalized.host = assertBridgeHost(config.host == null ? DEFAULT_HOST : config.host);
  normalized.port = parsePort(config.port == null ? undefined : config.port, DEFAULT_PORT);
  const lanHost = config.lanProxyHost == null
    ? undefined
    : assertLanProxyHost(config.lanProxyHost);
  normalized.lanProxyHost = lanHost;
  normalized.lanProxyPort = lanHost
    ? parsePort(config.lanProxyPort == null ? undefined : config.lanProxyPort, DEFAULT_LAN_PROXY_PORT)
    : undefined;
  if (lanHost && (normalized.lanProxyPort < 1 || normalized.lanProxyPort === normalized.port)) {
    throw new Error('LAN proxy port must be between 1 and 65535 and differ from bridge port');
  }
  normalized.lanProxyTargetHost = blank(config.lanProxyTargetHost) || config.lanProxyTargetHost == null
    ? undefined
    : assertBridgeHost(config.lanProxyTargetHost);
  // Keep an explicitly supplied ACL value verbatim here.  The normal config
  // loaders and LanProxy constructor perform strict validation; preserving a
  // malformed direct-injection value lets the detached child report the same
  // clear validation error instead of the launcher silently rewriting it.
  normalized.lanProxyAllowedCidrs = hasOwn(config, 'lanProxyAllowedCidrs')
    ? config.lanProxyAllowedCidrs
    : undefined;
  normalized.rateLimitPerMinute = strictInteger(config.rateLimitPerMinute, DEFAULT_RATE_PER_MINUTE, 10_000, 'rateLimitPerMinute');
  normalized.rateLimitBurst = strictInteger(
    config.rateLimitBurst,
    Math.min(DEFAULT_RATE_LIMIT_BURST, normalized.rateLimitPerMinute),
    normalized.rateLimitPerMinute,
    'rateLimitBurst',
  );
  normalized.rateLimitMaxEntries = strictInteger(config.rateLimitMaxEntries, DEFAULT_RATE_LIMIT_MAX_ENTRIES, MAX_RATE_LIMIT_ENTRIES, 'rateLimitMaxEntries');
  normalized.requestBodyTimeoutMs = strictInteger(config.requestBodyTimeoutMs, DEFAULT_REQUEST_BODY_TIMEOUT_MS, MAX_REQUEST_BODY_TIMEOUT_MS, 'requestBodyTimeoutMs');
  normalized.requestTimeoutMs = fallbackPositive(config.requestTimeoutMs, 5_000);
  normalized.maxBodyBytes = fallbackPositive(config.maxBodyBytes, 1024 * 1024);
  normalized.sessionTtlMs = fallbackPositive(config.sessionTtlMs, 7 * 24 * 60 * 60 * 1000);
  normalized.allowedOrigin = config.allowedOrigin == null ? '' : config.allowedOrigin;
  normalized.cookieSecure = booleanValue(config.cookieSecure);
  normalized.healthDetails = booleanValue(config.healthDetails);
  normalized.allowSseQueryToken = booleanValue(config.allowSseQueryToken);
  normalized.allowCustomPushEndpoints = booleanValue(
    config.allowCustomPushEndpoints ?? config.allowCustomEndpoints,
  );
  normalized.allowPushRelay = booleanValue(
    config.allowPushRelay ?? config.allowRelay,
  );
  normalized.pushTimeoutMs = fallbackPositive(config.pushTimeoutMs, DEFAULT_PUSH_TIMEOUT_MS, {
    integer: true,
    maximum: MAX_PUSH_TIMEOUT_MS,
  });
  normalized.pushEndpointAllowlist = config.pushEndpointAllowlist ?? config.allowedPushEndpointHosts;
  normalized.socketPath = socketPath;
  // State paths are not part of the public environment API, so a child that
  // only receives config/state roots would otherwise silently fall back to
  // `<stateDir>/*.json` while the parent launcher keeps using an injected
  // relative/custom path. Resolve explicit values once in the parent and pass
  // the resulting absolute paths through dedicated environment variables
  // below. `options.cwd` mirrors the detached child's cwd when supplied;
  // otherwise paths are relative to the launcher's current directory.
  const absoluteStatePath = (value, fallback) => {
    if (value === undefined || value === null || blank(value)) return fallback;
    const text = String(value);
    const expanded = envHome && text === '~'
      ? envHome
      : (envHome && text.startsWith('~/') ? join(envHome, text.slice(2)) : text);
    return resolve(pathBase, expanded);
  };
  normalized.runtimePath = absoluteStatePath(config.runtimePath, paths.runtimePath);
  normalized.runtimeLockPath = absoluteStatePath(config.runtimeLockPath, paths.runtimeLockPath);
  normalized.subscriptionsPath = absoluteStatePath(config.subscriptionsPath, paths.subscriptionsPath);
  normalized.dedupPath = absoluteStatePath(config.dedupPath, paths.dedupPath);
  // Keep the injected configuration's public shape consistent with the
  // loader result.  ensureBridge() recomputes this value before writing the
  // runtime marker, but callers also rely on `result.config` when deciding
  // whether a restart is required.
  normalized.configFingerprint = configFingerprint(normalized);
  return normalized;
}

/**
 * Read a numeric CLI option without turning an omitted value into a default.
 * A following long/short option is left for the next parser iteration, while
 * negative numeric literals are still consumed and then rejected by the
 * config validator as out of range.
 */
function numericOptionValue(argv, index, inline) {
  if (inline !== undefined) return { value: inline === '' ? '' : Number(inline), consumed: false };
  const candidate = argv[index + 1];
  if (candidate === undefined || candidate === '-h' || String(candidate).startsWith('--')) {
    return { value: '', consumed: false };
  }
  return { value: String(candidate) === '' ? '' : Number(candidate), consumed: true };
}

/** Preserve explicit `--flag=` while leaving a following option untouched. */
function textOptionValue(argv, index, inline) {
  if (inline !== undefined) return { value: inline, consumed: false, explicit: true };
  const candidate = argv[index + 1];
  if (candidate === undefined || String(candidate).startsWith('-')) {
    return { value: undefined, consumed: false, explicit: false };
  }
  return { value: String(candidate), consumed: true, explicit: true };
}

/** Numeric listener option parser; negative literals remain values for validation. */
function portOptionValue(argv, index, inline) {
  if (inline !== undefined) return { value: inline === '' ? '' : Number(inline), consumed: false, explicit: true };
  const candidate = argv[index + 1];
  // Keep `-h`/`--long-option` available to the main loop, but consume other
  // single-dash tokens (including malformed/negative numerics) so the config
  // validator can report a deterministic invalid-port error.
  if (candidate === undefined || candidate === '-h' || String(candidate).startsWith('--')) {
    return { value: undefined, consumed: false, explicit: false };
  }
  return { value: String(candidate) === '' ? '' : Number(candidate), consumed: true, explicit: true };
}

function configMismatchResult(config, runtime) {
  return {
    started: false,
    running: true,
    restartRequired: true,
    reason: 'config_mismatch',
    pid: Number(runtime?.pid) || null,
    runtime,
    config,
  };
}

function runtimeSecurityMetadata(config) {
  return {
    config_fingerprint: resolvedFingerprint(config),
    acl_enabled: config.lanProxyAllowedCidrs !== undefined,
    rate_limit_per_minute: config.rateLimitPerMinute,
    rate_limit_burst: config.rateLimitBurst,
    rate_limit_max_entries: config.rateLimitMaxEntries,
    request_body_timeout_ms: config.requestBodyTimeoutMs,
  };
}

function runtimePort(config, runtime) {
  // Port 0 asks the OS for an ephemeral listener. Once the detached child has
  // published its concrete port, refreshing the marker must not overwrite it
  // with the configuration sentinel `0` (otherwise status/clients would be
  // directed to `http://host:0`).
  if (Number(config.port) === 0 && Number.isInteger(Number(runtime?.port)) && Number(runtime.port) > 0) {
    return Number(runtime.port);
  }
  return config.port;
}

/**
 * Resolve the optional configuration object used by launcher lifecycle APIs.
 *
 * `null` and `undefined` intentionally mean "load the configured file", while
 * every other supplied value must be a non-array configuration object (arrays
 * and primitive truthy/falsy values are almost invariably caller mistakes). Keep
 * this check shared by ensure/stop/status so the three entry points cannot
 * silently choose different configuration sources.
 */
function suppliedLauncherConfig(options = {}) {
  const value = options?.config;
  if (value !== undefined && value !== null
    && (typeof value !== 'object' || Array.isArray(value))) {
    throw new TypeError('options.config must be an object or null');
  }
  return value;
}

/** Ensure one detached gateway process and refresh its session socket marker. */
export function ensureBridge(options = {}) {
  // `null` is the conventional JavaScript spelling for an omitted optional
  // config.  Keep it on the loader path; treating it as an injected object
  // would set HERDR_BRIDGE_CONFIG_INJECTED for the child while the parent had
  // actually loaded bridge.json, causing stale-file settings to diverge.
  const suppliedConfig = suppliedLauncherConfig(options);
  const injectedConfig = suppliedConfig !== undefined && suppliedConfig !== null;
  // The synchronous loader also supports an explicit file-isolation mode.
  // Carry that decision into the detached child even when the caller passed
  // `config:null` (or inherited the internal marker) so both processes read
  // the same authoritative source instead of one re-enabling bridge.json.
  const suppliedEnv = options.env && typeof options.env === 'object' ? options.env : process.env;
  const childConfigInjected = injectedConfig
    || options.ignoreFileConfig === true
    || String(suppliedEnv?.HERDR_BRIDGE_CONFIG_INJECTED ?? '').trim() === '1';
  let config = injectedConfig
    ? normalizeInjectedConfig(suppliedConfig, options)
    : loadConfigSync(options);
  const suppliedToken = firstCredential(suppliedEnv, ['HERDR_BRIDGE_TOKEN', 'BRIDGE_TOKEN']);
  const suppliedSecret = firstCredential(suppliedEnv, ['HERDR_BRIDGE_SECRET', 'BRIDGE_SECRET']);
  // A directly injected object bypasses loadConfig(), so an embedder may use
  // the normal credential environment as its fallback. Copy those explicit
  // values into the normalized object before publishing the marker; otherwise
  // the parent result would advertise an empty credential while the detached
  // child authenticates with the environment value.
  if (injectedConfig) {
    if (credentialValue(config.token) === undefined && suppliedToken !== undefined) config.token = suppliedToken;
    if (credentialValue(config.secret) === undefined && suppliedSecret !== undefined) config.secret = suppliedSecret;
  }
  const optionToken = credentialValue(options.token);
  const optionSecret = credentialValue(options.secret);
  const hasExplicitEnv = Boolean(options.env && typeof options.env === 'object');
  // Do not infer explicit credentials from `config.token`/`config.secret`:
  // loadConfigSync() always materializes those fields, even when they came
  // from a private file. Injecting every file-backed secret into an inherited
  // environment needlessly broadens its visibility through /proc and crash
  // diagnostics. Forward only values that the child cannot otherwise recover
  // (direct injection, explicit options, explicit env, or non-persisted
  // generation). `clearCredentialAliases` separately removes stale aliases
  // when options.env replaces the parent's environment object.
  const propagateToken = credentialValue(config.token) !== undefined && (
    injectedConfig || optionToken !== undefined || options.persistGenerated === false
      || (hasExplicitEnv && suppliedToken !== undefined)
  );
  const propagateSecret = credentialValue(config.secret) !== undefined && (
    injectedConfig || optionSecret !== undefined || options.persistGenerated === false
      || (hasExplicitEnv && suppliedSecret !== undefined)
  );
  const clearCredentialAliases = injectedConfig || optionToken !== undefined || optionSecret !== undefined
    || options.persistGenerated === false || hasExplicitEnv;
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const runtimePath = config.runtimePath || join(config.stateDir, 'runtime.json');
  const lockPath = config.runtimeLockPath || join(config.stateDir, 'runtime.lock');
  const processApi = options.processApi || process;
  const runtime = readJson(runtimePath);
  if (processMatchesRuntime(runtime, { ...options, processApi })) {
    if (runtime.config_fingerprint !== resolvedFingerprint(config)) {
      return configMismatchResult(config, runtime);
    }
    const refreshed = {
      ...runtime,
      host: config.host,
      port: runtimePort(config, runtime),
      socket_path: config.socketPath,
      ...runtimeSecurityMetadata(config),
    };
    try { writeRuntime(runtimePath, refreshed); } catch { /* status marker is best effort */ }
    return { started: false, pid: Number(runtime.pid), runtime: refreshed, config };
  }
  if (!acquireLock(lockPath)) {
    const pending = readJson(runtimePath);
    return { started: false, pending: true, pid: Number(pending.pid) || null, runtime: pending, config };
  }
  try {
    const afterLock = readJson(runtimePath);
    if (processMatchesRuntime(afterLock, { ...options, processApi })) {
      if (afterLock.config_fingerprint !== resolvedFingerprint(config)) {
        return configMismatchResult(config, afterLock);
      }
      const refreshed = {
        ...afterLock,
        host: config.host,
        port: runtimePort(config, afterLock),
        socket_path: config.socketPath,
        ...runtimeSecurityMetadata(config),
      };
      try { writeRuntime(runtimePath, refreshed); } catch { /* best effort */ }
      return { started: false, pid: Number(afterLock.pid), runtime: refreshed, config };
    }
    const entry = options.entry || fileURLToPath(new URL('./index.js', import.meta.url));
    const entryPath = resolve(entry);
    const spawn = options.spawn || nodeSpawn;
    // The detached child cannot rely on the launcher's parsed CLI options or
    // on a caller's current working directory. Propagate the resolved bridge
    // roots and listener/socket settings explicitly so a custom setup (for
    // example an ephemeral test port or a named Herdr session) starts with the
    // exact configuration represented by the runtime marker.
    const childEnv = {
      ...process.env,
      ...(options.env || {}),
      HERDR_BRIDGE_DETACHED: '1',
    };
    // Node's spawn treats undefined environment values inconsistently across
    // versions (and some versions stringify them). Only override inherited
    // settings when loadConfig actually resolved a value; this also keeps
    // ensureBridge usable with a small injected config in tests/embedders.
    const resolvedEnv = {
      HERDR_BRIDGE_CONFIG_INJECTED: childConfigInjected ? '1' : undefined,
      HERDR_PLUGIN_CONFIG_DIR: config.configDir,
      HERDR_PLUGIN_STATE_DIR: config.stateDir,
      HERDR_BRIDGE_RUNTIME_PATH: config.runtimePath,
      HERDR_BRIDGE_RUNTIME_LOCK_PATH: config.runtimeLockPath,
      HERDR_BRIDGE_SUBSCRIPTIONS_PATH: config.subscriptionsPath,
      HERDR_BRIDGE_DEDUP_PATH: config.dedupPath,
      HERDR_BRIDGE_HOST: config.host,
      HERDR_BRIDGE_PORT: config.port === undefined || config.port === null ? undefined : String(config.port),
      HERDR_SOCKET_PATH: config.socketPath,
      HERDR_LAN_PROXY_HOST: config.lanProxyHost,
      HERDR_LAN_PROXY_PORT: config.lanProxyHost && config.lanProxyPort !== undefined && config.lanProxyPort !== null
        ? String(config.lanProxyPort)
        : undefined,
      HERDR_BRIDGE_LAN_PROXY_TARGET_HOST: config.lanProxyTargetHost,
      HERDR_LAN_PROXY_ALLOWED_CIDRS: serializeAllowedCidrs(config.lanProxyAllowedCidrs),
      HERDR_BRIDGE_RATE_LIMIT_PER_MINUTE: config.rateLimitPerMinute === undefined ? undefined : String(config.rateLimitPerMinute),
      HERDR_BRIDGE_RATE_LIMIT_BURST: config.rateLimitBurst === undefined ? undefined : String(config.rateLimitBurst),
      HERDR_BRIDGE_RATE_LIMIT_MAX_ENTRIES: config.rateLimitMaxEntries === undefined ? undefined : String(config.rateLimitMaxEntries),
      HERDR_BRIDGE_REQUEST_BODY_TIMEOUT_MS: config.requestBodyTimeoutMs === undefined ? undefined : String(config.requestBodyTimeoutMs),
      HERDR_BRIDGE_SESSION_TTL_MS: config.sessionTtlMs === undefined ? undefined : String(config.sessionTtlMs),
      HERDR_BRIDGE_REQUEST_TIMEOUT_MS: config.requestTimeoutMs === undefined ? undefined : String(config.requestTimeoutMs),
      HERDR_BRIDGE_MAX_BODY_BYTES: config.maxBodyBytes === undefined ? undefined : String(config.maxBodyBytes),
      HERDR_BRIDGE_ALLOWED_ORIGIN: config.allowedOrigin === undefined ? undefined : String(config.allowedOrigin),
      HERDR_BRIDGE_COOKIE_SECURE: config.cookieSecure === undefined ? undefined : httpBoolean(config.cookieSecure),
      HERDR_BRIDGE_HEALTH_DETAILS: config.healthDetails === undefined ? undefined : httpBoolean(config.healthDetails),
      HERDR_BRIDGE_ALLOW_SSE_QUERY_TOKEN: config.allowSseQueryToken === undefined ? undefined : httpBoolean(config.allowSseQueryToken),
      HERDR_BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS: config.allowCustomPushEndpoints === undefined
        ? (config.allowCustomEndpoints === undefined ? undefined : httpBoolean(config.allowCustomEndpoints))
        : httpBoolean(config.allowCustomPushEndpoints),
      HERDR_BRIDGE_ALLOW_PUSH_RELAY: config.allowPushRelay === undefined
        ? (config.allowRelay === undefined ? undefined : httpBoolean(config.allowRelay))
        : httpBoolean(config.allowPushRelay),
      HERDR_BRIDGE_PUSH_TIMEOUT_MS: config.pushTimeoutMs === undefined ? undefined : String(config.pushTimeoutMs),
      HERDR_BRIDGE_PUSH_ENDPOINT_ALLOWLIST: serializeList(config.pushEndpointAllowlist ?? config.allowedPushEndpointHosts),
      // A direct injected config can carry an in-memory VAPID pair that is not
      // present in the child's config directory. Pass the pair through the
      // same canonical environment names consumed by configuredVapidPair().
      // Normal loader launches continue to use their persisted VAPID file and
      // do not expose the private key in a new environment variable.
      HERDR_BRIDGE_VAPID_PUBLIC_KEY: injectedConfig && vapidConfigValue(config, 'publicKey', 'public_key') !== undefined
        ? String(vapidConfigValue(config, 'publicKey', 'public_key'))
        : undefined,
      HERDR_BRIDGE_VAPID_PRIVATE_KEY: injectedConfig && vapidConfigValue(config, 'privateKey', 'private_key') !== undefined
        ? String(vapidConfigValue(config, 'privateKey', 'private_key'))
        : undefined,
      HERDR_BRIDGE_VAPID_SUBJECT: injectedConfig && vapidSubjectValue(config) !== undefined
        ? String(vapidSubjectValue(config))
        : undefined,
      // When an embedder supplies an already-resolved config object (or an
      // explicit non-persisted credential), make the detached child use the
      // same values even if the parent process has stale aliases in its
      // environment. File-backed credentials are intentionally left in the
      // file for normal CLI launches instead of being copied into /proc-visible
      // child environment state.
      HERDR_BRIDGE_TOKEN: propagateToken ? String(config.token) : undefined,
      HERDR_BRIDGE_SECRET: propagateSecret ? String(config.secret) : undefined,
    };
    // Do not let a stale inherited alias unexpectedly enable the optional LAN
    // listener when the resolved configuration has it disabled. The child
    // receives one authoritative value for each setting.
    for (const key of [
      'HERDR_BRIDGE_CONFIG_INJECTED',
      'HERDR_PLUGIN_CONFIG_DIR', 'HERDR_MOBILE_BRIDGE_CONFIG_DIR', 'BRIDGE_CONFIG_DIR',
      'HERDR_PLUGIN_STATE_DIR', 'HERDR_MOBILE_BRIDGE_STATE_DIR', 'BRIDGE_STATE_DIR',
      'HERDR_BRIDGE_RUNTIME_PATH', 'HERDR_RUNTIME_PATH', 'BRIDGE_RUNTIME_PATH',
      'HERDR_BRIDGE_RUNTIME_LOCK_PATH', 'HERDR_RUNTIME_LOCK_PATH', 'BRIDGE_RUNTIME_LOCK_PATH',
      'HERDR_BRIDGE_SUBSCRIPTIONS_PATH', 'HERDR_SUBSCRIPTIONS_PATH', 'BRIDGE_SUBSCRIPTIONS_PATH',
      'HERDR_BRIDGE_DEDUP_PATH', 'HERDR_DEDUP_PATH', 'BRIDGE_DEDUP_PATH',
      'HERDR_BRIDGE_HOST', 'BRIDGE_HOST', 'HERDR_BRIDGE_PORT', 'BRIDGE_PORT',
      'HERDR_LAN_PROXY_HOST', 'HERDR_LAN_PROXY_PORT',
      'BRIDGE_LAN_PROXY_HOST', 'BRIDGE_LAN_PROXY_PORT',
      'HERDR_SOCKET_PATH', 'BRIDGE_SOCKET_PATH',
      'HERDR_BRIDGE_LAN_PROXY_TARGET_HOST', 'BRIDGE_LAN_PROXY_TARGET_HOST',
      'HERDR_LAN_PROXY_ALLOWED_CIDRS', 'BRIDGE_LAN_PROXY_ALLOWED_CIDRS',
      'HERDR_BRIDGE_RATE_LIMIT_PER_MINUTE', 'BRIDGE_RATE_LIMIT_PER_MINUTE',
      'HERDR_BRIDGE_RATE_LIMIT_BURST', 'BRIDGE_RATE_LIMIT_BURST',
      'HERDR_BRIDGE_RATE_LIMIT_MAX_ENTRIES', 'BRIDGE_RATE_LIMIT_MAX_ENTRIES',
      'HERDR_BRIDGE_REQUEST_BODY_TIMEOUT_MS', 'BRIDGE_REQUEST_BODY_TIMEOUT_MS',
      'HERDR_BRIDGE_SESSION_TTL_MS', 'BRIDGE_SESSION_TTL_MS',
      'HERDR_BRIDGE_REQUEST_TIMEOUT_MS', 'BRIDGE_REQUEST_TIMEOUT_MS',
      'HERDR_BRIDGE_MAX_BODY_BYTES', 'BRIDGE_MAX_BODY_BYTES',
      'HERDR_BRIDGE_ALLOWED_ORIGIN', 'BRIDGE_ALLOWED_ORIGIN',
      'HERDR_BRIDGE_COOKIE_SECURE', 'BRIDGE_COOKIE_SECURE',
      'HERDR_BRIDGE_HEALTH_DETAILS', 'BRIDGE_HEALTH_DETAILS',
      'HERDR_BRIDGE_ALLOW_SSE_QUERY_TOKEN', 'BRIDGE_ALLOW_SSE_QUERY_TOKEN',
      'HERDR_BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS', 'BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS',
      'HERDR_BRIDGE_ALLOW_PUSH_RELAY', 'BRIDGE_ALLOW_PUSH_RELAY',
      'HERDR_BRIDGE_PUSH_TIMEOUT_MS', 'BRIDGE_PUSH_TIMEOUT_MS',
      'HERDR_BRIDGE_PUSH_ENDPOINT_ALLOWLIST', 'BRIDGE_PUSH_ENDPOINT_ALLOWLIST', 'HERDR_PUSH_ENDPOINT_ALLOWLIST',
      ...(injectedConfig ? [
        'HERDR_BRIDGE_VAPID_PUBLIC_KEY', 'VAPID_PUBLIC_KEY',
        'HERDR_BRIDGE_VAPID_PRIVATE_KEY', 'VAPID_PRIVATE_KEY',
        'HERDR_BRIDGE_VAPID_SUBJECT', 'VAPID_SUBJECT',
      ] : []),
      ...(clearCredentialAliases ? [
        'HERDR_BRIDGE_TOKEN', 'BRIDGE_TOKEN',
        'HERDR_BRIDGE_SECRET', 'BRIDGE_SECRET',
      ] : []),
    ]) delete childEnv[key];
    for (const [key, value] of Object.entries(resolvedEnv)) {
      // Preserve an explicitly supplied empty value.  In particular, an
      // injected `lanProxyAllowedCidrs: []`/`''` must reach the child as an
      // empty environment value so its config parser can reject it; only an
      // absent (`undefined`/`null`) setting means that the optional ACL is
      // disabled.
      if (value !== undefined && value !== null) childEnv[key] = value;
    }
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined || value === null) delete childEnv[key];
      else if (typeof value !== 'string') childEnv[key] = String(value);
    }
    const child = spawn(options.execPath || process.execPath, [entryPath, ...(options.args || [])], {
      cwd: options.cwd || dirname(entryPath),
      env: childEnv,
      detached: true,
      stdio: 'ignore',
    });
    if (typeof child.unref === 'function') child.unref();
    const childPid = Number(child.pid);
    const marker = {
      pid: childPid,
      host: config.host,
      port: config.port,
      socket_path: config.socketPath,
      started_at: new Date().toISOString(),
      launcher_pid: process.pid,
      entry: entryPath,
      ...runtimeSecurityMetadata(config),
    };
    const identity = safeInspectProcess(childPid, options.processInspector);
    if (identity?.startTime) marker.process_start_time = String(identity.startTime);
    writeRuntime(runtimePath, marker);
    return { started: true, pid: childPid, runtime: marker, config };
  } finally {
    releaseLock(lockPath);
  }
}

export function stopBridge(options = {}) {
  const suppliedConfig = suppliedLauncherConfig(options);
  const config = suppliedConfig === undefined || suppliedConfig === null
    ? loadConfigSync(options)
    : normalizeInjectedConfig(suppliedConfig, options);
  const runtimePath = config.runtimePath || join(config.stateDir, 'runtime.json');
  const runtime = readJson(runtimePath);
  const pid = Number(runtime.pid);
  const processApi = options.processApi || process;
  if (!processMatchesRuntime(runtime, { ...options, processApi })) {
    const alive = processAlive(pid, processApi);
    return {
      stopped: false,
      running: false,
      pid: Number.isFinite(pid) ? pid : null,
      ...(alive ? { reason: 'pid_mismatch' } : {}),
      config,
    };
  }
  try { processApi.kill(pid, options.signal || 'SIGTERM'); } catch (error) {
    return { stopped: false, running: true, pid, error: error.message, config };
  }
  return { stopped: true, running: true, pid, config };
}

export function statusBridge(options = {}) {
  const suppliedConfig = suppliedLauncherConfig(options);
  const config = suppliedConfig === undefined || suppliedConfig === null
    ? loadConfigSync(options)
    : normalizeInjectedConfig(suppliedConfig, options);
  const runtimePath = config.runtimePath || join(config.stateDir, 'runtime.json');
  const runtime = readJson(runtimePath);
  const running = processMatchesRuntime(runtime, options);
  const runtimePid = Number(runtime?.pid);
  const runtimeStale = Boolean(runtime && !running && Number.isFinite(runtimePid) && runtimePid > 0);
  const restartRequired = Boolean(running && runtime.config_fingerprint !== resolvedFingerprint(config));
  return {
    ok: true,
    running,
    pid: running ? Number(runtime.pid) : null,
    runtime_stale: runtimeStale,
    stale_pid: runtimeStale ? runtimePid : null,
    host: config.host,
    port: runtime.port ?? config.port,
    url: httpUrl(config.host, runtime.port ?? config.port),
    socket_path: config.socketPath,
    socket_present: Boolean(config.socketPath && existsSync(config.socketPath)),
    lan_proxy_host: config.lanProxyHost || null,
    lan_proxy_port: config.lanProxyHost ? config.lanProxyPort : null,
    lan_proxy_running: Boolean(running && config.lanProxyHost && runtime.lan_proxy_running === true),
    acl_enabled: config.lanProxyAllowedCidrs !== undefined,
    lan_proxy_allowed_cidrs: Array.isArray(config.lanProxyAllowedCidrs)
      ? config.lanProxyAllowedCidrs
      : (config.lanProxyAllowedCidrs === undefined ? [] : [String(config.lanProxyAllowedCidrs)]),
    rate_limit_per_minute: config.rateLimitPerMinute,
    rate_limit_burst: config.rateLimitBurst,
    rate_limit_max_entries: config.rateLimitMaxEntries,
    request_body_timeout_ms: config.requestBodyTimeoutMs,
    restart_required: restartRequired,
    restart_reason: restartRequired ? 'config_mismatch' : null,
    config_dir: config.configDir,
    state_dir: config.stateDir,
    runtime,
  };
}

function parseArgs(argv) {
  const result = { command: 'ensure', options: {} };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const [flag, inline] = arg.split('=', 2);
    const next = inline ?? argv[index + 1];
    if (flag === '--json') result.options.json = true;
    else if (flag === '--host') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        result.options.host = parsed.value;
        if (parsed.consumed) index += 1;
      }
    }
    else if (flag === '--port') {
      const parsed = portOptionValue(argv, index, inline);
      if (parsed.explicit) {
        result.options.port = parsed.value;
        if (parsed.consumed) index += 1;
      }
    }
    else if (flag === '--socket' || flag === '--socket-path') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        result.options.socketPath = parsed.value;
        if (parsed.consumed) index += 1;
      }
    }
    else if (flag === '--config-dir') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        result.options.configDir = parsed.value;
        if (parsed.consumed) index += 1;
      }
    }
    else if (flag === '--state-dir') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        result.options.stateDir = parsed.value;
        if (parsed.consumed) index += 1;
      }
    }
    else if (flag === '--lan-host') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        result.options.lanProxyHost = parsed.value;
        if (parsed.consumed) index += 1;
      }
    }
    else if (flag === '--lan-port') {
      const parsed = portOptionValue(argv, index, inline);
      if (parsed.explicit) {
        result.options.lanProxyPort = parsed.value;
        if (parsed.consumed) index += 1;
      }
    }
    else if (flag === '--lan-allow-cidr') {
      // Do not silently drop an explicit empty/missing ACL value; preserving
      // it lets loadConfigSync report the same validation error as env/file
      // configuration. A following option is left for the next iteration.
      const value = inline !== undefined
        ? inline
        : (next !== undefined && !String(next).startsWith('-') ? next : '');
      if (inline === undefined && value !== '' && next !== undefined) index += 1;
      result.options.lanProxyAllowedCidrs = [
        ...(result.options.lanProxyAllowedCidrs || []),
        ...String(value).split(',').map((entry) => entry.trim()),
      ];
    }
    else if (flag === '--rate-limit-per-minute') {
      const parsed = numericOptionValue(argv, index, inline);
      result.options.rateLimitPerMinute = parsed.value;
      if (parsed.consumed) index += 1;
    }
    else if (flag === '--rate-limit-burst') {
      const parsed = numericOptionValue(argv, index, inline);
      result.options.rateLimitBurst = parsed.value;
      if (parsed.consumed) index += 1;
    }
    else if (flag === '--rate-limit-max-entries') {
      const parsed = numericOptionValue(argv, index, inline);
      result.options.rateLimitMaxEntries = parsed.value;
      if (parsed.consumed) index += 1;
    }
    else if (flag === '--request-body-timeout-ms') {
      const parsed = numericOptionValue(argv, index, inline);
      result.options.requestBodyTimeoutMs = parsed.value;
      if (parsed.consumed) index += 1;
    }
    else if (flag === '--help' || flag === '-h') result.options.help = true;
  }
  if (positional[0]) result.command = positional[0].replace(/^--/, '');
  return result;
}

export async function pairBridge(options = {}) {
  const suppliedConfig = suppliedLauncherConfig(options);
  const paths = resolvePaths(options.env || process.env, options);
  if (!suppliedConfig && !existsSync(paths.runtimePath)) throw new Error('Bridge 未运行，请先执行 node src/launcher.js ensure');
  const config = suppliedConfig ? normalizeInjectedConfig(suppliedConfig, options) : loadConfigSync({ ...options, persistGenerated: false });
  const status = statusBridge({ ...options, config });
  if (!status.running) throw new Error('Bridge 未运行，请先执行 node src/launcher.js ensure');
  if (status.restart_required) throw new Error('Bridge 配置不匹配，请先重启 Bridge');
  const response = await (options.fetch || globalThis.fetch)(`${status.url}/api/auth/pairing-code`, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`无法生成配对码 (HTTP ${response.status})`);
  const result = await response.json();
  if (!/^\d{8}$/.test(result.code) || !Number.isFinite(Date.parse(result.expires_at))) throw new Error('Bridge 返回无效配对响应');
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.options.help || !['ensure', 'setup', 'status', 'token', 'stop', 'pair'].includes(parsed.command)) {
    process.stdout.write('Usage: node src/launcher.js <ensure|setup|status|token|stop|pair> [--host HOST] [--port PORT] [--lan-host HOST --lan-port PORT] [--lan-allow-cidr CIDR] [--rate-limit-per-minute N] [--rate-limit-burst N] [--rate-limit-max-entries N] [--request-body-timeout-ms N] [--config-dir DIR] [--state-dir DIR] [--json]\n');
    return null;
  }
  const { command, options } = parsed;
  if (command === 'pair') return pairBridge(options).then((result) => {
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `一次性配对码：${result.code}\n5 分钟内有效，只能使用一次。配对后可控制当前 Herdr 会话。\n`);
    return result;
  });
  if (command === 'ensure') {
    const result = ensureBridge(options);
    process.stdout.write(`${JSON.stringify({ started: result.started, pending: Boolean(result.pending), running: Boolean(result.running), restartRequired: Boolean(result.restartRequired), reason: result.reason, pid: result.pid, host: result.config.host, port: result.config.port })}\n`);
    return result;
  }
  if (command === 'stop') {
    const result = stopBridge(options);
    process.stdout.write(`${JSON.stringify({ stopped: result.stopped, running: result.running, pid: result.pid })}\n`);
    return result;
  }
  const config = loadConfigSync(options);
  if (command === 'token') {
    process.stdout.write(`${config.token}\n`);
    return { config };
  }
  if (command === 'status') {
    const result = statusBridge({ ...options, config });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const result = {
    ok: true,
    config_dir: config.configDir,
    state_dir: config.stateDir,
    url: httpUrl(config.host, config.port),
    token: config.token,
    vapid_public_key: config.vapid.publicKey,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return { config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await main(); } catch (error) {
    process.stderr.write(`herdr-mobile-bridge launcher failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { acquireLock, releaseLock, lockIsStale, LOCK_MAX_AGE_MS, parseArgs, inspectProcess };
