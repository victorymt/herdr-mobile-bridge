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
import { loadConfigSync } from './config.js';

const LOCK_MAX_AGE_MS = 30_000;

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
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

/** Ensure one detached gateway process and refresh its session socket marker. */
export function ensureBridge(options = {}) {
  const config = options.config || loadConfigSync(options);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const runtimePath = config.runtimePath || join(config.stateDir, 'runtime.json');
  const lockPath = config.runtimeLockPath || join(config.stateDir, 'runtime.lock');
  const processApi = options.processApi || process;
  const runtime = readJson(runtimePath);
  if (processMatchesRuntime(runtime, { ...options, processApi })) {
    const refreshed = { ...runtime, host: config.host, port: config.port, socket_path: config.socketPath };
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
      const refreshed = { ...afterLock, host: config.host, port: config.port, socket_path: config.socketPath };
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
      HERDR_PLUGIN_CONFIG_DIR: config.configDir,
      HERDR_PLUGIN_STATE_DIR: config.stateDir,
      HERDR_BRIDGE_HOST: config.host,
      HERDR_BRIDGE_PORT: config.port === undefined || config.port === null ? undefined : String(config.port),
      HERDR_SOCKET_PATH: config.socketPath,
      HERDR_LAN_PROXY_HOST: config.lanProxyHost,
      HERDR_LAN_PROXY_PORT: config.lanProxyHost ? String(config.lanProxyPort) : undefined,
    };
    for (const [key, value] of Object.entries(resolvedEnv)) {
      if (typeof value === 'string' && value.trim()) childEnv[key] = value;
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
  const config = options.config || loadConfigSync(options);
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
  const config = options.config || loadConfigSync(options);
  const runtime = readJson(config.runtimePath);
  const running = processMatchesRuntime(runtime, options);
  return {
    ok: true,
    running,
    pid: running ? Number(runtime.pid) : null,
    host: config.host,
    port: runtime.port ?? config.port,
    url: `http://${config.host}:${runtime.port ?? config.port}`,
    socket_path: config.socketPath,
    socket_present: Boolean(config.socketPath && existsSync(config.socketPath)),
    lan_proxy_host: config.lanProxyHost || null,
    lan_proxy_port: config.lanProxyHost ? config.lanProxyPort : null,
    lan_proxy_running: Boolean(running && config.lanProxyHost && runtime.lan_proxy_running === true),
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
    else if (flag === '--host' && next) { result.options.host = next; if (inline === undefined) index += 1; }
    else if (flag === '--port' && next) { result.options.port = Number(next); if (inline === undefined) index += 1; }
    else if ((flag === '--socket' || flag === '--socket-path') && next) { result.options.socketPath = next; if (inline === undefined) index += 1; }
    else if (flag === '--config-dir' && next) { result.options.configDir = next; if (inline === undefined) index += 1; }
    else if (flag === '--state-dir' && next) { result.options.stateDir = next; if (inline === undefined) index += 1; }
    else if (flag === '--lan-host' && next) { result.options.lanProxyHost = next; if (inline === undefined) index += 1; }
    else if (flag === '--lan-port' && next) { result.options.lanProxyPort = Number(next); if (inline === undefined) index += 1; }
    else if (flag === '--help' || flag === '-h') result.options.help = true;
  }
  if (positional[0]) result.command = positional[0].replace(/^--/, '');
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.options.help || !['ensure', 'setup', 'status', 'token', 'stop'].includes(parsed.command)) {
    process.stdout.write('Usage: node src/launcher.js <ensure|setup|status|token|stop> [--json]\n');
    return null;
  }
  const { command, options } = parsed;
  if (command === 'ensure') {
    const result = ensureBridge(options);
    process.stdout.write(`${JSON.stringify({ started: result.started, pending: Boolean(result.pending), pid: result.pid, host: result.config.host, port: result.config.port })}\n`);
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
    url: `http://${config.host}:${config.port}`,
    token: config.token,
    vapid_public_key: config.vapid.publicKey,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return { config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) {
    process.stderr.write(`herdr-mobile-bridge launcher failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { acquireLock, releaseLock, lockIsStale, LOCK_MAX_AGE_MS, parseArgs, inspectProcess };
