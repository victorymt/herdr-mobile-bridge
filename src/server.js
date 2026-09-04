import http from 'node:http';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import QRCode from 'qrcode';

import { AuthManager, constantTimeEqual } from './auth.js';
import { EventBus, EventInputError } from './event-bus.js';
import {
  HerdrApiError,
  HerdrSocketError,
  assertInputText,
  assertPromptText,
  normaliseInputKeys,
  positiveLines,
} from './herdr-client.js';
import { StateStore } from './state-store.js';
import { PushManager } from './push.js';
import {
  assertBridgeHost,
  assertLanProxyHost,
  DEFAULT_HOST,
  DEFAULT_LAN_PROXY_PORT,
  DEFAULT_PORT,
  parsePort,
  configFingerprint,
  DEFAULT_PUSH_TIMEOUT_MS,
  MAX_PUSH_TIMEOUT_MS,
} from './config.js';
import { isLocalAddress, parseAllowedCidrs } from './network-acl.js';
import {
  TokenBucketLimiter,
  canonicalizeAddress,
  hashCredential,
  DEFAULT_RATE_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
  MAX_RATE_LIMIT_ENTRIES,
  MIN_RATE_LIMIT_MAX_ENTRIES,
} from './rate-limit.js';

const MAX_SSE_CLIENTS = 128;
const MAX_SSE_PENDING = 512;
const MAX_SSE_QUEUE = 512;
const MAX_CONTROL_IN_FLIGHT = 32;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_QR_CODES = 8;
const MAX_DISCOVERY_QR_URL_BYTES = 512;
const MAX_DISCOVERY_HOSTS = 8;
export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 10_000;
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

function jsonHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
}

function writeJson(res, status, value, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { ...jsonHeaders(), 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function writeError(res, status, code, message, details) {
  const body = { ok: false, error: { code, message } };
  if (details !== undefined) body.error.details = details;
  writeJson(res, status, body);
}

function bodyReadStatus(error) {
  if (error?.code === 'body_too_large') return 413;
  if (error?.code === 'request_body_timeout') return 408;
  return statusForError(error);
}

function closeRequestAfterResponse(req, res) {
  if (!req || typeof req.destroy !== 'function') return;
  if (req.__bridgeCloseScheduled) return;
  req.__bridgeCloseScheduled = true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (typeof res?.off === 'function') {
        if (finishListener) res.off('finish', finishListener);
        if (closeListener) res.off('close', closeListener);
      }
    } catch { /* best effort */ }
    try { req.destroy(); } catch { /* the peer may already be gone */ }
  };
  let finishListener;
  let closeListener;
  if (res?.writableEnded || res?.writableFinished) {
    // `finish` may already have fired by the time an early auth/routing
    // response reaches the finally block; do not leave an unread body on a
    // keep-alive socket in that case.
    setImmediate(close);
  } else if (typeof res?.once === 'function') {
    finishListener = () => setImmediate(close);
    closeListener = () => setImmediate(close);
    res.once('finish', finishListener);
    res.once('close', closeListener);
  } else {
    setImmediate(close);
  }
}

function requestMayHaveBody(req) {
  const length = req.headers?.['content-length'];
  const transfer = req.headers?.['transfer-encoding'];
  return (length !== undefined && String(length) !== '0') || Boolean(transfer);
}

function closeUnreadRequest(req, res) {
  if (!requestMayHaveBody(req) || req.complete || req.readableEnded) return;
  try { req.resume?.(); } catch { /* best effort */ }
  closeRequestAfterResponse(req, res);
}

function rejectUnexpectedBody(req, res) {
  if (!requestMayHaveBody(req)) return false;
  res.setHeader?.('connection', 'close');
  writeError(res, 400, 'request_body_not_allowed', 'request body is not allowed for this endpoint');
  closeRequestAfterResponse(req, res);
  return true;
}

function writeBodyReadError(req, res, error) {
  const status = bodyReadStatus(error);
  if (error?.requestClose) res.setHeader?.('connection', 'close');
  writeError(res, status, error?.code || 'invalid_json', error?.message || 'invalid request body');
  if (error?.requestClose) closeRequestAfterResponse(req, res);
}

function statusForError(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  if (['invalid_json', 'body_too_large', 'request_body_timeout', 'invalid_subscription', 'invalid_pane_id', 'invalid_workspace_id', 'invalid_lines', 'origin_forbidden', 'csrf_failed'].includes(error?.code)) {
    if (error.code === 'body_too_large') return 413;
    if (error.code === 'request_body_timeout') return 408;
    return 400;
  }
  if (error instanceof EventInputError || error?.code === 'invalid_event') return 400;
  if (error instanceof TypeError || error?.code === 'invalid_subscription') return 400;
  if (error instanceof HerdrApiError) {
    if (['agent_not_found', 'pane_not_found', 'workspace_not_found', 'tab_not_found'].includes(error.code)) return 404;
    if (['empty_agent_prompt', 'invalid_key', 'invalid_params', 'invalid_request', 'method_not_allowed'].includes(error.code)) return 400;
    if (['agent_blocked', 'agent_not_ready', 'agent_target_ambiguous', 'ambiguous_agent'].includes(error.code)) return 409;
    return 502;
  }
  if (error instanceof HerdrSocketError || error?.name === 'HerdrSocketError') return 502;
  if (error?.statusCode && Number.isInteger(error.statusCode)) return error.statusCode >= 500 ? 502 : error.statusCode;
  return 500;
}

function normaliseOrigin(configOrigin, requestOrigin) {
  if (!requestOrigin) return undefined;
  const configured = String(configOrigin || '').trim();
  const allowed = configured.split(',').map((value) => value.trim()).filter(Boolean);
  return allowed.includes(requestOrigin) ? requestOrigin : undefined;
}

function originAllowed(configOrigin, requestOrigin, requestHost) {
  if (!requestOrigin) return true;
  const configured = String(configOrigin || '').trim();
  if (configured === '*') {
    // Historical configs may use `*`; treat it as same-host only rather than
    // reflecting arbitrary origins with credentials.
    try { return new URL(requestOrigin).host === String(requestHost || '').trim(); } catch { return false; }
  }
  const allowed = configured.split(',').map((value) => value.trim()).filter(Boolean);
  if (allowed.length) return allowed.includes(requestOrigin);
  try {
    const origin = new URL(requestOrigin);
    return origin.host === String(requestHost || '').trim();
  } catch {
    return false;
  }
}

function isLoopback(req) {
  let address;
  try {
    address = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress;
  } catch {
    // A malformed/injected request object must fail closed rather than turn a
    // property-access failure into an internal-event authorization bypass.
    return false;
  }
  // Use the same strict IP parser as the LAN ACL.  Besides the usual
  // `127.0.0.1`/`::1`, this recognizes every IPv4 loopback address in
  // 127.0.0.0/8, expanded IPv6 spellings of ::1, and IPv4-mapped loopback
  // addresses (including an expanded mapped representation).  We deliberately
  // do not inspect forwarded headers: this endpoint is a kernel-level
  // loopback boundary, not an application proxy trust boundary.
  return isLocalAddress(address, '127.0.0.1');
}

function requestRemoteAddress(req) {
  return req?.socket?.remoteAddress ?? req?.connection?.remoteAddress;
}

function isPrivateLanAddress(address, family) {
  const raw = String(address || '').trim();
  const detectedFamily = isIP(raw);
  const value = raw.toLowerCase();
  if (family === 'IPv4' || family === 4) {
    if (detectedFamily !== 4) return false;
    const octets = value.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [first, second] = octets;
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127);
  }
  if (detectedFamily !== 6) return false;
  // ULA IPv6 addresses are usable in a browser URL. Link-local addresses
  // require an interface scope (for example `%25wlan0`) that Node's generic
  // networkInterfaces() result does not expose consistently, so omit them
  // instead of presenting a URL that will fail on most phones.
  return value.startsWith('fc') || value.startsWith('fd');
}

function collectLanAddresses(config = {}, interfaces = networkInterfaces()) {
  const values = [];
  const configured = String(config.lanProxyHost || '').trim();
  if (configured && configured !== '0.0.0.0' && configured !== '::') {
    const normalized = canonicalizeAddress(configured);
    if (normalized !== 'unknown' && normalized !== '0.0.0.0' && normalized !== '::') values.push(normalized);
  }
  for (const entries of Object.values(interfaces || {})) {
    for (const item of entries || []) {
      if (!item || item.internal || !isPrivateLanAddress(item.address, item.family)) continue;
      const normalized = canonicalizeAddress(String(item.address));
      if (normalized !== 'unknown') values.push(normalized);
    }
  }
  const unique = [...new Set(values)];
  // Prefer IPv4 addresses because they do not require browser-specific IPv6
  // scope syntax, then keep a small bounded set for a readable connection
  // wizard when the host has many virtual interfaces.
  return unique.sort((left, right) => {
    const leftV6 = left.includes(':') ? 1 : 0;
    const rightV6 = right.includes(':') ? 1 : 0;
    return leftV6 - rightV6;
  }).slice(0, MAX_DISCOVERY_HOSTS);
}

function authorityHost(host) {
  const value = String(host || '').trim();
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function lanUrl(host, port, protocol = 'http') {
  return `${protocol}://${authorityHost(host)}:${Number(port)}`;
}

function cleanText(value, max = 200) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function cleanLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    const name = cleanText(key, 64);
    const label = cleanText(item, 160);
    if (name && label) result[name] = label;
  }
  return Object.keys(result).length ? result : undefined;
}

function pick(value, keys) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const key of keys) {
    const item = value[key];
    if (item === undefined || item === null) continue;
    if (typeof item === 'string') {
      const text = cleanText(item, 240);
      if (text !== undefined) result[key] = text;
    } else if (typeof item === 'boolean') {
      result[key] = item;
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      result[key] = item;
    } else if (key === 'state_labels' || key === 'tokens') {
      const labels = cleanLabels(item);
      if (labels) result[key] = labels;
    }
  }
  return result;
}

function sanitiseSnapshot(snapshot, persistedStatuses = {}) {
  if (!snapshot || typeof snapshot !== 'object') return { version: undefined, protocol: undefined, workspaces: [], tabs: [], panes: [], agents: [] };
  const workspaceKeys = [
    'workspace_id', 'label', 'focused', 'index', 'worktree', 'tokens',
    // These additive summary fields are present in newer Herdr snapshots and
    // let the mobile client render workspace controls without another API.
    'pane_count', 'tab_count', 'active_tab_id', 'agent_status',
  ];
  const tabKeys = ['tab_id', 'workspace_id', 'label', 'focused', 'index'];
  const paneKeys = ['pane_id', 'workspace_id', 'tab_id', 'label', 'focused', 'agent', 'display_agent', 'agent_status', 'final_status', 'state_labels', 'title', 'terminal_title_stripped', 'revision'];
  const agentKeys = ['agent_id', 'pane_id', 'workspace_id', 'agent', 'display_agent', 'status', 'agent_status', 'final_status', 'title', 'state_labels'];
  const panes = Array.isArray(snapshot.panes) ? snapshot.panes.map((pane) => {
    const clean = pick(pane, paneKeys);
    const persisted = persistedStatuses?.[clean.pane_id];
    if (persisted && clean.agent_status === undefined) {
      clean.agent_status = persisted.agent_status || persisted.final_status;
    }
    if (persisted && clean.agent === undefined && persisted.agent) clean.agent = persisted.agent;
    return clean;
  }) : [];
  return {
    version: cleanText(snapshot.version, 40),
    protocol: Number.isInteger(snapshot.protocol) ? snapshot.protocol : undefined,
    focused_workspace_id: cleanText(snapshot.focused_workspace_id, 256),
    focused_tab_id: cleanText(snapshot.focused_tab_id, 256),
    focused_pane_id: cleanText(snapshot.focused_pane_id, 256),
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.slice(0, 256).map((value) => pick(value, workspaceKeys)) : [],
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.slice(0, 512).map((value) => pick(value, tabKeys)) : [],
    panes: panes.slice(0, 512),
    agents: Array.isArray(snapshot.agents) ? snapshot.agents.slice(0, 512).map((value) => pick(value, agentKeys)) : [],
  };
}

function sanitiseEvent(event) {
  const context = event?.context || {};
  const clean = pick(context, ['pane_id', 'workspace_id', 'tab_id', 'agent', 'display_agent', 'title', 'agent_status', 'final_status', 'released', 'revision', 'generation', 'latest_seq']);
  const labels = cleanLabels(context.state_labels);
  if (labels) clean.state_labels = labels;
  return {
    id: cleanText(String(event?.id || event?.seq || ''), 128),
    seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : undefined,
    event: cleanText(event?.event, 80),
    context: clean,
    received_at: cleanText(event?.received_at, 64),
  };
}

function mergeSnapshotResponse(snapshot, statuses) {
  const body = { ok: true, snapshot };
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) Object.assign(body, snapshot);
  if (statuses && Object.keys(statuses).length) body.pane_statuses = statuses;
  return body;
}

function bodyReadError(code, message) {
  const error = new Error(message);
  error.code = code;
  if (code === 'body_too_large') error.status = 413;
  if (code === 'request_body_timeout') error.status = 408;
  error.requestClose = true;
  return error;
}

/**
 * Read and parse one JSON object with both a size bound and an absolute wall
 * clock deadline.  The collector is deliberately kept alive until the
 * response has been written; callers mark the response's connection for
 * closure so a slow peer cannot poison a subsequent keep-alive request.
 */
async function readBody(req, maxBytes, timeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : 1024 * 1024;
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_REQUEST_BODY_TIMEOUT_MS;
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw bodyReadError('body_too_large', `request body exceeds ${limit} bytes`);
  }
  const collect = (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
      // IncomingMessage normally yields Buffers, but a few embedders and
      // tests provide a generic async iterable that yields strings or typed
      // arrays. Normalize at the boundary so size accounting and concatenation
      // remain deterministic instead of surfacing an unrelated 500.
      let buffer;
      try {
        buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      } catch {
        throw bodyReadError('invalid_json', 'invalid request body chunk');
      }
      size += buffer.length;
      if (size > limit) {
        throw bodyReadError('body_too_large', `request body exceeds ${limit} bytes`);
      }
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object');
      return parsed;
    } catch (error) {
      const wrapped = new Error(`invalid JSON body: ${error.message}`);
      wrapped.code = 'invalid_json';
      throw wrapped;
    }
  })();
  const COMPLETE_SENTINEL = Symbol('body-complete');
  let timer;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      // If the readable side has actually ended, prefer the body collector's
      // completion even when the timer callback was queued in the same turn.
      // `IncomingMessage.complete` only means the HTTP parser saw the final
      // bytes; a custom/slow async iterator can still remain open, so using it
      // here would let a supposedly absolute deadline wait forever.
      if (req.readableEnded) {
        resolve(COMPLETE_SENTINEL);
        return;
      }
      reject(bodyReadError('request_body_timeout', `request body did not complete within ${timeout} ms`));
    }, timeout);
  });
  try {
    const result = await Promise.race([collect, timeoutPromise]);
    // A completed request wins over the sentinel timeout promise.
    if (result === COMPLETE_SENTINEL) return await collect;
    return result;
  } catch (error) {
    // Once the timer wins, the async iterator may reject later when the
    // response closes the socket. Attach a handler now to avoid an unhandled
    // ERR_STREAM_PREMATURE_CLOSE while retaining the useful client error.
    collect.catch(() => {});
    try { req.resume?.(); } catch { /* best effort */ }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function idFromBody(body, names) {
  for (const name of names) {
    const value = body?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function decodeSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    // Pane/workspace identifiers may legitimately contain an encoded slash
    // (for example `workspace/pane`). The route matcher still sees it as one
    // raw URL segment; after decoding, reject only control characters,
    // backslashes, and traversal components before handing it to Herdr.
    if (!decoded || decoded.length > 256 || decoded.includes('\0') || /[\r\n\\]/.test(decoded)) return undefined;
    if (decoded.split('/').some((part) => part === '..')) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function sseFrame(event) {
  // Use only the monotonic sequence for Last-Event-ID replay. Random UUIDs
  // remain in the JSON envelope for correlation, but are not valid cursors
  // for EventBus.getSince(). Events such as `ready` intentionally omit an
  // id so they cannot move a reconnect cursor backwards.
  let sequence;
  try {
    const numeric = Number(event?.seq);
    if (Number.isSafeInteger(numeric) && numeric >= 0) sequence = numeric;
  } catch {
    // A malformed internal event should still produce a valid SSE frame; it
    // simply does not participate in replay.
  }
  const type = event.event || 'message';
  const payload = JSON.stringify(event);
  const id = sequence === undefined ? '' : `id: ${sequence}\n`;
  return `${id}event: ${type}\ndata: ${payload}\n\n`;
}

export class BridgeServer {
  constructor(options = {}) {
    const injectedConfig = options.config;
    // BridgeServer is exported for embedders that may construct it directly,
    // bypassing createBridgeServer(). Keep the same boundary contract at this
    // lower-level entry point: only an object (or an explicit null/undefined
    // omission) can be used as configuration. Object-spreading primitives
    // would otherwise silently turn false, strings, or arrays into an empty
    // default configuration and make the listener policy depend on the entry
    // point used by the caller.
    if (injectedConfig !== undefined && injectedConfig !== null
      && (typeof injectedConfig !== 'object' || Array.isArray(injectedConfig))) {
      throw new TypeError('options.config must be an object or null');
    }
    // Match the config loader's explicit-value semantics for listener
    // settings.  `parsePort()` intentionally treats a blank value as a
    // generic fallback, but a caller that supplied an own property here has
    // made an explicit configuration choice; silently replacing it with a
    // default would make direct construction diverge from loadConfig().
    const explicitBlank = (key) => injectedConfig !== undefined
      && injectedConfig !== null
      && Object.prototype.hasOwnProperty.call(injectedConfig, key)
      && typeof injectedConfig[key] === 'string'
      && injectedConfig[key].trim() === '';
    if (explicitBlank('host')) throw new TypeError('bridge host must be a loopback address');
    if (explicitBlank('port')) throw new TypeError('bridge port must not be empty');
    if (explicitBlank('lanProxyHost')) throw new TypeError('LAN proxy host must be an explicit interface address');
    if (explicitBlank('lanProxyPort')) throw new TypeError('LAN proxy port must not be empty');
    this.config = { ...(injectedConfig || {}) };
    if (this.config.socketPath !== undefined && this.config.socketPath !== null) {
      if (typeof this.config.socketPath !== 'string' || this.config.socketPath.trim() === '') {
        throw new TypeError('socket path must not be empty');
      }
      if (this.config.socketPath.includes('\0')) throw new TypeError('Herdr socket path must be an absolute path');
      // loadConfig() expands `~` and resolves relative socket paths before
      // constructing the client. Direct BridgeServer embedders should get the
      // same deterministic path instead of handing a relative value to an
      // injected client (or failing only when the child tries to connect).
      const configuredHome = options.env && typeof options.env === 'object'
        ? (options.env.HOME || options.env.USERPROFILE)
        : undefined;
      const home = typeof configuredHome === 'string' && configuredHome.trim()
        ? configuredHome.trim()
        : (typeof process.env.HOME === 'string' && process.env.HOME.trim() ? process.env.HOME.trim() : homedir());
      const socketValue = this.config.socketPath;
      const expandedSocket = socketValue === '~'
        ? home
        : (socketValue.startsWith('~/') ? join(home, socketValue.slice(2)) : socketValue);
      this.config.socketPath = resolve(expandedSocket);
      // `resolve()` always returns an absolute path on supported platforms;
      // keep an explicit guard for unusual path implementations and future
      // portability changes.
      if (!isAbsolute(this.config.socketPath)) throw new TypeError('Herdr socket path must be an absolute path');
    }
    // Callers embedding BridgeServer may inject a config object directly and
    // therefore bypass loadConfig(). Re-validate listener boundaries here so
    // an accidental wildcard host can never expose the authenticated Bridge.
    // Null/undefined mean omitted; every other supplied value (including
    // false/0/empty strings) must pass the strict host validator rather than
    // being hidden by a truthiness fallback.
    this.config.host = assertBridgeHost(this.config.host ?? DEFAULT_HOST);
    this.config.port = parsePort(this.config.port, DEFAULT_PORT);
    if (this.config.lanProxyTargetHost !== undefined && this.config.lanProxyTargetHost !== null && this.config.lanProxyTargetHost !== '') {
      this.config.lanProxyTargetHost = assertBridgeHost(this.config.lanProxyTargetHost);
    } else if (this.config.lanProxyTargetHost === '' || this.config.lanProxyTargetHost === null) {
      this.config.lanProxyTargetHost = undefined;
    }
    const positiveInteger = (value, fallback, maximum = Number.MAX_SAFE_INTEGER, label = 'value', minimum = 1) => {
      if (value === undefined) return fallback;
      const number = Number(value);
      if (!Number.isInteger(number) || number < minimum || number > maximum) {
        if (minimum > 1) {
          throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
        }
        if (!Number.isInteger(number) || number <= 0) {
          throw new TypeError(`${label} must be a positive integer`);
        }
        throw new TypeError(`${label} must be between 1 and ${maximum}`);
      }
      return number;
    };
    const configBoolean = (value, fallback = false) => {
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return fallback;
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
    };
    this.config.requestBodyTimeoutMs = positiveInteger(this.config.requestBodyTimeoutMs, DEFAULT_REQUEST_BODY_TIMEOUT_MS, 60_000, 'requestBodyTimeoutMs');
    this.config.rateLimitPerMinute = positiveInteger(this.config.rateLimitPerMinute, DEFAULT_RATE_PER_MINUTE, 10_000, 'rateLimitPerMinute');
    this.config.rateLimitBurst = positiveInteger(this.config.rateLimitBurst, Math.min(DEFAULT_RATE_LIMIT_BURST, this.config.rateLimitPerMinute), this.config.rateLimitPerMinute, 'rateLimitBurst');
    this.config.rateLimitMaxEntries = positiveInteger(this.config.rateLimitMaxEntries, DEFAULT_RATE_LIMIT_MAX_ENTRIES, MAX_RATE_LIMIT_ENTRIES, 'rateLimitMaxEntries', MIN_RATE_LIMIT_MAX_ENTRIES);
    this.config.allowedOrigin = this.config.allowedOrigin == null ? '' : this.config.allowedOrigin;
    this.config.cookieSecure = configBoolean(this.config.cookieSecure);
    this.config.healthDetails = configBoolean(this.config.healthDetails);
    this.config.allowSseQueryToken = configBoolean(this.config.allowSseQueryToken);
    this.config.allowCustomPushEndpoints = configBoolean(this.config.allowCustomPushEndpoints ?? this.config.allowCustomEndpoints);
    this.config.allowPushRelay = configBoolean(this.config.allowPushRelay ?? this.config.allowRelay);
    const pushTimeout = Number(this.config.pushTimeoutMs);
    this.config.pushTimeoutMs = Number.isFinite(pushTimeout) && pushTimeout > 0
      ? Math.min(MAX_PUSH_TIMEOUT_MS, Math.max(1, Math.floor(pushTimeout)))
      : DEFAULT_PUSH_TIMEOUT_MS;
    if (this.config.lanProxyAllowedCidrs !== undefined) {
      this.config.lanProxyAllowedCidrs = parseAllowedCidrs(this.config.lanProxyAllowedCidrs, { maxEntries: 128 });
      if (!this.config.lanProxyHost) throw new TypeError('lanProxyAllowedCidrs requires lanProxyHost');
    }
    if (this.config.lanProxyHost !== undefined && this.config.lanProxyHost !== null) {
      this.config.lanProxyHost = assertLanProxyHost(this.config.lanProxyHost);
      this.config.lanProxyPort = parsePort(this.config.lanProxyPort, DEFAULT_LAN_PROXY_PORT);
      if (this.config.lanProxyPort < 1 || this.config.lanProxyPort === this.config.port) {
        throw new Error('LAN proxy port must be between 1 and 65535 and differ from bridge port');
      }
    }
    // Compute the marker from the effective, normalized values. In particular,
    // a directly embedded server may provide a whitespace-padded LAN host or
    // an unnormalized CIDR even though loadConfig() normally canonicalizes it.
    // Doing this after validation avoids spurious launcher restarts and keeps
    // the fingerprint meaningful for both construction paths.
    this.config.configFingerprint = configFingerprint(this.config);
    this.publicDir = resolve(options.publicDir || this.config.publicDir || PUBLIC_DIR);
    this.logger = options.logger || console;
    this.herdrClient = options.herdrClient;
    this.networkInterfaces = options.networkInterfaces || networkInterfaces;
    // `loadConfig()` exposes canonical push-policy names. Keep historical
    // aliases usable for embedders constructing BridgeServer directly, while
    // giving an explicitly supplied canonical value precedence.
    const pushEndpointAllowlist = this.config.pushEndpointAllowlist
      ?? this.config.allowedPushEndpointHosts;
    const allowCustomEndpoints = this.config.allowCustomPushEndpoints !== undefined
      ? this.config.allowCustomPushEndpoints === true
      : this.config.allowCustomEndpoints === true;
    const allowPushRelay = this.config.allowPushRelay !== undefined
      ? this.config.allowPushRelay === true
      : this.config.allowRelay === true;
    this.store = options.store || new StateStore({
      stateDir: this.config.stateDir,
      subscriptionsPath: this.config.subscriptionsPath,
      dedupPath: this.config.dedupPath,
      runtimePath: this.config.runtimePath,
      // Keep subscription validation consistent with the resolved bridge
      // configuration.  The store validates both newly registered and
      // persisted subscriptions, so policy must be passed at construction
      // time rather than applied only by the HTTP handler.
      pushEndpointAllowlist,
      allowCustomEndpoints,
    });
    this.auth = options.auth || new AuthManager({
      token: this.config.token,
      ttlMs: this.config.sessionTtlMs,
      cookieSecure: this.config.cookieSecure,
    });
    this.push = options.pushManager || new PushManager({
      store: this.store,
      vapid: { ...(this.config.vapid || {}), subject: this.config.vapid?.subject || this.config.vapidSubject || 'mailto:herdr-mobile-bridge@localhost' },
      logger: this.logger,
      sender: options.pushSender,
      webPush: options.webPush,
      fetch: options.fetch,
      pushEndpointAllowlist,
      allowCustomEndpoints,
      allowRelay: allowPushRelay,
      timeoutMs: this.config.pushTimeoutMs,
    });
    this.eventBus = options.eventBus || new EventBus({
      store: this.store,
      pushManager: this.push,
      socketPath: this.config.socketPath,
      onSocketPath: (path) => this.updateSocketPath(path),
      logger: this.logger,
    });
    this.server = null;
    this.sseClients = new Set();
    this.started = false;
    this.startedAt = null;
    this.runtimeWritten = false;
    this.stateCache = null;
    this.stateCacheAt = 0;
    this.rateLimiter = options.rateLimiter === false
      ? null
      : (options.rateLimiter || new TokenBucketLimiter({
        ratePerMinute: this.config.rateLimitPerMinute,
        burst: this.config.rateLimitBurst,
        maxEntries: this.config.rateLimitMaxEntries,
        now: options.now,
      }));
    this.controlInFlight = new Map();
    this.unsubscribeStateInvalidation = this.eventBus.subscribe(() => {
      this.stateCache = null;
      this.stateCacheAt = 0;
    });
  }

  updateSocketPath(path) {
    if (typeof path !== 'string' || !path || path.includes('\0') || !path.startsWith('/')) return false;
    this.config.socketPath = path;
    if (this.herdrClient?.setSocketPath) {
      try {
        this.herdrClient.setSocketPath(path);
      } catch {
        return false;
      }
    }
    if (this.store?.initialized) {
      void this.store.getRuntime().then((runtime) => this.store.setRuntime({ ...runtime, socket_path: path })).catch(() => {});
    }
    return true;
  }

  invalidateStateCache() {
    this.stateCache = null;
    this.stateCacheAt = 0;
  }

  connectionInfo(req) {
    const address = this.address();
    const lanHost = this.config.lanProxyHost || null;
    const lanPort = Number(this.config.lanProxyPort || DEFAULT_LAN_PROXY_PORT);
    let interfaces = {};
    try { interfaces = this.networkInterfaces?.() || {}; } catch { interfaces = {}; }
    const hosts = collectLanAddresses(this.config, interfaces);
    const urls = hosts.map((host) => lanUrl(host, lanPort));
    const configuredUrl = lanHost ? lanUrl(lanHost, lanPort) : null;
    if (configuredUrl && !urls.includes(configuredUrl)) urls.unshift(configuredUrl);
    const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const secure = Boolean(req?.socket?.encrypted) || (forwardedProto === 'https' && this.requestOriginAllowed(req));
    return {
      ok: true,
      service: 'herdr-mobile-bridge',
      bridge: {
        host: address.host,
        port: address.port,
        loopback: isLocalAddress(address.host, '127.0.0.1'),
      },
      lan_proxy: {
        enabled: Boolean(lanHost),
        host: lanHost,
        port: lanHost ? lanPort : null,
        // LanProxy keeps a server reference while it is probing and clears
        // its health flag as soon as the listener errors. Report the actual
        // ready state to the connection guide instead of advertising a dead
        // or still-starting port as usable.
        running: Boolean(this.lanProxy?.server && this.lanProxy?.healthy === true),
        urls,
      },
      request: { secure },
      hints: {
        manual_forward: `socat TCP-LISTEN:${lanPort},bind=<LAN_IP>,reuseaddr,fork TCP:${authorityHost(address.host)}:${address.port}`,
        vpn_bypass: '如果手机 VPN 阻断私网访问，请开启“允许局域网 / Allow LAN traffic / Bypass private networks”。',
      },
    };
  }

  /**
   * Return the public connection hints and, when explicitly requested, local
   * QR SVGs. QR generation is opt-in because the discovery endpoint is also
   * used by health checks and should stay small by default. The encoded value
   * is always one of the server-generated LAN URLs; no credentials or
   * arbitrary request data can enter the image.
   */
  async connectionInfoWithQr(req) {
    const info = this.connectionInfo(req);
    const urls = Array.isArray(info.lan_proxy?.urls) ? info.lan_proxy.urls : [];
    const qr = {};
    for (const value of urls.slice(0, MAX_DISCOVERY_QR_CODES)) {
      if (Buffer.byteLength(value, 'utf8') > MAX_DISCOVERY_QR_URL_BYTES) continue;
      try {
        const svg = await QRCode.toString(value, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 240,
        });
        // Keep the transport JSON-friendly and let the browser place the
        // trusted SVG into an image/document without making another request.
        qr[value] = svg;
      } catch (error) {
        this.logger.warn?.('failed to generate LAN discovery QR', error);
      }
    }
    return { ...info, qr };
  }

  /**
   * Serialize mutations targeting the same pane. Mobile browsers can emit a
   * duplicate submit while a request is still waiting on the Herdr socket;
   * rejecting that overlap prevents accidental double prompts/keystrokes.
   */
  async withControlGuard(paneId, operation) {
    const key = String(paneId || '').trim();
    if (!key) return operation();
    const existing = this.controlInFlight.get(key);
    if (existing) {
      const error = new Error('a control request for this pane is already in progress');
      error.code = 'control_in_flight';
      error.status = 429;
      error.retryAfter = 1;
      throw error;
    }
    if (this.controlInFlight.size >= MAX_CONTROL_IN_FLIGHT) {
      const error = new Error('too many control requests in progress');
      error.code = 'control_capacity';
      error.status = 429;
      error.retryAfter = 2;
      throw error;
    }
    const task = Promise.resolve().then(operation);
    this.controlInFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.controlInFlight.get(key) === task) this.controlInFlight.delete(key);
    }
  }

  async start() {
    if (this.started && this.server) return this.address();
    await this.store.init();
    if (!this.herdrClient) throw new Error('herdrClient is required');
    const host = this.config.host || '127.0.0.1';
    const port = Number(this.config.port ?? 8787);
    const listener = http.createServer((req, res) => {
      // A body-bearing request may be rejected before its payload is read
      // (authentication, origin, method, or rate-limit checks). Marking these
      // responses as non-persistent up front prevents an unread payload from
      // being interpreted as the next request on a keep-alive connection.
      // readBody callers consequently close their normal POST/DELETE response
      // as well; the predictable one-request boundary is preferable to
      // risking request smuggling when a client disconnects mid-body.
      if (requestMayHaveBody(req)) res.setHeader('connection', 'close');
      this.handle(req, res)
        .catch((error) => this.handleError(res, error, req))
        .finally(() => closeUnreadRequest(req, res));
    });
    // Bound requests that never reach one of the explicit readBody callers.
    // Keep the generic socket idle timeout untouched: SSE connections are
    // intentionally long-lived and are protected by their own cleanup path.
    listener.requestTimeout = this.config.requestBodyTimeoutMs;
    this.server = listener;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          listener.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          listener.off('error', onError);
          resolve();
        };
        listener.once('error', onError);
        listener.once('listening', onListening);
        listener.listen(port, host);
      });
    } catch (error) {
      // A failed listen leaves a created http.Server object behind. Close it
      // before surfacing the error so a caller can retry without leaking a
      // handle or retaining a stale runtime marker.
      this.server = null;
      try { await new Promise((resolve) => listener.close(() => resolve())); } catch { /* best effort */ }
      this.started = false;
      this.startedAt = null;
      this.runtimeWritten = false;
      throw error;
    }
    this.started = true;
    this.startedAt = new Date();
    const address = this.address();
    try {
      await this.store.setRuntime({
        pid: process.pid,
        host,
        port: address.port,
        socket_path: this.config.socketPath,
        started_at: this.startedAt.toISOString(),
        config_fingerprint: this.config.configFingerprint,
        acl_enabled: Array.isArray(this.config.lanProxyAllowedCidrs),
        lan_proxy_allowed_cidrs: this.config.lanProxyAllowedCidrs || [],
        rate_limit_per_minute: this.config.rateLimitPerMinute,
        rate_limit_burst: this.config.rateLimitBurst,
        rate_limit_max_entries: this.config.rateLimitMaxEntries,
        request_body_timeout_ms: this.config.requestBodyTimeoutMs,
      });
      this.runtimeWritten = true;
    } catch (error) {
      this.logger.warn?.('failed to persist bridge runtime metadata', error);
    }
    return address;
  }

  listen() {
    return this.start();
  }

  address() {
    const value = this.server?.address?.();
    if (value && typeof value === 'object') return { host: value.address, port: value.port };
    return { host: this.config.host || '127.0.0.1', port: Number(this.config.port ?? 8787) };
  }

  async close() {
    this.unsubscribeStateInvalidation?.();
    for (const client of [...this.sseClients]) {
      try {
        client.cleanup();
      } catch {
        // Ignore disconnected clients.
      }
    }
    this.sseClients.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      // `server.close()` waits for handlers that are still reading a body.
      // Force active connections down first so shutdown is bounded even when
      // a peer deliberately sends only half a request (or holds an SSE socket
      // open while the bridge is being stopped).
      try { server.closeAllConnections?.(); } catch { /* best effort */ }
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (this.runtimeWritten) {
      try {
        const runtime = await this.store.getRuntime();
        if (runtime.pid === process.pid) await this.store.clearRuntime();
      } catch {
        // Runtime cleanup is best effort.
      }
    }
    this.started = false;
  }

  setCors(req, res) {
    const requestOrigin = req.headers?.origin;
    if (originAllowed(this.config.allowedOrigin, requestOrigin, req.headers?.host)) {
      // CORS is only needed for an explicitly configured cross-origin proxy.
      // For the normal same-origin PWA request, omitting ACAO avoids creating
      // a credentialed wildcard surface.
      if (requestOrigin && String(this.config.allowedOrigin || '').trim()) {
        res.setHeader('access-control-allow-origin', requestOrigin);
        res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('vary', 'Origin');
      }
    }
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'Authorization,Content-Type,X-CSRF-Token,X-Herdr-Bridge-Secret,X-Bridge-Token,Last-Event-ID');
    res.setHeader('access-control-expose-headers', 'Content-Type,Content-Length,Retry-After');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
  }

  requestOriginAllowed(req) {
    return originAllowed(this.config.allowedOrigin, req.headers?.origin, req.headers?.host);
  }

  requireMutationSecurity(req, url, authResult) {
    if (!this.requestOriginAllowed(req)) {
      const error = new Error('request Origin is not allowed');
      error.code = 'origin_forbidden';
      error.status = 403;
      throw error;
    }
    // Cookie-authenticated browser requests must prove possession of the
    // readable CSRF cookie. Bearer/bridge-token callers are non-browser local
    // clients and do not have a cookie ambient authority to protect.
    if (authResult?.kind !== 'session') return;
    const supplied = String(req.headers?.['x-csrf-token'] || '');
    const cookies = this.auth.extractSession ? req.headers?.cookie : undefined;
    const cookieHeader = String(cookies || '');
    const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${this.auth.csrfCookieName || 'XSRF-TOKEN'}=`));
    let cookieToken = '';
    if (match) {
      try { cookieToken = decodeURIComponent(match.slice(match.indexOf('=') + 1)); } catch { cookieToken = ''; }
    }
    const expected = authResult.csrf || cookieToken;
    if (!expected || !constantTimeEqual(supplied, expected) || (cookieToken && !constantTimeEqual(cookieToken, expected))) {
      const error = new Error('CSRF token is missing or invalid');
      error.code = 'csrf_failed';
      error.status = 403;
      throw error;
    }
  }

  async serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    // Static resources are intentionally bodyless. Reject a supplied payload
    // instead of parsing it as a future keep-alive request; this also keeps the
    // public surface consistent with the bodyless discovery/health routes.
    if (rejectUnexpectedBody(req, res)) return true;
    let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    try { relative = decodeURIComponent(relative); } catch { return false; }
    if (!relative || relative.includes('\0') || relative.split('/').includes('..') || relative.includes('\\')) return false;
    const file = resolve(this.publicDir, relative);
    if (!(file === this.publicDir || file.startsWith(`${this.publicDir}${sep}`))) return false;
    let body;
    try {
      const fileStat = await stat(file);
      if (!fileStat.isFile() || fileStat.size > MAX_STATIC_BYTES) return false;
      body = await readFile(file);
    } catch { return false; }
    const type = MIME_TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    if (req.method === 'GET') res.end(body); else res.end();
    return true;
  }

  async handle(req, res) {
    this.setCors(req, res);
    if (req.method === 'OPTIONS') {
      if (rejectUnexpectedBody(req, res)) return;
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

    if (req.method === 'GET' && pathname === '/healthz') {
      if (rejectUnexpectedBody(req, res)) return;
      const health = { ok: true, service: 'herdr-mobile-bridge' };
      if (this.config.healthDetails === true) {
        const runtime = this.store.initialized ? await this.store.getRuntime().catch(() => ({})) : {};
        Object.assign(health, { version: this.config.version || '0.1.0', uptime_seconds: Math.floor(process.uptime()), pid: process.pid, host: this.address().host, port: this.address().port, socket_present: Boolean(this.config.socketPath && existsSync(this.config.socketPath)), started_at: runtime.started_at || this.startedAt?.toISOString() || null });
      }
      writeJson(res, 200, health);
      return;
    }

    // Discovery is intentionally unauthenticated so the login screen can
    // explain how to reach this machine. It exposes only local addresses and
    // ports—never tokens, socket paths, PIDs, or terminal data.
    if (req.method === 'GET' && pathname === '/api/discovery') {
      if (rejectUnexpectedBody(req, res)) return;
      const includeQr = url.searchParams.get('qr') === '1' || url.searchParams.get('include_qr') === '1';
      writeJson(res, 200, includeQr ? await this.connectionInfoWithQr(req) : this.connectionInfo(req));
      return;
    }

    if (pathname === '/internal/event') {
      await this.handleInternalEvent(req, res);
      return;
    }

    // The login page and PWA assets are intentionally public. API routes below
    // remain authenticated; unknown paths do not fall through to the index so
    // a typo cannot mask an API error.
    if (!pathname.startsWith('/api/')) {
      if (await this.serveStatic(req, res, pathname)) return;
      writeError(res, 404, 'not_found', 'route not found');
      return;
    }

    if (pathname === '/api/auth/login' || pathname === '/api/login') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
      await this.handleLogin(req, res);
      return;
    }

    // EventSource cannot set arbitrary headers, but accepting a long-lived
    // owner/session token in the URL leaks it to browser history, proxy logs,
    // and referrers. Query credentials are therefore opt-in for a narrowly
    // controlled short-lived deployment; normal LAN use relies on cookies.
    const authResult = this.auth.authenticate(req, url, {
      allowQuery: pathname === '/api/stream' && this.config.allowSseQueryToken === true,
    });
    if (!authResult.ok) {
      if (!this.consumeRate(req, res, null)) return;
      writeError(res, 401, 'unauthorized', 'authentication required');
      return;
    }
    if (!this.consumeRate(req, res, authResult)) return;

    if (req.method === 'POST' || req.method === 'DELETE') {
      this.requireMutationSecurity(req, url, authResult);
    }

    if (pathname === '/api/auth/logout') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
      if (rejectUnexpectedBody(req, res)) return;
      this.auth.logout(req);
      writeJson(res, 200, { ok: true, logged_out: true }, { 'set-cookie': [this.auth.clearCookie(), this.auth.clearCsrfCookie?.() || ''] });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      if (rejectUnexpectedBody(req, res)) return;
      writeJson(res, 200, await this.readState());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/stream') {
      await this.handleStream(req, res, url);
      return;
    }
    const outputMatch = /^\/api\/panes\/([^/]+)\/output$/.exec(pathname);
    if (outputMatch) {
      if (req.method !== 'GET') return this.methodNotAllowed(res, ['GET']);
      await this.handleOutput(req, res, url, outputMatch[1]);
      return;
    }
    if (pathname === '/api/focus/pane') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
      await this.handleFocusPane(req, res);
      return;
    }
    if (pathname === '/api/focus/workspace') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
      await this.handleFocusWorkspace(req, res);
      return;
    }
    if (pathname === '/api/control/prompt') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
      await this.handleAgentPrompt(req, res);
      return;
    }
    if (pathname === '/api/control/input') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
      await this.handlePaneInput(req, res);
      return;
    }
    if (pathname === '/api/push/key') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, ['GET']);
      if (rejectUnexpectedBody(req, res)) return;
      const key = this.push.publicKey;
      writeJson(res, 200, { ok: true, publicKey: key, vapidPublicKey: key, vapid_public_key: key });
      return;
    }
    if (pathname === '/api/push/subscriptions') {
      if (req.method === 'POST') return this.handleSubscriptionAdd(req, res);
      if (req.method === 'DELETE') return this.handleSubscriptionRemove(req, res, url);
      return this.methodNotAllowed(res, ['POST', 'DELETE']);
    }
    writeError(res, 404, 'not_found', 'route not found');
  }

  async readState() {
    const now = Date.now();
    if (this.stateCache && now - this.stateCacheAt < 750) return this.stateCache;
    try {
      const runtime = await this.store.getRuntime();
      if (runtime.socket_path && runtime.socket_path !== this.config.socketPath) this.updateSocketPath(runtime.socket_path);
    } catch { /* use the injected/configured path */ }
    const snapshot = await this.herdrClient.snapshot();
    const statuses = await this.store.listPaneStatuses().catch(() => ({}));
    const clean = sanitiseSnapshot(snapshot, statuses);
    const body = {
      ok: true,
      generated_at: new Date().toISOString(),
      snapshot: clean,
      version: clean.version,
      protocol: clean.protocol,
      focused: {
        workspace_id: clean.focused_workspace_id,
        tab_id: clean.focused_tab_id,
        pane_id: clean.focused_pane_id,
      },
      focused_workspace_id: clean.focused_workspace_id,
      focused_tab_id: clean.focused_tab_id,
      focused_pane_id: clean.focused_pane_id,
      workspaces: clean.workspaces,
      tabs: clean.tabs,
      panes: clean.panes,
      agents: clean.agents,
      pane_statuses: statuses,
    };
    this.stateCache = body;
    this.stateCacheAt = now;
    return body;
  }

  async handleLogin(req, res) {
    if (!this.requestOriginAllowed(req)) {
      writeError(res, 403, 'origin_forbidden', 'request Origin is not allowed');
      return;
    }
    if (!this.consumeLoginRate(req, res)) return;
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
    } catch (error) {
      return writeBodyReadError(req, res, error);
    }
    const result = this.auth.login(body);
    if (!result.ok) return writeError(res, 401, 'invalid_credentials', 'invalid bridge token');
    writeJson(res, 200, {
      ok: true,
      expires_at: new Date(result.expiresAt).toISOString(),
      expires_in: Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000)),
    }, { 'set-cookie': [this.auth.sessionCookie(result.session), this.auth.csrfCookie?.(result.csrf) || ''] });
  }

  rateLimitDescriptors(req, authResult, profile = 'api') {
    const address = canonicalizeAddress(requestRemoteAddress(req));
    const descriptors = [{ key: `${profile}:ip:${address}`, profile }];
    if (authResult?.ok && authResult.token) {
      descriptors.push({ key: `${profile}:credential:${hashCredential(authResult.token)}`, profile });
    }
    return descriptors;
  }

  rejectRateLimit(req, res, result) {
    const retryAfterMs = Number.isFinite(Number(result?.retryAfterMs))
      ? Math.max(1, Number(result.retryAfterMs))
      : (Number.isFinite(Number(result?.retryAfter))
        ? Math.max(1, Number(result.retryAfter) * 1000)
        : 60_000);
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader?.('retry-after', String(retryAfter));
    res.setHeader?.('connection', 'close');
    try { req.resume?.(); } catch { /* best effort */ }
    writeError(res, 429, 'rate_limited', 'too many requests');
    closeRequestAfterResponse(req, res);
    return false;
  }

  consumeRate(req, res, authResult) {
    if (!this.rateLimiter) return true;
    let result;
    try {
      const descriptors = this.rateLimitDescriptors(req, authResult, 'api');
      const consume = typeof this.rateLimiter.tryConsume === 'function'
        ? this.rateLimiter.tryConsume
        : this.rateLimiter.consume;
      if (typeof consume !== 'function') throw new TypeError('rate limiter must expose tryConsume() or consume()');
      result = consume.call(this.rateLimiter, descriptors);
    } catch (error) {
      // A limiter is part of the security boundary. If an injected/custom
      // implementation fails, reject the request rather than accidentally
      // converting the failure into an unlimited unauthenticated path.
      this.logger.warn?.('rate limiter rejected a decision', error?.message || error);
      return this.rejectRateLimit(req, res, { retryAfterMs: 60_000 });
    }
    return result === true || result?.allowed === true ? true : this.rejectRateLimit(req, res, result);
  }

  consumeLoginRate(req, res) {
    if (!this.rateLimiter) return true;
    let result;
    try {
      const address = canonicalizeAddress(requestRemoteAddress(req));
      // Login has its own fixed five-attempt profile. Keep it independent of
      // the deployment-wide API bucket so a low API setting cannot prevent a
      // user from completing the normal five-try manual login flow.
      const descriptors = [{ key: `login:ip:${address}`, profile: 'login' }];
      const consume = typeof this.rateLimiter.tryConsume === 'function'
        ? this.rateLimiter.tryConsume
        : this.rateLimiter.consume;
      if (typeof consume !== 'function') throw new TypeError('rate limiter must expose tryConsume() or consume()');
      result = consume.call(this.rateLimiter, descriptors);
    } catch (error) {
      this.logger.warn?.('login rate limiter rejected a decision', error?.message || error);
      return this.rejectRateLimit(req, res, { retryAfterMs: 60_000 });
    }
    return result === true || result?.allowed === true ? true : this.rejectRateLimit(req, res, result);
  }

  async handleInternalEvent(req, res) {
    if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
    if (!isLoopback(req)) {
      writeError(res, 403, 'loopback_required', 'internal event endpoint is local-only');
      return;
    }
    const supplied = req.headers?.['x-herdr-bridge-secret'];
    const expected = this.config.secret || '';
    if (!supplied || !expected || !constantTimeEqual(String(supplied), String(expected))) {
      writeError(res, 401, 'invalid_secret', 'invalid internal event secret');
      return;
    }
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
      const result = await this.eventBus.processIncoming(body);
      writeJson(res, result.duplicate ? 200 : 202, { ok: true, ...result });
    } catch (error) {
      this.handleError(res, error, req);
    }
  }

  async handleOutput(req, res, url, encodedPaneId) {
    if (rejectUnexpectedBody(req, res)) return;
    const paneId = decodeSegment(encodedPaneId);
    if (!paneId) return writeError(res, 400, 'invalid_pane_id', 'invalid pane id');
    let lines;
    try {
      lines = positiveLines(url.searchParams.get('lines') || 80, 80);
    } catch (error) {
      return writeError(res, 400, 'invalid_lines', error.message);
    }
    const read = await this.herdrClient.readPane(paneId, lines);
    const text = typeof read === 'string' ? read : (read?.text ?? read?.output ?? '');
    writeJson(res, 200, { ok: true, pane_id: paneId, lines, output: text, text });
  }

  async handleFocusPane(req, res) {
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
    } catch (error) {
      return writeBodyReadError(req, res, error);
    }
    const paneId = idFromBody(body, ['pane_id', 'paneId', 'id']);
    if (!paneId) return writeError(res, 400, 'invalid_pane_id', 'pane_id is required');
    await this.withControlGuard(paneId, () => this.herdrClient.focusPane(paneId));
    // Focusing changes the authoritative session snapshot. Do not let the
    // short read-state cache make the UI appear to have ignored a successful
    // focus action.
    this.invalidateStateCache();
    writeJson(res, 200, { ok: true, pane_id: paneId, accepted: true });
  }

  async handleFocusWorkspace(req, res) {
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
    } catch (error) {
      return writeBodyReadError(req, res, error);
    }
    const workspaceId = idFromBody(body, ['workspace_id', 'workspaceId', 'id']);
    if (!workspaceId) return writeError(res, 400, 'invalid_workspace_id', 'workspace_id is required');
    await this.withControlGuard(`workspace:${workspaceId}`, () => this.herdrClient.focusWorkspace(workspaceId));
    this.invalidateStateCache();
    writeJson(res, 200, { ok: true, workspace_id: workspaceId, accepted: true });
  }

  async handleAgentPrompt(req, res) {
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
    } catch (error) {
      return writeBodyReadError(req, res, error);
    }
    const paneId = idFromBody(body, ['pane_id', 'paneId']);
    if (!paneId) return writeError(res, 400, 'invalid_pane_id', 'pane_id is required');
    const text = assertPromptText(body.text);
    // Do not return the raw agent response: it can contain cwd/session
    // metadata that is intentionally omitted from the mobile snapshot.
    await this.withControlGuard(paneId, () => this.herdrClient.promptAgent(paneId, text));
    this.invalidateStateCache();
    writeJson(res, 202, { ok: true, accepted: true, pane_id: paneId });
  }

  async handlePaneInput(req, res) {
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
    } catch (error) {
      return writeBodyReadError(req, res, error);
    }
    const paneId = idFromBody(body, ['pane_id', 'paneId']);
    if (!paneId) return writeError(res, 400, 'invalid_pane_id', 'pane_id is required');
    const text = assertInputText(body.text ?? '');
    const keys = normaliseInputKeys(body.keys ?? []);
    if (!text && keys.length === 0) throw new TypeError('pane input requires text or at least one key');
    await this.withControlGuard(paneId, () => this.herdrClient.sendPaneInput(paneId, {
      text,
      keys,
    }));
    this.invalidateStateCache();
    writeJson(res, 202, { ok: true, accepted: true, pane_id: paneId });
  }

  async handleSubscriptionAdd(req, res) {
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
      const subscription = await this.push.register(body);
      writeJson(res, 201, { ok: true, subscription });
    } catch (error) {
      this.handleError(res, error, req);
    }
  }

  async handleSubscriptionRemove(req, res, url) {
    let body = {};
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024, this.config.requestBodyTimeoutMs);
    } catch (error) {
      return writeBodyReadError(req, res, error);
    }
    const id = idFromBody(body, ['id', 'subscription_id', 'subscriptionId']) || url.searchParams.get('id');
    const endpoint = body.endpoint || url.searchParams.get('endpoint');
    if (!id && !endpoint) return writeError(res, 400, 'invalid_subscription', 'id or endpoint is required');
    try {
      const removed = await this.push.remove({ id, endpoint });
      writeJson(res, 200, { ok: true, removed });
    } catch (error) {
      this.handleError(res, error, req);
    }
  }

  async handleStream(req, res, url) {
    // An SSE response never finishes while healthy, so the generic
    // closeUnreadRequest() hook cannot safely drain a stray GET body. Reject
    // it before switching the response to an indefinite keep-alive stream.
    if (rejectUnexpectedBody(req, res)) return;
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      writeError(res, 503, 'stream_capacity', 'too many stream clients', { retry_after: 10 });
      return;
    }
    const resetCursor = url.searchParams.get('reset') === '1' || url.searchParams.get('resync') === '1';
    const lastId = resetCursor ? undefined : (req.headers?.['last-event-id'] || url.searchParams.get('lastEventId'));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-herdr-event-generation': this.eventBus.generation || '',
    });
    let closed = false;
    let heartbeat;
    let unsubscribe = () => {};
    let client;
    let replaying = true;
    let backpressured = false;
    let drainListener;
    const pending = [];
    let replayOverflow = false;
    const queue = [];
    const removeDrainListener = () => {
      if (!drainListener || typeof res.off !== 'function') return;
      res.off('drain', drainListener);
      drainListener = undefined;
    };
    const flush = () => {
      if (closed || res.writableEnded || backpressured) return;
      removeDrainListener();
      while (queue.length && !closed && !res.writableEnded) {
        const frame = queue.shift();
        try {
          const writable = res.write(frame);
          if (writable === false) {
            backpressured = true;
            drainListener = () => {
              backpressured = false;
              drainListener = undefined;
              flush();
            };
            if (typeof res.once === 'function') res.once('drain', drainListener);
            return;
          }
        } catch {
          cleanup();
          return;
        }
      }
    };
    const enqueue = (frame) => {
      if (closed || res.writableEnded) return;
      if (backpressured || queue.length) {
        if (queue.length >= MAX_SSE_QUEUE) {
          // A client that cannot drain is no longer safe to keep around. It
          // will reconnect with Last-Event-ID and receive a full resync.
          cleanup();
          return;
        }
        queue.push(frame);
        return;
      }
      try {
        const writable = res.write(frame);
        if (writable === false) {
          backpressured = true;
          drainListener = () => {
            backpressured = false;
            drainListener = undefined;
            flush();
          };
          if (typeof res.once === 'function') res.once('drain', drainListener);
        }
      } catch {
        cleanup();
      }
    };
    const write = (event) => enqueue(sseFrame(sanitiseEvent(event)));
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      removeDrainListener();
      queue.length = 0;
      pending.length = 0;
      unsubscribe();
      if (client) this.sseClients.delete(client);
      try {
        if (!res.writableEnded) res.end();
      } catch {
        // Ignore a socket already closed by the peer.
      }
    };
    // Send the retry hint through the same bounded writer as event frames so
    // a saturated socket cannot bypass backpressure accounting.
    enqueue('retry: 3000\n\n');
    // Subscribe before taking the replay snapshot. Events emitted while the
    // snapshot is being written are queued and flushed afterward, preventing
    // a reconnect from observing live output before older replayed frames or
    // missing an event in the snapshot/subscribe gap.
    const onEvent = (event) => {
      if (replaying) {
        pending.push(event);
        if (pending.length > MAX_SSE_PENDING) {
          replayOverflow = true;
          pending.splice(0, pending.length - MAX_SSE_PENDING);
        }
      }
      else write(event);
    };
    unsubscribe = this.eventBus.subscribe(onEvent);
    client = { res, cleanup };
    this.sseClients.add(client);
    // Register close handlers before replay so a client that disappears while
    // a large history is being serialized is removed immediately.
    if (typeof req.on === 'function') {
      req.on('close', cleanup);
      req.on('aborted', cleanup);
    }
    const generation = req.headers?.['x-herdr-event-generation'] || url.searchParams.get('generation');
    const replayInfo = this.eventBus.replaySince ? this.eventBus.replaySince(lastId, generation) : { events: this.eventBus.getSince(lastId), gap: false };
    const replay = replayInfo.events;
    if (replayInfo.gap) write({ event: 'resync_required', context: { reason: 'replay_gap', generation: this.eventBus.generation }, received_at: new Date().toISOString() });
    const replayed = new Set(replay);
    for (const event of replay) write(event);
    replaying = false;
    // EventEmitter preserves publication order, but sorting by sequence keeps
    // the cursor monotonic even when a custom event source batches callbacks.
    pending.sort((left, right) => {
      const leftSeq = Number(left?.seq);
      const rightSeq = Number(right?.seq);
      const leftValid = Number.isSafeInteger(leftSeq) && leftSeq >= 0;
      const rightValid = Number.isSafeInteger(rightSeq) && rightSeq >= 0;
      if (leftValid && rightValid) return leftSeq - rightSeq;
      if (leftValid) return -1;
      if (rightValid) return 1;
      return 0;
    });
    for (const event of pending.splice(0)) {
      // The event may have been published after subscription but before the
      // replay snapshot, in which case the same object is already replayed.
      if (!replayed.has(event)) write(event);
    }
    if (replayOverflow) {
      write({ event: 'resync_required', context: { reason: 'replay_overflow', generation: this.eventBus.generation }, received_at: new Date().toISOString() });
    }
    flush();
    if (closed) return;
    // A readiness marker must not carry an SSE id: assigning seq=0 here would
    // reset the browser's Last-Event-ID after replay and cause every reconnect
    // to receive the entire bounded history again.
    write({
      id: `ready-${randomUUID()}`,
      event: 'ready',
      context: { connected: true, generation: this.eventBus.generation, latest_seq: this.eventBus.latest?.()?.seq ?? 0 },
      received_at: new Date().toISOString(),
    });
    heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return cleanup();
      enqueue(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
  }

  methodNotAllowed(res, methods) {
    res.setHeader('allow', methods.join(', '));
    writeError(res, 405, 'method_not_allowed', 'method not allowed', { allow: methods });
  }

  handleError(res, error, req) {
    if (res.writableEnded) return;
    const status = bodyReadStatus(error);
    const code = error?.code || (status === 500 ? 'internal_error' : 'request_failed');
    const message = status >= 500 ? (status === 502 ? 'Herdr session unavailable' : 'internal server error') : (error?.message || 'request failed');
    if (error?.retryAfter) res.setHeader('retry-after', String(error.retryAfter));
    if (status >= 500) this.logger.error?.(error);
    if (error?.requestClose) res.setHeader?.('connection', 'close');
    writeError(res, status, code, message);
    if (error?.requestClose) closeRequestAfterResponse(req, res);
  }
}

export { collectLanAddresses, readBody, writeJson, writeError, sseFrame, statusForError, normaliseOrigin, isLoopback };
