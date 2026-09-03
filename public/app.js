import { parseDeepLink } from './deep-link.js';

const $ = (id) => document.getElementById(id);

const model = {
  authenticated: false,
  connected: false,
  snapshot: null,
  panes: [],
  workspaces: [],
  output: '',
  selectedPane: '',
  controlBusy: false,
  activeView: 'overview',
  attention: null,
  deepLink: null,
  outputError: '',
  outputLoading: false,
  outputRequest: 0,
  stream: null,
  retryTimer: null,
  toastTimer: null,
};

const STATUS_LABELS = {
  working: '运行中',
  blocked: '需要介入',
  done: '已完成',
  idle: '空闲',
  waiting: '等待中',
  unknown: '未知',
};

const EVENT_LABELS = {
  pane_agent_status_changed: '智能体状态变化',
  pane_agent_detected: '检测到智能体',
  pane_output_changed: '窗格输出变化',
};

const STATUS_ALIASES = {
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
};

function statusKey(value) {
  const key = String(value || 'unknown').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_ALIASES[key] || key || 'unknown';
}

function statusLabel(value) {
  const key = statusKey(value);
  return STATUS_LABELS[key] || key;
}

function eventLabel(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[.\s-]+/g, '_');
  return EVENT_LABELS[key] || (key || '状态通知');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char]));
}

function csrfToken() {
  const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('XSRF-TOKEN='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice('XSRF-TOKEN='.length)); } catch { return ''; }
}

function setConnection(connected) {
  model.connected = connected;
  $('status-dot').classList.toggle('offline', !connected);
  $('connection-label').textContent = connected ? '已连接' : '离线';
  $('offline-banner').hidden = connected;
}

function showToast(message, duration = 3200) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(model.toastTimer);
  model.toastTimer = setTimeout(() => { node.hidden = true; }, duration);
}

function setAuthenticated(value) {
  model.authenticated = value;
  $('login-screen').hidden = value;
  $('app-shell').hidden = !value;
}

async function discoverBridge() {
  const status = $('discovery-status');
  const urls = $('discovery-urls');
  if (!status || !urls) return;
  status.textContent = '正在检测局域网地址…';
  urls.replaceChildren();
  try {
    const data = await api('/api/discovery');
    const info = data?.lan_proxy || {};
    const candidates = Array.isArray(info.urls) ? info.urls : [];
    status.textContent = info.running && candidates.length ? '服务已就绪，请选择手机可访问的地址。' : '暂未发现可用的局域网地址。';
    for (const value of candidates) {
      try { if (!/^https?:\/\//i.test(value)) continue; } catch { continue; }
      const row = document.createElement('div');
      row.className = 'discovery-url';
      row.innerHTML = `<code>${escapeHtml(value)}</code><button type="button" class="secondary-button" data-copy-url="${escapeHtml(value)}">复制</button>`;
      urls.append(row);
    }
    const secure = data?.request?.secure;
    $('discovery-hint').textContent = secure === false
      ? '当前使用 HTTP 明文连接，仅适用于可信局域网；请勿在公共网络使用。二维码不会包含访问令牌。'
      : (data?.hints?.vpn_bypass || '二维码不会包含访问令牌。请确认手机与电脑在同一网络。');
  } catch (error) {
    status.textContent = error.message || '检测失败，请确认桥接服务正在运行。';
  }
}

async function responseJson(response) {
  let body = {};
  try { body = await response.json(); } catch { /* empty response */ }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }
  const response = await fetch(path, { ...options, method, headers, credentials: 'include' });
  return responseJson(response);
}

function paneDisplayName(pane, index = 0) {
  return pane?.display_agent || pane?.agent || pane?.label || pane?.title || pane?.pane_id || `窗格 ${index + 1}`;
}

function paneStatus(pane) {
  return statusKey(pane?.agent_status || pane?.final_status || pane?.status || 'unknown');
}

function renderStatusGrid(data) {
  const focusedPane = data.panes?.find((pane) => pane.pane_id === data.focused_pane_id);
  const persisted = data.pane_statuses?.[data.focused_pane_id];
  const status = paneStatus(focusedPane) !== 'unknown'
    ? paneStatus(focusedPane)
    : paneStatus(persisted) !== 'unknown' ? paneStatus(persisted) : 'idle';
  const currentWorkspace = data.workspaces?.find((item) => item.workspace_id === data.focused_workspace_id);
  const values = [
    ['运行状态', statusLabel(status), ['working', 'done'].includes(status) ? 'good' : ''],
    ['工作区', currentWorkspace?.label || data.focused_workspace_id || '未选择', ''],
    ['窗格数量', String(data.panes?.length || 0), ''],
    ['协议', data.protocol ? `v${data.protocol}` : '—', ''],
  ];
  $('status-grid').innerHTML = values.map(([key, value, className]) => `<div class="status-item"><span>${escapeHtml(key)}</span><strong class="${className}">${escapeHtml(value)}</strong></div>`).join('');
}

function renderOutput() {
  const text = model.output || '';
  const message = model.outputLoading
    ? '正在读取…'
    : model.outputError || text || '选择一个窗格后读取最近输出。';
  $('output-preview').textContent = model.outputLoading ? '正在读取…' : (text || '暂无输出');
  $('output-console').textContent = message;
  $('output-console').scrollTop = $('output-console').scrollHeight;
  const attentionConsole = $('attention-output-console');
  if (attentionConsole) {
    const attentionMessage = message === '选择一个窗格后读取最近输出。'
      ? (model.attention?.pane ? '暂无输出' : '正在等待通知目标…')
      : message;
    attentionConsole.textContent = attentionMessage;
    attentionConsole.scrollTop = attentionConsole.scrollHeight;
  }
  const attentionError = $('attention-error');
  if (attentionError) {
    attentionError.textContent = model.outputError && !model.outputLoading ? model.outputError : '';
  }
}

function renderPaneSelect() {
  const current = model.selectedPane;
  const available = model.panes.some((pane) => pane.pane_id === current);
  let options = '<option value="">选择窗格</option>' + model.panes.map((pane, index) => `<option value="${escapeHtml(pane.pane_id || '')}">${escapeHtml(paneDisplayName(pane, index))} · ${escapeHtml(statusLabel(paneStatus(pane)))}</option>`).join('');
  if (current && !available) options += `<option value="${escapeHtml(current)}" disabled>通知目标不可用 · ${escapeHtml(current)}</option>`;
  for (const select of [$('output-pane'), $('control-pane')].filter(Boolean)) {
    select.innerHTML = options;
    if (current) select.value = current;
  }
  const target = model.panes.find((pane) => pane.pane_id === current);
  const hint = $('control-target-hint');
  if (hint) hint.textContent = target
    ? `${paneDisplayName(target)} · ${statusLabel(paneStatus(target))}`
    : current
      ? '通知目标已不可用，请刷新状态或选择其他窗格。'
      : '先选择一个窗格。';
  for (const button of [$('prompt-button'), $('input-text-button'), ...document.querySelectorAll('[data-input-key]')].filter(Boolean)) {
    button.disabled = !current || !available || model.controlBusy;
  }
  const attentionFocus = $('attention-focus-button');
  if (attentionFocus) attentionFocus.disabled = !current || !available;
}

function attentionStatus() {
  const requested = model.attention?.status;
  if (requested) return statusKey(requested);
  const pane = model.panes.find((item) => item.pane_id === model.attention?.pane);
  return paneStatus(pane);
}

function attentionDetail(status, pane, paneId) {
  let detail = status === 'blocked'
    ? '智能体正在等待你的交互输入。'
    : status === 'done'
      ? '最近任务已完成，可查看输出或继续发送后续任务。'
      : status === 'working'
        ? '智能体正在处理任务，下面显示最近的窗格输出。'
        : '从通知打开的目标已准备好查看和操作。';
  if (paneId && !pane) detail += ' 该窗格可能已经关闭，请刷新状态后重试。';
  return detail;
}

function renderAttention() {
  const attention = model.attention;
  const tab = $('tab-attention');
  if (!attention) {
    if (tab) tab.hidden = true;
    return;
  }
  const pane = model.panes.find((item) => item.pane_id === attention.pane);
  if (tab) {
    tab.hidden = false;
    const badge = $('attention-tab-badge');
    if (badge) badge.textContent = attentionStatus() === 'done' ? '✓' : '!';
  }
  const status = attentionStatus();
  const summaryIcon = $('attention-summary')?.querySelector('.attention-summary-icon');
  if (summaryIcon) {
    summaryIcon.textContent = status === 'done' ? '✓' : '!';
    summaryIcon.classList.toggle('is-done', status === 'done');
  }
  const statusNode = $('attention-status');
  if (statusNode) {
    statusNode.textContent = statusLabel(status);
    statusNode.dataset.status = status || 'unknown';
  }
  const heading = $('attention-heading');
  if (heading) heading.textContent = status === 'blocked' ? '需要你的关注' : status === 'done' ? '任务已完成' : '会话状态更新';
  const agent = attention.agent || pane?.display_agent || pane?.agent || 'Herdr 会话';
  const detail = attentionDetail(status, pane, attention.pane);
  if ($('attention-agent')) $('attention-agent').textContent = agent;
  if ($('attention-detail')) $('attention-detail').textContent = detail;
  if ($('attention-pane')) $('attention-pane').textContent = attention.pane || '未提供';
  if ($('attention-workspace')) $('attention-workspace').textContent = attention.workspace || pane?.workspace_id || '未提供';
  if ($('attention-event')) $('attention-event').textContent = eventLabel(attention.event);
  const focus = $('attention-focus-button');
  if (focus) focus.disabled = !attention.pane || !model.panes.some((pane) => pane.pane_id === attention.pane);
  renderOutput();
}

function renderFocus() {
  const list = $('focus-list');
  renderWorkspaces();
  if (!model.panes.length) {
    list.innerHTML = '<div class="empty-state">暂无可聚焦的窗格</div>';
    renderPaneSelect();
    return;
  }
  list.innerHTML = model.panes.map((pane, index) => {
    const id = pane.pane_id || '';
    const active = id === model.snapshot?.focused_pane_id;
    return `<div class="focus-item"><div><strong>${escapeHtml(paneDisplayName(pane, index))}</strong><small>${escapeHtml(statusLabel(paneStatus(pane)))}${active ? ' · 当前聚焦' : ''}${pane.workspace_id ? ` · ${escapeHtml(pane.workspace_id)}` : ''}</small></div><button type="button" data-focus-pane="${escapeHtml(id)}" ${active ? 'disabled' : ''}>${active ? '已聚焦' : '聚焦'}</button></div>`;
  }).join('');
  renderPaneSelect();
}

function renderWorkspaces() {
  const list = $('workspace-list');
  if (!list) return;
  if (!model.workspaces.length) { list.innerHTML = '<div class="empty-state">暂无可聚焦的工作区</div>'; return; }
  const focused = model.snapshot?.focused_workspace_id;
  list.innerHTML = model.workspaces.map((workspace, index) => {
    const id = workspace.workspace_id || workspace.id || '';
    const label = workspace.label || workspace.name || `工作区 ${index + 1}`;
    const active = id === focused;
    return `<div class="focus-item"><div><strong>${escapeHtml(label)}</strong><small>${active ? '当前聚焦' : `${workspace.pane_count ?? workspace.panes?.length ?? 0} 个窗格`}</small></div><button type="button" data-focus-workspace="${escapeHtml(id)}" ${active ? 'disabled' : ''}>${active ? '已聚焦' : '聚焦'}</button></div>`;
  }).join('');
}

function render(data) {
  const body = data && typeof data === 'object' ? data : {};
  const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : body;
  model.snapshot = snapshot;
  model.panes = Array.isArray(body.panes || snapshot.panes) ? (body.panes || snapshot.panes) : [];
  model.workspaces = Array.isArray(body.workspaces || snapshot.workspaces) ? (body.workspaces || snapshot.workspaces) : [];
  const focusedPaneId = body.focused_pane_id || snapshot.focused_pane_id;
  const attentionPane = model.attention?.pane;
  if (!model.selectedPane || (!model.panes.some((pane) => pane.pane_id === model.selectedPane) && !attentionPane)) {
    model.selectedPane = attentionPane || focusedPaneId || '';
  }
  const focusedPane = model.panes.find((pane) => pane.pane_id === focusedPaneId);
  const persisted = body.pane_statuses?.[focusedPaneId] || snapshot.pane_statuses?.[focusedPaneId];
  const liveStatus = paneStatus(focusedPane);
  const status = liveStatus !== 'unknown' ? liveStatus : paneStatus(persisted);
  $('app-shell').dataset.status = status || 'unknown';
  const persistedName = persisted?.display_agent || persisted?.agent || persisted?.title;
  $('agent-heading').textContent = focusedPane ? paneDisplayName(focusedPane) : (persistedName || model.workspaces.find((item) => item.workspace_id === (body.focused_workspace_id || snapshot.focused_workspace_id))?.label || 'Herdr 会话');
  $('agent-detail').textContent = status === 'working' ? '智能体正在处理任务…' : status === 'blocked' ? '智能体需要你的关注' : status === 'done' ? '最近任务已完成' : '当前没有运行中的任务';
  $('metric-state').textContent = statusLabel(status);
  $('metric-focus').textContent = body.focused_pane_id || snapshot.focused_pane_id || '未选择';
  $('metric-output').textContent = String(model.panes.length);
  const now = new Date();
  $('updated-at').textContent = `更新于 ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  $('updated-at').dateTime = now.toISOString();
  $('version-label').textContent = body.version ? `协议 v${body.protocol || '—'}` : '本地服务';
  renderStatusGrid({ ...snapshot, ...body, panes: model.panes, workspaces: model.workspaces, pane_statuses: body.pane_statuses || snapshot.pane_statuses });
  renderFocus();
  renderOutput();
  renderAttention();
}

async function refreshState({ quiet = false } = {}) {
  try {
    const data = await api('/api/state');
    render(data);
    setConnection(true);
    if (!quiet) $('refresh-button').classList.remove('is-spinning');
    return data;
  } catch (error) {
    if (error.status === 401) {
      setAuthenticated(false);
      closeStream();
      model.outputRequest += 1;
      model.outputLoading = false;
      model.output = '';
      model.outputError = '';
      renderOutput();
    }
    setConnection(false);
    if (!quiet && error.status !== 401) showToast(error.message || '无法读取 Herdr 状态');
    throw error;
  }
}

function closeStream() {
  if (model.stream) model.stream.close();
  model.stream = null;
}

function scheduleStreamRetry() {
  clearTimeout(model.retryTimer);
  model.retryTimer = setTimeout(() => { if (model.authenticated) connectStream(); }, 4000);
}

function connectStream() {
  if (!model.authenticated || !window.EventSource) return;
  closeStream();
  const stream = new EventSource('/api/stream', { withCredentials: true });
  model.stream = stream;
  stream.onopen = () => { setConnection(true); clearTimeout(model.retryTimer); };
  stream.onerror = () => { setConnection(false); scheduleStreamRetry(); };
  stream.onmessage = handleStreamEvent;
  stream.addEventListener('ready', () => setConnection(true));
  stream.addEventListener('pane_agent_status_changed', handleStreamEvent);
  stream.addEventListener('pane_agent_detected', handleStreamEvent);
}

function handleStreamEvent(event) {
  try {
    const payload = JSON.parse(event.data);
    if (payload.event === 'ready') return;
    // The stream carries sanitized metadata only. Refreshing obtains the
    // authoritative snapshot and keeps terminal output out of notifications.
    void refreshState({ quiet: true });
    const context = payload.context && typeof payload.context === 'object' ? payload.context : payload;
    if (model.attention && context.pane_id && context.pane_id === model.attention.pane) {
      const nextStatus = payload.event === 'pane_agent_detected'
        ? (context.final_status || context.agent_status)
        : (context.agent_status || context.final_status);
      if (nextStatus) model.attention.status = statusKey(nextStatus);
      if (context.agent || context.display_agent) model.attention.agent = context.agent || context.display_agent;
      renderAttention();
    }
    const currentStatus = statusKey(context.agent_status || context.final_status);
    const finalStatus = statusKey(context.final_status || context.agent_status);
    if (currentStatus === 'blocked' || finalStatus === 'blocked') showToast('有智能体需要介入');
    if (currentStatus === 'done' || finalStatus === 'done') showToast('智能体任务已完成');
  } catch { /* ignore malformed reconnect frames */ }
}

async function login(event) {
  event.preventDefault();
  const token = $('token').value.trim();
  if (!token) { $('login-error').textContent = '请输入访问令牌'; return; }
  const button = $('login-button');
  button.disabled = true;
  button.classList.add('is-loading');
  $('login-error').textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json' } });
    $('token').value = '';
    setAuthenticated(true);
    await refreshState({ quiet: true });
    connectStream();
    // A notification can open the login screen with a pane/workspace query
    // still attached. Apply it after the first authenticated snapshot too,
    // not only during the initial already-authenticated boot path.
    applyDeepLink();
  } catch (error) {
    // A successful token exchange can still be followed by an unavailable
    // Herdr socket. Return to the login surface in that case instead of
    // leaving an authenticated-looking shell with no state behind it.
    closeStream();
    setAuthenticated(false);
    $('login-error').textContent = error.status === 429 ? '尝试次数过多，请稍后再试' : (error.status === 403 ? '来源未被允许，请使用配置的 HTTPS 地址' : '令牌无效或服务不可用');
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
  closeStream();
  // Invalidate an in-flight output read and clear terminal text before the
  // authenticated shell is hidden. A late response must not repopulate the
  // dashboard after a subsequent login.
  model.outputRequest += 1;
  model.outputLoading = false;
  model.output = '';
  model.outputError = '';
  renderOutput();
  setAuthenticated(false);
  setConnection(false);
}

async function focusPane(id) {
  if (!id) return;
  try {
    await api('/api/focus/pane', { method: 'POST', body: JSON.stringify({ pane_id: id }) });
    model.selectedPane = id;
    await refreshState({ quiet: true });
    showToast('已聚焦窗格');
  } catch (error) { showToast(controlErrorMessage(error, '聚焦失败')); }
}

async function focusWorkspace(id) {
  if (!id) return;
  try {
    await api('/api/focus/workspace', { method: 'POST', body: JSON.stringify({ workspace_id: id }) });
    await refreshState({ quiet: true });
    showToast('已聚焦工作区');
  } catch (error) { showToast(error.message || '聚焦工作区失败'); }
}

async function loadPaneOutput(id = model.selectedPane, { view = 'output' } = {}) {
  if (!id) {
    if (view === 'attention') {
      model.outputLoading = false;
      model.outputError = '通知没有提供可读取的窗格。';
      renderOutput();
    } else showToast('请先选择窗格');
    return false;
  }
  model.selectedPane = id;
  model.output = '';
  model.outputError = '';
  model.outputLoading = true;
  const requestId = ++model.outputRequest;
  renderPaneSelect();
  renderAttention();
  renderOutput();
  try {
    const data = await api(`/api/panes/${encodeURIComponent(id)}/output?lines=80`);
    if (requestId !== model.outputRequest) return false;
    model.output = String(data.output ?? data.text ?? data.read?.text ?? '');
    model.outputError = '';
    model.outputLoading = false;
    renderOutput();
    renderAttention();
    if (view === 'output') switchView('output');
    return true;
  } catch (error) {
    if (requestId !== model.outputRequest) return false;
    model.outputLoading = false;
    model.outputError = error.status === 404
      ? '该窗格可能已关闭或当前不可访问。'
      : '读取失败，请稍后重试。';
    renderOutput();
    renderAttention();
    if (view === 'output') showToast(error.message || '无法读取窗格输出');
    return false;
  }
}

function byteLength(value) {
  try { return new TextEncoder().encode(String(value || '')).length; } catch { return String(value || '').length; }
}

function updateControlCounts() {
  const prompt = $('prompt-text');
  const input = $('input-text');
  if (prompt && $('prompt-count')) $('prompt-count').textContent = `${byteLength(prompt.value).toLocaleString('zh-CN')} / 32K`;
  if (input && $('input-count')) $('input-count').textContent = `${byteLength(input.value).toLocaleString('zh-CN')} / 8K`;
}

function clearControlError(id) {
  const node = $(id);
  if (node) node.textContent = '';
}

function setControlBusy(value) {
  model.controlBusy = Boolean(value);
  renderPaneSelect();
  $('prompt-button')?.classList.toggle('is-loading', model.controlBusy && $('prompt-button')?.dataset.busy === 'true');
}

function controlErrorMessage(error, fallback) {
  const code = error?.payload?.error?.code;
  const messages = {
    agent_blocked: '该智能体正等待交互，请使用下面的终端输入。',
    agent_not_ready: '该窗格中的智能体尚未准备好接收任务。',
    agent_not_found: '找不到该智能体，请刷新状态后重试。',
    pane_not_found: '找不到该窗格，请刷新状态后重试。',
    invalid_key: '该按键不受支持。',
    empty_agent_prompt: '请输入任务内容。',
    pane_send_failed: '终端暂时无法接收输入。',
  };
  return messages[code] || error?.message || fallback;
}

async function sendAgentPrompt(event) {
  event.preventDefault();
  const paneId = model.selectedPane;
  const text = $('prompt-text')?.value || '';
  clearControlError('prompt-error');
  if (!paneId) { $('prompt-error').textContent = '请先选择目标窗格。'; return; }
  if (!text.trim()) { $('prompt-error').textContent = '请输入任务内容。'; return; }
  const pane = model.panes.find((item) => item.pane_id === paneId);
  const name = pane ? paneDisplayName(pane) : paneId;
  if (typeof window.confirm === 'function' && !window.confirm(`将任务发送到“${name}”吗？\n\n${text.slice(0, 180)}${text.length > 180 ? '…' : ''}`)) return;
  const button = $('prompt-button');
  button.disabled = true;
  button.dataset.busy = 'true';
  button.classList.add('is-loading');
  model.controlBusy = true;
  try {
    await api('/api/control/prompt', { method: 'POST', body: JSON.stringify({ pane_id: paneId, text }) });
    $('prompt-text').value = '';
    updateControlCounts();
    showToast('任务已发送');
    // The command has already been accepted at this point.  A transient
    // socket/read failure while refreshing the dashboard must not turn a
    // successful submission into a misleading "任务发送失败" error.
    try {
      await refreshState({ quiet: true });
    } catch (refreshError) {
      if (refreshError.status !== 401) showToast('任务已发送，但状态刷新失败');
    }
  } catch (error) {
    $('prompt-error').textContent = controlErrorMessage(error, '任务发送失败');
  } finally {
    model.controlBusy = false;
    button.dataset.busy = 'false';
    button.classList.remove('is-loading');
    renderPaneSelect();
  }
}

async function sendPaneInput({ key, event } = {}) {
  event?.preventDefault();
  const paneId = model.selectedPane;
  const text = $('input-text')?.value || '';
  const keys = key ? [key] : [];
  clearControlError('input-error');
  if (!paneId) { $('input-error').textContent = '请先选择目标窗格。'; return; }
  if (!text && !keys.length) { $('input-error').textContent = '请输入文字或选择一个按键。'; return; }
  if (['ctrl+c', 'ctrl+d', 'ctrl+z'].includes(key) && typeof window.confirm === 'function' && !window.confirm(`向当前窗格发送 ${key}？`)) return;
  const button = key
    ? [...document.querySelectorAll('[data-input-key]')].find((node) => node.dataset.inputKey === key)
    : $('input-text-button');
  if (button) { button.disabled = true; button.classList.add('is-loading'); }
  model.controlBusy = true;
  renderPaneSelect();
  try {
    await api('/api/control/input', { method: 'POST', body: JSON.stringify({ pane_id: paneId, text, keys }) });
    $('input-text').value = '';
    updateControlCounts();
    showToast(key ? `已发送 ${key}` : '文字已发送');
    try {
      await refreshState({ quiet: true });
    } catch (refreshError) {
      if (refreshError.status !== 401) showToast('输入已发送，但状态刷新失败');
    }
  } catch (error) {
    $('input-error').textContent = controlErrorMessage(error, '输入发送失败');
  } finally {
    model.controlBusy = false;
    if (button) button.classList.remove('is-loading');
    renderPaneSelect();
  }
}

function mountControlSurface(view) {
  const surface = $('control-surface');
  if (!surface) return;
  const destination = view === 'attention' ? $('attention-control-slot') : $('control-surface-home');
  if (destination && surface.parentElement !== destination) destination.appendChild(surface);
}

function switchView(view) {
  const requested = ['overview', 'output', 'focus', 'control', 'attention'].includes(view) ? view : 'overview';
  if (requested === 'attention' && !model.attention) return switchView('overview');
  model.activeView = requested;
  mountControlSurface(requested);
  if (requested === 'attention') {
    const tab = $('tab-attention');
    if (tab) tab.hidden = false;
  }
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.view === requested;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.quick-action[data-view]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === requested);
  });
  document.querySelectorAll('.view').forEach((panel) => {
    const active = panel.id === `${requested}-view`;
    panel.classList.toggle('is-hidden', !active);
    panel.hidden = !active;
  });
  if (requested === 'attention') {
    const heading = $('attention-heading');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      queueMicrotask(() => heading.focus({ preventScroll: true }));
    }
  }
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function enablePush() {
  const button = $('push-button');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    button.textContent = '浏览器不支持'; button.disabled = true; return;
  }
  button.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('通知权限未开启');
    const keyData = await api('/api/push/key');
    if (!keyData.publicKey) throw new Error('服务尚未配置推送密钥');
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(keyData.publicKey) });
    await api('/api/push/subscriptions', { method: 'POST', body: JSON.stringify(subscription) });
    button.textContent = '提醒已开启';
    showToast('手机提醒已开启');
  } catch (error) {
    button.disabled = false;
    button.textContent = '开启提醒';
    showToast(error.message || '提醒开启失败');
  }
}

async function boot() {
  setAuthenticated(false);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    await refreshState({ quiet: true });
    setAuthenticated(true);
    connectStream();
    applyDeepLink();
  } catch { /* login screen remains visible */ }
}

function applyDeepLink() {
  const link = parseDeepLink(window.location.search);
  model.deepLink = link;
  const paneKnown = link.pane && model.panes.some((item) => item.pane_id === link.pane);
  const workspaceKnown = link.workspace && model.workspaces.some((item) => (item.workspace_id || item.id) === link.workspace);

  if (link.view === 'attention') {
    model.attention = {
      pane: link.pane,
      workspace: link.workspace,
      event: link.event,
      status: link.status,
      agent: link.agent,
    };
    // A notification without a pane must never inherit the pane selected in a
    // previous view: doing so could send a reply to an unrelated session.
    // Keep the action panel visible for its workspace/status context, but leave
    // all pane controls disabled until the user explicitly chooses a pane.
    model.selectedPane = link.pane || '';
    model.output = '';
    model.outputError = link.pane ? '' : '通知没有提供可读取的窗格。';
    renderPaneSelect();
    renderAttention();
    switchView('attention');
    if (link.pane) {
      void loadPaneOutput(link.pane, { view: 'attention' });
    }
    return;
  }

  // A logout/login cycle can call applyDeepLink again. Do not leave a stale
  // action panel from a previous notification when the current URL is a
  // normal dashboard link (or the root URL).
  model.attention = null;
  renderAttention();

  // Keep links issued by older bridge versions working as before.
  if ((link.view === 'output' || (!link.view && link.pane)) && paneKnown) {
    model.selectedPane = link.pane;
    renderPaneSelect();
    switchView('output');
    void loadPaneOutput(link.pane, { view: 'output' });
  } else if ((link.view === 'focus' || (!link.view && link.workspace)) && workspaceKnown) {
    switchView('focus');
    [...document.querySelectorAll('[data-focus-workspace]')].find((node) => node.dataset.focusWorkspace === link.workspace)?.scrollIntoView({ block: 'center' });
  } else {
    switchView('overview');
  }
}

$('login-form').addEventListener('submit', login);
$('discovery-refresh')?.addEventListener('click', discoverBridge);
$('discovery-urls')?.addEventListener('click', async (event) => {
  const value = event.target.closest('[data-copy-url]')?.dataset.copyUrl;
  if (!value) return;
  try { await navigator.clipboard.writeText(value); showToast('地址已复制'); }
  catch { showToast(`请手动复制：${value}`); }
});
$('reveal-token').addEventListener('click', () => {
  const input = $('token');
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  $('reveal-token').textContent = visible ? '显示' : '隐藏';
  $('reveal-token').setAttribute('aria-label', visible ? '显示令牌' : '隐藏令牌');
});
$('logout-button').addEventListener('click', logout);
$('refresh-button').addEventListener('click', () => { $('refresh-button').classList.add('is-spinning'); void refreshState().finally(() => $('refresh-button').classList.remove('is-spinning')); });
$('output-refresh').addEventListener('click', () => void loadPaneOutput());
$('attention-output-refresh').addEventListener('click', () => {
  const pane = model.attention?.pane || model.selectedPane;
  void loadPaneOutput(pane, { view: 'attention' });
});
$('attention-focus-button').addEventListener('click', () => {
  const pane = model.attention?.pane || model.selectedPane;
  if (pane) void focusPane(pane);
});
$('load-output').addEventListener('click', () => void loadPaneOutput($('output-pane').value));
$('output-pane').addEventListener('change', (event) => {
  model.selectedPane = event.target.value;
  if ($('control-pane')) $('control-pane').value = model.selectedPane;
  clearControlError('prompt-error');
  clearControlError('input-error');
  renderPaneSelect();
});
$('control-pane').addEventListener('change', (event) => {
  model.selectedPane = event.target.value;
  if ($('output-pane')) $('output-pane').value = model.selectedPane;
  clearControlError('prompt-error');
  clearControlError('input-error');
  renderPaneSelect();
});
$('clear-output').addEventListener('click', () => { model.output = ''; model.outputError = ''; renderOutput(); renderAttention(); });
$('push-button').addEventListener('click', enablePush);
$('focus-list').addEventListener('click', (event) => { const id = event.target.closest('[data-focus-pane]')?.dataset.focusPane; if (id) void focusPane(id); });
$('workspace-list').addEventListener('click', (event) => { const id = event.target.closest('[data-focus-workspace]')?.dataset.focusWorkspace; if (id) void focusWorkspace(id); });
$('prompt-form').addEventListener('submit', sendAgentPrompt);
$('input-form').addEventListener('submit', (event) => void sendPaneInput({ event }));
$('prompt-text').addEventListener('input', () => { clearControlError('prompt-error'); updateControlCounts(); });
$('input-text').addEventListener('input', () => { clearControlError('input-error'); updateControlCounts(); });
document.querySelectorAll('[data-input-key]').forEach((button) => {
  button.addEventListener('click', () => void sendPaneInput({ key: button.dataset.inputKey }));
});
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));

updateControlCounts();
discoverBridge();
boot();
