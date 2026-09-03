import { fileURLToPath } from 'node:url';
import { basename, dirname } from 'node:path';

import { loadConfig } from './config.js';
import { HerdrSocketClient } from './herdr-client.js';
import { BridgeServer } from './server.js';
import { LanProxy } from './lan-proxy.js';

export { BridgeServer } from './server.js';
export { HerdrSocketClient, HerdrApiError, HerdrSocketError, ALLOWED_METHODS } from './herdr-client.js';
export { AuthManager } from './auth.js';
export { EventBus, EventInputError, normalizeEventName, normalizeStatus } from './event-bus.js';
export { PushManager, makePushPayload } from './push.js';
export { StateStore } from './state-store.js';
export { LanProxy } from './lan-proxy.js';
export { loadConfig, loadConfigSync, resolvePaths } from './config.js';

export async function createBridgeServer(options = {}) {
  const config = options.config || await loadConfig(options);
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
    try { await server?.close(); } catch { /* preserve the original error */ }
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
      await proxy?.close().catch(() => {});
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

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.split('=', 2);
    const next = inline ?? argv[index + 1];
    if (flag === '--host' && next) {
      options.host = next;
      if (inline === undefined) index += 1;
    } else if (flag === '--port' && next) {
      options.port = Number(next);
      if (inline === undefined) index += 1;
    } else if ((flag === '--socket' || flag === '--socket-path') && next) {
      options.socketPath = next;
      if (inline === undefined) index += 1;
    } else if (flag === '--config-dir' && next) {
      options.configDir = next;
      if (inline === undefined) index += 1;
    } else if (flag === '--state-dir' && next) {
      options.stateDir = next;
      if (inline === undefined) index += 1;
    } else if (flag === '--lan-host' && next) {
      options.lanProxyHost = next;
      if (inline === undefined) index += 1;
    } else if (flag === '--lan-port' && next) {
      options.lanProxyPort = Number(next);
      if (inline === undefined) index += 1;
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
    process.stdout.write('Usage: node src/index.js [--host HOST] [--port PORT] [--lan-host HOST] [--lan-port PORT] [--socket PATH] [--config-dir DIR] [--state-dir DIR]\n');
    return null;
  }
  const server = await startBridge(cli);
  const address = server.address();
  process.stdout.write(`herdr-mobile-bridge listening on http://${address.host}:${address.port}\n`);
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
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`herdr-mobile-bridge failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
