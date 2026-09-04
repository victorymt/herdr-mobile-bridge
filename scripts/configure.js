#!/usr/bin/env node

import { copyFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, networkInterfaces as osNetworkInterfaces } from 'node:os';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertBridgeHost,
  assertLanProxyHost,
  DEFAULT_HOST,
  DEFAULT_LAN_PROXY_PORT,
  DEFAULT_PORT,
  DEFAULT_REQUEST_BODY_TIMEOUT_MS,
  loadConfigSync,
  resolvePaths,
} from '../src/config.js';
import { parseAllowedCidrs } from '../src/network-acl.js';
import {
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  DEFAULT_RATE_PER_MINUTE,
  MAX_RATE_LIMIT_ENTRIES,
  MIN_RATE_LIMIT_MAX_ENTRIES,
} from '../src/rate-limit.js';
import { ensureBridge, statusBridge, stopBridge } from '../src/launcher.js';

const MAX_REQUEST_BODY_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 5_000;
const STARTUP_POLL_INTERVAL_MS = 100;
const HERDR_PLUGIN_ID = 'herdr.mobile-bridge';
const MODES = Object.freeze({
  local: 'local',
  lan: 'lan',
  https: 'https',
  both: 'both',
});

function outputLine(output, value = '') {
  output.write(`${value}\n`);
}

function authorityHost(host) {
  const value = String(host ?? '').trim();
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['y', 'yes', '是', '1', 'true', 'on'].includes(normalized)) return true;
  if (['n', 'no', '否', '0', 'false', 'off'].includes(normalized)) return false;
  throw new TypeError('请输入 y/yes/是 或 n/no/否');
}

function splitList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => String(item ?? '').split(','));
  if (value === undefined || value === null) return [];
  return String(value).split(',');
}

function inferMode(config = {}) {
  const lan = config.lanProxyHost !== undefined && config.lanProxyHost !== null && String(config.lanProxyHost).trim() !== '';
  const origins = splitList(config.allowedOrigin).map((item) => String(item).trim().toLowerCase());
  const https = origins.some((origin) => origin.startsWith('https://')) || config.cookieSecure === true;
  if (lan && https) return MODES.both;
  if (lan) return MODES.lan;
  if (https) return MODES.https;
  return MODES.local;
}

/** Return stable, user-selectable non-loopback addresses from os.networkInterfaces(). */
export function detectInterfaces(provider = osNetworkInterfaces) {
  let interfaces;
  try { interfaces = provider?.() || {}; } catch { return []; }
  const result = [];
  const seen = new Set();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      const value = String(address?.address || '').trim();
      if (!value || address?.internal === true || !isIP(value) || seen.has(value)) continue;
      seen.add(value);
      result.push({
        name,
        address: value,
        family: String(address?.family || (isIP(value) === 6 ? 'IPv6' : 'IPv4')),
        cidr: address?.cidr || undefined,
      });
    }
  }
  return result;
}

function parseCliValue(argv, index, inline, flag) {
  if (inline !== undefined) return { value: inline, consumed: false };
  const next = argv[index + 1];
  if (next === undefined || String(next).startsWith('-')) {
    throw new TypeError(`${flag} 需要一个值`);
  }
  return { value: next, consumed: true };
}

function firstNonEmpty(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Resolve the wizard target independently from the launcher's process
 * environment. Herdr injects both plugin roots when it starts the plugin, but
 * users commonly run `npm run configure` from a regular shell. In that case,
 * ask Herdr for the registered config directory and derive its matching state
 * directory before falling back to the standalone XDG layout.
 */
export function resolveWizardPaths(options = {}) {
  const env = options.env || process.env;
  const explicit = options.configDir !== undefined || options.stateDir !== undefined;
  if (explicit) {
    return {
      paths: resolvePaths(env, { configDir: options.configDir, stateDir: options.stateDir }),
      source: 'explicit',
    };
  }

  const envConfig = firstNonEmpty(env, ['HERDR_PLUGIN_CONFIG_DIR']);
  const envState = firstNonEmpty(env, ['HERDR_PLUGIN_STATE_DIR']);
  if (envConfig || envState) {
    return {
      paths: resolvePaths(env, { configDir: envConfig, stateDir: envState }),
      source: 'environment',
    };
  }

  const command = options.herdrCommand || env.HERDR_BIN_PATH || 'herdr';
  const run = options.execFileSync || execFileSync;
  let herdrConfigDir;
  try {
    herdrConfigDir = String(run(command, ['plugin', 'config-dir', HERDR_PLUGIN_ID], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    })).trim();
    if (!herdrConfigDir) herdrConfigDir = undefined;
  } catch {
    herdrConfigDir = undefined;
  }
  if (herdrConfigDir) {
    const home = firstNonEmpty(env, ['HOME', 'USERPROFILE']) || homedir();
    const stateHome = firstNonEmpty(env, ['XDG_STATE_HOME']) || join(home, '.local', 'state');
    const stateDir = join(stateHome, 'herdr', 'plugins', HERDR_PLUGIN_ID);
    return {
      paths: resolvePaths(env, { configDir: herdrConfigDir, stateDir }),
      source: 'herdr',
    };
  }
  return {
    paths: resolvePaths(env),
    source: 'standalone',
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('-')) throw new TypeError(`无法识别的位置参数：${arg}`);
    const [flag, inline] = arg.split('=', 2);
    if (flag !== '--config-dir' && flag !== '--state-dir') {
      throw new TypeError(`无法识别的参数：${flag}`);
    }
    const parsed = parseCliValue(argv, index, inline, flag);
    options[flag === '--config-dir' ? 'configDir' : 'stateDir'] = parsed.value;
    if (parsed.consumed) index += 1;
  }
  return options;
}

function modeUsesLan(mode) {
  return mode === MODES.lan || mode === MODES.both;
}

function modeUsesHttps(mode) {
  return mode === MODES.https || mode === MODES.both;
}

function parseOriginList(value, { requireHttps = false } = {}) {
  const entries = splitList(value).map((item) => String(item).trim()).filter(Boolean);
  if (entries.length === 0) throw new TypeError('至少输入一个来源');
  const origins = [];
  for (const entry of entries) {
    let parsed;
    try { parsed = new URL(entry); } catch { throw new TypeError(`来源不是有效 URL：${entry}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash || parsed.origin === 'null') {
      throw new TypeError(`来源必须是没有路径、参数或凭据的 http(s) origin：${entry}`);
    }
    if (requireHttps && parsed.protocol !== 'https:') {
      throw new TypeError(`HTTPS 模式只能填写 HTTPS 来源：${entry}`);
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return origins.join(',');
}

function positiveInteger(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(String(value).trim());
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

function validateCandidate(config) {
  const candidate = { ...config };
  candidate.host = assertBridgeHost(candidate.host ?? DEFAULT_HOST);
  candidate.port = positiveInteger(candidate.port ?? DEFAULT_PORT, 'Bridge 端口', { maximum: 65_535 });
  const lanEnabled = candidate.lanProxyHost !== undefined && candidate.lanProxyHost !== null;
  if (lanEnabled) {
    candidate.lanProxyHost = assertLanProxyHost(candidate.lanProxyHost);
    candidate.lanProxyPort = positiveInteger(candidate.lanProxyPort ?? DEFAULT_LAN_PROXY_PORT, 'LAN 端口', { maximum: 65_535 });
    if (candidate.lanProxyPort === candidate.port) throw new TypeError('LAN 端口不能与 Bridge 端口相同');
  }
  if (candidate.lanProxyAllowedCidrs !== undefined) {
    if (!lanEnabled) throw new TypeError('配置 ACL 前必须启用 LAN proxy');
    candidate.lanProxyAllowedCidrs = parseAllowedCidrs(candidate.lanProxyAllowedCidrs, { maxEntries: 128 });
  }
  if (candidate.allowedOrigin !== undefined && candidate.allowedOrigin !== null
    && String(candidate.allowedOrigin).trim() !== '') {
    candidate.allowedOrigin = parseOriginList(candidate.allowedOrigin);
  }
  candidate.rateLimitPerMinute = positiveInteger(candidate.rateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE, '每分钟限流', { maximum: 10_000 });
  candidate.rateLimitBurst = positiveInteger(candidate.rateLimitBurst ?? Math.min(DEFAULT_RATE_LIMIT_BURST, candidate.rateLimitPerMinute), '突发限流', { maximum: candidate.rateLimitPerMinute });
  candidate.rateLimitMaxEntries = positiveInteger(candidate.rateLimitMaxEntries ?? DEFAULT_RATE_LIMIT_MAX_ENTRIES, '限流条目数', { minimum: MIN_RATE_LIMIT_MAX_ENTRIES, maximum: MAX_RATE_LIMIT_ENTRIES });
  candidate.requestBodyTimeoutMs = positiveInteger(candidate.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS, '请求体超时', { maximum: MAX_REQUEST_BODY_TIMEOUT_MS });
  return candidate;
}

/** Merge only fields owned by the wizard while preserving other bridge.json keys. */
export function mergeConfig(existing = {}, answers = {}) {
  const next = { ...existing };
  next.host = existing.host || DEFAULT_HOST;
  next.port = answers.port ?? existing.port ?? DEFAULT_PORT;
  const mode = answers.mode || inferMode(existing);
  if (!Object.values(MODES).includes(mode)) throw new TypeError(`无法识别的访问模式：${mode}`);
  const lanEnabled = modeUsesLan(mode);
  const httpsEnabled = modeUsesHttps(mode);
  if (lanEnabled) {
    next.lanProxyHost = answers.lanProxyHost ?? existing.lanProxyHost;
    next.lanProxyPort = answers.lanProxyPort ?? existing.lanProxyPort ?? DEFAULT_LAN_PROXY_PORT;
    if (next.lanProxyHost === undefined || next.lanProxyHost === null || String(next.lanProxyHost).trim() === '') {
      throw new TypeError('启用 LAN proxy 时必须提供网卡 IP 地址');
    }
  } else {
    delete next.lanProxyHost;
    delete next.lanProxyPort;
    delete next.lanProxyTargetHost;
    delete next.lanProxyAllowedCidrs;
  }
  if (mode === MODES.local) {
    delete next.allowedOrigin;
  } else if (answers.allowedOrigin !== undefined) {
    if (answers.allowedOrigin) next.allowedOrigin = answers.allowedOrigin;
    else delete next.allowedOrigin;
  }
  if (!httpsEnabled) next.cookieSecure = false;
  else next.cookieSecure = true;
  if (answers.advanced) {
    if (lanEnabled) {
      if (answers.lanProxyAllowedCidrs === undefined) delete next.lanProxyAllowedCidrs;
      else next.lanProxyAllowedCidrs = answers.lanProxyAllowedCidrs;
    }
    for (const key of ['rateLimitPerMinute', 'rateLimitBurst', 'rateLimitMaxEntries', 'requestBodyTimeoutMs']) {
      if (answers[key] !== undefined) next[key] = answers[key];
    }
    for (const key of ['allowCustomPushEndpoints', 'allowPushRelay']) {
      if (answers[key] !== undefined) next[key] = answers[key];
    }
    if (answers.pushEndpointAllowlist === undefined) delete next.pushEndpointAllowlist;
    else if (answers.pushEndpointAllowlist) next.pushEndpointAllowlist = answers.pushEndpointAllowlist;
    else delete next.pushEndpointAllowlist;
  }
  return validateCandidate(next);
}

async function readConfig(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根节点必须是 JSON 对象');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`无法读取 ${path}：${error.message}`);
  }
}

export async function writeConfig(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const backupPath = `${path}.bak`;
  const hadExisting = existsSync(path);
  if (hadExisting) {
    await copyFile(path, backupPath);
    try { await chmod(backupPath, 0o600); } catch { /* best effort */ }
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try { await chmod(temporary, 0o600); } catch { /* best effort */ }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { backupPath: hadExisting ? backupPath : undefined };
}

async function rollbackConfig(path, backupPath) {
  if (backupPath && existsSync(backupPath)) {
    await copyFile(backupPath, path);
    return;
  }
  await rm(path, { force: true });
}

function makeAsker(options, output) {
  if (typeof options.ask === 'function') return { ask: options.ask, close() {} };
  const input = options.input || defaultInput;
  if (input.isTTY !== true && options.allowNonTty !== true) {
    throw new Error('配置向导需要交互式终端，请直接在终端运行 npm run configure');
  }
  const rl = createInterface({ input, output });
  return { ask: (prompt) => rl.question(prompt), close: () => rl.close() };
}

async function askText(ask, output, prompt, { defaultValue, required = false, parser = (value) => value.trim(), allowClear = false } = {}) {
  while (true) {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
    const clearHint = allowClear ? '（输入 - 清空）' : '';
    const answer = String(await ask(`${prompt}${clearHint}${suffix}：`));
    const trimmed = answer.trim();
    if (allowClear && trimmed === '-') return undefined;
    if (!trimmed && defaultValue !== undefined) return defaultValue;
    if (!trimmed && !required) return undefined;
    try { return parser(trimmed); } catch (error) {
      outputLine(output, `输入无效：${error.message}`);
    }
  }
}

async function askYesNo(ask, output, prompt, defaultValue = false) {
  while (true) {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = String(await ask(`${prompt} [${hint}]：`)).trim();
    if (!answer) return defaultValue;
    try { return parseBoolean(answer); } catch (error) { outputLine(output, `输入无效：${error.message}`); }
  }
}

async function askChoice(ask, output, prompt, choices, defaultValue) {
  outputLine(output, prompt);
  choices.forEach((choice, index) => outputLine(output, `  ${index + 1}) ${choice.label}${choice.description ? ` — ${choice.description}` : ''}`));
  const defaultIndex = Math.max(1, choices.findIndex((choice) => choice.value === defaultValue) + 1);
  while (true) {
    const answer = String(await ask(`请选择 [${defaultIndex}]：`)).trim();
    const index = answer ? Number(answer) : defaultIndex;
    if (Number.isInteger(index) && choices[index - 1]) return choices[index - 1].value;
    outputLine(output, '请输入列表中的编号。');
  }
}

async function askLanHost(ask, output, existingHost, provider) {
  const interfaces = detectInterfaces(provider);
  if (interfaces.length) {
    outputLine(output, '检测到以下可用网卡地址：');
    interfaces.forEach((item, index) => outputLine(output, `  ${index + 1}) ${item.name} — ${item.address}${item.cidr ? ` (${item.cidr})` : ''}`));
    const currentIndex = interfaces.findIndex((item) => item.address === existingHost);
    const defaultIndex = currentIndex >= 0 ? currentIndex + 1 : 1;
    while (true) {
      const answer = String(await ask(`选择编号，或输入 IP 手填 [${defaultIndex}]：`)).trim();
      if (!answer) return interfaces[defaultIndex - 1].address;
      if (/^m|手填$/i.test(answer)) break;
      if (/^\d+$/.test(answer) && interfaces[Number(answer) - 1]) return interfaces[Number(answer) - 1].address;
      try { return assertLanProxyHost(answer); } catch { outputLine(output, '请输入列表编号或有效的网卡 IP 地址。'); }
    }
  } else {
    outputLine(output, '没有自动检测到可用网卡地址。');
  }
  return askText(ask, output, '输入 LAN 网卡 IP 地址', {
    defaultValue: existingHost || undefined,
    required: true,
    parser: (value) => assertLanProxyHost(value),
  });
}

async function askAdvanced(ask, output, existing, lanEnabled) {
  const answers = { advanced: true };
  if (lanEnabled) {
    const oldAcl = existing.lanProxyAllowedCidrs;
    const aclEnabled = await askYesNo(ask, output, '是否启用 LAN 来源 CIDR 白名单？', oldAcl !== undefined);
    if (aclEnabled) {
      answers.lanProxyAllowedCidrs = await askText(ask, output, '允许的 CIDR（逗号分隔）', {
        defaultValue: oldAcl === undefined ? undefined : splitList(oldAcl).join(','),
        required: true,
        parser: (value) => parseAllowedCidrs(value, { maxEntries: 128 }),
      });
    }
  }
  const rate = await askText(ask, output, '每分钟 API 请求数', {
    defaultValue: String(existing.rateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE),
    parser: (value) => positiveInteger(value, '每分钟限流', { maximum: 10_000 }),
  });
  const burst = await askText(ask, output, '允许的突发请求数', {
    defaultValue: String(existing.rateLimitBurst ?? Math.min(DEFAULT_RATE_LIMIT_BURST, rate)),
    parser: (value) => positiveInteger(value, '突发限流', { maximum: rate }),
  });
  answers.rateLimitPerMinute = rate;
  answers.rateLimitBurst = burst;
  answers.rateLimitMaxEntries = await askText(ask, output, '限流缓存条目数', {
    defaultValue: String(existing.rateLimitMaxEntries ?? DEFAULT_RATE_LIMIT_MAX_ENTRIES),
    parser: (value) => positiveInteger(value, '限流条目数', { minimum: MIN_RATE_LIMIT_MAX_ENTRIES, maximum: MAX_RATE_LIMIT_ENTRIES }),
  });
  answers.requestBodyTimeoutMs = await askText(ask, output, '请求体超时（毫秒）', {
    defaultValue: String(existing.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS),
    parser: (value) => positiveInteger(value, '请求体超时', { maximum: MAX_REQUEST_BODY_TIMEOUT_MS }),
  });
  answers.allowCustomPushEndpoints = await askYesNo(ask, output, '是否允许自定义 Web Push endpoint？', existing.allowCustomPushEndpoints === true || existing.allowCustomEndpoints === true);
  answers.allowPushRelay = await askYesNo(ask, output, '是否允许 Push relay？', existing.allowPushRelay === true || existing.allowRelay === true);
  if (answers.allowCustomPushEndpoints) {
    const oldAllowlist = existing.pushEndpointAllowlist ?? existing.allowedPushEndpointHosts;
    answers.pushEndpointAllowlist = await askText(ask, output, '自定义 endpoint 主机名（逗号分隔，可留空）', {
      defaultValue: oldAllowlist === undefined ? undefined : splitList(oldAllowlist).join(','),
      allowClear: true,
    });
  }
  return answers;
}

function wait(ms, sleeper) {
  if (typeof sleeper === 'function') return Promise.resolve(sleeper(ms));
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForStatus(launcher, paths, predicate, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS));
  const intervalMs = Math.max(1, Number(options.intervalMs ?? options.startupPollIntervalMs ?? STARTUP_POLL_INTERVAL_MS));
  const startedAt = Date.now();
  let status;
  do {
    status = launcher.statusBridge({ configDir: paths.configDir, stateDir: paths.stateDir });
    if (predicate(status)) return status;
    if (Date.now() - startedAt >= timeoutMs) break;
    await wait(Math.min(intervalMs, timeoutMs - (Date.now() - startedAt)), options.sleep);
  } while (Date.now() - startedAt <= timeoutMs);
  return status;
}

async function readStartupError(stateDir) {
  try {
    const value = await readFile(join(stateDir, 'startup-error.log'), 'utf8');
    return value.trim().split('\n').slice(-1)[0] || undefined;
  } catch {
    return undefined;
  }
}

async function runApply(ask, output, options, paths) {
  const launcher = options.launcher || { statusBridge, stopBridge, ensureBridge };
  const status = launcher.statusBridge({ configDir: paths.configDir, stateDir: paths.stateDir });
  if (status.running) {
    const restart = await askYesNo(ask, output, 'Bridge 当前正在运行，是否停止并重启以应用新配置？', false);
    if (!restart) {
      outputLine(output, `配置已保存；现有进程未重启。稍后可执行：node src/launcher.js stop --config-dir "${paths.configDir}" --state-dir "${paths.stateDir}" && node src/launcher.js ensure --config-dir "${paths.configDir}" --state-dir "${paths.stateDir}"`);
      return { applied: false, status };
    }
    launcher.stopBridge({ configDir: paths.configDir, stateDir: paths.stateDir });
    const stopped = await waitForStatus(
      launcher,
      paths,
      (current) => !current.running,
      options,
    );
    if (stopped.running) {
      outputLine(output, `Bridge 未能在 ${options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS}ms 内停止，未启动新配置。`);
      outputLine(output, '请先确认旧进程已退出，再执行 node src/launcher.js ensure。');
      return { applied: false, status: stopped, reason: 'stop_timeout' };
    }
  }
  const result = launcher.ensureBridge({ configDir: paths.configDir, stateDir: paths.stateDir });
  const ready = await waitForStatus(
    launcher,
    paths,
    (current) => current.running && (!current.lan_proxy_host || current.lan_proxy_running),
    options,
  );
  if (!ready.running || (ready.lan_proxy_host && !ready.lan_proxy_running)) {
    const detail = await readStartupError(paths.stateDir);
    outputLine(output, `Bridge 启动失败或未就绪（pid=${result.pid ?? 'unknown'}）。`);
    if (detail) outputLine(output, `启动错误：${detail}`);
    outputLine(output, `配置目录：${paths.configDir}`);
    outputLine(output, `状态目录：${paths.stateDir}`);
    outputLine(output, `请检查：node src/launcher.js status --config-dir "${paths.configDir}" --state-dir "${paths.stateDir}"`);
    return { applied: false, result, status: ready, reason: 'startup_timeout', startupError: detail };
  }
  outputLine(output, `Bridge 已就绪（pid=${ready.pid ?? result.pid ?? 'unknown'}）。`);
  outputLine(output, `状态检查：node src/launcher.js status --config-dir "${paths.configDir}" --state-dir "${paths.stateDir}"`);
  return { applied: true, result, status: ready };
}

export async function runWizard(options = {}) {
  const output = options.output || defaultOutput;
  const target = resolveWizardPaths(options);
  const paths = target.paths;
  const existing = await readConfig(paths.bridgeConfigPath);
  const { ask, close } = makeAsker(options, output);
  try {
    outputLine(output, '\nHerdr Mobile Bridge 配置向导');
    outputLine(output, '直接回车接受方括号中的默认值；输入 - 可清空可选字段。');
    outputLine(output, `配置目标：${target.source === 'herdr' || target.source === 'environment' ? 'Herdr 插件' : '独立运行'}`);
    outputLine(output, `配置目录：${paths.configDir}`);
    outputLine(output, `状态目录：${paths.stateDir}`);
    if (target.source === 'standalone') {
      outputLine(output, '未检测到 Herdr 插件目录，将按独立运行方式保存；接入 Herdr 时请使用 --config-dir 和 --state-dir 覆盖。');
    }
    const mode = await askChoice(ask, output, '选择访问方式：', [
      { value: MODES.local, label: '仅电脑本机', description: '只监听回环地址' },
      { value: MODES.lan, label: '手机 LAN HTTP', description: '启用内置 LAN proxy' },
      { value: MODES.https, label: 'HTTPS 反向代理', description: '由 Caddy 等代理转发到回环 Bridge' },
      { value: MODES.both, label: 'LAN + HTTPS', description: '同时启用 LAN proxy 和 HTTPS 来源' },
    ], inferMode(existing));
    const port = await askText(ask, output, 'Bridge 本机端口', {
      defaultValue: String(existing.port ?? DEFAULT_PORT),
      parser: (value) => positiveInteger(value, 'Bridge 端口', { maximum: 65_535 }),
    });
    let lanProxyHost;
    let lanProxyPort;
    if (modeUsesLan(mode)) {
      lanProxyHost = await askLanHost(ask, output, existing.lanProxyHost, options.networkInterfaces || osNetworkInterfaces);
      lanProxyPort = await askText(ask, output, 'LAN proxy 端口', {
        defaultValue: String(existing.lanProxyPort ?? DEFAULT_LAN_PROXY_PORT),
        parser: (value) => {
          const parsed = positiveInteger(value, 'LAN 端口', { maximum: 65_535 });
          if (parsed === port) throw new TypeError('LAN 端口不能与 Bridge 端口相同');
          return parsed;
        },
      });
    }
    let allowedOrigin;
    if (modeUsesHttps(mode)) {
      allowedOrigin = await askText(ask, output, '允许的浏览器来源（HTTPS 必须包含 https://，多个来源用逗号分隔）', {
        defaultValue: existing.allowedOrigin || undefined,
        required: true,
        parser: (value) => {
          const parsed = parseOriginList(value);
          if (!splitList(parsed).some((origin) => origin.startsWith('https://'))) throw new TypeError('至少需要一个 HTTPS 来源');
          return parsed;
        },
      });
    } else if (mode === MODES.lan) {
      allowedOrigin = await askText(ask, output, '浏览器来源覆盖（可留空，默认按 Host 判断）', {
        defaultValue: existing.allowedOrigin || undefined,
        allowClear: true,
        parser: (value) => parseOriginList(value),
      });
    }
    const advanced = await askYesNo(ask, output, '是否配置 ACL、限流和 Push relay 等高级设置？', false);
    const advancedAnswers = advanced
      ? await askAdvanced(ask, output, existing, modeUsesLan(mode))
      : { advanced: false };
    const candidate = mergeConfig(existing, {
      mode,
      port,
      lanProxyHost,
      lanProxyPort,
      allowedOrigin,
      ...advancedAnswers,
    });
    const { backupPath } = await writeConfig(paths.bridgeConfigPath, candidate);
    let config;
    try {
      config = loadConfigSync({
        configDir: paths.configDir,
        stateDir: paths.stateDir,
        persistGenerated: true,
      });
    } catch (error) {
      await rollbackConfig(paths.bridgeConfigPath, backupPath);
      throw new Error(`配置校验失败，已恢复原文件：${error.message}`);
    }
    outputLine(output, `\n配置已保存到：${paths.bridgeConfigPath}`);
    if (backupPath) outputLine(output, `旧配置备份为：${backupPath}`);
    outputLine(output, `Bridge token：${config.token}`);
    outputLine(output, `本机地址：http://${authorityHost(config.host)}:${config.port}`);
    if (config.lanProxyHost) outputLine(output, `手机 LAN 地址：http://${authorityHost(config.lanProxyHost)}:${config.lanProxyPort}`);
    if (config.allowedOrigin) outputLine(output, `允许来源：${config.allowedOrigin}`);
    const apply = await askYesNo(ask, output, '现在启动或应用这份配置吗？', true);
    const applyResult = apply ? await runApply(ask, output, options, paths) : undefined;
    if (!apply) outputLine(output, `配置已保存。稍后可执行：node src/launcher.js ensure --config-dir "${paths.configDir}" --state-dir "${paths.stateDir}"`);
    return {
      paths,
      existing,
      candidate,
      config,
      applied: applyResult ? applyResult.applied : false,
      applyResult,
    };
  } finally {
    close();
  }
}

function usage() {
  return 'Usage: npm run configure -- [--config-dir DIR] [--state-dir DIR]\n       node scripts/configure.js [--config-dir DIR] [--state-dir DIR]';
}

export async function main(argv = process.argv.slice(2), options = {}) {
  try {
    const cli = parseArgs(argv);
    if (cli.help) {
      outputLine(options.output || defaultOutput, usage());
      return null;
    }
    const result = await runWizard({ ...options, ...cli });
    if (result?.applyResult && result.applied === false) process.exitCode = 1;
    return result;
  } catch (error) {
    const output = options.output || defaultOutput;
    outputLine(options.errorOutput || process.stderr, `配置向导失败：${error.message}`);
    process.exitCode = 1;
    if (options.throwOnError) throw error;
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.on('SIGINT', () => {
    process.stderr.write('\n已取消配置，未写入 bridge.json。\n');
    process.exit(130);
  });
  await main();
}

export { inferMode, parseOriginList, validateCandidate, modeUsesLan, modeUsesHttps };
