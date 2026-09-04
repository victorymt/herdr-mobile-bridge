import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const ALLOWED_METHODS = Object.freeze([
  'session.snapshot',
  'pane.read',
  'pane.focus',
  'workspace.focus',
  'agent.prompt',
  'pane.send_input',
]);

export const MAX_PROMPT_BYTES = 32 * 1024;
export const MAX_INPUT_BYTES = 8 * 1024;
export const MAX_INPUT_KEYS = 8;

// Keep the browser bridge narrower than Herdr's general key-combo parser.
// Printable input belongs in `text`; these keys cover the interaction controls
// needed from a phone without exposing arbitrary Herdr/TUI bindings.
export const ALLOWED_INPUT_KEYS = Object.freeze([
  'enter',
  'escape',
  'tab',
  'shift+tab',
  'backspace',
  'left',
  'right',
  'up',
  'down',
  'ctrl+a',
  'ctrl+c',
  'ctrl+d',
  'ctrl+e',
  'ctrl+l',
  'ctrl+u',
  'ctrl+w',
  'ctrl+z',
]);

const ALLOWED_METHOD_SET = new Set(ALLOWED_METHODS);
const ALLOWED_INPUT_KEY_SET = new Set(ALLOWED_INPUT_KEYS);

export class HerdrApiError extends Error {
  constructor(code, message, response) {
    super(message || code || 'Herdr API request failed');
    this.name = 'HerdrApiError';
    this.code = code || 'herdr_error';
    this.response = response;
  }
}

export class HerdrSocketError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HerdrSocketError';
    this.cause = cause;
    this.code = cause?.code || 'socket_error';
  }
}

function assertSocketPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) {
    throw new TypeError('Herdr socket path must be an absolute path');
  }
  return path;
}

function assertPaneId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || id.includes('\0') || /[\r\n]/.test(id)) {
    throw new TypeError('invalid pane id');
  }
  return id.trim();
}

function assertWorkspaceId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || id.includes('\0') || /[\r\n]/.test(id)) {
    throw new TypeError('invalid workspace id');
  }
  return id.trim();
}

function assertText(value, options = {}) {
  const name = options.name || 'text';
  const maxBytes = Number(options.maxBytes);
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  if (value.includes('\0')) throw new TypeError(`${name} must not contain NUL bytes`);
  if (options.required && !value.trim()) throw new TypeError(`${name} must not be empty`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || bytes > maxBytes) {
    throw new TypeError(`${name} must be at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function assertPromptText(text) {
  return assertText(text, { name: 'prompt', maxBytes: MAX_PROMPT_BYTES, required: true });
}

function assertInputText(text = '') {
  return assertText(text, { name: 'input text', maxBytes: MAX_INPUT_BYTES });
}

function normaliseInputKeys(keys = []) {
  if (!Array.isArray(keys)) throw new TypeError('keys must be an array');
  if (keys.length > MAX_INPUT_KEYS) throw new TypeError(`keys must contain at most ${MAX_INPUT_KEYS} items`);
  return keys.map((key) => {
    if (typeof key !== 'string') throw new TypeError('each key must be a string');
    const normalized = key.trim().toLowerCase();
    if (!ALLOWED_INPUT_KEY_SET.has(normalized)) throw new TypeError(`unsupported input key: ${key}`);
    return normalized;
  });
}

function positiveLines(lines, fallback = 80) {
  if (lines === undefined || lines === null || lines === '') return fallback;
  const value = Number(lines);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new TypeError('lines must be an integer between 1 and 10000');
  return value;
}

function parseResponse(line) {
  let response;
  try {
    response = JSON.parse(line);
  } catch (error) {
    throw new HerdrSocketError(`invalid JSON response from Herdr: ${error.message}`, error);
  }
  if (!response || typeof response !== 'object') throw new HerdrSocketError('invalid response from Herdr');
  if (response.error) {
    throw new HerdrApiError(response.error.code, response.error.message, response);
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
    throw new HerdrSocketError('Herdr response did not contain a result', response);
  }
  return response;
}

/**
 * Minimal newline-delimited JSON client. The public request method accepts
 * only the explicitly allowlisted methods used by the mobile bridge; there is deliberately no
 * generic proxy route in the HTTP server.
 */
export class HerdrSocketClient {
  constructor(options = {}) {
    // Preserve the loader/BridgeServer distinction between an omitted path and
    // an explicitly supplied empty/invalid one.  Truthiness fallback here
    // would silently redirect `socketPath: ''`, `false`, or `0` to the default
    // socket while the higher-level configuration rejects those values.
    const socketPath = options.socketPath === undefined || options.socketPath === null
      ? '/tmp/herdr.sock'
      : options.socketPath;
    this.socketPath = assertSocketPath(socketPath);
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 5000;
    this.net = options.net || net;
    this.idFactory = options.idFactory || (() => `bridge-${randomUUID()}`);
    this.maxResponseBytes = options.maxResponseBytes || 16 * 1024 * 1024;
  }

  setSocketPath(path) {
    this.socketPath = assertSocketPath(path);
    return this.socketPath;
  }

  async request(method, params = {}, options = {}) {
    if (!ALLOWED_METHOD_SET.has(method)) {
      throw new HerdrApiError('method_not_allowed', `Herdr method is not allowed: ${method}`);
    }
    const request = {
      id: options.id || this.idFactory(),
      method,
      params: params && typeof params === 'object' ? params : {},
    };
    const socketPath = options.socketPath === undefined || options.socketPath === null
      ? this.socketPath
      : assertSocketPath(options.socketPath);
    const line = await this.exchange(socketPath, `${JSON.stringify(request)}\n`);
    const response = parseResponse(line);
    if (response.id !== undefined && response.id !== request.id) {
      throw new HerdrSocketError(`Herdr response id mismatch (expected ${request.id}, got ${response.id})`);
    }
    return response;
  }

  async snapshot(options = {}) {
    const response = await this.request('session.snapshot', {}, options);
    return response.result?.snapshot ?? response.result;
  }

  async readPane(paneId, lines = 80, options = {}) {
    const id = assertPaneId(paneId);
    const count = positiveLines(lines);
    const response = await this.request('pane.read', {
      pane_id: id,
      source: options.source || 'recent',
      lines: count,
      format: options.format || 'text',
      strip_ansi: options.stripAnsi !== false,
    }, options);
    return response.result?.read ?? response.result;
  }

  async focusPane(paneId, options = {}) {
    const response = await this.request('pane.focus', { pane_id: assertPaneId(paneId) }, options);
    return response.result;
  }

  async focusWorkspace(workspaceId, options = {}) {
    const response = await this.request('workspace.focus', { workspace_id: assertWorkspaceId(workspaceId) }, options);
    return response.result;
  }

  async promptAgent(target, text, options = {}) {
    const response = await this.request('agent.prompt', {
      // A public pane id is a valid Herdr agent target and avoids exposing a
      // second name-resolution surface through the bridge.
      target: assertPaneId(target),
      text: assertPromptText(text),
    }, options);
    return response.result;
  }

  async sendPaneInput(paneId, input = {}, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('pane input must be an object');
    }
    const text = assertInputText(input.text ?? '');
    const keys = normaliseInputKeys(input.keys ?? []);
    if (!text && keys.length === 0) throw new TypeError('pane input requires text or at least one key');
    const response = await this.request('pane.send_input', {
      pane_id: assertPaneId(paneId),
      text,
      keys,
    }, options);
    return response.result;
  }

  exchange(socketPath, requestLine) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      let buffer = '';
      let timer;
      const socket = this.net.createConnection({ path: socketPath });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.removeAllListeners();
        try {
          socket.destroy();
        } catch {
          // Ignore a socket that has already closed.
        }
        if (error) reject(error);
        else resolve(value);
      };
      timer = setTimeout(() => finish(new HerdrSocketError(`timed out connecting to Herdr at ${socketPath}`)), this.timeoutMs);
      socket.once('connect', () => {
        socket.setTimeout(this.timeoutMs, () => finish(new HerdrSocketError(`timed out waiting for Herdr at ${socketPath}`)));
        socket.write(requestLine, (error) => {
          if (error) finish(new HerdrSocketError(`failed to write Herdr request: ${error.message}`, error));
        });
      });
      socket.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > this.maxResponseBytes) {
          finish(new HerdrSocketError('Herdr response exceeded the size limit'));
          return;
        }
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline >= 0) finish(null, buffer.slice(0, newline).replace(/\r$/, ''));
      });
      socket.once('error', (error) => finish(new HerdrSocketError(`Herdr socket error: ${error.message}`, error)));
      socket.once('close', () => {
        if (!settled) finish(new HerdrSocketError('Herdr socket closed before a response'));
      });
    });
  }
}

export {
  assertInputText,
  assertPaneId,
  assertPromptText,
  assertSocketPath,
  assertWorkspaceId,
  normaliseInputKeys,
  parseResponse,
  positiveLines,
};
