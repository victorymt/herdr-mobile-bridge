import { chmod, mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, chmodSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { randomBytes, createECDH } from 'node:crypto';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_LAN_PROXY_PORT = 18787;
export const DEFAULT_CONFIG_NAME = 'herdr-mobile-bridge';
export const DEFAULT_HERDR_SOCKET = '/tmp/herdr.sock';

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
  if (family === 6 && (value === '::1' || value.toLowerCase() === '::ffff:127.0.0.1')) return value;
  throw new TypeError('bridge host must be a loopback address');
}

/** LAN proxy listeners must bind one explicit IP, never a wildcard. */
export function assertLanProxyHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value === '0.0.0.0' || value === '::' || value === '*') {
    throw new TypeError('LAN proxy host must be an explicit interface address');
  }
  if (!isIP(value)) throw new TypeError('LAN proxy host must be an IP address');
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
  let socketPath = firstEnv(env, ['HERDR_SOCKET_PATH', 'BRIDGE_SOCKET_PATH']);
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
  const runtimePath = join(stateRoot, 'runtime.json');
  const runtimeLockPath = join(stateRoot, 'runtime.lock');
  const subscriptionsPath = join(stateRoot, 'subscriptions.json');
  const dedupPath = join(stateRoot, 'dedup.json');
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
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
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
  const fileConfig = objectValue(await readJson(paths.bridgeConfigPath));

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

  const host = assertBridgeHost(options.host || firstEnv(env, ['HERDR_BRIDGE_HOST', 'BRIDGE_HOST']) || fileConfig.host || DEFAULT_HOST);
  const port = parsePort(options.port ?? firstEnv(env, ['HERDR_BRIDGE_PORT', 'BRIDGE_PORT']) ?? fileConfig.port, DEFAULT_PORT);
  const lanProxyPort = parsePort(options.lanProxyPort ?? firstEnv(env, ['HERDR_LAN_PROXY_PORT', 'BRIDGE_LAN_PROXY_PORT']) ?? fileConfig.lanProxyPort, DEFAULT_LAN_PROXY_PORT);
  const configuredLanProxyHost = options.lanProxyHost || firstEnv(env, ['HERDR_LAN_PROXY_HOST', 'BRIDGE_LAN_PROXY_HOST']) || fileConfig.lanProxyHost;
  const lanProxyHost = configuredLanProxyHost ? assertLanProxyHost(configuredLanProxyHost) : undefined;
  if (lanProxyHost && (lanProxyPort < 1 || lanProxyPort === port)) {
    throw new Error('LAN proxy port must be between 1 and 65535 and differ from bridge port');
  }
  const socketPath = resolve(homePath(options.socketPath || firstEnv(env, ['HERDR_SOCKET_PATH', 'BRIDGE_SOCKET_PATH']) || fileConfig.socketPath || paths.socketPath, firstEnv(env, ['HOME', 'USERPROFILE']) || homedir()));
  const allowedOrigin = options.allowedOrigin || firstEnv(env, ['HERDR_BRIDGE_ALLOWED_ORIGIN', 'BRIDGE_ALLOWED_ORIGIN']) || fileConfig.allowedOrigin || '';
  const sessionTtlMs = Number(options.sessionTtlMs ?? fileConfig.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000);
  const requestTimeoutMs = Number(options.requestTimeoutMs ?? fileConfig.requestTimeoutMs ?? 5000);
  const maxBodyBytes = Number(options.maxBodyBytes ?? fileConfig.maxBodyBytes ?? 1024 * 1024);
  const vapidSubject = vapidSubjectValue(options, env, fileConfig, vapid);
  const finalVapid = { ...vapid, subject: vapidSubject };
  return {
    ...paths,
    host,
    port,
    lanProxyHost,
    lanProxyPort,
    socketPath,
    token,
    secret,
    vapid: finalVapid,
    allowedOrigin,
    sessionTtlMs: Number.isFinite(sessionTtlMs) && sessionTtlMs > 0 ? sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 5000,
    maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 1024 * 1024,
    cookieSecure: parseBoolean(options.cookieSecure ?? firstEnv(env, ['HERDR_BRIDGE_COOKIE_SECURE', 'BRIDGE_COOKIE_SECURE']) ?? fileConfig.cookieSecure, false),
    healthDetails: parseBoolean(options.healthDetails ?? firstEnv(env, ['HERDR_BRIDGE_HEALTH_DETAILS', 'BRIDGE_HEALTH_DETAILS']) ?? fileConfig.healthDetails, false),
    allowSseQueryToken: parseBoolean(options.allowSseQueryToken ?? firstEnv(env, ['HERDR_BRIDGE_ALLOW_SSE_QUERY_TOKEN', 'BRIDGE_ALLOW_SSE_QUERY_TOKEN']) ?? fileConfig.allowSseQueryToken, false),
    version: options.version || fileConfig.version || '0.1.0',
    vapidSubject,
  };
}

/** Synchronous counterpart used by launcher startup checks. */
export function loadConfigSync(options = {}) {
  const env = options.env || process.env;
  const paths = resolvePaths(env, options);
  ensurePrivateDirSync(paths.configDir);
  ensurePrivateDirSync(paths.stateDir);
  let fileConfig = {};
  if (existsSync(paths.bridgeConfigPath)) {
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
  const host = assertBridgeHost(options.host || firstEnv(env, ['HERDR_BRIDGE_HOST', 'BRIDGE_HOST']) || fileConfig.host || DEFAULT_HOST);
  const port = parsePort(options.port ?? firstEnv(env, ['HERDR_BRIDGE_PORT', 'BRIDGE_PORT']) ?? fileConfig.port, DEFAULT_PORT);
  const lanProxyPort = parsePort(options.lanProxyPort ?? firstEnv(env, ['HERDR_LAN_PROXY_PORT', 'BRIDGE_LAN_PROXY_PORT']) ?? fileConfig.lanProxyPort, DEFAULT_LAN_PROXY_PORT);
  const configuredLanProxyHost = options.lanProxyHost || firstEnv(env, ['HERDR_LAN_PROXY_HOST', 'BRIDGE_LAN_PROXY_HOST']) || fileConfig.lanProxyHost;
  const lanProxyHost = configuredLanProxyHost ? assertLanProxyHost(configuredLanProxyHost) : undefined;
  if (lanProxyHost && (lanProxyPort < 1 || lanProxyPort === port)) {
    throw new Error('LAN proxy port must be between 1 and 65535 and differ from bridge port');
  }
  const home = firstEnv(env, ['HOME', 'USERPROFILE']) || homedir();
  const socketPath = resolve(homePath(options.socketPath || firstEnv(env, ['HERDR_SOCKET_PATH', 'BRIDGE_SOCKET_PATH']) || fileConfig.socketPath || paths.socketPath, home));
  const sessionTtlMs = Number(options.sessionTtlMs ?? fileConfig.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000);
  const requestTimeoutMs = Number(options.requestTimeoutMs ?? fileConfig.requestTimeoutMs ?? 5000);
  const maxBodyBytes = Number(options.maxBodyBytes ?? fileConfig.maxBodyBytes ?? 1024 * 1024);
  const vapidSubject = vapidSubjectValue(options, env, fileConfig, vapid);
  const finalVapid = { ...vapid, subject: vapidSubject };
  return {
    ...paths,
    host,
    port,
    lanProxyHost,
    lanProxyPort,
    socketPath,
    token,
    secret,
    vapid: finalVapid,
    allowedOrigin: options.allowedOrigin || firstEnv(env, ['HERDR_BRIDGE_ALLOWED_ORIGIN', 'BRIDGE_ALLOWED_ORIGIN']) || fileConfig.allowedOrigin || '',
    sessionTtlMs: Number.isFinite(sessionTtlMs) && sessionTtlMs > 0 ? sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 5000,
    maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 1024 * 1024,
    cookieSecure: parseBoolean(options.cookieSecure ?? firstEnv(env, ['HERDR_BRIDGE_COOKIE_SECURE', 'BRIDGE_COOKIE_SECURE']) ?? fileConfig.cookieSecure, false),
    healthDetails: parseBoolean(options.healthDetails ?? firstEnv(env, ['HERDR_BRIDGE_HEALTH_DETAILS', 'BRIDGE_HEALTH_DETAILS']) ?? fileConfig.healthDetails, false),
    allowSseQueryToken: parseBoolean(options.allowSseQueryToken ?? firstEnv(env, ['HERDR_BRIDGE_ALLOW_SSE_QUERY_TOKEN', 'BRIDGE_ALLOW_SSE_QUERY_TOKEN']) ?? fileConfig.allowSseQueryToken, false),
    version: options.version || fileConfig.version || '0.1.0',
    vapidSubject,
  };
}

export { ensurePrivateDir, writePrivate, hardenPrivateFile, hardenPrivateFileSync };
