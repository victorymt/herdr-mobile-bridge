import { fileURLToPath } from 'node:url';
import { basename, dirname } from 'node:path';

import { loadConfig } from './config.js';
import { HerdrSocketClient } from './herdr-client.js';
import { BridgeServer } from './server.js';

export { BridgeServer } from './server.js';
export { HerdrSocketClient, HerdrApiError, HerdrSocketError, ALLOWED_METHODS } from './herdr-client.js';
export { AuthManager } from './auth.js';
export { EventBus, EventInputError, normalizeEventName, normalizeStatus } from './event-bus.js';
export { PushManager, makePushPayload } from './push.js';
export { StateStore } from './state-store.js';
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
  const server = await createBridgeServer(options);
  await server.start();
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
    process.stdout.write('Usage: node src/index.js [--host HOST] [--port PORT] [--socket PATH] [--config-dir DIR] [--state-dir DIR]\n');
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

