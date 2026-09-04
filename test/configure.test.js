import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectInterfaces,
  mergeConfig,
  parseArgs,
  parseOriginList,
  resolveWizardPaths,
  runWizard,
} from '../scripts/configure.js';

function outputBuffer() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); },
    text() { return value; },
  };
}

function queuedAnswers(values) {
  const answers = [...values];
  return async () => {
    if (!answers.length) throw new Error('test answer queue exhausted');
    return answers.shift();
  };
}

test('detectInterfaces filters loopback and duplicate addresses', () => {
  const interfaces = detectInterfaces(() => ({
    lo: [
      { address: '127.0.0.1', internal: true, family: 'IPv4' },
      { address: '::1', internal: true, family: 'IPv6' },
    ],
    eth0: [
      { address: '192.168.1.20', internal: false, family: 'IPv4', cidr: '192.168.1.20/24' },
      { address: '192.168.1.20', internal: false, family: 'IPv4' },
      { address: 'fd00::20', internal: false, family: 'IPv6' },
      { address: 'not-an-ip', internal: false, family: 'IPv4' },
    ],
  }));
  assert.deepEqual(interfaces.map((item) => item.address), ['192.168.1.20', 'fd00::20']);
  assert.equal(interfaces[0].name, 'eth0');
});

test('parseOriginList canonicalizes origins and rejects paths or credentials', () => {
  assert.equal(parseOriginList(' https://example.test/ ,http://192.168.1.20:18787 '), 'https://example.test,http://192.168.1.20:18787');
  assert.throws(() => parseOriginList('https://example.test/path'), /origin/);
  assert.throws(() => parseOriginList('https://user:pass@example.test'), /origin/);
});

test('mergeConfig removes disabled LAN settings and preserves unrelated keys', () => {
  const result = mergeConfig({
    lanProxyHost: '192.168.1.20',
    lanProxyPort: 18787,
    lanProxyAllowedCidrs: ['192.168.1.0/24'],
    allowedOrigin: 'https://old.example.test',
    customSetting: 'keep-me',
  }, { mode: 'local', port: 8787, advanced: false });
  assert.equal(result.customSetting, 'keep-me');
  assert.equal(result.host, '127.0.0.1');
  assert.equal(result.port, 8787);
  assert.equal('lanProxyHost' in result, false);
  assert.equal('lanProxyAllowedCidrs' in result, false);
  assert.equal('allowedOrigin' in result, false);
  assert.equal(result.cookieSecure, false);
});

test('LAN wizard writes a backup, generated credentials stay outside bridge.json, and apply can be skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-configure-lan-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  await mkdir(configDir, { recursive: true });
  const oldConfig = {
    port: 8787,
    customSetting: 'keep-me',
    rateLimitPerMinute: 120,
  };
  await writeFile(join(configDir, 'bridge.json'), `${JSON.stringify(oldConfig, null, 2)}\n`);
  const output = outputBuffer();
  const result = await runWizard({
    configDir,
    stateDir,
    output,
    ask: queuedAnswers(['2', '', '1', '', '', 'n', 'n']),
    networkInterfaces: () => ({ eth0: [{ address: '192.168.1.20', internal: false, family: 'IPv4' }] }),
  });
  const saved = JSON.parse(await readFile(join(configDir, 'bridge.json'), 'utf8'));
  assert.equal(saved.customSetting, 'keep-me');
  assert.equal(saved.lanProxyHost, '192.168.1.20');
  assert.equal(saved.lanProxyPort, 18787);
  assert.equal(saved.cookieSecure, false);
  assert.equal('token' in saved, false);
  assert.equal('secret' in saved, false);
  assert.equal(typeof result.config.token, 'string');
  assert.equal(typeof result.config.vapid.privateKey, 'string');
  assert.equal(await readFile(join(configDir, 'bridge.json.bak'), 'utf8'), `${JSON.stringify(oldConfig, null, 2)}\n`);
  assert.equal((await stat(join(configDir, 'bridge.json'))).mode & 0o777, 0o600);
  assert.match(output.text(), /配置已保存/);
  await rm(root, { recursive: true, force: true });
});

test('HTTPS wizard requires an HTTPS origin and invokes injected launcher when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-configure-https-'));
  const calls = [];
  let statusCalls = 0;
  const result = await runWizard({
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    output: outputBuffer(),
    ask: queuedAnswers(['3', '9000', 'https://bridge.example.test', 'n', 'y']),
    launcher: {
      statusBridge() {
        calls.push('status');
        statusCalls += 1;
        return statusCalls === 1 ? { running: false } : { running: true, pid: 42 };
      },
      ensureBridge(options) { calls.push(['ensure', options.configDir, options.stateDir]); return { pid: 42 }; },
      stopBridge() { calls.push('stop'); return { stopped: true }; },
    },
  });
  assert.equal(result.candidate.port, 9000);
  assert.equal(result.candidate.allowedOrigin, 'https://bridge.example.test');
  assert.equal(result.candidate.cookieSecure, true);
  assert.deepEqual(calls, ['status', ['ensure', join(root, 'config'), join(root, 'state')], 'status']);
  await rm(root, { recursive: true, force: true });
});

test('advanced wizard normalizes ACL and security values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-configure-advanced-'));
  const result = await runWizard({
    configDir: join(root, 'config'),
    stateDir: join(root, 'state'),
    output: outputBuffer(),
    ask: queuedAnswers([
      '2', '', 'm', '192.168.1.20', '', '', 'y', 'y', '192.168.1.0/24',
      '90', '15', '2048', '9000', 'n', 'n', 'n', 'n',
    ]),
    networkInterfaces: () => ({}),
  });
  assert.deepEqual(result.candidate.lanProxyAllowedCidrs, ['192.168.1.0/24']);
  assert.equal(result.candidate.rateLimitPerMinute, 90);
  assert.equal(result.candidate.rateLimitBurst, 15);
  assert.equal(result.candidate.rateLimitMaxEntries, 2048);
  assert.equal(result.candidate.requestBodyTimeoutMs, 9000);
  await rm(root, { recursive: true, force: true });
});

test('configure CLI parser accepts only directory overrides', () => {
  assert.deepEqual(parseArgs(['--config-dir=/tmp/config', '--state-dir', '/tmp/state']), {
    configDir: '/tmp/config',
    stateDir: '/tmp/state',
  });
  assert.throws(() => parseArgs(['--unknown']), /无法识别的参数/);
  assert.throws(() => parseArgs(['--config-dir']), /需要一个值/);
});

test('wizard resolves Herdr-managed directories when no environment is injected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-configure-paths-'));
  const detected = resolveWizardPaths({
    env: { HOME: root },
    execFileSync() { return join(root, '.config', 'herdr', 'plugins', 'config', 'herdr.mobile-bridge'); },
  });
  assert.equal(detected.source, 'herdr');
  assert.equal(detected.paths.configDir, join(root, '.config', 'herdr', 'plugins', 'config', 'herdr.mobile-bridge'));
  assert.equal(detected.paths.stateDir, join(root, '.local', 'state', 'herdr', 'plugins', 'herdr.mobile-bridge'));
  await rm(root, { recursive: true, force: true });
});

test('explicit wizard directories override Herdr auto-detection', () => {
  const detected = resolveWizardPaths({
    configDir: '/tmp/standalone-config',
    stateDir: '/tmp/standalone-state',
    execFileSync() { throw new Error('must not probe Herdr'); },
  });
  assert.equal(detected.source, 'explicit');
  assert.equal(detected.paths.configDir, '/tmp/standalone-config');
  assert.equal(detected.paths.stateDir, '/tmp/standalone-state');
});

test('wizard falls back to the standalone XDG layout when Herdr is unavailable', () => {
  const detected = resolveWizardPaths({
    env: { HOME: '/tmp/herdr-configure-no-herdr' },
    execFileSync() { throw new Error('herdr unavailable'); },
  });
  assert.equal(detected.source, 'standalone');
  assert.equal(detected.paths.configDir, '/tmp/herdr-configure-no-herdr/.config/herdr-mobile-bridge');
  assert.equal(detected.paths.stateDir, '/tmp/herdr-configure-no-herdr/.local/state/herdr-mobile-bridge');
});

test('apply reports a detached startup failure instead of claiming success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-configure-startup-failure-'));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'startup-error.log'), '2026-01-01 listen EADDRINUSE\n');
  const output = outputBuffer();
  const calls = [];
  const result = await runWizard({
    configDir: join(root, 'config'),
    stateDir,
    output,
    startupTimeoutMs: 0,
    ask: queuedAnswers(['1', '', 'n', 'y']),
    launcher: {
      statusBridge() { calls.push('status'); return { running: false }; },
      ensureBridge() { calls.push('ensure'); return { pid: 99 }; },
      stopBridge() { calls.push('stop'); return { stopped: true }; },
    },
  });
  assert.equal(result.applied, false);
  assert.equal(result.applyResult.reason, 'startup_timeout');
  assert.match(output.text(), /启动失败或未就绪/);
  assert.match(output.text(), /EADDRINUSE/);
  assert.deepEqual(calls, ['status', 'ensure', 'status']);
  await rm(root, { recursive: true, force: true });
});
