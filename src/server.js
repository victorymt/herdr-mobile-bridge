import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

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

const MAX_SSE_CLIENTS = 128;
const MAX_SSE_PENDING = 512;
const MAX_SSE_QUEUE = 512;
const MAX_CONTROL_IN_FLIGHT = 32;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
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

function statusForError(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  if (['invalid_json', 'body_too_large', 'invalid_subscription', 'invalid_pane_id', 'invalid_workspace_id', 'invalid_lines', 'origin_forbidden', 'csrf_failed'].includes(error?.code)) {
    return error.code === 'body_too_large' ? 413 : 400;
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
  const address = req.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
  const clean = pick(context, ['pane_id', 'workspace_id', 'tab_id', 'agent', 'display_agent', 'title', 'agent_status', 'final_status', 'released', 'revision']);
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

async function readBody(req, maxBytes) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`request body exceeds ${maxBytes} bytes`);
    error.code = 'body_too_large';
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
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
    this.config = options.config || {};
    this.publicDir = resolve(options.publicDir || this.config.publicDir || PUBLIC_DIR);
    this.logger = options.logger || console;
    this.herdrClient = options.herdrClient;
    this.store = options.store || new StateStore({
      stateDir: this.config.stateDir,
      subscriptionsPath: this.config.subscriptionsPath,
      dedupPath: this.config.dedupPath,
      runtimePath: this.config.runtimePath,
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
    this.loginAttempts = new Map();
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
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => this.handleError(res, error));
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });
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
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

    if (req.method === 'GET' && pathname === '/healthz') {
      const health = { ok: true, service: 'herdr-mobile-bridge' };
      if (this.config.healthDetails === true) {
        const runtime = this.store.initialized ? await this.store.getRuntime().catch(() => ({})) : {};
        Object.assign(health, { version: this.config.version || '0.1.0', uptime_seconds: Math.floor(process.uptime()), pid: process.pid, host: this.address().host, port: this.address().port, socket_present: Boolean(this.config.socketPath && existsSync(this.config.socketPath)), started_at: runtime.started_at || this.startedAt?.toISOString() || null });
      }
      writeJson(res, 200, health);
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
      writeError(res, 401, 'unauthorized', 'authentication required');
      return;
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      this.requireMutationSecurity(req, url, authResult);
    }

    if (pathname === '/api/auth/logout') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, ['POST']);
      this.auth.logout(req);
      writeJson(res, 200, { ok: true, logged_out: true }, { 'set-cookie': [this.auth.clearCookie(), this.auth.clearCsrfCookie?.() || ''] });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
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
    if (!this.allowLoginAttempt(req)) {
      res.setHeader('retry-after', '30');
      writeError(res, 429, 'rate_limited', 'too many login attempts');
      return;
    }
    let body;
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
    } catch (error) {
      return writeError(res, error.code === 'body_too_large' ? 413 : 400, error.code || 'invalid_json', error.message);
    }
    const result = this.auth.login(body);
    if (!result.ok) return writeError(res, 401, 'invalid_credentials', 'invalid bridge token');
    writeJson(res, 200, {
      ok: true,
      expires_at: new Date(result.expiresAt).toISOString(),
      expires_in: Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000)),
    }, { 'set-cookie': [this.auth.sessionCookie(result.session), this.auth.csrfCookie?.(result.csrf) || ''] });
  }

  allowLoginAttempt(req) {
    const now = Date.now();
    // Bound this map even when an attacker rotates source addresses.
    for (const [address, value] of this.loginAttempts) {
      if (value.resetAt <= now) this.loginAttempts.delete(address);
    }
    const key = String(req.socket?.remoteAddress || 'unknown');
    const entry = this.loginAttempts.get(key) || { count: 0, resetAt: now + 60_000 };
    if (entry.resetAt <= now) { entry.count = 0; entry.resetAt = now + 60_000; }
    entry.count += 1;
    this.loginAttempts.set(key, entry);
    // Five attempts per minute per source is enough for a manually entered
    // token while limiting online guessing against the owner token.
    return entry.count <= 5;
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
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
      const result = await this.eventBus.processIncoming(body);
      writeJson(res, result.duplicate ? 200 : 202, { ok: true, ...result });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  async handleOutput(req, res, url, encodedPaneId) {
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
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
    } catch (error) {
      return writeError(res, error.code === 'body_too_large' ? 413 : 400, error.code || 'invalid_json', error.message);
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
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
    } catch (error) {
      return writeError(res, error.code === 'body_too_large' ? 413 : 400, error.code || 'invalid_json', error.message);
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
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
    } catch (error) {
      return writeError(res, error.code === 'body_too_large' ? 413 : 400, error.code || 'invalid_json', error.message);
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
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
    } catch (error) {
      return writeError(res, error.code === 'body_too_large' ? 413 : 400, error.code || 'invalid_json', error.message);
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
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
      const subscription = await this.push.register(body);
      writeJson(res, 201, { ok: true, subscription });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  async handleSubscriptionRemove(req, res, url) {
    let body = {};
    try {
      body = await readBody(req, this.config.maxBodyBytes || 1024 * 1024);
    } catch (error) {
      return writeError(res, error.code === 'body_too_large' ? 413 : 400, error.code || 'invalid_json', error.message);
    }
    const id = idFromBody(body, ['id', 'subscription_id', 'subscriptionId']) || url.searchParams.get('id');
    const endpoint = body.endpoint || url.searchParams.get('endpoint');
    if (!id && !endpoint) return writeError(res, 400, 'invalid_subscription', 'id or endpoint is required');
    try {
      const removed = await this.push.remove({ id, endpoint });
      writeJson(res, 200, { ok: true, removed });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  async handleStream(req, res, url) {
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      writeError(res, 503, 'stream_capacity', 'too many stream clients', { retry_after: 10 });
      return;
    }
    const lastId = req.headers?.['last-event-id'] || url.searchParams.get('lastEventId');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
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
    const replayInfo = this.eventBus.replaySince ? this.eventBus.replaySince(lastId) : { events: this.eventBus.getSince(lastId), gap: false };
    const replay = replayInfo.events;
    if (replayInfo.gap) write({ event: 'resync_required', context: { reason: 'replay_gap' }, received_at: new Date().toISOString() });
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
      write({ event: 'resync_required', context: { reason: 'replay_overflow' }, received_at: new Date().toISOString() });
    }
    flush();
    if (closed) return;
    // A readiness marker must not carry an SSE id: assigning seq=0 here would
    // reset the browser's Last-Event-ID after replay and cause every reconnect
    // to receive the entire bounded history again.
    write({ id: `ready-${randomUUID()}`, event: 'ready', context: { connected: true }, received_at: new Date().toISOString() });
    heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return cleanup();
      enqueue(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
  }

  methodNotAllowed(res, methods) {
    res.setHeader('allow', methods.join(', '));
    writeError(res, 405, 'method_not_allowed', 'method not allowed', { allow: methods });
  }

  handleError(res, error) {
    if (res.writableEnded) return;
    const status = error?.code === 'body_too_large' ? 413 : statusForError(error);
    const code = error?.code || (status === 500 ? 'internal_error' : 'request_failed');
    const message = status >= 500 ? (status === 502 ? 'Herdr session unavailable' : 'internal server error') : (error?.message || 'request failed');
    if (error?.retryAfter) res.setHeader('retry-after', String(error.retryAfter));
    if (status >= 500) this.logger.error?.(error);
    writeError(res, status, code, message);
  }
}

export { readBody, writeJson, writeError, sseFrame, statusForError, normaliseOrigin };
