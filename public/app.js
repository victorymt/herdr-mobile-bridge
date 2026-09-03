import { parseDeepLink } from './deep-link.js';

const $ = (id) => document.getElementById(id);

const model = {
  authenticated: false,
  connected: false,
  snapshot: null,
  panes: [],
  workspaces: [],
  output: '',
  // The output buffer is shared by the desktop output view and the attention
  // action panel. Keep its source pane explicit so switching views cannot
  // accidentally present one pane's log as another pane's notification.
  outputPaneId: '',
  selectedPane: '',
  controlBusy: false,
  focusBusy: false,
  activeView: 'overview',
  attention: null,
  deepLink: null,
  outputError: '',
  outputLoading: false,
  outputRequest: 0,
  outputRefreshTimer: null,
  stream: null,
  retryTimer: null,
  streamResyncTimer: null,
  toastTimer: null,
  discoveryUrls: [],
  discoveryQr: {},
  stateRequest: null,
  stateRefreshQueued: false,
  stateRefreshTimer: null,
  lastSyncAt: 0,
  stale: false,
  streamGeneration: '',
  streamReset: false,
  streamResyncing: false,
  cachedState: null,
  mobileNavProtectionTimer: null,
  mobileNavProtectionRetryTimer: null,
  mobileNavProtectionLateTimer: null,
  mobileNavProtectionFrame: null,
};


const CACHE_KEY = 'herdr-mobile-bridge:last-state:v1';
const SESSION_MARKER_KEY = 'herdr-mobile-bridge:authenticated:v1';
const STATE_DEBOUNCE_MS = 280;
const OUTPUT_BOTTOM_THRESHOLD = 36;
const outputScrollState = new WeakMap();

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

function storageGet(key) {
  try { return window.localStorage?.getItem(key) || ''; } catch { return ''; }
}

function storageSet(key, value) {
  try { window.localStorage?.setItem(key, value); } catch { /* private mode/quota */ }
}

function storageRemove(key) {
  try { window.localStorage?.removeItem(key); } catch { /* private mode */ }
}

function setSessionMarker(value) {
  if (value) storageSet(SESSION_MARKER_KEY, '1');
  else storageRemove(SESSION_MARKER_KEY);
}

function hasSessionMarker() {
  return storageGet(SESSION_MARKER_KEY) === '1';
}

function offlineSafeState(data) {
  const source = data && typeof data === 'object' ? data : {};
  const snapshot = source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : source;
  const keepArray = (value, max = 512) => Array.isArray(value) ? value.slice(0, max) : [];
  const keepObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const cleanStatuses = (value) => Object.fromEntries(Object.entries(keepObject(value)).slice(0, 512).flatMap(([id, status]) => {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
    const clean = {};
    for (const key of ['agent', 'display_agent', 'title', 'agent_status', 'final_status', 'workspace_id', 'updated_at']) {
      if (status[key] === undefined || status[key] === null) continue;
      const text = String(status[key]).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
      if (text) clean[key] = text;
    }
    return Object.keys(clean).length ? [[String(id).slice(0, 256), clean]] : [];
  }));
  return {
    ok: true,
    generated_at: typeof source.generated_at === 'string' ? source.generated_at.slice(0, 64) : new Date().toISOString(),
    version: typeof source.version === 'string' ? source.version.slice(0, 64) : undefined,
    protocol: Number.isFinite(source.protocol) ? source.protocol : undefined,
    focused_workspace_id: String(source.focused_workspace_id || snapshot.focused_workspace_id || '').slice(0, 256) || undefined,
    focused_tab_id: String(source.focused_tab_id || snapshot.focused_tab_id || '').slice(0, 256) || undefined,
    focused_pane_id: String(source.focused_pane_id || snapshot.focused_pane_id || '').slice(0, 256) || undefined,
    snapshot: {
      version: typeof snapshot.version === 'string' ? snapshot.version.slice(0, 64) : undefined,
      protocol: Number.isFinite(snapshot.protocol) ? snapshot.protocol : undefined,
      focused_workspace_id: String(snapshot.focused_workspace_id || '').slice(0, 256) || undefined,
      focused_tab_id: String(snapshot.focused_tab_id || '').slice(0, 256) || undefined,
      focused_pane_id: String(snapshot.focused_pane_id || '').slice(0, 256) || undefined,
      workspaces: keepArray(snapshot.workspaces).map((item) => ({
        workspace_id: String(item?.workspace_id || item?.id || '').slice(0, 256),
        label: String(item?.label || item?.name || '').slice(0, 160),
        pane_count: Number.isFinite(item?.pane_count) ? item.pane_count : undefined,
      })),
      panes: keepArray(snapshot.panes).map((item) => ({
        pane_id: String(item?.pane_id || '').slice(0, 256),
        workspace_id: String(item?.workspace_id || '').slice(0, 256),
        agent: String(item?.agent || '').slice(0, 160),
        display_agent: String(item?.display_agent || '').slice(0, 160),
        title: String(item?.title || '').slice(0, 160),
        agent_status: String(item?.agent_status || '').slice(0, 64),
        final_status: String(item?.final_status || '').slice(0, 64),
      })),
    },
    workspaces: keepArray(source.workspaces || snapshot.workspaces).map((item) => ({
      workspace_id: String(item?.workspace_id || item?.id || '').slice(0, 256),
      label: String(item?.label || item?.name || '').slice(0, 160),
      pane_count: Number.isFinite(item?.pane_count) ? item.pane_count : undefined,
    })),
    panes: keepArray(source.panes || snapshot.panes).map((item) => ({
      pane_id: String(item?.pane_id || '').slice(0, 256),
      workspace_id: String(item?.workspace_id || '').slice(0, 256),
      agent: String(item?.agent || '').slice(0, 160),
      display_agent: String(item?.display_agent || '').slice(0, 160),
      title: String(item?.title || '').slice(0, 160),
      agent_status: String(item?.agent_status || '').slice(0, 64),
      final_status: String(item?.final_status || '').slice(0, 64),
    })),
    pane_statuses: cleanStatuses(source.pane_statuses || snapshot.pane_statuses),
  };
}

function saveCachedState(data) {
  try {
    const payload = JSON.stringify({ saved_at: new Date().toISOString(), data: offlineSafeState(data) });
    if (payload.length <= 256 * 1024) storageSet(CACHE_KEY, payload);
  } catch { /* malformed state must never break the live UI */ }
}

function restoreCachedState() {
  const raw = storageGet(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const savedAt = Date.parse(parsed?.saved_at || '');
    if (!parsed?.data || !Number.isFinite(savedAt) || Date.now() - savedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return parsed.data;
  } catch { return null; }
}

function announce(message, id = 'output-status-announcer') {
  const node = $(id);
  if (node) node.textContent = String(message || '');
}

function csrfToken() {
  const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('XSRF-TOKEN='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice('XSRF-TOKEN='.length)); } catch { return ''; }
}

function setConnection(connected, reason = '') {
  model.connected = Boolean(connected);
  model.stale = !model.connected;
  const dot = $('status-dot');
  const label = $('connection-label');
  const banner = $('offline-banner');
  const detail = $('sync-detail');
  const livePill = $('live-pill');
  const liveLabel = $('live-label');
  dot?.classList.toggle('offline', !model.connected);
  if (label) label.textContent = model.connected ? '已连接' : '离线';
  if (banner) {
    banner.hidden = model.connected;
    banner.textContent = reason || (model.cachedState ? '暂时离线，显示最近一次状态；恢复网络后将自动同步。' : '暂时离线，正在重试连接…');
  }
  if (detail) {
    detail.textContent = model.connected
      ? (model.lastSyncAt ? `刚刚同步 · ${new Date(model.lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '已连接')
      : '状态可能已过期';
  }
  livePill?.classList.toggle('offline', !model.connected);
  if (liveLabel) liveLabel.textContent = model.connected ? '实时状态' : (model.cachedState ? '缓存状态' : '已断开');
  // Keep all mutation controls in sync with the transport state.  The focus
  // and workspace lists are rendered from the snapshot, so merely updating
  // the pane selector would leave stale enabled buttons after a disconnect
  // (and disabled buttons on the first successful state load).
  $('app-shell')?.setAttribute('aria-busy', model.authenticated && !model.connected ? 'true' : 'false');
  updatePushAvailability();
  renderPaneSelect();
  renderFocus();
  renderWorkspaces();
}

function statusErrorMessage(error, fallback = '请求失败，请稍后重试。') {
  const status = Number(error?.status);
  if (status === 401) return '登录已过期，请重新输入访问令牌。';
  if (status === 403) return '请求被拒绝，请检查局域网地址、来源或 CSRF 状态。';
  if (status === 404) return '目标已不存在，可能窗格已经关闭。';
  if (status === 409) return '当前状态不允许此操作，请刷新后重试。';
  if (status === 429) return '操作过于频繁，请稍后重试。';
  if (status >= 500) return '桥接服务暂时不可用，请检查电脑端服务。';
  if (!status) return '无法连接桥接服务，可能被 VPN 或防火墙拦截。';
  return error?.message || fallback;
}

function updatePushAvailability() {
  const button = $('push-button');
  if (!button) return;
  const hint = $('push-hint');
  const secure = window.isSecureContext !== false;
  const supported = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!secure) {
    button.disabled = true;
    button.textContent = '需 HTTPS';
    if (hint) hint.textContent = '当前是 HTTP 局域网入口；如需浏览器提醒，请另行配置仅限局域网的 HTTPS 反向代理。';
    return;
  }
  if (!supported) {
    button.disabled = true;
    button.textContent = '浏览器不支持';
    if (hint) hint.textContent = '此浏览器不支持 Web Push；控制台查看、输出和控制仍可正常使用。';
    return;
  }
  if (button.dataset.enabled === 'true') {
    button.disabled = true;
    button.textContent = '提醒已开启';
    if (hint) hint.textContent = '浏览器会在任务完成或需要介入时发送轻量提醒。';
    return;
  }
  button.disabled = !model.connected;
  button.textContent = '开启提醒';
  if (hint) hint.textContent = '需要 HTTPS 和浏览器通知权限；HTTP 局域网仍可正常查看和控制。';
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
  $('app-shell')?.setAttribute('aria-busy', value && !model.connected ? 'true' : 'false');
  if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'auto' });
  if (value) scheduleMobileNavProtection();
}

async function discoverBridge() {
  const status = $('discovery-status');
  const urls = $('discovery-urls');
  if (!status || !urls) return;
  status.textContent = '正在检测局域网地址…';
  urls.replaceChildren();
  try {
    const data = await api('/api/discovery?qr=1');
    model.discoveryUrls = Array.isArray(data?.lan_proxy?.urls) ? data.lan_proxy.urls.filter((value) => /^https?:\/\//i.test(value)) : [];
    const info = data?.lan_proxy || {};
    const candidates = model.discoveryUrls;
    const qrData = data?.qr || info.qr || {};
    status.textContent = info.running && candidates.length
      ? '服务已就绪，请选择手机可访问的地址。'
      : candidates.length
        ? '已找到局域网地址；请启动 LAN 代理后再从手机访问。'
        : '暂未发现可用的局域网地址。';
    for (const value of candidates) {
      try { if (!/^https?:\/\//i.test(value)) continue; } catch { continue; }
      const row = document.createElement('div');
      row.className = 'discovery-url';
      row.innerHTML = `<a class="discovery-link" href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a><button type="button" class="secondary-button" data-copy-url="${escapeHtml(value)}">复制</button>`;
      const qr = typeof qrData === 'string' ? qrData : qrData[value];
      if (typeof qr === 'string' && qr.trim().startsWith('<svg') && qr.length <= 120_000) {
        const holder = document.createElement('span'); holder.className = 'discovery-qr'; holder.setAttribute('aria-label', `扫描二维码打开 ${value}`);
        const image = document.createElement('img');
        image.alt = `扫描二维码打开 ${value}`;
        image.width = 128; image.height = 128; image.loading = 'lazy';
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`;
        holder.append(image);
        row.append(holder);
      } else { const fallback = document.createElement('span'); fallback.className = 'qr-fallback'; fallback.setAttribute('aria-label', '二维码不可用，请复制地址'); fallback.textContent = '请复制'; row.append(fallback); }
      urls.append(row);
    }
    const secure = data?.request?.secure;
    const baseHint = secure === false
      ? '当前使用 HTTP 明文连接，仅适用于可信局域网；请勿在公共网络使用。'
      : (data?.hints?.vpn_bypass || '请确认手机与电脑在同一网络。');
    const manualHint = !info.running && data?.hints?.manual_forward
      ? `未检测到自动代理，可临时运行：${data.hints.manual_forward}`
      : '';
    $('discovery-hint').textContent = `${baseHint} ${manualHint} 二维码不会包含访问令牌。`.trim();
  } catch (error) {
    status.textContent = error.message || '检测失败，请确认桥接服务正在运行。';
  }
}

async function testDiscovery() {
  const node = $('discovery-test-status');
  const button = $('discovery-test');
  const target = model.discoveryUrls?.[0];
  if (!node || !button) return;
  if (!target) { node.textContent = '暂无可测试地址'; return; }
  button.disabled = true; node.textContent = '测试中…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${target.replace(/\/$/, '')}/api/discovery`, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (response.ok) node.textContent = '连接成功，局域网入口可达';
    else if (response.status === 401 || response.status === 403) node.textContent = '服务拒绝，请检查代理认证或来源设置';
    else if (response.status === 404) node.textContent = '端口可达但路径不正确，请确认入口端口';
    else if (response.status === 429) node.textContent = '请求过于频繁，请稍后再测';
    else if (response.status >= 500) node.textContent = '电脑端服务异常，请检查 Bridge 日志';
    else node.textContent = `服务拒绝（${response.status}）`;
  } catch (error) {
    node.textContent = error.name === 'AbortError'
      ? '连接超时，请检查局域网、防火墙或 VPN 的允许局域网开关'
      : '无法连接，可能被 VPN/网络策略拦截；请开启 Allow LAN traffic / 允许局域网';
  } finally { clearTimeout(timer); button.disabled = false; }
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
  const preview = $('output-preview');
  const consoleNode = $('output-console');
  const attentionConsole = $('attention-output-console');
  const attentionPane = model.attention?.pane || '';
  const attentionOutputMatches = !attentionPane || model.outputPaneId === attentionPane;
  const stick = (node) => {
    if (!node) return true;
    const remembered = outputScrollState.get(node);
    return remembered === undefined
      ? node.scrollHeight - node.scrollTop - node.clientHeight <= OUTPUT_BOTTOM_THRESHOLD
      : remembered;
  };
  const put = (node, value, forceBottom = false) => {
    if (!node) return;
    const shouldScroll = forceBottom || stick(node);
    node.textContent = value;
    if (shouldScroll) node.scrollTop = node.scrollHeight;
  };
  put(preview, model.outputLoading ? '正在读取…' : (text || '暂无输出'));
  put(consoleNode, message);
  if (attentionConsole) {
    const attentionMessage = !attentionOutputMatches
      ? '正在读取通知目标输出…'
      : message === '选择一个窗格后读取最近输出。'
      ? (model.attention?.pane ? '暂无输出' : '正在等待通知目标…')
      : message;
    put(attentionConsole, attentionMessage);
  }
  const attentionError = $('attention-error');
  if (attentionError) {
    attentionError.textContent = model.outputError && !model.outputLoading ? model.outputError : '';
  }
  $('copy-output')?.toggleAttribute('disabled', !text);
  $('attention-copy-output')?.toggleAttribute('disabled', !text || !attentionOutputMatches);
  $('output-jump-latest')?.toggleAttribute('disabled', !text);
  $('attention-jump-latest')?.toggleAttribute('disabled', !text || !attentionOutputMatches);
  const announcement = model.outputLoading
    ? '正在读取窗格输出'
    : model.outputError
      ? `输出读取失败：${model.outputError}`
      : text
        ? `已加载 ${text.split('\n').filter(Boolean).length} 行输出`
        : '当前没有输出';
  if (announcement !== model.lastOutputAnnouncement) {
    model.lastOutputAnnouncement = announcement;
    announce(announcement, 'output-status-announcer');
    announce(announcement, 'output-console-announcer');
    announce(announcement, 'attention-output-announcer');
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
  if (hint) hint.textContent = !model.connected
    ? '当前离线，恢复连接后才能操作。'
    : target
      ? `${paneDisplayName(target)} · ${statusLabel(paneStatus(target))}`
      : current
        ? '通知目标已不可用，请刷新状态或选择其他窗格。'
        : '先选择一个窗格。';
  for (const button of [$('prompt-button'), $('input-text-button'), ...document.querySelectorAll('[data-input-key]')].filter(Boolean)) {
    button.disabled = !model.connected || !current || !available || model.controlBusy;
  }
  const attentionFocus = $('attention-focus-button');
  if (attentionFocus) attentionFocus.disabled = !model.connected || !current || !available;
  const outputLoader = $('load-output');
  if (outputLoader) outputLoader.disabled = !model.connected || !current || !available;
  const outputRefresh = $('output-refresh');
  if (outputRefresh) outputRefresh.disabled = !model.connected || !current || !available || model.outputLoading;
  const attentionRefresh = $('attention-output-refresh');
  if (attentionRefresh) attentionRefresh.disabled = !model.connected || !model.attention?.pane || model.outputLoading;
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

function syncMobileAttentionNav() {
  const button = $('mobile-attention');
  const nav = document.querySelector('.mobile-actions');
  const visible = Boolean(model.attention);
  if (button) button.hidden = !visible;
  nav?.classList.toggle('has-attention', visible);
}

function renderAttention() {
  const attention = model.attention;
  const tab = $('tab-attention');
  syncMobileAttentionNav();
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
  if (focus) focus.disabled = !model.connected || model.focusBusy || !attention.pane || !model.panes.some((pane) => pane.pane_id === attention.pane);
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
    return `<div class="focus-item"><div><strong>${escapeHtml(paneDisplayName(pane, index))}</strong><small>${escapeHtml(statusLabel(paneStatus(pane)))}${active ? ' · 当前聚焦' : ''}${pane.workspace_id ? ` · ${escapeHtml(pane.workspace_id)}` : ''}</small></div><button type="button" data-focus-pane="${escapeHtml(id)}" ${active || model.focusBusy || !model.connected ? 'disabled' : ''}>${active ? '已聚焦' : model.focusBusy ? '处理中…' : '聚焦'}</button></div>`;
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
    return `<div class="focus-item"><div><strong>${escapeHtml(label)}</strong><small>${active ? '当前聚焦' : `${workspace.pane_count ?? workspace.panes?.length ?? 0} 个窗格`}</small></div><button type="button" data-focus-workspace="${escapeHtml(id)}" ${active || model.focusBusy || !model.connected ? 'disabled' : ''}>${active ? '已聚焦' : model.focusBusy ? '处理中…' : '聚焦'}</button></div>`;
  }).join('');
}

function render(data, { cached = false } = {}) {
  const body = data && typeof data === 'object' ? data : {};
  const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : body;
  model.snapshot = snapshot;
  model.cachedState = offlineSafeState(body);
  // A cached render must not refresh the cache timestamp: repeatedly opening
  // the page while offline should eventually expire old state instead of
  // extending its lifetime forever.
  if (!cached) saveCachedState(body);
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
  if (!cached) model.lastSyncAt = Date.now();
  const generated = Date.parse(body.generated_at || '');
  const shownAt = Number.isFinite(generated) ? new Date(generated) : now;
  $('updated-at').textContent = cached
    ? `缓存于 ${shownAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : `更新于 ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  $('updated-at').dateTime = shownAt.toISOString();
  $('version-label').textContent = body.version ? `协议 v${body.protocol || '—'}` : '本地服务';
  renderStatusGrid({ ...snapshot, ...body, panes: model.panes, workspaces: model.workspaces, pane_statuses: body.pane_statuses || snapshot.pane_statuses });
  renderFocus();
  renderOutput();
  renderAttention();
  // State arrives asynchronously while the shell may still be hidden. Queue
  // the mobile overlap check after each render so the first visible layout is
  // protected even when the initial boot request resolves late.
  if (model.authenticated) scheduleMobileNavProtection();
}

async function refreshState({ quiet = false } = {}) {
  if (model.stateRequest) {
    model.stateRefreshQueued = true;
    return model.stateRequest;
  }
  const run = (async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        const error = new Error('offline');
        error.code = 'offline';
        throw error;
      }
      const data = await api('/api/state');
      render(data);
      model.stale = false;
      setConnection(true);
      return data;
    } catch (error) {
      if (error.status === 401) {
        setSessionMarker(false);
        storageRemove(CACHE_KEY);
        setAuthenticated(false);
        closeStream();
        model.outputRequest += 1;
        model.outputLoading = false;
        model.output = '';
        model.outputPaneId = '';
        model.outputError = '';
        renderOutput();
      }
      const reason = error.code === 'offline'
        ? '当前设备离线，显示最近一次状态；恢复网络后将自动同步。'
        : '暂时无法连接桥接服务，可能被 VPN 或防火墙拦截。';
      setConnection(false, reason);
      if (!quiet && error.status !== 401 && error.code !== 'offline') showToast(statusErrorMessage(error, '无法读取 Herdr 状态'));
      throw error;
    } finally {
      $('refresh-button')?.classList.remove('is-spinning');
    }
  })();
  model.stateRequest = run;
  try {
    return await run;
  } finally {
    if (model.stateRequest === run) model.stateRequest = null;
    if (model.stateRefreshQueued) {
      model.stateRefreshQueued = false;
      scheduleStateRefresh(0);
    }
  }
}

function scheduleStateRefresh(delay = STATE_DEBOUNCE_MS) {
  clearTimeout(model.stateRefreshTimer);
  model.stateRefreshTimer = setTimeout(() => {
    model.stateRefreshTimer = null;
    if (model.authenticated && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      void refreshState({ quiet: true }).catch(() => {});
    }
  }, Math.max(0, Number(delay) || 0));
}

function scheduleOutputRefresh(paneId) {
  if (!paneId || paneId !== model.selectedPane || !['output', 'attention'].includes(model.activeView)) return;
  clearTimeout(model.outputRefreshTimer);
  model.outputRefreshTimer = setTimeout(() => {
    model.outputRefreshTimer = null;
    if (!model.authenticated || !model.connected || paneId !== model.selectedPane) return;
    void loadPaneOutput(paneId, { view: model.activeView, preserve: true, quiet: true });
  }, 420);
}

function closeStream() {
  if (model.stream) model.stream.close();
  model.stream = null;
  clearTimeout(model.retryTimer);
  model.retryTimer = null;
}

function cancelStreamResync() {
  clearTimeout(model.streamResyncTimer);
  model.streamResyncTimer = null;
  model.streamResyncing = false;
}

function scheduleStreamRetry() {
  clearTimeout(model.retryTimer);
  const delay = Math.min(30_000, Math.max(3_000, (model.streamRetryCount || 0) * 2_000 + 3_000));
  model.streamRetryCount = Math.min(12, (model.streamRetryCount || 0) + 1);
  model.retryTimer = setTimeout(() => { if (model.authenticated) connectStream(); }, delay);
}

function connectStream() {
  if (!model.authenticated || !window.EventSource) return;
  clearTimeout(model.streamResyncTimer);
  model.streamResyncTimer = null;
  model.streamResyncing = false;
  closeStream();
  const params = new URLSearchParams();
  if (model.streamGeneration) params.set('generation', model.streamGeneration);
  if (model.streamReset) params.set('reset', '1');
  const query = params.toString() ? `?${params.toString()}` : '';
  model.streamReset = false;
  const stream = new EventSource(`/api/stream${query}`, { withCredentials: true });
  model.stream = stream;
  stream.onopen = () => { model.streamRetryCount = 0; setConnection(true); clearTimeout(model.retryTimer); };
  stream.onerror = () => { setConnection(false, '实时连接已断开，正在重试；请检查 VPN 是否允许局域网。'); scheduleStateRefresh(0); scheduleStreamRetry(); };
  stream.onmessage = handleStreamEvent;
  stream.addEventListener('ready', handleStreamReady);
  stream.addEventListener('resync_required', handleStreamResync);
  stream.addEventListener('pane_agent_status_changed', handleStreamEvent);
  stream.addEventListener('pane_agent_detected', handleStreamEvent);
  stream.addEventListener('pane_output_changed', handleStreamEvent);
}

function handleStreamReady(event) {
  setConnection(true);
  try {
    const payload = JSON.parse(event.data || '{}');
    const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
    if (typeof context.generation === 'string' && context.generation) model.streamGeneration = context.generation;
    model.streamReset = false;
  } catch { /* malformed readiness metadata is harmless */ }
}

function handleStreamResync(event) {
  model.stale = true;
  let reason = '实时连接需要重新同步';
  try {
    const payload = JSON.parse(event.data || '{}');
    if (payload?.context?.reason === 'replay_gap' || payload?.context?.reason === 'replay_overflow') reason = '实时记录已滚动，正在重新同步完整状态';
    if (typeof payload?.context?.generation === 'string' && payload.context.generation) model.streamGeneration = payload.context.generation;
  } catch { /* use the safe default */ }
  announce(reason);
  showToast(reason);
  scheduleStateRefresh(0);
  if (!model.streamResyncing) {
    model.streamResyncing = true;
    model.streamReset = true;
    closeStream();
    clearTimeout(model.streamResyncTimer);
    model.streamResyncTimer = setTimeout(() => {
      model.streamResyncTimer = null;
      model.streamResyncing = false;
      if (model.authenticated) connectStream();
    }, 80);
  }
}

function handleStreamEvent(event) {
  try {
    const payload = JSON.parse(event.data);
    const eventName = payload.event || event.type;
    if (eventName === 'ready') return handleStreamReady(event);
    if (eventName === 'resync_required') return handleStreamResync(event);
    // The stream carries sanitized metadata only. Refreshing obtains the
    // authoritative snapshot and keeps terminal output out of notifications.
    scheduleStateRefresh(STATE_DEBOUNCE_MS);
    const context = payload.context && typeof payload.context === 'object' ? payload.context : payload;
    if (model.attention && context.pane_id && context.pane_id === model.attention.pane) {
      const nextStatus = eventName === 'pane_agent_detected'
        ? (context.final_status || context.agent_status)
        : (context.agent_status || context.final_status);
      if (nextStatus) model.attention.status = statusKey(nextStatus);
      if (context.agent || context.display_agent) model.attention.agent = context.agent || context.display_agent;
      renderAttention();
    }
    const currentStatus = statusKey(context.agent_status || context.final_status);
    const finalStatus = statusKey(context.final_status || context.agent_status);
    if (eventName === 'pane_output_changed') scheduleOutputRefresh(context.pane_id);
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
    setSessionMarker(true);
    setAuthenticated(true);
    await refreshState({ quiet: true });
    connectStream();
    // A notification can open the login screen with a pane/workspace query
    // still attached. Apply it after the first authenticated snapshot too,
    // not only during the initial already-authenticated boot path.
    applyDeepLink();
    scheduleMobileNavProtection();
  } catch (error) {
    // A successful token exchange can still be followed by an unavailable
    // Herdr socket. Return to the login surface in that case instead of
    // leaving an authenticated-looking shell with no state behind it.
    closeStream();
    setSessionMarker(false);
    setAuthenticated(false);
    $('login-error').textContent = error.status === 429 ? '尝试次数过多，请稍后再试' : (error.status === 403 ? '来源未被允许，请使用配置的 HTTPS 地址' : statusErrorMessage(error, '令牌无效或服务不可用'));
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
  closeStream();
  cancelStreamResync();
  clearTimeout(model.stateRefreshTimer);
  clearTimeout(model.outputRefreshTimer);
  model.stateRefreshTimer = null;
  model.outputRefreshTimer = null;
  // Invalidate an in-flight output read and clear terminal text before the
  // authenticated shell is hidden. A late response must not repopulate the
  // dashboard after a subsequent login.
  model.outputRequest += 1;
  model.outputLoading = false;
  model.output = '';
  model.outputPaneId = '';
  model.outputError = '';
  renderOutput();
  setSessionMarker(false);
  storageRemove(CACHE_KEY);
  model.cachedState = null;
  setAuthenticated(false);
  setConnection(false);
}

async function focusPane(id) {
  if (!id) return;
  if (!model.connected) { showToast('当前离线，恢复连接后才能聚焦窗格'); return; }
  if (model.focusBusy) return;
  model.focusBusy = true;
  renderFocus();
  try {
    await api('/api/focus/pane', { method: 'POST', body: JSON.stringify({ pane_id: id }) });
    model.selectedPane = id;
    await refreshState({ quiet: true });
    showToast('已聚焦窗格');
  } catch (error) { showToast(controlErrorMessage(error, '聚焦失败')); }
  finally { model.focusBusy = false; renderFocus(); }
}

async function focusWorkspace(id) {
  if (!id) return;
  if (!model.connected) { showToast('当前离线，恢复连接后才能聚焦工作区'); return; }
  if (model.focusBusy) return;
  model.focusBusy = true;
  renderFocus();
  try {
    await api('/api/focus/workspace', { method: 'POST', body: JSON.stringify({ workspace_id: id }) });
    await refreshState({ quiet: true });
    showToast('已聚焦工作区');
  } catch (error) { showToast(statusErrorMessage(error, '聚焦工作区失败')); }
  finally { model.focusBusy = false; renderFocus(); }
}

async function loadPaneOutput(id = model.selectedPane, { view = 'output', preserve = false, quiet = false } = {}) {
  // An attention refresh is always scoped to the pane carried by the
  // notification. Ignore a stale selector value if a user changed panes in
  // the general output view just before returning here.
  if (view === 'attention' && model.attention?.pane) id = model.attention.pane;
  if (!id) {
    model.outputPaneId = '';
    model.output = '';
    if (view === 'attention') {
      model.outputLoading = false;
      model.outputError = '通知没有提供可读取的窗格。';
      renderOutput();
    } else showToast('请先选择窗格');
    return false;
  }
  if (!model.connected) {
    model.outputPaneId = id;
    model.output = '';
    model.outputLoading = false;
    model.outputError = '当前离线，恢复连接后才能读取输出。';
    renderOutput();
    if (!quiet) showToast(model.outputError);
    return false;
  }
  const previousPane = model.selectedPane;
  model.selectedPane = id;
  model.outputPaneId = id;
  const keepOutput = preserve || (previousPane === id && Boolean(model.output));
  if (!keepOutput) {
    model.output = '';
    document.querySelectorAll('.output-console, .output-preview').forEach((node) => outputScrollState.set(node, true));
  }
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
      : statusErrorMessage(error, '读取失败，请稍后重试。');
    renderOutput();
    renderAttention();
    if (view === 'output' && !quiet) showToast(statusErrorMessage(error, '无法读取窗格输出'));
    return false;
  }
}

function byteLength(value) {
  try { return new TextEncoder().encode(String(value || '')).length; } catch { return String(value || '').length; }
}

function truncateUtf8(value, maxBytes) {
  const input = String(value || '');
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (byteLength(input) <= limit) return input;
  let result = '';
  for (const character of input) {
    const next = result + character;
    if (byteLength(next) > limit) break;
    result = next;
  }
  return result;
}

function enforceByteLimit(field) {
  if (!field) return;
  const max = Number(field.dataset.maxBytes);
  if (!Number.isFinite(max) || max <= 0) return;
  const limited = truncateUtf8(field.value, max);
  if (limited !== field.value) {
    field.value = limited;
    announce(`输入已限制为 ${max.toLocaleString('zh-CN')} 字节`, field.id === 'prompt-text' ? 'output-status-announcer' : 'output-console-announcer');
  }
  field.dataset.byteLength = String(byteLength(field.value));
}

function updateControlCounts() {
  const prompt = $('prompt-text');
  const input = $('input-text');
  enforceByteLimit(prompt);
  enforceByteLimit(input);
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
    control_in_flight: '该窗格已有操作正在处理，请稍候。',
    control_capacity: '当前操作较多，请稍后重试。',
    csrf_failed: '安全校验已失效，请刷新页面后重试。',
  };
  return messages[code] || (error?.status ? statusErrorMessage(error, fallback) : error?.message || fallback);
}

async function sendAgentPrompt(event) {
  event.preventDefault();
  const paneId = model.selectedPane;
  const text = $('prompt-text')?.value || '';
  clearControlError('prompt-error');
  if (!model.connected) { $('prompt-error').textContent = '当前离线，恢复连接后才能发送任务。'; return; }
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
  if (!model.connected) { $('input-error').textContent = '当前离线，恢复连接后才能发送输入。'; return; }
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

/**
 * Restore the notification's pane before showing the action panel. The
 * output buffer is intentionally shared between views, so a user who visited
 * another pane in "最近输出" could otherwise see (and reply to) the wrong
 * session when returning to a notification deep link.
 */
function enterAttentionTarget() {
  const target = typeof model.attention?.pane === 'string' ? model.attention.pane : '';
  if (!target) return;
  const paneChanged = model.selectedPane !== target;
  const outputChanged = model.outputPaneId !== target;
  if (!paneChanged && !outputChanged) return;

  model.selectedPane = target;
  model.output = '';
  model.outputError = '';
  model.outputLoading = false;
  document.querySelectorAll('.output-console, .output-preview').forEach((node) => outputScrollState.set(node, true));
  renderPaneSelect();
  // loadPaneOutput records outputPaneId before its first render, preventing
  // the attention renderer from observing a transient pane mismatch.
  void loadPaneOutput(target, { view: 'attention' });
}

function switchView(view) {
  const requested = ['overview', 'output', 'focus', 'control', 'attention'].includes(view) ? view : 'overview';
  if (requested === 'attention' && !model.attention) return switchView('overview');
  const previousView = model.activeView;
  model.activeView = requested;
  mountControlSurface(requested);
  if (requested === 'attention') {
    const tab = $('tab-attention');
    if (tab) tab.hidden = false;
    enterAttentionTarget();
  }
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.view === requested;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.quick-action[data-view]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === requested);
  });
  document.querySelectorAll('.mobile-actions [data-view]').forEach((button) => {
    const active = button.dataset.view === requested;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((panel) => {
    const active = panel.id === `${requested}-view`;
    panel.classList.toggle('is-hidden', !active);
    panel.hidden = !active;
    panel.tabIndex = active ? 0 : -1;
  });
  // The mobile action bar is fixed to the viewport. Bring the selected panel
  // to the top when switching views so its heading and first controls are not
  // left underneath the bar after a tap from the overview screen.
  if (previousView !== requested && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 599px)').matches) {
    const panel = document.getElementById(`${requested}-view`);
    if (panel && typeof window.scrollTo === 'function') {
      const top = Math.max(0, panel.getBoundingClientRect().top + window.scrollY - 12);
      window.scrollTo({ top, behavior: 'auto' });
    }
  }
  if (requested === 'attention') {
    const heading = $('attention-heading');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      queueMicrotask(() => heading.focus({ preventScroll: true }));
    }
  }
  // The active panel can change height when its controls are mounted (for
  // example when the attention surface moves into its action slot). Recheck
  // after the DOM mutation so a short mobile viewport is not covered by the
  // fixed action bar on the first paint.
  if (model.authenticated) scheduleMobileNavProtection();
}

function currentPageScrollTop() {
  const values = [
    typeof window.scrollY === 'number' ? window.scrollY : NaN,
    document.scrollingElement?.scrollTop,
    document.documentElement?.scrollTop,
    document.body?.scrollTop,
  ];
  return values.find((value) => Number.isFinite(value) && value > 0) || 0;
}

function scrollPageTo(top) {
  const target = Math.max(0, Number(top) || 0);
  let moved = false;
  if (typeof window.scrollTo === 'function') {
    try {
      window.scrollTo({ top: target, behavior: 'auto' });
      moved = Math.abs(currentPageScrollTop() - target) <= 2;
    } catch { /* older WebViews only support the positional form */ }
    if (!moved) {
      try { window.scrollTo(0, target); } catch { /* fall through to the scroller */ }
    }
  }
  // A few embedded mobile WebViews expose a no-op window.scrollTo while the
  // document scroller remains writable. Keep the fallback narrow and avoid
  // touching layout when the browser already moved the page.
  const scroller = document.scrollingElement || document.documentElement || document.body;
  if (scroller && Math.abs((scroller.scrollTop || 0) - target) > 2) scroller.scrollTop = target;
  if (document.body && document.body !== scroller && Math.abs((document.body.scrollTop || 0) - target) > 2) document.body.scrollTop = target;
}

function protectMobileNavOverlap(view = model.activeView) {
  if (typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 599px)').matches) return false;
  const currentScroll = currentPageScrollTop();
  // Only protect the initial viewport. Once the user has scrolled, do not
  // yank them back to the status cards during a background state refresh.
  if (currentScroll > 2) return false;
  const nav = document.querySelector('.mobile-actions');
  const panel = document.getElementById(`${view}-view`);
  if (!nav || !panel || panel.hidden) return false;
  // On very short screens the fixed action bar can cover the first status
  // cards even when the page is at scrollY=0. Nudge only as much as needed;
  // this keeps the brand/hero visible while making the first useful controls
  // reachable without an immediate manual scroll.
  // Prefer the first useful content block over the section heading itself.
  // `querySelector` follows document order, so a combined selector would
  // always pick the heading in the overview panel and miss cards hidden
  // beneath the fixed action bar on short screens.
  const target = panel.querySelector('.status-grid') || panel.querySelector('.section-heading, .control-target');
  if (!target) return false;
  const navRect = nav.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!Number.isFinite(navRect.top) || !Number.isFinite(targetRect.bottom) || navRect.height <= 0 || targetRect.height <= 0) return false;
  const limit = navRect.top - 12;
  const overlap = targetRect.bottom - limit;
  if (overlap <= 0) return false;
  scrollPageTo(currentScroll + overlap);
  return true;
}

function cancelMobileNavProtection() {
  clearTimeout(model.mobileNavProtectionTimer);
  clearTimeout(model.mobileNavProtectionRetryTimer);
  clearTimeout(model.mobileNavProtectionLateTimer);
  model.mobileNavProtectionTimer = null;
  model.mobileNavProtectionRetryTimer = null;
  model.mobileNavProtectionLateTimer = null;
  if (model.mobileNavProtectionFrame !== null && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(model.mobileNavProtectionFrame);
  }
  model.mobileNavProtectionFrame = null;
}

function scheduleMobileNavProtection() {
  if (typeof window.setTimeout !== 'function') return;
  cancelMobileNavProtection();
  const run = () => {
    model.mobileNavProtectionFrame = null;
    protectMobileNavOverlap(model.activeView);
  };
  const queueFrame = () => {
    if (typeof window.requestAnimationFrame === 'function') model.mobileNavProtectionFrame = window.requestAnimationFrame(run);
    else run();
  };
  // Run once on the next paint, then retry after the shell becomes visible and
  // after mobile browser viewport/scroll restoration settles. This covers
  // both cached/offline boot and a slow /api/state response.
  queueFrame();
  model.mobileNavProtectionTimer = window.setTimeout(queueFrame, 140);
  model.mobileNavProtectionRetryTimer = window.setTimeout(queueFrame, 420);
  model.mobileNavProtectionLateTimer = window.setTimeout(queueFrame, 900);
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function enablePush() {
  const button = $('push-button');
  if (window.isSecureContext === false) {
    updatePushAvailability();
    showToast('浏览器提醒需要 HTTPS；当前 HTTP 局域网仍可用于控制台操作');
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    updatePushAvailability();
    return;
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
    button.dataset.enabled = 'true';
    button.textContent = '提醒已开启';
    updatePushAvailability();
    showToast('手机提醒已开启');
  } catch (error) {
    button.disabled = false;
    button.textContent = '开启提醒';
    updatePushAvailability();
    showToast(error.message || '提醒开启失败');
  }
}

let pendingServiceWorker = null;
let reloadAfterServiceWorker = false;

function showServiceWorkerUpdate(worker) {
  if (!worker) return;
  pendingServiceWorker = worker;
  const banner = $('update-banner');
  if (banner) banner.hidden = false;
  announce('发现新版界面，可点击重新加载新版。');
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  const hadController = Boolean(navigator.serviceWorker.controller);
  const registration = await navigator.serviceWorker.register('/sw.js');
  if (registration.waiting && hadController) showServiceWorkerUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) showServiceWorkerUpdate(worker);
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadAfterServiceWorker) return;
    reloadAfterServiceWorker = false;
    window.location.reload();
  });
  $('update-reload')?.addEventListener('click', () => {
    if (!pendingServiceWorker) return;
    reloadAfterServiceWorker = true;
    pendingServiceWorker.postMessage({ type: 'SKIP_WAITING' });
  });
  return registration;
}

async function boot() {
  setAuthenticated(false);
  void registerServiceWorker().catch(() => {});
  try {
    await refreshState({ quiet: true });
    setSessionMarker(true);
    setAuthenticated(true);
    connectStream();
    applyDeepLink();
    scheduleMobileNavProtection();
  } catch {
    const cached = hasSessionMarker() ? restoreCachedState() : null;
    if (cached) {
      model.cachedState = cached;
      render(cached, { cached: true });
      setAuthenticated(true);
      setConnection(false, '暂时离线，显示最近一次状态；恢复网络后将自动同步。');
      announce('当前显示缓存状态，恢复网络后将自动同步。');
      applyDeepLink();
      scheduleMobileNavProtection();
    }
    // Without a prior authenticated session the login screen remains visible.
  }
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
    model.outputPaneId = '';
    model.outputError = link.pane ? '' : '通知没有提供可读取的窗格。';
    renderPaneSelect();
    renderAttention();
    switchView('attention');
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

function setupTabKeyboard() {
  const tabList = document.querySelector('[role="tablist"]');
  if (!tabList) return;
  const tabs = () => [...tabList.querySelectorAll('[role="tab"]')].filter((tab) => !tab.hidden);
  tabList.addEventListener('keydown', (event) => {
    const current = event.target.closest('[role="tab"]');
    if (!current) return;
    const visible = tabs();
    const index = visible.indexOf(current);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % visible.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + visible.length) % visible.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      switchView(current.dataset.view);
      return;
    } else return;
    event.preventDefault();
    const target = visible[next];
    switchView(target.dataset.view);
    target.focus();
  });
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
  });
}

function setupOutputScrolling() {
  document.querySelectorAll('.output-console, .output-preview').forEach((node) => {
    node.addEventListener('scroll', () => {
      outputScrollState.set(node, node.scrollHeight - node.scrollTop - node.clientHeight <= OUTPUT_BOTTOM_THRESHOLD);
    }, { passive: true });
  });
}

function setupConnectivityListeners() {
  window.addEventListener('online', () => {
    if (!model.authenticated) return;
    setConnection(false, '网络已恢复，正在同步最新状态…');
    scheduleStateRefresh(0);
    connectStream();
  });
  window.addEventListener('offline', () => {
    if (!model.authenticated) return;
    setConnection(false, '当前设备离线，显示最近一次状态；恢复网络后将自动同步。');
    closeStream();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !model.authenticated) return;
    scheduleStateRefresh(0);
    if (!model.stream || model.stream.readyState === window.EventSource?.CLOSED) connectStream();
  });
}

function setupMobileNavProtectionListeners() {
  if (typeof window.addEventListener !== 'function') return;
  const schedule = () => {
    if (model.authenticated) scheduleMobileNavProtection();
  };
  window.addEventListener('load', schedule, { once: true });
  window.addEventListener('pageshow', schedule);
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  if (window.visualViewport?.addEventListener) window.visualViewport.addEventListener('resize', schedule, { passive: true });
}

async function copyOutput() {
  if (model.activeView === 'attention' && model.attention?.pane && model.outputPaneId !== model.attention.pane) {
    showToast('正在读取通知目标输出，请稍候');
    return;
  }
  const text = String(model.output || '');
  if (!text) { showToast('当前没有可复制的输出'); return; }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('clipboard unavailable');
    announce('输出已复制');
    showToast('输出已复制');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text; helper.setAttribute('readonly', ''); helper.style.position = 'fixed'; helper.style.opacity = '0';
    document.body.append(helper); helper.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    helper.remove();
    showToast(copied ? '输出已复制' : '无法自动复制，请长按输出文本');
  }
}

function jumpOutputLatest() {
  document.querySelectorAll('.output-console, .output-preview').forEach((node) => {
    node.scrollTop = node.scrollHeight;
    outputScrollState.set(node, true);
  });
  showToast('已跳到最新输出');
}

$('login-form').addEventListener('submit', login);
$('discovery-refresh')?.addEventListener('click', discoverBridge);
$('discovery-test')?.addEventListener('click', testDiscovery);
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
$('copy-output')?.addEventListener('click', () => void copyOutput());
$('output-jump-latest')?.addEventListener('click', jumpOutputLatest);
$('attention-copy-output')?.addEventListener('click', () => void copyOutput());
$('attention-jump-latest')?.addEventListener('click', jumpOutputLatest);
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
$('clear-output').addEventListener('click', () => {
  model.output = '';
  model.outputPaneId = model.selectedPane || '';
  model.outputError = '';
  renderOutput();
  renderAttention();
  announce('输出已清空');
});
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

setupTabKeyboard();
setupOutputScrolling();
setupConnectivityListeners();
setupMobileNavProtectionListeners();
switchView('overview');
updateControlCounts();
discoverBridge();
boot();
