import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalContext, normalizeEventName } from './event-bus.js';

const DEFAULT_EVENT_URL = 'http://127.0.0.1:8787/internal/event';
const MAX_EVENT_BYTES = 256 * 1024;
const EVENT_ALLOWLIST_ENV_NAMES = [
  'HERDR_BRIDGE_EVENT_ALLOWED_ORIGINS',
  'BRIDGE_EVENT_ALLOWED_ORIGINS',
  'HERDR_BRIDGE_EVENT_ALLOWLIST',
  'BRIDGE_EVENT_ALLOWLIST',
];

function firstNonEmpty(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Only exact loopback hosts are trusted for the unauthenticated local hook.
 * DNS names other than `localhost` are deliberately not resolved here: doing
 * so would make a DNS rebinding attack able to turn a configured name into a
 * remote endpoint after validation.
 */
function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  // WHATWG URL canonicalises IPv4-mapped loopback addresses to hexadecimal
  // IPv6 notation (for example ::ffff:7f00:1).
  return /^::ffff:7f00:[0-9a-f]+$/.test(host);
}

function configuredEventAllowlist(env = process.env, options = {}) {
  const configured = options.allowedOrigins ?? options.allowedHosts ??
    EVENT_ALLOWLIST_ENV_NAMES.map((name) => env?.[name]).find((value) => firstNonEmpty(value));
  if (Array.isArray(configured)) return configured.flatMap((value) => String(value).split(','));
  if (typeof configured === 'string') return configured.split(',');
  return [];
}

function normaliseAllowlistEntry(value) {
  const entry = firstNonEmpty(String(value || ''));
  if (!entry) return undefined;
  let url;
  try {
    // Full origins are preferred, but host[:port] entries are accepted as a
    // convenience and are still forced to HTTPS below.
    url = new URL(entry.includes('://') ? entry : `https://${entry}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
  return url.origin;
}

/**
 * Validate an event delivery endpoint before putting the bridge secret on the
 * wire. HTTP is permitted only for exact loopback addresses. A remote target
 * must be HTTPS and appear in an explicit origin allowlist.
 */
export function validateEventEndpoint(endpoint, env = process.env, options = {}) {
  let url;
  try {
    url = endpoint instanceof URL ? new URL(endpoint.href) : new URL(String(endpoint));
  } catch (error) {
    throw new Error(`invalid bridge event URL: ${error.message}`);
  }
  if (url.username || url.password) throw new Error('bridge event URL must not include credentials');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('bridge event URL must use HTTP or HTTPS');
  }
  if (isLoopbackHost(url.hostname)) return url;
  if (url.protocol !== 'https:') {
    throw new Error('non-loopback bridge event URL must use HTTPS');
  }
  const allowedOrigins = new Set(configuredEventAllowlist(env, options).map(normaliseAllowlistEntry).filter(Boolean));
  if (!allowedOrigins.has(url.origin)) {
    throw new Error('non-loopback bridge event URL is not in the HTTPS allowlist');
  }
  return url;
}

function readSecret(env = process.env) {
  const direct = env.HERDR_BRIDGE_SECRET || env.BRIDGE_SECRET;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const dir = env.HERDR_PLUGIN_CONFIG_DIR || env.HERDR_MOBILE_BRIDGE_CONFIG_DIR || env.BRIDGE_CONFIG_DIR;
  if (!dir) return undefined;
  try {
    return readFileSync(join(dir, 'bridge-secret'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseEvent(env = process.env) {
  const raw = env.HERDR_PLUGIN_EVENT_JSON;
  let eventObject = {};
  if (raw) {
    if (Buffer.byteLength(raw, 'utf8') > MAX_EVENT_BYTES) throw new Error('event payload is too large');
    try {
      eventObject = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid HERDR_PLUGIN_EVENT_JSON: ${error.message}`);
    }
  }
  if (!eventObject || typeof eventObject !== 'object' || Array.isArray(eventObject)) eventObject = {};
  const event = env.HERDR_PLUGIN_EVENT || eventObject.event || eventObject.type;
  if (!event) throw new Error('HERDR_PLUGIN_EVENT is missing');
  const contextRaw = env.HERDR_PLUGIN_CONTEXT_JSON;
  let context = {};
  if (contextRaw) {
    if (Buffer.byteLength(contextRaw, 'utf8') > MAX_EVENT_BYTES) throw new Error('event context is too large');
    try {
      context = JSON.parse(contextRaw);
    } catch (error) {
      throw new Error(`invalid HERDR_PLUGIN_CONTEXT_JSON: ${error.message}`);
    }
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('event context must be an object');
  // Herdr serializes EventEnvelope as {event, data}; retain all event data in
  // the context field expected by the bridge while allowing explicit plugin
  // context to override stale fields.
  if (eventObject.data && typeof eventObject.data === 'object') context = { ...eventObject.data, ...context };
  return {
    event,
    context,
    socket_path: env.HERDR_SOCKET_PATH || eventObject.socket_path,
    event_id: env.HERDR_PLUGIN_EVENT_ID || eventObject.event_id || eventObject.id,
  };
}

function endpointFromEnv(env = process.env) {
  const value = env.HERDR_BRIDGE_EVENT_URL || env.HERDR_BRIDGE_URL || env.BRIDGE_EVENT_URL;
  if (!value || !value.trim()) {
    const stateDir = env.HERDR_PLUGIN_STATE_DIR || env.HERDR_MOBILE_BRIDGE_STATE_DIR || env.BRIDGE_STATE_DIR;
    if (stateDir) {
      try {
        const runtime = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
        if (runtime && Number.isInteger(Number(runtime.port)) && runtime.port > 0) {
          const host = typeof runtime.host === 'string' && runtime.host ? runtime.host : '127.0.0.1';
          const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
          return `http://${authorityHost}:${runtime.port}/internal/event`;
        }
      } catch { /* use the default while the gateway is starting */ }
    }
    return DEFAULT_EVENT_URL;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/internal/event') ? trimmed : `${trimmed}/internal/event`;
}

export async function sendEvent(payload, options = {}) {
  const env = options.env || process.env;
  const secret = options.secret || readSecret(env);
  if (!secret) return { skipped: true, reason: 'bridge secret is not configured' };
  const endpoint = options.endpoint || endpointFromEnv(env);
  const bounded = boundPayload(payload);
  const url = validateEventEndpoint(endpoint, env, options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 1500);
  try {
    const response = await (options.fetch || globalThis.fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-herdr-bridge-secret': secret,
      },
      body: JSON.stringify(bounded),
      // Never forward the bridge secret to a redirect target. In addition to
      // being surprising for a local hook, cross-origin redirects can turn a
      // typo in the endpoint into credential exfiltration.
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`bridge returned HTTP ${response.status}`);
    return { delivered: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Keep the event hook's outbound request as small and metadata-only as the
 * gateway's own parser. Hooks run in Herdr's process environment, so
 * sanitising before the network call prevents accidental terminal output (or
 * arbitrary plugin context) from crossing the process boundary at all.
 */
function boundPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('event payload must be an object');
  const event = normalizeEventName(payload.event || payload.type || payload.name);
  if (!event) throw new Error('event is required');
  const bounded = {
    event,
    context: canonicalContext({ event, context: payload.context }, event),
  };
  const socketPath = payload.socket_path || payload.socketPath;
  if (typeof socketPath === 'string' && socketPath.length <= 4096 && socketPath.startsWith('/') && !socketPath.includes('\0')) {
    bounded.socket_path = socketPath;
  }
  const eventId = payload.event_id || payload.eventId || payload.id;
  if (eventId !== undefined && eventId !== null) {
    const text = String(eventId).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
    if (text) bounded.event_id = text;
  }
  const encoded = JSON.stringify(bounded);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EVENT_BYTES) throw new Error('event payload is too large');
  return bounded;
}

export async function main(options = {}) {
  const env = options.env || process.env;
  let payload;
  try {
    payload = options.payload || parseEvent(env);
  } catch (error) {
    if (options.throwOnError) throw error;
    process.stderr.write(`herdr-mobile-bridge event hook skipped: ${error.message}\n`);
    return { skipped: true, reason: error.message };
  }
  try {
    return await sendEvent(payload, options);
  } catch (error) {
    // Event hooks are best effort. A stopped/restarting gateway must not make
    // the Herdr state transition fail.
    if (options.throwOnError) throw error;
    process.stderr.write(`herdr-mobile-bridge event hook delivery failed: ${error.message}\n`);
    return { delivered: false, reason: error.message };
  }
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((result) => {
    if (result?.delivered === false && process.env.HERDR_PLUGIN_EVENT_HOOK_STRICT === '1') process.exitCode = 1;
  });
}

export { parseEvent, readSecret, endpointFromEnv, DEFAULT_EVENT_URL, boundPayload, MAX_EVENT_BYTES, isLoopbackHost, configuredEventAllowlist };
