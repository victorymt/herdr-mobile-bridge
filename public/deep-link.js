// Query-string parsing lives in a small, dependency-free module so the
// navigation contract can be tested without booting the dashboard DOM.

const MAX_PARAMETER_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const PARAMETER_LIMITS = Object.freeze({
  pane: 256,
  workspace: 256,
  event: 80,
  status: 32,
  agent: 120,
});

const STATUS_ALIASES = Object.freeze({
  complete: 'done',
  completed: 'done',
  success: 'done',
  finished: 'done',
  needs_attention: 'blocked',
  needs_intervention: 'blocked',
  waiting_for_input: 'blocked',
  processing: 'working',
  finish: 'done',
  error: 'blocked',
  failed: 'blocked',
  failure: 'blocked',
  in_progress: 'working',
  pending: 'working',
});

function parameter(params, name) {
  const value = params.get(name);
  if (value === null) return '';
  const trimmed = value.trim();
  const limit = PARAMETER_LIMITS[name] || MAX_PARAMETER_LENGTH;
  if (!trimmed || trimmed.length > limit || CONTROL_CHARACTERS.test(trimmed)) return '';
  return trimmed;
}

function normaliseStatus(value) {
  if (!value) return '';
  const key = value.toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_ALIASES[key] || key;
}

/**
 * Parse a notification/dashboard query string into safe display metadata.
 * URLSearchParams performs percent decoding; callers must still escape values
 * before inserting them into HTML. Invalid or oversized values are ignored.
 */
export function parseDeepLink(search = '') {
  let params;
  try {
    params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  } catch {
    return { view: '', pane: '', workspace: '', event: '', status: '', agent: '', hasContext: false };
  }
  const requestedView = parameter(params, 'view').toLowerCase();
  const pane = parameter(params, 'pane');
  const workspace = parameter(params, 'workspace');
  const event = parameter(params, 'event');
  const agent = parameter(params, 'agent');
  const status = normaliseStatus(parameter(params, 'status'));
  const view = requestedView === 'attention' || requestedView === 'output' || requestedView === 'focus'
    ? requestedView
    : '';
  return {
    view,
    pane,
    workspace,
    event,
    status,
    agent,
    // A pane/workspace is enough to retain a notification target even when a
    // stale/older sender omitted `view=attention`.
    hasContext: Boolean(pane || workspace),
  };
}

/** Build a same-origin action-panel URL for in-app links and tests. */
export function buildAttentionUrl(context = {}) {
  const params = new URLSearchParams();
  params.set('view', 'attention');
  const fields = Object.entries({
    pane: context.pane ?? context.pane_id,
    workspace: context.workspace ?? context.workspace_id,
    event: context.event,
    status: context.status,
    agent: context.agent,
  });
  for (const [key, value] of fields) {
    const text = String(value ?? '').trim();
    const limit = PARAMETER_LIMITS[key] || MAX_PARAMETER_LENGTH;
    if (text && text.length <= limit && !CONTROL_CHARACTERS.test(text)) params.set(key, text);
  }
  let candidate = `/?${params.toString()}`;
  if (candidate.length <= MAX_URL_LENGTH) return candidate;

  // Keep the location fields first; optional labels can be dropped if an
  // unusually long Unicode identifier expands beyond browser URL limits.
  for (const key of ['agent', 'status', 'event']) {
    params.delete(key);
    candidate = `/?${params.toString()}`;
    if (candidate.length <= MAX_URL_LENGTH) return candidate;
  }
  return candidate.length <= MAX_URL_LENGTH ? candidate : '/?view=attention';
}

export { MAX_PARAMETER_LENGTH, MAX_URL_LENGTH, PARAMETER_LIMITS };
