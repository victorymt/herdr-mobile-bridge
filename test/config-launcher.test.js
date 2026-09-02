import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, loadConfigSync, resolvePaths } from '../src/config.js';
import { ensureBridge, processAlive } from '../src/launcher.js';

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
  const alive = ensureBridge({ config, processApi, spawn() { spawned += 1; return { pid: 1234, unref() {} }; } });
  assert.equal(alive.started, true);
  assert.equal(spawned, 1);
  const second = ensureBridge({ config, processApi, spawn() { spawned += 1; return { pid: 1234, unref() {} }; } });
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

test('socket path follows named Herdr session and explicit overrides', () => {
  const named = resolvePaths({ HOME: '/home/test', XDG_CONFIG_HOME: '/home/test/.config', HERDR_SESSION: 'work' });
  assert.equal(named.socketPath, '/home/test/.config/herdr/sessions/work/herdr.sock');
  const explicit = resolvePaths({ HOME: '/home/test', HERDR_SOCKET_PATH: '/tmp/custom.sock' });
  assert.equal(explicit.socketPath, '/tmp/custom.sock');
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
