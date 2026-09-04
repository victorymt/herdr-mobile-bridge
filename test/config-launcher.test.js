import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertBridgeHost, assertLanProxyHost, configFingerprint, loadConfig, loadConfigSync, parsePort, resolvePaths } from '../src/config.js';
import { createBridgeServer, parseArgs as parseBridgeArgs } from '../src/index.js';
import {
  ensureBridge,
  parseArgs as parseLauncherArgs,
  processAlive,
  statusBridge,
  stopBridge,
} from '../src/launcher.js';
import { StateStore } from '../src/state-store.js';

test('config generates stable owner/secret/VAPID files in private dirs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-config-test-'));
  const options = { configDir: join(root, 'config'), stateDir: join(root, 'state'), port: 8787 };
  const first = await loadConfig(options);
  const second = await loadConfig(options);
  assert.equal(first.token, second.token);
  assert.equal(first.secret, second.secret);
  assert.equal(first.vapid.publicKey, second.vapid.publicKey);
  assert.equal((await stat(first.configDir)).mode & 0o777, 0o700);
  assert.match(await readFile(first.tokenPath, 'utf8'), new RegExp(first.token));
  await rm(root, { recursive: true, force: true });
});

test('launcher does not spawn when runtime PID is alive and acquires a lock for stale state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-test-'));
  const config = loadConfigSync({
    configDir: join(root, 'config'), stateDir: join(root, 'state'), token: 't', secret: 's', persistGenerated: false,
  });
  let spawned = 0;
  const processApi = { kill(pid, signal) { if (pid === 1234 && signal === 0) return true; const error = new Error('dead'); error.code = 'ESRCH'; throw error; } };
  // The fake process API deliberately reports the PID as alive. Disable the
  // optional /proc identity probe so this test remains deterministic when the
  // host happens to have a real process with PID 1234.
  const processInspector = () => undefined;
  const alive = ensureBridge({ config, processApi, processInspector, spawn() { spawned += 1; return { pid: 1234, unref() {} }; } });
  assert.equal(alive.started, true);
  assert.equal(spawned, 1);
  const second = ensureBridge({ config, processApi, processInspector, spawn() { spawned += 1; return { pid: 1234, unref() {} }; } });
  assert.equal(second.started, false);
  assert.equal(spawned, 1);
  assert.equal(processAlive(0, processApi), false);
  await rm(root, { recursive: true, force: true });
});

test('launcher propagates resolved settings to the detached gateway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-env-test-'));
  const config = loadConfigSync({
    configDir: join(root, 'config'), stateDir: join(root, 'state'),
    host: '127.0.0.1', port: 49123, socketPath: join(root, 'herdr.sock'),
    token: 't', secret: 's', persistGenerated: false,
  });
  let spawnedOptions;
  const result = ensureBridge({
    config,
    processApi: { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } },
    spawn(_exec, _args, options) {
      spawnedOptions = options;
      return { pid: 4321, unref() {} };
    },
  });
  assert.equal(result.started, true);
  assert.equal(spawnedOptions.env.HERDR_PLUGIN_CONFIG_DIR, config.configDir);
  assert.equal(spawnedOptions.env.HERDR_PLUGIN_STATE_DIR, config.stateDir);
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_HOST, config.host);
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_PORT, String(config.port));
  assert.equal(spawnedOptions.env.HERDR_SOCKET_PATH, config.socketPath);
  await rm(root, { recursive: true, force: true });
});

test('launcher leaves file-backed credentials out of the detached environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-file-credentials-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  // Seed owner-only credential files through the normal loader. The launcher
  // should let the detached child read these files instead of copying the
  // values into its /proc-visible environment.
  const loaded = loadConfigSync({ configDir, stateDir, env: { HOME: root } });
  let spawnedOptions;
  const deadProcess = { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } };
  const result = ensureBridge({
    configDir,
    stateDir,
    env: { HOME: root },
    processApi: deadProcess,
    processInspector: () => undefined,
    spawn(_exec, _args, options) {
      spawnedOptions = options;
      return { pid: 4328, unref() {} };
    },
  });
  assert.equal(result.config.token, loaded.token);
  assert.equal(result.config.secret, loaded.secret);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'HERDR_BRIDGE_TOKEN'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'BRIDGE_TOKEN'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'HERDR_BRIDGE_SECRET'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'BRIDGE_SECRET'), false);
  const child = loadConfigSync({ env: spawnedOptions.env, persistGenerated: false });
  assert.equal(child.token, result.config.token);
  assert.equal(child.secret, result.config.secret);
  await rm(root, { recursive: true, force: true });
});

test('injected config uses explicit environment credentials when fields are omitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-injected-credentials-'));
  let spawnedOptions;
  const deadProcess = { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } };
  const result = ensureBridge({
    config: {
      configDir: join(root, 'config'),
      stateDir: join(root, 'state'),
      socketPath: join(root, 'herdr.sock'),
      host: '127.0.0.1',
      port: 49_126,
    },
    env: {
      HOME: root,
      HERDR_BRIDGE_TOKEN: 'env-token',
      BRIDGE_SECRET: 'env-secret',
    },
    cwd: root,
    processApi: deadProcess,
    processInspector: () => undefined,
    spawn(_exec, _args, options) {
      spawnedOptions = options;
      return { pid: 4329, unref() {} };
    },
  });
  assert.equal(result.config.token, 'env-token');
  assert.equal(result.config.secret, 'env-secret');
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_TOKEN, 'env-token');
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_SECRET, 'env-secret');
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'BRIDGE_TOKEN'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'BRIDGE_SECRET'), false);
  const child = loadConfigSync({ env: spawnedOptions.env, persistGenerated: false });
  assert.equal(child.token, result.config.token);
  assert.equal(child.secret, result.config.secret);
  await rm(root, { recursive: true, force: true });
});

test('launcher treats a null config as omitted instead of an injected config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-null-config-'));
  let spawnedOptions;
  const result = ensureBridge({
    config: null,
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
    processApi: { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } },
    processInspector: () => undefined,
    spawn(_exec, _args, options) {
      spawnedOptions = options;
      return { pid: 4323, unref() {} };
    },
  });
  assert.equal(result.started, true);
  assert.equal(result.config.host, '127.0.0.1');
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'HERDR_BRIDGE_CONFIG_INJECTED'), false);
  await rm(root, { recursive: true, force: true });
});

test('launcher propagates file-isolation semantics to detached children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-file-isolation-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  await mkdir(configDir, { recursive: true });
  // This listener must remain disabled whenever the parent intentionally
  // ignores bridge.json; if the child re-reads the file it would diverge.
  await writeFile(join(configDir, 'bridge.json'), JSON.stringify({
    lanProxyHost: '192.168.1.20',
    lanProxyPort: 18_787,
  }));
  const cases = [
    { env: { HERDR_BRIDGE_CONFIG_INJECTED: '1' }, ignoreFileConfig: false },
    { env: {}, ignoreFileConfig: true },
  ];
  let pid = 4324;
  for (const current of cases) {
    let spawnedOptions;
    const result = ensureBridge({
      config: null,
      configDir,
      stateDir: join(stateDir, String(pid)),
      token: 't',
      secret: 's',
      persistGenerated: false,
      env: { HOME: root, ...current.env },
      ignoreFileConfig: current.ignoreFileConfig,
      processApi: { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } },
      processInspector: () => undefined,
      spawn(_exec, _args, options) {
        spawnedOptions = options;
        return { pid: pid++, unref() {} };
      },
    });
    assert.equal(result.config.lanProxyHost, undefined);
    assert.equal(spawnedOptions.env.HERDR_BRIDGE_CONFIG_INJECTED, '1');
    const child = loadConfigSync({ env: spawnedOptions.env, persistGenerated: false });
    assert.equal(child.lanProxyHost, undefined);
  }
  await rm(root, { recursive: true, force: true });
});

test('createBridgeServer matches launcher config injection validation', async () => {
  await assert.rejects(() => createBridgeServer({ config: false }), /options\.config must be an object or null/);
  await assert.rejects(() => createBridgeServer({ config: 'invalid' }), /options\.config must be an object or null/);
  const root = await mkdtemp(join(tmpdir(), 'herdr-create-server-null-config-'));
  const server = await createBridgeServer({
    config: null,
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
    herdrClient: { snapshot: async () => ({}) },
  });
  assert.equal(server.config.host, '127.0.0.1');
  await server.close();
  await rm(root, { recursive: true, force: true });
});

test('stop/status share launcher config injection validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-stop-status-config-'));
  const base = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
  };
  const deadProcess = {
    kill() {
      const error = new Error('dead');
      error.code = 'ESRCH';
      throw error;
    },
  };

  for (const lifecycle of [stopBridge, statusBridge]) {
    assert.throws(() => lifecycle({ ...base, config: false, processApi: deadProcess }), /options\.config must be an object or null/);
    assert.throws(() => lifecycle({ ...base, config: 'invalid', processApi: deadProcess }), /options\.config must be an object or null/);
    assert.throws(() => lifecycle({ ...base, config: [], processApi: deadProcess }), /options\.config must be an object or null/);
  }

  // Null is an omitted value and therefore loads bridge.json/defaults. A
  // directly supplied object is used as-is by both lifecycle operations.
  const fromNull = statusBridge({ ...base, config: null, processApi: deadProcess });
  assert.equal(fromNull.host, '127.0.0.1');
  const direct = loadConfigSync(base);
  const directStatus = statusBridge({ config: direct, processApi: deadProcess });
  assert.equal(directStatus.host, direct.host);
  const directStop = stopBridge({ config: direct, processApi: deadProcess });
  assert.equal(directStop.config.runtimePath, direct.runtimePath);
  assert.equal(directStop.config.configFingerprint, direct.configFingerprint);

  const fromUndefined = stopBridge({ ...base, processApi: deadProcess });
  assert.equal(fromUndefined.config.host, '127.0.0.1');
  await rm(root, { recursive: true, force: true });
});

test('status distinguishes an exited process from a missing runtime marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-stale-status-'));
  const config = loadConfigSync({
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
  });
  await writeFile(config.runtimePath, JSON.stringify({ pid: 9876, port: config.port }));
  const deadProcess = {
    kill() {
      const error = new Error('dead');
      error.code = 'ESRCH';
      throw error;
    },
  };
  const status = statusBridge({ config, processApi: deadProcess });
  assert.equal(status.running, false);
  assert.equal(status.runtime_stale, true);
  assert.equal(status.stale_pid, 9876);
  await rm(root, { recursive: true, force: true });
});

test('parsePort ignores blank strings but rejects boolean/object coercion', () => {
  assert.equal(parsePort('  \t', 4321), 4321);
  assert.equal(parsePort('0', 4321), 0);
  assert.throws(() => parsePort(false), /invalid bridge port/);
  assert.throws(() => parsePort(true), /invalid bridge port/);
  assert.throws(() => parsePort([8787]), /invalid bridge port/);
});

test('launcher propagates direct injected VAPID credentials and clears stale aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-vapid-env-test-'));
  const stateDir = join(root, 'state');
  const config = {
    configDir: join(root, 'config'),
    stateDir,
    runtimePath: join(stateDir, 'runtime.json'),
    runtimeLockPath: join(stateDir, 'runtime.lock'),
    socketPath: join(root, 'herdr.sock'),
    host: '127.0.0.1',
    port: 49_123,
    token: 't',
    secret: 's',
    vapid: { publicKey: 'injected-public', privateKey: 'injected-private', subject: 'mailto:injected@example.test' },
  };
  let spawnedOptions;
  const result = ensureBridge({
    config,
    env: {
      VAPID_PUBLIC_KEY: 'stale-public',
      VAPID_PRIVATE_KEY: 'stale-private',
      VAPID_SUBJECT: 'mailto:stale@example.test',
    },
    processApi: { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } },
    processInspector: () => undefined,
    spawn(_exec, _args, options) {
      spawnedOptions = options;
      return { pid: 4322, unref() {} };
    },
  });
  assert.equal(result.started, true);
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_VAPID_PUBLIC_KEY, 'injected-public');
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_VAPID_PRIVATE_KEY, 'injected-private');
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_VAPID_SUBJECT, 'mailto:injected@example.test');
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'VAPID_PUBLIC_KEY'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'VAPID_PRIVATE_KEY'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'VAPID_SUBJECT'), false);

  const childConfig = loadConfigSync({ env: spawnedOptions.env, persistGenerated: false });
  assert.deepEqual(childConfig.vapid, config.vapid);
  await rm(root, { recursive: true, force: true });
});

test('launcher resolves and propagates custom relative state paths for injected configs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-relative-paths-'));
  const config = {
    // All filesystem values are intentionally relative.  A detached child
    // receives `cwd: root`; parent lifecycle calls must resolve these against
    // that same base rather than the launcher's incidental cwd.
    configDir: 'config',
    stateDir: 'state',
    runtimePath: 'bridge-runtime.json',
    runtimeLockPath: 'bridge-runtime.lock',
    subscriptionsPath: 'bridge-subscriptions.json',
    dedupPath: 'bridge-dedup.json',
    socketPath: join('sockets', 'herdr.sock'),
    host: '127.0.0.1',
    port: 49_123,
    token: 't',
    secret: 's',
  };
  let spawnedOptions;
  const deadProcess = { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } };
  const result = ensureBridge({
    config,
    cwd: root,
    processApi: deadProcess,
    processInspector: () => undefined,
    spawn(_exec, _args, options) {
      spawnedOptions = options;
      return { pid: 4322, unref() {} };
    },
  });
  const child = loadConfigSync({ env: spawnedOptions.env, persistGenerated: false });
  assert.equal(result.config.runtimePath, child.runtimePath);
  assert.equal(result.config.runtimeLockPath, child.runtimeLockPath);
  assert.equal(result.config.subscriptionsPath, child.subscriptionsPath);
  assert.equal(result.config.dedupPath, child.dedupPath);
  assert.equal(result.config.runtimePath, join(root, 'bridge-runtime.json'));
  assert.equal(result.config.configDir, join(root, 'config'));
  assert.equal(result.config.stateDir, join(root, 'state'));
  assert.equal(result.config.socketPath, join(root, 'sockets', 'herdr.sock'));
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_RUNTIME_PATH, result.config.runtimePath);
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_RUNTIME_LOCK_PATH, result.config.runtimeLockPath);
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_SUBSCRIPTIONS_PATH, result.config.subscriptionsPath);
  assert.equal(spawnedOptions.env.HERDR_BRIDGE_DEDUP_PATH, result.config.dedupPath);
  assert.equal(spawnedOptions.env.HERDR_PLUGIN_CONFIG_DIR, result.config.configDir);
  assert.equal(spawnedOptions.env.HERDR_PLUGIN_STATE_DIR, result.config.stateDir);
  assert.equal(spawnedOptions.env.HERDR_SOCKET_PATH, result.config.socketPath);
  assert.equal(result.config.configFingerprint, child.configFingerprint);
  await rm(root, { recursive: true, force: true });
});

test('launcher rejects comma-containing ACL array entries before spawning a child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-acl-array-comma-'));
  const config = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    host: '127.0.0.1',
    port: 49_124,
    lanProxyHost: '192.168.1.20',
    lanProxyPort: 18_788,
    // Commas are the serialized environment separator; an array item that
    // contains one is malformed and must not become two child rules.
    lanProxyAllowedCidrs: ['192.168.1.0/24,10.0.0.0/8'],
    token: 't',
    secret: 's',
  };
  let spawned = false;
  const dead = { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } };
  assert.throws(() => ensureBridge({
    config,
    processApi: dead,
    processInspector: () => undefined,
    spawn() {
      spawned = true;
      return { pid: 4325, unref() {} };
    },
  }), /array entries must be strings without commas/);
  assert.equal(spawned, false);
  await rm(root, { recursive: true, force: true });
});

test('custom runtime marker paths create their missing parent directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-nested-runtime-'));
  const runtimePath = join('markers', 'nested', 'runtime.json');
  const lockPath = join('locks', 'nested', 'runtime.lock');
  const config = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    runtimePath,
    runtimeLockPath: lockPath,
    host: '127.0.0.1',
    port: 49_125,
    token: 't',
    secret: 's',
  };
  const signals = [];
  const processApi = {
    kill(pid, signal) {
      if (pid !== 4326) {
        const error = new Error('dead');
        error.code = 'ESRCH';
        throw error;
      }
      if (signal !== 0) signals.push(signal);
    },
  };
  const result = ensureBridge({
    config,
    cwd: root,
    processApi,
    processInspector: () => undefined,
    spawn() { return { pid: 4326, unref() {} }; },
  });
  assert.equal(result.started, true);
  const resolvedRuntimePath = join(root, runtimePath);
  assert.equal(result.config.runtimePath, resolvedRuntimePath);
  assert.equal((await stat(resolvedRuntimePath)).isFile(), true);
  assert.equal((await stat(join(root, 'locks', 'nested'))).isDirectory(), true);
  const status = statusBridge({ config, cwd: root, processApi, processInspector: () => undefined });
  assert.equal(status.running, true);
  assert.equal(status.runtime.pid, 4326);
  const stopped = stopBridge({ config, cwd: root, processApi, processInspector: () => undefined });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(signals, ['SIGTERM']);
  await rm(root, { recursive: true, force: true });
});

test('StateStore creates parents for custom subscription, dedup, and runtime paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-state-nested-paths-'));
  const stateDir = join(root, 'state');
  const external = join(root, 'persisted', 'deep');
  const store = new StateStore({
    stateDir,
    subscriptionsPath: join(external, 'subscriptions.json'),
    dedupPath: join(external, 'dedup.json'),
    runtimePath: join(external, 'runtime.json'),
  });
  await store.setRuntime({ pid: process.pid });
  await store.addSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/nested-path-test' });
  assert.equal(await store.markSeen('nested-path-test'), true);
  for (const name of ['subscriptions.json', 'dedup.json', 'runtime.json']) {
    assert.equal((await stat(join(external, name))).isFile(), true, name);
  }
  await rm(root, { recursive: true, force: true });
});

test('injected config does not inherit ambient state-path aliases', () => {
  // Run this check in a separate process so changing its environment cannot
  // race other node:test workers. The launcher should ignore aliases inherited
  // from an older Herdr session unless they are explicitly supplied in
  // options.env for this injected config.
  const script = `
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { ensureBridge } from './src/launcher.js';
    import { loadConfigSync } from './src/config.js';
    const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-ambient-paths-'));
    const config = { configDir: join(root, 'config'), stateDir: join(root, 'state'), token: 't', secret: 's' };
    let childEnv;
    const dead = { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } };
    const result = ensureBridge({
      config,
      processApi: dead,
      processInspector: () => undefined,
      spawn(_exec, _args, options) { childEnv = options.env; return { pid: 4324, unref() {} }; },
    });
    const child = loadConfigSync({ env: childEnv, persistGenerated: false });
    process.stdout.write(JSON.stringify({ parent: result.config.runtimePath, child: child.runtimePath, state: result.config.stateDir }));
    await rm(root, { recursive: true, force: true });
  `;
  const staleRoot = '/tmp/herdr-stale-ambient-paths';
  const completed = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HERDR_BRIDGE_RUNTIME_PATH: `${staleRoot}/runtime.json`,
      HERDR_RUNTIME_LOCK_PATH: `${staleRoot}/runtime.lock`,
      BRIDGE_SUBSCRIPTIONS_PATH: `${staleRoot}/subscriptions.json`,
      HERDR_DEDUP_PATH: `${staleRoot}/dedup.json`,
    },
    encoding: 'utf8',
  });
  assert.equal(completed.status, 0, completed.stderr);
  const output = JSON.parse(completed.stdout);
  assert.equal(output.parent, join(output.state, 'runtime.json'));
  assert.equal(output.child, output.parent);
  assert.equal(output.parent.startsWith(staleRoot), false);
});

test('explicit relative state aliases in options.env follow the detached cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-explicit-relative-aliases-'));
  let spawnedOptions;
  const deadProcess = { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } };
  const result = ensureBridge({
    config: {},
    cwd: root,
    env: {
      HOME: root,
      HERDR_RUNTIME_PATH: join('nested', 'runtime.json'),
      HERDR_RUNTIME_LOCK_PATH: join('nested', 'runtime.lock'),
      HERDR_SUBSCRIPTIONS_PATH: join('nested', 'subscriptions.json'),
      HERDR_DEDUP_PATH: join('nested', 'dedup.json'),
    },
    processApi: deadProcess,
    processInspector: () => undefined,
    spawn(_exec, _args, options) {
      spawnedOptions = options;
      return { pid: 4327, unref() {} };
    },
  });
  const child = loadConfigSync({ env: spawnedOptions.env, persistGenerated: false });
  for (const key of ['runtimePath', 'runtimeLockPath', 'subscriptionsPath', 'dedupPath']) {
    assert.equal(result.config[key], child[key]);
    assert.equal(result.config[key].startsWith(root), true, key);
  }
  await rm(root, { recursive: true, force: true });
});

test('numeric security CLI flags preserve missing and empty values for validation', () => {
  const flags = [
    ['--rate-limit-per-minute', 'rateLimitPerMinute'],
    ['--rate-limit-burst', 'rateLimitBurst'],
    ['--rate-limit-max-entries', 'rateLimitMaxEntries'],
    ['--request-body-timeout-ms', 'requestBodyTimeoutMs'],
  ];
  for (const [flag, key] of flags) {
    assert.equal(parseLauncherArgs([flag]).options[key], '', `${flag} without a value`);
    assert.equal(parseLauncherArgs([`${flag}=`]).options[key], '', `${flag}= with an empty value`);
    assert.equal(parseLauncherArgs([flag, '--help']).options[key], '', `${flag} before another option`);
    assert.equal(parseLauncherArgs([flag, '--help']).options.help, true);
    // A negative token is still a value (and is subsequently rejected by the
    // config validator), rather than being mistaken for another flag.
    assert.equal(parseLauncherArgs([flag, '-1']).options[key], -1, `${flag} negative value`);
  }
});

test('bridge CLI parser preserves missing and empty numeric security values', () => {
  const flags = [
    ['--rate-limit-per-minute', 'rateLimitPerMinute'],
    ['--rate-limit-burst', 'rateLimitBurst'],
    ['--rate-limit-max-entries', 'rateLimitMaxEntries'],
    ['--request-body-timeout-ms', 'requestBodyTimeoutMs'],
  ];
  for (const [flag, key] of flags) {
    assert.equal(parseBridgeArgs([flag])[key], '', `${flag} without a value`);
    assert.equal(parseBridgeArgs([`${flag}=`])[key], '', `${flag}= with an empty value`);
    const beforeOption = parseBridgeArgs([flag, '--help']);
    assert.equal(beforeOption[key], '', `${flag} before another option`);
    assert.equal(beforeOption.help, true);
    assert.equal(parseBridgeArgs([flag, '-1'])[key], -1, `${flag} negative value`);
  }
});

test('CLI listener flags preserve inline empty sentinels without swallowing help', () => {
  const listenerFlags = [
    ['--port=', 'port'],
    ['--lan-port=', 'lanProxyPort'],
    ['--host=', 'host'],
    ['--lan-host=', 'lanProxyHost'],
    ['--socket=', 'socketPath'],
  ];
  for (const [flag, key] of listenerFlags) {
    const bridge = parseBridgeArgs([flag]);
    assert.equal(bridge[key], '', `bridge ${flag}`);
    const launcher = parseLauncherArgs([flag]);
    assert.equal(launcher.options[key], '', `launcher ${flag}`);

    const bridgeMissing = parseBridgeArgs([flag.slice(0, -1), '--help']);
    assert.equal(Object.prototype.hasOwnProperty.call(bridgeMissing, key), false, `bridge ${flag.slice(0, -1)}`);
    assert.equal(bridgeMissing.help, true);
    const launcherMissing = parseLauncherArgs([flag.slice(0, -1), '--help']);
    assert.equal(Object.prototype.hasOwnProperty.call(launcherMissing.options, key), false, `launcher ${flag.slice(0, -1)}`);
    assert.equal(launcherMissing.options.help, true);
  }
});

test('explicit empty listener configuration values fail validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-empty-listener-config-'));
  const base = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
  };
  assert.throws(() => loadConfigSync({ ...base, port: '' }), /bridge port must not be empty/);
  assert.throws(() => loadConfigSync({ ...base, lanProxyPort: '' }), /LAN proxy port must not be empty/);
  assert.throws(() => loadConfigSync({ ...base, host: '' }), /loopback/);
  assert.throws(() => loadConfigSync({ ...base, lanProxyHost: '' }), /explicit interface/);
  assert.throws(() => loadConfigSync({ ...base, socketPath: '' }), /socket path must not be empty/);
  await assert.rejects(() => loadConfig({ ...base, port: '' }), /bridge port must not be empty/);
  await rm(root, { recursive: true, force: true });
});

test('injected launcher configuration does not silently default explicit blank listener values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-empty-listener-'));
  const deadProcess = {
    kill() {
      const error = new Error('dead');
      error.code = 'ESRCH';
      throw error;
    },
  };
  const cases = [
    ['host', /bridge host must be a loopback address/],
    ['port', /bridge port must not be empty/],
    ['lanProxyHost', /LAN proxy host must be an explicit interface address/],
    ['lanProxyPort', /LAN proxy port must not be empty/],
    ['socketPath', /socket path must not be empty/],
  ];
  for (const [key, pattern] of cases) {
    let spawned = false;
    assert.throws(() => ensureBridge({
      config: {
        configDir: join(root, 'config'),
        stateDir: join(root, key),
        token: 't',
        secret: 's',
        [key]: ' ',
      },
      processApi: deadProcess,
      processInspector: () => undefined,
      spawn() {
        spawned = true;
        return { pid: 4390, unref() {} };
      },
    }), pattern, key);
    assert.equal(spawned, false, `${key} must fail before spawn`);
  }
  await rm(root, { recursive: true, force: true });
});

test('launcher preserves raw and explicitly empty ACL values for child validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-acl-env-test-'));
  const cases = [
    ['raw string', '192.168.1.0/24', '192.168.1.0/24'],
    ['empty array', [], ''],
    ['empty string', '', ''],
  ];
  let pid = 5400;
  for (const [label, acl, expectedEnv] of cases) {
    const stateDir = join(root, label.replace(/\s+/g, '-'));
    const config = {
      configDir: join(root, 'config'),
      stateDir,
      runtimePath: join(stateDir, 'runtime.json'),
      runtimeLockPath: join(stateDir, 'runtime.lock'),
      socketPath: join(stateDir, 'herdr.sock'),
      host: '127.0.0.1',
      port: 48_000 + pid - 5400,
      lanProxyHost: '192.168.1.20',
      lanProxyPort: 18_787,
      lanProxyAllowedCidrs: acl,
      token: 't',
      secret: 's',
    };
    let spawnedOptions;
    const result = ensureBridge({
      config,
      env: { BRIDGE_LAN_PROXY_ALLOWED_CIDRS: 'stale-inherited-value' },
      processApi: { kill() { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } },
      processInspector: () => undefined,
      spawn(_exec, _args, options) {
        spawnedOptions = options;
        return { pid: pid++, unref() {} };
      },
    });
    assert.equal(result.started, true, label);
    assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'HERDR_LAN_PROXY_ALLOWED_CIDRS'), true, label);
    assert.equal(spawnedOptions.env.HERDR_LAN_PROXY_ALLOWED_CIDRS, expectedEnv, label);
    assert.equal(Object.prototype.hasOwnProperty.call(spawnedOptions.env, 'BRIDGE_LAN_PROXY_ALLOWED_CIDRS'), false, label);
    assert.equal(result.runtime.acl_enabled, true, label);
  }
  await rm(root, { recursive: true, force: true });
});

test('socket path follows named Herdr session and explicit overrides', () => {
  const named = resolvePaths({ HOME: '/home/test', XDG_CONFIG_HOME: '/home/test/.config', HERDR_SESSION: 'work' });
  assert.equal(named.socketPath, '/home/test/.config/herdr/sessions/work/herdr.sock');
  const explicit = resolvePaths({ HOME: '/home/test', HERDR_SOCKET_PATH: '/tmp/custom.sock' });
  assert.equal(explicit.socketPath, '/tmp/custom.sock');
  assert.equal(resolvePaths({ HOME: '/home/test' }, { socketPath: '/tmp/options.sock' }).socketPath, '/tmp/options.sock');
  assert.throws(() => resolvePaths({ HOME: '/home/test' }, { socketPath: '' }), /socket path must not be empty/);
});

test('filesystem roots fall back to HOME when XDG roots are absent', () => {
  const paths = resolvePaths({ HOME: '/home/test' });
  assert.equal(paths.configDir, '/home/test/.config/herdr-mobile-bridge');
  assert.equal(paths.stateDir, '/home/test/.local/state/herdr-mobile-bridge');
});

test('VAPID subject precedence is consistent for async and sync loaders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-vapid-subject-'));
  const options = { env: { HOME: root, HERDR_BRIDGE_VAPID_SUBJECT: 'mailto:env@example.com' }, configDir: join(root, 'config'), stateDir: join(root, 'state'), token: 't', secret: 's', persistGenerated: false, vapidSubject: 'mailto:option@example.com' };
  const asyncConfig = await loadConfig(options);
  const syncConfig = loadConfigSync(options);
  assert.equal(asyncConfig.vapid.subject, 'mailto:option@example.com');
  assert.equal(syncConfig.vapid.subject, asyncConfig.vapid.subject);
  await rm(root, { recursive: true, force: true });
});

test('explicit VAPID configuration rejects a partial key pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-vapid-partial-'));
  const options = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
    env: { HOME: root, HERDR_BRIDGE_VAPID_PUBLIC_KEY: 'public-only' },
  };
  await assert.rejects(() => loadConfig(options), /VAPID .*configured together/);
  assert.throws(() => loadConfigSync(options), /VAPID .*configured together/);
  await rm(root, { recursive: true, force: true });
});

test('partial persisted VAPID files are replaced with a complete pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-vapid-file-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'vapid.json'), JSON.stringify({ publicKey: 'stale-public', subject: 'mailto:file@example.com' }));
  const loaded = await loadConfig({ configDir, stateDir, token: 't', secret: 's' });
  assert.notEqual(loaded.vapid.publicKey, 'stale-public');
  assert.equal(typeof loaded.vapid.privateKey, 'string');
  assert.equal(loaded.vapid.subject, 'mailto:file@example.com');
  const persisted = JSON.parse(await readFile(loaded.vapidPath, 'utf8'));
  assert.equal(typeof persisted.publicKey, 'string');
  assert.equal(typeof persisted.privateKey, 'string');
  await rm(root, { recursive: true, force: true });
});

test('existing credential files are tightened to owner-only permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-credential-mode-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(configDir, 'token'), 'token\n', { mode: 0o644 });
  await writeFile(join(configDir, 'bridge-secret'), 'secret\n', { mode: 0o644 });
  await writeFile(join(configDir, 'vapid.json'), JSON.stringify({
    publicKey: 'public', privateKey: 'private', subject: 'mailto:test@example.com',
  }), { mode: 0o644 });
  // chmod is needed on filesystems whose umask masks the mode option.
  await chmod(join(configDir, 'token'), 0o644);
  await chmod(join(configDir, 'bridge-secret'), 0o644);
  await chmod(join(configDir, 'vapid.json'), 0o644);

  const asyncConfig = await loadConfig({ configDir, stateDir });
  assert.equal((await stat(asyncConfig.tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(asyncConfig.secretPath)).mode & 0o777, 0o600);
  assert.equal((await stat(asyncConfig.vapidPath)).mode & 0o777, 0o600);

  // Exercise the synchronous launcher path too after deliberately relaxing
  // the modes again.
  await chmod(asyncConfig.tokenPath, 0o644);
  await chmod(asyncConfig.secretPath, 0o644);
  await chmod(asyncConfig.vapidPath, 0o644);
  const syncConfig = loadConfigSync({ configDir, stateDir });
  assert.equal((await stat(syncConfig.tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(syncConfig.secretPath)).mode & 0o777, 0o600);
  assert.equal((await stat(syncConfig.vapidPath)).mode & 0o777, 0o600);
  await rm(root, { recursive: true, force: true });
});

test('USERPROFILE and tilde paths resolve consistently', () => {
  const paths = resolvePaths({ USERPROFILE: '/home/profile' }, { configDir: '~/bridge-config', stateDir: '~/bridge-state' });
  assert.equal(paths.configDir, '/home/profile/bridge-config');
  assert.equal(paths.stateDir, '/home/profile/bridge-state');
});

test('LAN configuration keeps the bridge loopback-only and rejects wildcard proxy binds', async () => {
  assert.equal(assertBridgeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(assertBridgeHost('::1'), '::1');
  assert.throws(() => assertBridgeHost('0.0.0.0'), /loopback/);
  assert.throws(() => assertBridgeHost('192.168.1.20'), /loopback/);
  assert.equal(assertLanProxyHost('192.168.1.20'), '192.168.1.20');
  assert.throws(() => assertLanProxyHost('0.0.0.0'), /explicit interface/);
  assert.throws(() => assertLanProxyHost('lan.example'), /IP address/);

  const root = await mkdtemp(join(tmpdir(), 'herdr-lan-config-'));
  const base = { configDir: join(root, 'config'), stateDir: join(root, 'state'), token: 't', secret: 's', persistGenerated: false };
  await assert.rejects(() => loadConfig({ ...base, host: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfigSync({ ...base, lanProxyHost: '0.0.0.0' }), /explicit interface/);
  assert.throws(() => loadConfigSync({ ...base, lanProxyHost: '192.168.1.20', lanProxyPort: 0 }), /between 1 and 65535/);
  await rm(root, { recursive: true, force: true });
});

test('push policy settings resolve consistently for async and sync config loaders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-push-config-'));
  const options = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
    pushEndpointAllowlist: ['relay.example.test', 'https://relay.example.test/'],
    allowCustomPushEndpoints: true,
    allowPushRelay: true,
    pushTimeoutMs: 1234,
  };
  const asyncConfig = await loadConfig(options);
  const syncConfig = loadConfigSync(options);
  for (const config of [asyncConfig, syncConfig]) {
    assert.deepEqual(config.pushEndpointAllowlist, options.pushEndpointAllowlist);
    assert.equal(config.allowCustomPushEndpoints, true);
    assert.equal(config.allowPushRelay, true);
    assert.equal(config.pushTimeoutMs, 1234);
  }
  assert.deepEqual(syncConfig.pushEndpointAllowlist, asyncConfig.pushEndpointAllowlist);
  assert.equal(syncConfig.allowCustomPushEndpoints, asyncConfig.allowCustomPushEndpoints);
  assert.equal(syncConfig.allowPushRelay, asyncConfig.allowPushRelay);
  assert.equal(syncConfig.pushTimeoutMs, asyncConfig.pushTimeoutMs);
  await rm(root, { recursive: true, force: true });
});

test('push timeout parser keeps every accepted positive value at least one millisecond', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-push-timeout-bound-'));
  const base = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
  };
  const config = loadConfigSync({ ...base, pushTimeoutMs: 0.5 });
  assert.equal(config.pushTimeoutMs, 1);
  const fallback = loadConfigSync({ ...base, pushTimeoutMs: 0 });
  assert.equal(fallback.pushTimeoutMs, 5000);
  await rm(root, { recursive: true, force: true });
});

test('security settings keep async and sync loaders in parity with explicit precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-security-config-'));
  const base = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
    lanProxyHost: '192.168.1.20',
    env: {
      HOME: root,
      HERDR_LAN_PROXY_ALLOWED_CIDRS: '192.168.1.0/24,2001:db8::1',
      HERDR_BRIDGE_RATE_LIMIT_PER_MINUTE: '90',
      HERDR_BRIDGE_RATE_LIMIT_BURST: '15',
      HERDR_BRIDGE_REQUEST_BODY_TIMEOUT_MS: '9000',
    },
    rateLimitMaxEntries: 2048,
  };
  const asyncConfig = await loadConfig(base);
  const syncConfig = loadConfigSync(base);
  for (const config of [asyncConfig, syncConfig]) {
    assert.deepEqual(config.lanProxyAllowedCidrs, ['192.168.1.0/24', '2001:db8::1/128']);
    assert.equal(config.rateLimitPerMinute, 90);
    assert.equal(config.rateLimitBurst, 15);
    assert.equal(config.rateLimitMaxEntries, 2048);
    assert.equal(config.requestBodyTimeoutMs, 9000);
    assert.match(config.configFingerprint, /^[a-f0-9]{64}$/);
  }
  assert.equal(asyncConfig.configFingerprint, syncConfig.configFingerprint);
  assert.equal(configFingerprint({ ...asyncConfig, token: 'different', secret: 'different' }), asyncConfig.configFingerprint);
  await rm(root, { recursive: true, force: true });
});

test('security settings reject explicit empty/invalid values and ACL without a listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-security-invalid-'));
  const base = { configDir: join(root, 'config'), stateDir: join(root, 'state'), token: 't', secret: 's', persistGenerated: false };
  assert.throws(() => loadConfigSync({ ...base, lanProxyAllowedCidrs: [] }), /list must not be empty/);
  assert.throws(() => loadConfigSync({ ...base, lanProxyAllowedCidrs: ['192.168.1.0/24'] }), /requires lanProxyHost/);
  assert.throws(() => loadConfigSync({ ...base, lanProxyHost: '192.168.1.20', requestBodyTimeoutMs: 60_001 }), /between 1 and 60000/);
  assert.throws(() => loadConfigSync({ ...base, rateLimitPerMinute: 10, rateLimitBurst: 11 }), /between 1 and 10/);
  assert.throws(() => loadConfigSync({ ...base, rateLimitMaxEntries: 1 }), /between 2 and/);
  await assert.rejects(() => loadConfig({ ...base, rateLimitMaxEntries: 1 }), /between 2 and/);
  await rm(root, { recursive: true, force: true });
});

test('launcher refuses to reuse a live process when the security fingerprint changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-launcher-fingerprint-'));
  const base = {
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    token: 't',
    secret: 's',
    persistGenerated: false,
  };
  const config = loadConfigSync(base);
  let spawned = 0;
  const processApi = { kill(pid, signal) {
    if (pid === 4321 && signal === 0) return true;
    const error = new Error('dead');
    error.code = 'ESRCH';
    throw error;
  } };
  const first = ensureBridge({
    config,
    processApi,
    processInspector: () => undefined,
    spawn() { spawned += 1; return { pid: 4321, unref() {} }; },
  });
  assert.equal(first.started, true);
  const changed = loadConfigSync({ ...base, rateLimitBurst: 10 });
  const second = ensureBridge({ config: changed, processApi, processInspector: () => undefined, spawn() { spawned += 1; return { pid: 9999, unref() {} }; } });
  assert.equal(second.started, false);
  assert.equal(second.restartRequired, true);
  assert.equal(second.reason, 'config_mismatch');
  assert.equal(second.pid, 4321);
  assert.equal(spawned, 1);
  await rm(root, { recursive: true, force: true });
});
