import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { loadConfig, resolvePaths } from './config.js';
import { HerdrSocketClient } from './herdr-client.js';
import { BridgeServer } from './server.js';
import { LanProxy } from './lan-proxy.js';
import { TokenBucketLimiter } from './rate-limit.js';

function authorityHost(host) {
  const value = String(host ?? '').trim();
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function startupErrorPath(options = {}) {
  try {
    return join(resolvePaths(process.env, options).stateDir, 'startup-error.log');
  } catch {
    return undefined;
  }
}

function recordStartupError(error, options = {}) {
  const path = startupErrorPath(options);
  if (!path) return;
  const detail = String(error?.message || error || 'unknown startup error')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 1_000);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${new Date().toISOString()} ${detail}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  } catch {
    // Startup diagnostics must never mask the original error.
  }
}

function clearStartupError(options = {}) {
  const path = startupErrorPath(options);
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* best effort */ }
}

export { BridgeServer } from './server.js';
export {
  HerdrSocketClient,
  HerdrApiError,
  HerdrSocketError,
  ALLOWED_METHODS,
  READ_FORMATS,
  READ_SOURCES,
} from './herdr-client.js';
export { AuthManager } from './auth.js';
export { EventBus, EventInputError, normalizeEventName, normalizeStatus } from './event-bus.js';
export { PushManager, makePushPayload } from './push.js';
export { PushWorker, deliveryFailure } from './push-worker.js';
export { StateStore } from './state-store.js';
export { LanProxy } from './lan-proxy.js';
export {
  TokenBucketLimiter,
  RateLimiter,
  createRateLimiter,
  hashCredential,
  hashToken,
  canonicalizeAddress,
  canonicaliseAddress,
  DEFAULT_RATE_PER_MINUTE,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  MAX_RATE_LIMIT_ENTRIES,
  MIN_RATE_LIMIT_MAX_ENTRIES,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_LOGIN_RATE_PROFILE,
  DEFAULT_API_RATE_PROFILE,
  RATE_LIMIT_PROFILES,
} from './rate-limit.js';
export {
  parseAllowedCidrs,
  compileAllowedCidrs,
  parseLanProxyAllowedCidrs,
  compileLanProxyAcl,
  isAddressAllowed,
  isLocalAddress,
} from './network-acl.js';
export {
  loadConfig,
  loadConfigSync,
  resolvePaths,
  configFingerprint,
  DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  MAX_REQUEST_BODY_TIMEOUT_MS,
  MAX_ALLOWED_CIDRS,
} from './config.js';

export async function createBridgeServer(options = {}) {
  const injectedConfig = options.config;
  if (injectedConfig !== undefined && injectedConfig !== null
    && (typeof injectedConfig !== 'object' || Array.isArray(injectedConfig))) {
    throw new TypeError('options.config must be an object or null');
  }
  // Keep null/undefined equivalent to an omitted config, matching the
  // detached launcher.  Truthiness checks would silently accept false or a
  // string in one entry point and load a different configuration in another.
  const config = injectedConfig === undefined || injectedConfig === null
    ? await loadConfig(options)
    : injectedConfig;
  const herdrClient = options.herdrClient || new HerdrSocketClient({
    socketPath: config.socketPath,
    timeoutMs: config.requestTimeoutMs,
  });
  return new BridgeServer({ ...options, config, herdrClient });
}

export async function startBridge(options = {}) {
  let server;
  try {
    server = await createBridgeServer(options);
    await server.start();
  } catch (error) {
    // `BridgeServer.start()` can fail after creating its listener (for
    // example, an address/port race). Do not leave that listener or its
    // runtime marker behind when the optional LAN transport never starts.
    if (server) {
      try { await server.close(); } catch { /* preserve the original error */ }
    }
    throw error;
  }
  if (server.config.lanProxyHost) {
    let proxy;
    let proxyStarted = false;
    let lifecycleClosed = false;
    let proxyFailureReported = false;
    let proxyFailure;
    let closePromise;
    let runtimeUpdate = Promise.resolve();
    const persistProxyRuntime = (running, error) => {
      runtimeUpdate = runtimeUpdate.then(async () => {
        if (!server.store?.initialized) return;
        try {
          const runtime = await server.store.getRuntime();
          await server.store.setRuntime({
            ...runtime,
            lan_proxy_running: Boolean(running),
            lan_proxy_host: proxy?.host || server.config.lanProxyHost,
            lan_proxy_port: proxy?.port || server.config.lanProxyPort,
            lan_proxy_error: error ? String(error.message || error).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) : null,
          });
        } catch {
          // Runtime metadata is diagnostic; a persistence failure must not
          // turn a functioning LAN proxy into a failed startup.
        }
      }).catch(() => {});
      return runtimeUpdate;
    };
    const onProxyFailure = (error) => {
      proxyFailure = error instanceof Error ? error : new Error(String(error || 'LAN proxy failed'));
      proxyFailureReported = true;
      // Startup failures are reported through the rejected startBridge()
      // promise. Persist only failures observed after a healthy listener has
      // been published, otherwise a late diagnostic could recreate a runtime
      // marker after the failed server has already been closed.
      if (!proxyStarted || lifecycleClosed) return;
      void persistProxyRuntime(false, error);
    };
    try {
      proxy = new LanProxy({
        host: server.config.lanProxyHost,
        port: server.config.lanProxyPort,
        targetPort: server.address().port,
        // Follow the actual loopback listener when an embedder chooses a
        // non-default 127/8 address (or `localhost` resolves to IPv6).  A
        // hard-coded 127.0.0.1 here would make the otherwise valid proxy
        // configuration fail its health probe.
        targetHost: options.lanProxyTargetHost || server.config.lanProxyTargetHost || server.address().host || '127.0.0.1',
        net: options.net,
        allowLocalSource: options.allowLocalSource,
        connectionRateLimiter: options.connectionRateLimiter === false
          ? false
          : (options.connectionRateLimiter || new TokenBucketLimiter({
            ratePerMinute: server.config.rateLimitPerMinute,
            burst: server.config.rateLimitBurst,
            maxEntries: server.config.rateLimitMaxEntries,
            now: options.now,
          })),
        rateLimitPerMinute: server.config.rateLimitPerMinute,
        rateLimitBurst: server.config.rateLimitBurst,
        rateLimitMaxEntries: server.config.rateLimitMaxEntries,
        now: options.now,
        closeTimeoutMs: options.proxyCloseTimeoutMs,
        allowedCidrs: server.config.lanProxyAllowedCidrs,
        onError: onProxyFailure,
        onClose: () => {
          // A listener error invokes onError before the asynchronous close
          // callback. Preserve that more useful diagnostic instead of
          // replacing it with the generic "stopped" message.
          if (!proxyFailureReported) onProxyFailure(new Error('LAN proxy stopped'));
        },
      });
      // Publish the proxy reference before probing so an asynchronous listener
      // failure cannot be mistaken for a healthy Bridge by discovery callers.
      server.lanProxy = proxy;
      await proxy.start();
      if (proxyFailure || !proxy.server || proxy.healthy !== true) {
        throw proxyFailure || new Error('LAN proxy became unhealthy during startup');
      }
      proxyStarted = true;
      await persistProxyRuntime(true);
    } catch (error) {
      lifecycleClosed = true;
      if (proxy) {
        try { await proxy.close(); } catch { /* preserve the original error */ }
      }
      await server.close();
      const detail = proxyFailure?.message || error?.message || 'unknown error';
      throw new Error(`LAN proxy health check failed: ${detail}`, { cause: error });
    }
    // Consumers commonly call `server.close()` directly (including tests and
    // embedders), so make proxy shutdown part of the Bridge lifecycle rather
    // than requiring them to know about the optional LAN transport.
    const closeBridge = server.close.bind(server);
    server.close = async () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        lifecycleClosed = true;
        try { await proxy.close(); } finally {
          await persistProxyRuntime(false);
          server.lanProxy = null;
          await closeBridge();
        }
      })();
      return closePromise;
    };
  }
  return server;
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

/**
 * Read a textual CLI option while distinguishing an explicit `--flag=` from
 * an omitted value.  A following option token is left for the main loop so
 * `--host --help` still shows help and falls back to the configured host.
 */
function textOptionValue(argv, index, inline) {
  if (inline !== undefined) return { value: inline, consumed: false, explicit: true };
  const candidate = argv[index + 1];
  if (candidate === undefined || String(candidate).startsWith('-')) {
    return { value: undefined, consumed: false, explicit: false };
  }
  return { value: String(candidate), consumed: true, explicit: true };
}

/** Read a numeric CLI option with the same missing/inline distinction. */
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

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.split('=', 2);
    const next = inline ?? argv[index + 1];
    if (flag === '--host') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        options.host = parsed.value;
        if (parsed.consumed) index += 1;
      }
    } else if (flag === '--port') {
      const parsed = portOptionValue(argv, index, inline);
      if (parsed.explicit) {
        options.port = parsed.value;
        if (parsed.consumed) index += 1;
      }
    } else if (flag === '--socket' || flag === '--socket-path') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        options.socketPath = parsed.value;
        if (parsed.consumed) index += 1;
      }
    } else if (flag === '--config-dir') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        options.configDir = parsed.value;
        if (parsed.consumed) index += 1;
      }
    } else if (flag === '--state-dir') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        options.stateDir = parsed.value;
        if (parsed.consumed) index += 1;
      }
    } else if (flag === '--lan-host') {
      const parsed = textOptionValue(argv, index, inline);
      if (parsed.explicit) {
        options.lanProxyHost = parsed.value;
        if (parsed.consumed) index += 1;
      }
    } else if (flag === '--lan-port') {
      const parsed = portOptionValue(argv, index, inline);
      if (parsed.explicit) {
        options.lanProxyPort = parsed.value;
        if (parsed.consumed) index += 1;
      }
    } else if (flag === '--lan-allow-cidr') {
      // Preserve an explicit missing/empty value as an empty ACL entry. The
      // config loader then raises a clear validation error instead of silently
      // running with the ACL disabled.
      const value = inline !== undefined
        ? inline
        : (next !== undefined && !String(next).startsWith('-') ? next : '');
      if (inline === undefined && value !== '' && next !== undefined) index += 1;
      options.lanProxyAllowedCidrs = [
        ...(options.lanProxyAllowedCidrs || []),
        ...String(value).split(',').map((entry) => entry.trim()),
      ];
    } else if (flag === '--rate-limit-per-minute') {
      const parsed = numericOptionValue(argv, index, inline);
      options.rateLimitPerMinute = parsed.value;
      if (parsed.consumed) index += 1;
    } else if (flag === '--rate-limit-burst') {
      const parsed = numericOptionValue(argv, index, inline);
      options.rateLimitBurst = parsed.value;
      if (parsed.consumed) index += 1;
    } else if (flag === '--rate-limit-max-entries') {
      const parsed = numericOptionValue(argv, index, inline);
      options.rateLimitMaxEntries = parsed.value;
      if (parsed.consumed) index += 1;
    } else if (flag === '--request-body-timeout-ms') {
      const parsed = numericOptionValue(argv, index, inline);
      options.requestBodyTimeoutMs = parsed.value;
      if (parsed.consumed) index += 1;
    } else if (flag === '--print-token') {
      options.printToken = true;
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  if (cli.help) {
    process.stdout.write('Usage: node src/index.js [--host HOST] [--port PORT] [--lan-host HOST] [--lan-port PORT] [--lan-allow-cidr CIDR] [--rate-limit-per-minute N] [--rate-limit-burst N] [--rate-limit-max-entries N] [--request-body-timeout-ms N] [--socket PATH] [--config-dir DIR] [--state-dir DIR]\n');
    return null;
  }
  try {
    const server = await startBridge(cli);
    clearStartupError(cli);
    const address = server.address();
    process.stdout.write(`herdr-mobile-bridge listening on http://${authorityHost(address.host)}:${address.port}\n`);
    if (cli.printToken) process.stdout.write(`bridge token: ${server.config.token}\n`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await server.close();
    };
    process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
    return server;
  } catch (error) {
    recordStartupError(error, cli);
    throw error;
  }
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`herdr-mobile-bridge failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
