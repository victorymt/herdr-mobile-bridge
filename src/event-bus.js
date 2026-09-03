import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

export const STATUS_EVENTS = new Set(['pane_agent_status_changed', 'pane.agent_status_changed']);
export const DETECTED_EVENTS = new Set(['pane_agent_detected', 'pane.agent_detected']);
export const TERMINAL_STATUSES = new Set(['done', 'blocked']);
export const KNOWN_INTERNAL_EVENTS = new Set([
  ...STATUS_EVENTS,
  ...DETECTED_EVENTS,
  'pane_created', 'pane.created',
  'pane_updated', 'pane.updated',
  'pane_closed', 'pane.closed',
  'pane_focused', 'pane.focused',
  'pane_output_changed', 'pane.output_changed',
  'pane_exited', 'pane.exited',
  'workspace_created', 'workspace.created',
  'workspace_updated', 'workspace.updated',
  'workspace_focused', 'workspace.focused',
]);

function compact(value) {
  if (!value || typeof value !== 'object') return {};
  return value;
}

export function normalizeEventName(value) {
  if (value && typeof value === 'object') {
    return normalizeEventName(value.event || value.type || value.name);
  }
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.replace(/[.\s-]+/g, '_');
}

export function normalizeStatus(value) {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    complete: 'done',
    completed: 'done',
    success: 'done',
    finished: 'done',
    finish: 'done',
    error: 'blocked',
    failed: 'blocked',
    failure: 'blocked',
    in_progress: 'working',
    pending: 'working',
  };
  return aliases[normalized] || normalized;
}

function sourceData(payload) {
  const rawEvent = payload?.event;
  const eventObject = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
  // Hooks may send a serialized EventEnvelope (`event` + top-level `data`),
  // an object-valued `event` (`event.data`), or a plugin context alongside
  // either form. Accept all three wire shapes.
  const topLevelData = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const data = eventObject.data && typeof eventObject.data === 'object' ? eventObject.data : topLevelData;
  const context = payload?.context && typeof payload.context === 'object' ? payload.context : {};
  return { eventObject, data, context };
}

export function canonicalContext(payload, eventName) {
  const { eventObject, data, context } = sourceData(payload);
  const merged = { ...data, ...eventObject, ...context };
  // Avoid retaining the full nested event object in every SSE frame while
  // preserving unknown context fields supplied by a plugin hook.
  delete merged.data;
  delete merged.context;
  delete merged.event;
  delete merged.type;
  delete merged.name;
  const paneId = merged.pane_id || merged.focused_pane_id || merged.paneId;
  const workspaceId = merged.workspace_id || merged.workspaceId;
  const status = normalizeStatus(merged.agent_status ?? merged.agentStatus);
  const finalStatus = normalizeStatus(merged.final_status ?? merged.finalStatus);
  if (paneId !== undefined) merged.pane_id = String(paneId);
  if (workspaceId !== undefined) merged.workspace_id = String(workspaceId);
  if (status !== undefined) merged.agent_status = status;
  if (finalStatus !== undefined) merged.final_status = finalStatus;
  if (eventName === 'pane_agent_detected' && finalStatus === undefined && merged.released === true) {
    // A release without a final status is intentionally not terminal.
    delete merged.final_status;
  }
  // Event hooks are trusted local executables, but their context can contain
  // arbitrary plugin fields. Keep only the metadata the mobile bridge needs;
  // in particular never retain terminal text, `read`, or nested payloads.
  const allowed = new Set([
    'pane_id', 'workspace_id', 'tab_id', 'agent', 'display_agent', 'title',
    'agent_status', 'final_status', 'released', 'revision', 'seq', 'event_id',
    'state_labels',
  ]);
  const safe = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!allowed.has(key)) continue;
    if (['pane_id', 'workspace_id', 'tab_id', 'agent', 'display_agent', 'title', 'agent_status', 'final_status', 'event_id'].includes(key)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
      if (text) safe[key] = text;
    } else if (key === 'state_labels' && value && typeof value === 'object' && !Array.isArray(value)) {
      safe.state_labels = Object.fromEntries(Object.entries(value).slice(0, 32).flatMap(([name, label]) => {
        if (typeof label !== 'string') return [];
        const cleanName = String(name).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        const cleanLabel = label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
        return cleanName && cleanLabel ? [[cleanName, cleanLabel]] : [];
      }));
    } else if (key === 'released') {
      safe.released = value === true;
    } else if (key === 'revision' || key === 'seq') {
      const number = Number(value);
      if (Number.isFinite(number)) safe[key] = number;
    }
  }
  return safe;
}

function eventFingerprint(payload, eventName, context) {
  const explicit = payload?.event_id ?? payload?.eventId ?? payload?.id ?? context.event_id ?? context.eventId;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    const bounded = String(explicit).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
    if (bounded) return `id:${eventName}:${bounded}`;
  }
  // Herdr's plugin EventEnvelope currently has no event identifier. Hash the
  // complete sanitized context so metadata-only status updates (title,
  // display agent, or state labels) are not mistaken for duplicates. Sort
  // keys, including nested labels, because equivalent JSON payloads may arrive
  // with a different property order.
  const stableContext = Object.fromEntries(
    Object.entries(context)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        key === 'state_labels' && value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
          : value,
      ]),
  );
  const stable = { event: eventName, context: stableContext };
  return `hash:${createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}

/** Bounded in-process event fanout with optional durable deduplication. */
export class EventBus {
  constructor(options = {}) {
    this.store = options.store;
    this.pushManager = options.pushManager;
    this.clock = options.clock || (() => Date.now());
    this.maxReplay = options.maxReplay || 256;
    this.events = [];
    this.nextSeq = 1;
    this.generation = options.generation || randomUUID();
    this.emitter = new EventEmitter();
    this.socketPath = options.socketPath;
    this.onSocketPath = options.onSocketPath;
    this.logger = options.logger || console;
    this.processing = Promise.resolve();
  }

  publish(envelope) {
    const value = {
      id: envelope.id || String(this.nextSeq),
      seq: envelope.seq || this.nextSeq,
      event: envelope.event,
      context: compact(envelope.context),
      socket_path: envelope.socket_path,
      received_at: envelope.received_at || new Date(this.clock()).toISOString(),
    };
    this.nextSeq = Math.max(this.nextSeq + 1, Number(value.seq) + 1);
    this.events.push(value);
    if (this.events.length > this.maxReplay) this.events.splice(0, this.events.length - this.maxReplay);
    this.emitter.emit('event', value);
    return value;
  }

  subscribe(listener) {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  getSince(lastEventId) {
    const numeric = Number(lastEventId);
    if (!Number.isFinite(numeric)) return [...this.events];
    return this.events.filter((event) => Number(event.seq) > numeric);
  }

  replaySince(lastEventId, generation) {
    if (generation && generation !== this.generation) return { events: [...this.events], gap: true, generation: this.generation };
    const numeric = Number(lastEventId);
    if (!Number.isFinite(numeric) || this.events.length === 0) return { events: this.getSince(lastEventId), gap: false };
    const oldest = Number(this.events[0]?.seq);
    return { events: this.getSince(lastEventId), gap: Number.isFinite(oldest) && numeric < oldest - 1, oldest, generation: this.generation };
  }

  latest() {
    return this.events.at(-1);
  }

  processIncoming(payload) {
    // Hook processes can arrive concurrently. Serialising the small state
    // transition prevents two terminal events from both winning the same
    // pane-status deduplication check.
    const run = this.processing.then(() => this.#processIncoming(payload), () => this.#processIncoming(payload));
    this.processing = run.catch(() => {});
    return run;
  }

  async #processIncoming(payload) {
    if (!payload || typeof payload !== 'object') throw new EventInputError('event body must be an object');
    const eventValue = payload.event;
    const eventName = normalizeEventName(eventValue);
    if (!eventName) throw new EventInputError('event is required');
    if (!KNOWN_INTERNAL_EVENTS.has(eventValue) && !KNOWN_INTERNAL_EVENTS.has(eventName)) {
      throw new EventInputError(`unsupported internal event: ${String(eventValue)}`);
    }
    const context = canonicalContext(payload, eventName);
    const dedupKey = eventFingerprint(payload, eventName, context);
    if (this.store && !(await this.store.markSeen(dedupKey))) {
      return { accepted: true, duplicate: true, dedup_key: dedupKey, event: eventName };
    }

    const socketPath = payload.socket_path || payload.socketPath || this.socketPath;
    if (socketPath && typeof this.onSocketPath === 'function') {
      try {
        this.onSocketPath(socketPath);
      } catch (error) {
        this.logger.warn?.('ignoring invalid socket path from event hook', error);
      }
    }
    const envelope = this.publish({
      id: payload.event_id || payload.eventId || randomUUID(),
      event: eventName,
      context,
      socket_path: socketPath,
      received_at: new Date(this.clock()).toISOString(),
    });

    let previousStatus;
    const statusEvent = (STATUS_EVENTS.has(eventName) || DETECTED_EVENTS.has(eventName)) && context.pane_id;
    if (this.store && statusEvent) {
      try {
        previousStatus = (await this.store.listPaneStatuses())[context.pane_id];
      } catch { /* status persistence is best effort */ }
    }

    const status = eventName === 'pane_agent_detected' ? context.final_status : context.agent_status;
    const terminal = TERMINAL_STATUSES.has(status);
    const agent = context.agent || context.display_agent || '';
    // Compare against the pane's current status, not only the historical
    // notification marker. The marker intentionally survives a terminal
    // event, but a done -> working -> done lifecycle must notify again even
    // though StateStore keeps the last-notified fields when partial updates
    // omit them.
    const previousCurrentStatus = eventName === 'pane_agent_detected'
      ? previousStatus?.final_status
      : previousStatus?.agent_status;
    const shouldNotify = terminal && (
      !previousStatus
      || previousCurrentStatus !== status
      || previousStatus.last_notified_agent !== agent
    );

    if (this.store && statusEvent) {
      try {
        // A detector release explicitly ends the detected lifecycle. Clear a
        // previously persisted terminal result instead of letting a partial
        // release payload inherit the old `final_status` forever.
        const persistedContext = eventName === 'pane_agent_detected' && context.released === true && context.final_status === undefined
          ? { ...context, final_status: null }
          : context;
        await this.store.setPaneStatus(context.pane_id, {
          ...persistedContext,
          ...(shouldNotify ? { last_notified_status: status, last_notified_agent: agent } : {}),
          updated_at: envelope.received_at,
        });
      } catch (error) {
        this.logger.warn?.('failed to persist Herdr pane status', error);
      }
    }

    let push = null;
    if (statusEvent && shouldNotify) {
      if (this.pushManager) {
        try {
          push = await this.pushManager.notify(envelope);
        } catch (error) {
          this.logger.warn?.('failed to deliver Herdr bridge push notification', error);
          push = { attempted: 0, delivered: 0, error: error?.message || String(error) };
        }
      }
    }
    return { accepted: true, duplicate: false, dedup_key: dedupKey, event: eventName, envelope, push };
  }
}

export class EventInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventInputError';
    this.code = 'invalid_event';
  }
}

export { eventFingerprint };
