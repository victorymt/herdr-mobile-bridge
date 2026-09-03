import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';

const MAX_SUBSCRIPTIONS = 256;
const MAX_DEDUP_ENTRIES = 4096;
const MAX_PANE_STATUSES = 512;
const DEDUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function boundedLimit(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function safeId(value) {
  return `sub_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function validSubscriptionShape(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.endpoint !== 'string' || value.endpoint.length < 8 || value.endpoint.length > 4096) return false;
  let url;
  try {
    url = new URL(value.endpoint);
  } catch {
    return false;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
  if (value.keys !== undefined) {
    if (!value.keys || typeof value.keys !== 'object') return false;
    if (value.keys.p256dh !== undefined && (typeof value.keys.p256dh !== 'string' || value.keys.p256dh.length > 2048)) return false;
    if (value.keys.auth !== undefined && (typeof value.keys.auth !== 'string' || value.keys.auth.length > 2048)) return false;
  }
  return true;
}

/** Small JSON state store. It intentionally has no field for terminal output. */
export class StateStore {
  constructor(options = {}) {
    this.stateDir = options.stateDir;
    this.subscriptionsPath = options.subscriptionsPath || (this.stateDir && `${this.stateDir}/subscriptions.json`);
    this.dedupPath = options.dedupPath || (this.stateDir && `${this.stateDir}/dedup.json`);
    this.runtimePath = options.runtimePath || (this.stateDir && `${this.stateDir}/runtime.json`);
    this.clock = options.clock || (() => Date.now());
    this.maxSubscriptions = boundedLimit(options.maxSubscriptions, MAX_SUBSCRIPTIONS, MAX_SUBSCRIPTIONS);
    this.maxDedupEntries = boundedLimit(options.maxDedupEntries, MAX_DEDUP_ENTRIES, MAX_DEDUP_ENTRIES);
    this.maxPaneStatuses = boundedLimit(options.maxPaneStatuses, MAX_PANE_STATUSES, MAX_PANE_STATUSES);
    this.dedupTtlMs = options.dedupTtlMs || DEDUP_TTL_MS;
    this.subscriptions = new Map();
    this.dedup = new Map();
    this.runtime = {};
    this.paneStatuses = new Map();
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.initialized) return this;
    if (!this.stateDir) throw new Error('stateDir is required');
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    // An existing state directory may have been created by an older release
    // (or by a umask that was more permissive than intended). Re-apply the
    // owner-only mode on every initialization so subscriptions and runtime
    // metadata do not become readable by other local users.
    try {
      await chmod(this.stateDir, 0o700);
    } catch {
      // Best effort on filesystems without POSIX permission bits.
    }
    await this.#loadSubscriptions();
    await this.#loadDedup();
    await this.#loadRuntime();
    this.initialized = true;
    return this;
  }

  async #loadSubscriptions() {
    const raw = await readJson(this.subscriptionsPath, []);
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.subscriptions) ? raw.subscriptions : []);
    for (const candidate of list.slice(0, this.maxSubscriptions)) {
      if (!validSubscriptionShape(candidate)) continue;
      const normalized = normalizeSubscription(candidate);
      this.subscriptions.set(normalized.id, normalized);
    }
  }

  async #loadDedup() {
    const raw = await readJson(this.dedupPath, {});
    const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const cutoff = this.clock() - this.dedupTtlMs;
    let processed = 0;
    for (const [key, stamp] of Object.entries(entries)) {
      if (processed >= this.maxDedupEntries) break;
      processed += 1;
      const value = Number(stamp);
      if (Number.isFinite(value) && value >= cutoff) {
        this.dedup.set(key, value);
      }
    }
    this.#trimDedup();
  }

  async #loadRuntime() {
    const raw = await readJson(this.runtimePath, {});
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    this.runtime = sanitizeRuntime(source);
    const statuses = source.pane_statuses;
    if (statuses && typeof statuses === 'object' && !Array.isArray(statuses)) {
      let processed = 0;
      for (const [paneId, value] of Object.entries(statuses)) {
        if (processed >= this.maxPaneStatuses) break;
        processed += 1;
        const clean = sanitizePaneStatus(paneId, value);
        if (clean) {
          this.paneStatuses.set(clean.pane_id, clean);
        }
      }
    }
    this.runtime.pane_statuses = Object.fromEntries(this.paneStatuses);
  }

  async #persistSubscriptions() {
    await this.#writeJson(this.subscriptionsPath, [...this.subscriptions.values()]);
  }

  async #persistDedup() {
    await this.#writeJson(this.dedupPath, Object.fromEntries(this.dedup));
  }

  async #persistRuntime() {
    await this.#writeJson(this.runtimePath, this.runtime);
  }

  async #writeJson(path, value) {
    if (!path) return;
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
    await rename(temporary, path);
    try {
      await chmod(path, 0o600);
    } catch {
      // Best effort.
    }
  }

  #trimDedup() {
    const cutoff = this.clock() - this.dedupTtlMs;
    for (const [key, stamp] of this.dedup) {
      if (stamp < cutoff) this.dedup.delete(key);
    }
    while (this.dedup.size > this.maxDedupEntries) {
      const first = this.dedup.keys().next().value;
      if (first === undefined) break;
      this.dedup.delete(first);
    }
  }

  #enqueue(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  async hasSeen(key) {
    await this.init();
    const stamp = this.dedup.get(String(key));
    if (stamp === undefined) return false;
    if (stamp < this.clock() - this.dedupTtlMs) {
      this.dedup.delete(String(key));
      return false;
    }
    return true;
  }

  /** Atomically check and record a deduplication key. */
  async markSeen(key) {
    await this.init();
    return this.#enqueue(async () => {
      const normalized = String(key);
      const now = this.clock();
      this.#trimDedup();
      if (this.dedup.has(normalized)) return false;
      this.dedup.set(normalized, now);
      this.#trimDedup();
      await this.#persistDedup();
      return true;
    });
  }

  async listSubscriptions() {
    await this.init();
    return clone([...this.subscriptions.values()]);
  }

  async addSubscription(value) {
    await this.init();
    if (!validSubscriptionShape(value)) throw new Error('invalid push subscription');
    return this.#enqueue(async () => {
      const normalized = normalizeSubscription(value);
      // One endpoint represents one device; replacing it avoids duplicate
      // notifications when a browser refreshes its subscription.
      for (const [id, existing] of this.subscriptions) {
        if (existing.endpoint === normalized.endpoint && id !== normalized.id) this.subscriptions.delete(id);
      }
      this.subscriptions.set(normalized.id, normalized);
      while (this.subscriptions.size > this.maxSubscriptions) {
        const first = this.subscriptions.keys().next().value;
        if (first === undefined) break;
        this.subscriptions.delete(first);
      }
      await this.#persistSubscriptions();
      return clone(normalized);
    });
  }

  async removeSubscription(criteria = {}) {
    await this.init();
    return this.#enqueue(async () => {
      let removed = false;
      const id = criteria.id && String(criteria.id);
      const endpoint = criteria.endpoint && String(criteria.endpoint);
      for (const [key, value] of this.subscriptions) {
        if ((id && key === id) || (endpoint && value.endpoint === endpoint)) {
          this.subscriptions.delete(key);
          removed = true;
        }
      }
      if (removed) await this.#persistSubscriptions();
      return removed;
    });
  }

  async getRuntime() {
    await this.init();
    return clone(this.runtime);
  }

  async setRuntime(value) {
    await this.init();
    return this.#enqueue(async () => {
      const next = sanitizeRuntime(value);
      // The gateway refreshes runtime metadata after startup without knowing
      // the launcher's process identity fields. Preserve those fields only
      // while the PID remains the same; clearRuntime({}) drops them.
      if (next.pid && this.runtime.pid === next.pid) {
        for (const key of ['entry', 'process_start_time']) {
          if (next[key] === undefined && this.runtime[key] !== undefined) next[key] = this.runtime[key];
        }
      }
      this.runtime = next;
      this.runtime.pane_statuses = Object.fromEntries(this.paneStatuses);
      await this.#persistRuntime();
      return clone(this.runtime);
    });
  }

  async clearRuntime() {
    await this.init();
    this.paneStatuses.clear();
    return this.setRuntime({});
  }

  async listPaneStatuses() {
    await this.init();
    return clone(Object.fromEntries(this.paneStatuses));
  }

  /** Persist compact agent facts, never terminal output. */
  async setPaneStatus(paneId, value) {
    await this.init();
    const normalizedPaneId = boundedString(paneId, 256);
    if (!normalizedPaneId) return;
    return this.#enqueue(async () => {
      const previous = this.paneStatuses.get(normalizedPaneId) || {};
      const safe = value && typeof value === 'object' ? {
        pane_id: normalizedPaneId,
        workspace_id: mergeString(value, 'workspace_id', previous.workspace_id, 256),
        agent: mergeString(value, 'agent', previous.agent, 120),
        agent_status: mergeString(value, 'agent_status', previous.agent_status, 32),
        final_status: mergeString(value, 'final_status', previous.final_status, 32),
        title: mergeString(value, 'title', previous.title, 160),
        display_agent: mergeString(value, 'display_agent', previous.display_agent, 120),
        state_labels: mergeLabels(value, 'state_labels', previous.state_labels),
        last_notified_status: mergeString(value, 'last_notified_status', previous.last_notified_status, 32),
        last_notified_agent: mergeString(value, 'last_notified_agent', previous.last_notified_agent, 120),
        updated_at: boundedString(value.updated_at, 64) || new Date(this.clock()).toISOString(),
      } : { pane_id: normalizedPaneId, updated_at: new Date(this.clock()).toISOString() };
      // Strip undefined values and cap labels to keep runtime.json bounded.
      for (const key of Object.keys(safe)) if (safe[key] === undefined) delete safe[key];
      if (safe.state_labels && typeof safe.state_labels === 'object') {
        safe.state_labels = Object.fromEntries(Object.entries(safe.state_labels).slice(0, 32));
      }
      this.paneStatuses.set(normalizedPaneId, safe);
      while (this.paneStatuses.size > this.maxPaneStatuses) {
        const first = this.paneStatuses.keys().next().value;
        if (first === undefined) break;
        this.paneStatuses.delete(first);
      }
      this.runtime.pane_statuses = Object.fromEntries(this.paneStatuses);
      await this.#persistRuntime();
      return clone(safe);
    });
  }
}

function boundedString(value, max) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function boundedLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, label] of Object.entries(value).slice(0, 32)) {
    const cleanKey = boundedString(key, 64);
    const cleanLabel = boundedString(label, 160);
    if (cleanKey && cleanLabel) result[cleanKey] = cleanLabel;
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizePaneStatus(paneId, value) {
  const normalizedPaneId = boundedString(paneId, 256);
  if (!normalizedPaneId || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const safe = {
    pane_id: normalizedPaneId,
    workspace_id: boundedString(value.workspace_id, 256),
    agent: boundedString(value.agent, 120),
    agent_status: boundedString(value.agent_status, 32),
    final_status: boundedString(value.final_status, 32),
    title: boundedString(value.title, 160),
    display_agent: boundedString(value.display_agent, 120),
    state_labels: boundedLabels(value.state_labels),
    last_notified_status: boundedString(value.last_notified_status, 32),
    last_notified_agent: boundedString(value.last_notified_agent, 120),
    updated_at: boundedString(value.updated_at, 64),
  };
  for (const key of Object.keys(safe)) if (safe[key] === undefined) delete safe[key];
  return safe;
}

function sanitizeRuntime(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const safe = {};
  if (Number.isInteger(Number(source.pid)) && Number(source.pid) > 0) safe.pid = Number(source.pid);
  if (Number.isInteger(Number(source.launcher_pid)) && Number(source.launcher_pid) > 0) safe.launcher_pid = Number(source.launcher_pid);
  const host = boundedString(source.host, 255);
  if (host) safe.host = host;
  const port = Number(source.port);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) safe.port = port;
  const socketPath = boundedString(source.socket_path, 4096);
  if (socketPath && socketPath.startsWith('/') && !socketPath.includes('\\')) safe.socket_path = socketPath;
  const entry = boundedString(source.entry, 4096);
  if (entry && entry.startsWith('/') && !entry.includes('\\')) safe.entry = entry;
  const processStartTime = boundedString(source.process_start_time, 64);
  if (processStartTime && /^\d+$/.test(processStartTime)) safe.process_start_time = processStartTime;
  const startedAt = boundedString(source.started_at, 64);
  if (startedAt) safe.started_at = startedAt;
  // LAN proxy metadata is used by the launcher to distinguish a healthy
  // bridge process from one whose optional forwarding listener has exited.
  // Keep this explicit, bounded allowlist separate from credentials and never
  // persist arbitrary proxy/runtime fields.
  if (typeof source.lan_proxy_running === 'boolean') safe.lan_proxy_running = source.lan_proxy_running;
  const lanProxyHost = boundedString(source.lan_proxy_host, 255);
  if (lanProxyHost && lanProxyHost !== '0.0.0.0' && lanProxyHost !== '::') safe.lan_proxy_host = lanProxyHost;
  const lanProxyPort = Number(source.lan_proxy_port);
  if (Number.isInteger(lanProxyPort) && lanProxyPort >= 1 && lanProxyPort <= 65535) safe.lan_proxy_port = lanProxyPort;
  const lanProxyError = boundedString(source.lan_proxy_error, 240);
  if (lanProxyError) safe.lan_proxy_error = lanProxyError;
  return safe;
}

/**
 * Merge a bounded string while preserving omitted fields and allowing an
 * explicit `null` to clear a stale value. Empty/invalid strings are treated
 * as omitted; hooks can use null when they intentionally want to erase a
 * previously persisted field.
 */
function mergeString(value, key, previous, max) {
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    if (value[key] === null) return undefined;
    const bounded = boundedString(value[key], max);
    if (bounded !== undefined) return bounded;
  }
  return previous;
}

/** Same merge semantics as mergeString for compact state-label maps. */
function mergeLabels(value, key, previous) {
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    if (value[key] === null) return undefined;
    const bounded = boundedLabels(value[key]);
    if (bounded !== undefined) return bounded;
    // An explicitly supplied empty object is a useful clear operation.
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) return undefined;
  }
  return previous;
}

function normalizeSubscription(value) {
  const endpoint = value.endpoint.trim();
  const id = String(value.id || safeId(endpoint));
  const result = {
    id: id.slice(0, 128),
    endpoint,
  };
  if (value.expirationTime !== undefined && value.expirationTime !== null) result.expirationTime = value.expirationTime;
  if (value.keys && typeof value.keys === 'object') {
    result.keys = {};
    if (typeof value.keys.p256dh === 'string') result.keys.p256dh = value.keys.p256dh;
    if (typeof value.keys.auth === 'string') result.keys.auth = value.keys.auth;
  }
  if (value.device_id || value.deviceId) result.device_id = String(value.device_id || value.deviceId).slice(0, 256);
  return result;
}

async function readJson(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    // Corrupt optional state should not stop the bridge; keep a backup-free
    // empty in-memory state and overwrite it on the next mutation.
    return fallback;
  }
}

export {
  normalizeSubscription,
  validSubscriptionShape,
  safeId,
  boundedString,
  boundedLabels,
  mergeString,
  mergeLabels,
  sanitizePaneStatus,
  sanitizeRuntime,
  MAX_SUBSCRIPTIONS,
  MAX_DEDUP_ENTRIES,
  MAX_PANE_STATUSES,
};
