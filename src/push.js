import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let optionalWebPush;
try {
  // `web-push` is an ordinary dependency in deployments that deliver directly
  // to browser push services. Keeping the require optional lets the bridge run
  // in a test-only/minimal install with an injected sender or relay endpoint.
  optionalWebPush = require('web-push');
} catch {
  optionalWebPush = undefined;
}

const PUSH_TIMEOUT_MS = 5000;
const DEFAULT_TTL_SECONDS = 300;
// Push services commonly reject very short TTLs; 30 seconds still gives a
// notification a useful delivery window while keeping stale status alerts
// short-lived. Four weeks is the Web Push protocol's practical upper bound.
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 2_419_200;

// Notification links are deliberately metadata-only.  The bridge never puts
// terminal output (or arbitrary plugin fields) in a URL that can be copied to
// a lock screen, browser history, or push provider.  These limits mirror the
// bounds used by the event/state layers while leaving enough room for a
// complete pane identifier to survive the round trip.
const ATTENTION_VIEW = 'attention';
const MAX_DEEPLINK_URL_LENGTH = 2048;
const DEEPLINK_FIELD_LIMITS = Object.freeze({
  pane: 256,
  workspace: 256,
  event: 80,
  status: 32,
  agent: 120,
});

function normaliseTtl(value, fallback = DEFAULT_TTL_SECONDS) {
  let number;
  try { number = Number(value); } catch { return fallback; }
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(number)));
}

function publicSubscription(value) {
  if (!value) return value;
  const copy = { ...value };
  return copy;
}

/**
 * Subscription registry and delivery adapter. The default adapter uses
 * fetch so deployments can provide a small push relay; production Web Push
 * encryption can be supplied through the `sender` option without changing the
 * gateway or its persisted subscription format.
 */
export class PushManager {
  constructor(options = {}) {
    this.store = options.store;
    this.vapid = options.vapid || {};
    this.fetch = options.fetch || globalThis.fetch;
    this.webPush = options.webPush || optionalWebPush;
    this.allowRelay = options.allowRelay === true;
    this.sender = options.sender || ((subscription, payload) => this.sendHttp(subscription, payload));
    this.clock = options.clock || (() => Date.now());
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : PUSH_TIMEOUT_MS;
    this.logger = options.logger || console;
  }

  get publicKey() {
    return this.vapid.publicKey || this.vapid.public_key || '';
  }

  async register(value) {
    if (!this.store) throw new Error('push state store is not configured');
    const candidate = value?.subscription && typeof value.subscription === 'object' ? value.subscription : value;
    const subscription = await this.store.addSubscription(candidate);
    return publicSubscription(subscription);
  }

  async remove(criteria) {
    if (!this.store) throw new Error('push state store is not configured');
    return this.store.removeSubscription(criteria);
  }

  async list() {
    if (!this.store) return [];
    return this.store.listSubscriptions();
  }

  async notify(event, options = {}) {
    const subscriptions = await this.list();
    const payload = makePushPayload(event, options);
    const results = [];
    for (const subscription of subscriptions) {
      try {
        const result = await this.sender(subscription, payload);
        results.push({ id: subscription.id, ok: true, result });
      } catch (error) {
        results.push({ id: subscription.id, ok: false, error: error?.message || String(error) });
        // Web Push endpoints return 404/410 after expiry. Removing those
        // entries prevents every subsequent terminal event from retrying them.
        if (error?.status === 404 || error?.status === 410 || error?.code === 'subscription_expired') {
          try {
            await this.remove({ id: subscription.id });
          } catch (removeError) {
            this.logger.warn?.('failed to remove expired push subscription', removeError);
          }
        }
      }
    }
    return { attempted: subscriptions.length, delivered: results.filter((entry) => entry.ok).length, results, payload };
  }

  async sendHttp(subscription, payload) {
    if (this.webPush?.sendNotification && this.vapid.publicKey && this.vapid.privateKey) {
      if (this.vapid.subject && this.webPush.setVapidDetails) {
        // setVapidDetails is idempotent for a given process; call it here so a
        // custom web-push implementation can also observe the configured keys.
        this.webPush.setVapidDetails(this.vapid.subject, this.vapid.publicKey, this.vapid.privateKey);
      }
      try {
        return await this.webPush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: normaliseTtl(payload.ttl),
        });
      } catch (error) {
        // Preserve HTTP status/code from web-push for stale subscription
        // cleanup in notify().
        if (error?.statusCode && !error.status) error.status = error.statusCode;
        throw error;
      }
    }
    if (!this.allowRelay || typeof this.fetch !== 'function') {
      throw new Error('web-push is unavailable; install dependencies or configure an explicit relay sender');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'ttl': String(normaliseTtl(payload.ttl)),
          'x-herdr-bridge-event': String(payload.event || 'agent_status'),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response?.ok) {
        const error = new Error(`push endpoint returned HTTP ${response?.status ?? 0}`);
        error.status = response?.status;
        throw error;
      }
      return { status: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function makePushPayload(event, options = {}) {
  const context = event?.context && typeof event.context === 'object' ? event.context : {};
  const eventName = normalizeEventName(event?.event || event?.type || event?.name);
  const detected = eventName === 'pane_agent_detected';
  // A detected event may carry the focused pane's current status alongside a
  // newly detected terminal result. For that event kind, final_status is the
  // authoritative value; status-change events use agent_status first.
  const rawStatus = normalizeStatus(detected
    ? firstValue(context.final_status, event?.final_status, context.agent_status, event?.agent_status)
    : firstValue(context.agent_status, event?.agent_status, context.final_status, event?.final_status));
  const status = boundedMetadata(rawStatus, DEEPLINK_FIELD_LIMITS.status) || undefined;
  const paneId = boundedMetadata(context.pane_id || context.focused_pane_id || context.paneId || event?.pane_id || event?.paneId, DEEPLINK_FIELD_LIMITS.pane) || undefined;
  const workspaceId = boundedMetadata(context.workspace_id || context.workspaceId || event?.workspace_id || event?.workspaceId, DEEPLINK_FIELD_LIMITS.workspace) || undefined;
  const agent = boundedMetadata(context.agent || context.display_agent || context.focused_pane_agent || event?.agent || event?.display_agent, DEEPLINK_FIELD_LIMITS.agent) || undefined;
  const outputEvent = boundedMetadata(eventName || 'pane_agent_status_changed', DEEPLINK_FIELD_LIMITS.event);
  const title = clean(options.title || (status === 'blocked' ? 'Herdr · 需要介入' : 'Herdr · 任务完成'), 120);
  const body = clean(options.body || [agent, paneId, statusLabel(status)].filter(Boolean).join(' · '), 240);
  const url = buildAttentionUrl({
    paneId,
    workspaceId,
    event: outputEvent,
    status,
    agent,
  });
  return {
    type: 'herdr_agent_status',
    view: ATTENTION_VIEW,
    event: outputEvent,
    status,
    pane_id: paneId,
    workspace_id: workspaceId,
    agent: agent || null,
    title,
    body,
    url,
    data: {
      view: ATTENTION_VIEW,
      event: outputEvent,
      status,
      pane_id: paneId,
      workspace_id: workspaceId,
      agent: agent || null,
      url,
    },
    ttl: normaliseTtl(options.ttl),
    sent_at: boundedMetadata(options.sentAt, 64) || new Date().toISOString(),
  };
}

/**
 * Build the notification click target from bounded, non-sensitive metadata.
 * A location is required before creating an attention link; otherwise a
 * malformed/partial event falls back to the dashboard root just like older
 * payloads did.  Values are encoded independently so pane IDs cannot inject
 * additional query parameters or fragments.
 */
function buildAttentionUrl({ paneId, workspaceId, event, status, agent } = {}) {
  const pane = boundedMetadata(paneId, DEEPLINK_FIELD_LIMITS.pane);
  const workspace = boundedMetadata(workspaceId, DEEPLINK_FIELD_LIMITS.workspace);
  if (!pane && !workspace) return '/';

  const fields = [
    ['view', ATTENTION_VIEW],
    ['pane', pane],
    ['workspace', workspace],
    ['event', boundedMetadata(event, DEEPLINK_FIELD_LIMITS.event)],
    ['status', boundedMetadata(status, DEEPLINK_FIELD_LIMITS.status)],
    ['agent', boundedMetadata(agent, DEEPLINK_FIELD_LIMITS.agent)],
  ];
  const query = fields
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${encodeMetadata(value)}`);
  const candidate = query.length ? `/?${query.join('&')}` : '/';
  // The individual bounds above keep this comfortably below normal browser
  // URL limits. Keep a final guard in case a future field is added without a
  // corresponding bound; dropping optional metadata is safer than emitting a
  // giant link. Pane/workspace are retained whenever possible.
  if (candidate.length <= MAX_DEEPLINK_URL_LENGTH) return candidate;
  const required = fields
    .slice(0, 3)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${encodeMetadata(value)}`);
  const requiredUrl = required.length ? `/?${required.join('&')}` : '/';
  return requiredUrl.length <= MAX_DEEPLINK_URL_LENGTH ? requiredUrl : '/';
}

function boundedMetadata(value, max = 256) {
  if (value === undefined || value === null) return '';
  let text;
  try {
    text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  } catch {
    return '';
  }
  // `encodeURIComponent` throws on lone UTF-16 surrogates.  Newer Node and
  // browsers expose `toWellFormed`; the fallback keeps this module compatible
  // with older runtimes without allowing a malformed value to break notify().
  if (typeof text.toWellFormed === 'function') text = text.toWellFormed();
  else if (/[\uD800-\uDFFF]/.test(text)) text = text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  return text.slice(0, max);
}

function encodeMetadata(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    return encodeURIComponent(String(value).replace(/[\uD800-\uDFFF]/g, '\uFFFD'));
  }
}

function normalizeEventName(value) {
  if (value && typeof value === 'object') {
    try { return normalizeEventName(value.event || value.type || value.name); } catch { return ''; }
  }
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[.\s-]+/g, '_');
}

function firstValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function normalizeStatus(value) {
  if (value === null || value === undefined) return undefined;
  let normalized;
  try { normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_'); } catch { return undefined; }
  if (!normalized) return undefined;
  return ({
    complete: 'done',
    completed: 'done',
    success: 'done',
    finished: 'done',
    finish: 'done',
    error: 'blocked',
    failed: 'blocked',
    failure: 'blocked',
    needs_attention: 'blocked',
    needs_intervention: 'blocked',
    waiting_for_input: 'blocked',
    in_progress: 'working',
    pending: 'working',
    processing: 'working',
  })[normalized] || normalized;
}

function clean(value, max) {
  try { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max); } catch { return ''; }
}

function statusLabel(value) {
  if (value === 'blocked' || value === 'done') return value;
  try { return String(value || 'status'); } catch { return 'status'; }
}

export {
  PUSH_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  ATTENTION_VIEW,
  MAX_DEEPLINK_URL_LENGTH,
  DEEPLINK_FIELD_LIMITS,
  buildAttentionUrl,
  boundedMetadata,
  normaliseTtl,
  publicSubscription,
};
