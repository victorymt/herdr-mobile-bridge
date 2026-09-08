import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const [html, app, ansi, deepLink] = await Promise.all(
  ['index.html', 'app.js', 'ansi.js', 'deep-link.js'].map((name) => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')),
);
// jsdom does not load ES modules. Keep each dependency in its own scope and
// run the complete production entrypoint, including boot and DOM listeners.
const script = `
const { parseDeepLink } = (() => { ${deepLink.replace(/^export /gm, '')}; return { parseDeepLink }; })();
const { ansiToText, renderAnsi } = (() => { ${ansi.replace(/^export /gm, '')}; return { ansiToText, renderAnsi }; })();
${app.replace(/^import .*;\n/gm, '')}
`;
const CACHE_KEY = 'herdr-mobile-bridge:last-state:v1';
const SESSION_KEY = 'herdr-mobile-bridge:authenticated:v1';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function state(version = 'initial') {
  return {
    version, focused_pane_id: 'pane-a', focused_workspace_id: 'workspace',
    workspaces: [{ workspace_id: 'workspace', label: 'Demo' }],
    panes: [
      { pane_id: 'pane-a', workspace_id: 'workspace', title: 'Pane A', agent_status: 'working' },
      { pane_id: 'pane-b', workspace_id: 'workspace', title: 'Pane B', agent_status: 'done' },
    ],
  };
}

function taskState() {
  return {
    version: 'multiple-tasks', focused_pane_id: 'pane-a', focused_workspace_id: 'workspace-a',
    workspaces: [
      { workspace_id: 'workspace-a', label: 'Alpha project' },
      { workspace_id: 'workspace-b', label: 'Beta project' },
    ],
    panes: [
      { pane_id: 'pane-a', workspace_id: 'workspace-a', agent: 'codex', display_agent: 'Codex', agent_status: 'working' },
      { pane_id: 'pane-c', workspace_id: 'workspace-b', agent: 'claude', display_agent: 'Claude', agent_status: 'done' },
      { pane_id: 'pane-b', workspace_id: 'workspace-b', agent: 'codex', display_agent: 'Codex', agent_status: 'blocked' },
    ],
  };
}

function assertTargetIdentity(text, paneId, snapshot) {
  const pane = snapshot.panes.find((item) => item.pane_id === paneId);
  const workspace = snapshot.workspaces.find((item) => item.workspace_id === pane.workspace_id);
  assert.ok(text.includes(paneId), `target must include pane ID ${paneId}: ${text}`);
  assert.ok(text.includes(workspace.workspace_id) || text.includes(workspace.label), `target must identify its workspace: ${text}`);
}

function page(t, { bootPending = false, signedIn = true, initialOnline = true, initialState = state(), cacheRecord = null, sessionMarker = false, url = 'http://localhost/', beforeBoot } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  t.after(async () => { await tick(); dom.window.close(); assert.deepEqual(errors, []); });
  const { window } = dom;
  if (cacheRecord) window.localStorage.setItem(CACHE_KEY, JSON.stringify(cacheRecord));
  if (sessionMarker) window.localStorage.setItem(SESSION_KEY, '1');
  window.TextEncoder = TextEncoder;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.confirm = () => true;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const requests = [];
  const holds = [];
  const streams = [];
  let currentState = initialState;
  let online = initialOnline;
  Object.defineProperty(window.navigator, 'onLine', { get: () => online });
  class EventSource extends window.EventTarget {
    static CLOSED = 2;
    constructor(url) { super(); this.url = url; this.readyState = 1; streams.push(this); }
    close() { this.readyState = EventSource.CLOSED; }
    emit(type, data = {}) {
      const event = new window.MessageEvent(type, { data: JSON.stringify(data) });
      this[`on${type}`]?.(event);
      this.dispatchEvent(event);
    }
  }
  window.EventSource = EventSource;
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  function hold(path, { honorAbort = false } = {}) {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const item = { path, promise, honorAbort, reject, respond: (body, status) => resolve(reply(body, status)) };
    holds.push(item);
    return item;
  }
  const boot = bootPending ? hold('/api/state') : null;
  window.fetch = (url, options = {}) => {
    const path = new URL(url, window.location.href).pathname;
    const request = { path, options };
    requests.push(request);
    const index = holds.findIndex((item) => item.path === path);
    if (index !== -1) {
      const [item] = holds.splice(index, 1);
      item.request = request;
      if (item.honorAbort && options.signal) {
        const abort = () => item.reject(new window.DOMException('Request aborted', 'AbortError'));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
        const cleanup = () => options.signal.removeEventListener('abort', abort);
        void item.promise.then(cleanup, cleanup);
      }
      // Deliberately allow delivery after abort: guards must also cover a
      // response already received while its body or continuation was pending.
      return item.promise;
    }
    if (path === '/api/auth/logout') signedIn = false;
    if (['/api/auth/login', '/api/auth/pair'].includes(path)) signedIn = true;
    if (path === '/api/state') return Promise.resolve(signedIn ? reply(currentState) : reply({}, 401));
    if (path.endsWith('/output')) return Promise.resolve(reply({ text: `Output for ${path}` }));
    if (path === '/api/discovery') return Promise.resolve(reply({ lan_proxy: { urls: [] } }));
    return Promise.resolve(reply({ ok: true }));
  };
  beforeBoot?.(window);
  window.eval(script);
  const $ = (id) => window.document.getElementById(id);
  const click = (id) => $(id).click();
  const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event('change', { bubbles: true })); };
  const submit = (id) => $(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const login = () => { change('login-method', 'token'); $('token').value = 'test-token'; submit('login-form'); };
  return {
    window, $, click, change, submit, login, hold, requests, streams, boot,
    cache: () => JSON.parse(window.localStorage.getItem(CACHE_KEY) || 'null')?.data,
    setState: (value) => { currentState = value; },
    connectivity(value) { online = value; window.dispatchEvent(new window.Event(value ? 'online' : 'offline')); },
  };
}

function mobilePage(t, { taskTop, taskBottom, initialScroll = 0 }) {
  let scrollTop = initialScroll;
  let nextFrame = 0;
  const frames = new Map();
  const scrolls = [];
  const rect = (top, bottom) => ({ top, bottom, height: bottom - top, left: 0, right: 390, width: 390 });
  const ui = page(t, {
    beforeBoot(window) {
      window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      Object.defineProperty(window, 'scrollY', { get: () => scrollTop });
      Object.defineProperty(window.document, 'scrollingElement', { value: window.document.documentElement });
      window.document.documentElement.scrollTop = initialScroll;
      window.scrollTo = (options, y) => {
        const target = typeof options === 'object' ? options.top : y;
        if (target !== scrollTop) scrolls.push(target);
        scrollTop = target;
        window.document.documentElement.scrollTop = scrollTop;
        window.document.body.scrollTop = scrollTop;
      };
      window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
      window.cancelAnimationFrame = (id) => frames.delete(id);
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.matches('.mobile-actions')) return rect(560, 640);
        if (this.matches('.task-card')) return rect(taskTop - scrollTop, taskBottom - scrollTop);
        // A misleading old status position must never drive the viewport:
        // these cards now belong to a closed connection-details disclosure.
        if (this.matches('.status-item')) return rect(600 - scrollTop, 680 - scrollTop);
        return rect(0, 0);
      };
    },
  });
  return {
    ...ui,
    scrolls,
    scrollManually(top) {
      scrollTop = top;
      ui.window.document.documentElement.scrollTop = top;
      ui.window.document.body.scrollTop = top;
    },
    paint() {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback();
    },
  };
}

test('mobile initial paint ignores closed status details while the first task is already visible', async (t) => {
  const ui = mobilePage(t, { taskTop: 280, taskBottom: 360 });
  await tick();
  assert.equal(ui.window.document.querySelector('.session-details').open, false);
  ui.paint();
  ui.window.dispatchEvent(new ui.window.Event('pageshow'));
  ui.paint();
  assert.deepEqual(ui.scrolls, []);
  assert.equal(ui.window.scrollY, 0);
});

test('mobile navigation protection does not pull an entirely offscreen task into view', async (t) => {
  const ui = mobilePage(t, { taskTop: 700, taskBottom: 780 });
  await tick();
  ui.paint();
  assert.deepEqual(ui.scrolls, []);
  assert.equal(ui.window.scrollY, 0);
});

test('mobile navigation protection scrolls only enough to uncover an overlapping task', async (t) => {
  const ui = mobilePage(t, { taskTop: 540, taskBottom: 620 });
  await tick();
  ui.paint();
  assert.equal(ui.scrolls.length, 1);
  assert.ok(ui.scrolls[0] > 0 && ui.scrolls[0] < 100, 'the correction should be a small viewport adjustment');
  const task = ui.window.document.querySelector('.task-card').getBoundingClientRect();
  const nav = ui.window.document.querySelector('.mobile-actions').getBoundingClientRect();
  assert.ok(task.bottom <= nav.top, 'the first task must be above the fixed navigation');
  ui.window.dispatchEvent(new ui.window.Event('resize'));
  ui.paint();
  assert.equal(ui.scrolls.length, 1, 'later layout checks must not repeat the correction');
});

test('mobile layout checks preserve a reader who already scrolled even when a task overlaps navigation', async (t) => {
  const ui = mobilePage(t, { taskTop: 640, taskBottom: 720 });
  await tick();
  ui.scrollManually(100);
  ui.paint();
  ui.window.dispatchEvent(new ui.window.Event('resize'));
  ui.paint();
  assert.deepEqual(ui.scrolls, []);
  assert.equal(ui.window.scrollY, 100);
});

test('overview output preview distinguishes unread, failed, and empty output', async (t) => {
  const ui = page(t);
  await tick();
  assert.ok(ui.$('output-preview').textContent.includes('点击任务'));
  const failed = ui.hold('/api/panes/pane-a/output');
  ui.click('tab-output');
  failed.respond({ error: { message: 'Output service unavailable' } }, 503);
  await tick();
  assert.ok(ui.$('output-preview').textContent.includes('桥接服务暂时不可用'));
  assert.equal(ui.$('output-preview').textContent, ui.$('output-console').textContent);
  const empty = ui.hold('/api/panes/pane-a/output');
  ui.click('output-refresh');
  empty.respond({ text: '' });
  await tick();
  assert.equal(ui.$('output-preview').textContent, '该任务暂无输出');
});

test('selecting a task updates its summary and disambiguates same-named agents without changing computer focus', async (t) => {
  const snapshot = taskState();
  const ui = page(t, { initialState: snapshot });
  await tick();
  assert.equal(ui.$('context-pane').value, 'pane-b', 'an initial selection should prioritize blocked work');
  for (const pane of snapshot.panes) {
    const option = [...ui.$('context-pane').options].find((item) => item.value === pane.pane_id);
    assertTargetIdentity(option.textContent, pane.pane_id, snapshot);
    const focusItem = ui.window.document.querySelector(`[data-focus-pane="${pane.pane_id}"]`).closest('.focus-item');
    assertTargetIdentity(focusItem.textContent, pane.pane_id, snapshot);
  }
  ui.change('context-pane', 'pane-a');
  await tick();
  assertTargetIdentity(`${ui.$('agent-heading').textContent} ${ui.$('agent-detail').textContent}`, 'pane-a', snapshot);
  ui.change('context-pane', 'pane-b');
  await tick();
  assert.equal(ui.$('metric-state').textContent, '需要介入');
  assertTargetIdentity(`${ui.$('agent-heading').textContent} ${ui.$('agent-detail').textContent}`, 'pane-b', snapshot);
  assert.ok(ui.$('agent-detail').textContent.includes('需要介入'));
  for (const id of ['output-target-label', 'control-target-name']) {
    assertTargetIdentity(ui.$(id).textContent, 'pane-b', snapshot);
  }
  assertTargetIdentity(ui.$('desktop-focus').textContent, 'pane-a', snapshot);
  assert.equal(ui.$('metric-focus').textContent, 'pane-a', 'the separately labelled computer display still describes actual focus');
  assert.equal(ui.window.document.querySelector('[data-focus-pane="pane-a"]').disabled, true);
  assert.equal(ui.window.document.querySelector('[data-focus-pane="pane-b"]').disabled, false);
  assert.equal(ui.requests.some((request) => request.path.startsWith('/api/focus/')), false);
  ui.change('context-pane', 'pane-a');
  ui.setState({ ...snapshot, focused_pane_id: 'pane-c', focused_workspace_id: 'workspace-b' });
  ui.click('refresh-button');
  await tick();
  assert.equal(ui.$('context-pane').value, 'pane-a', 'a refresh must retain the selected task despite blocked work and changed computer focus');
  assertTargetIdentity(`${ui.$('agent-heading').textContent} ${ui.$('agent-detail').textContent}`, 'pane-a', snapshot);
  assertTargetIdentity(ui.$('desktop-focus').textContent, 'pane-c', snapshot);
});

test('overview task cards prioritize blocked work and open the correct pane without focusing the computer', async (t) => {
  const snapshot = taskState();
  const ui = page(t, { initialState: snapshot });
  await tick();
  const cards = [...ui.$('task-list').querySelectorAll('[data-open-pane]')];
  assert.equal(cards.length, snapshot.panes.length);
  assert.equal(cards[0].dataset.openPane, 'pane-b');
  for (const card of cards) assertTargetIdentity(card.textContent, card.dataset.openPane, snapshot);
  cards[0].click();
  await tick();
  assert.equal(ui.$('attention-view').hidden, false);
  assert.equal(ui.$('context-pane').value, 'pane-b');
  assert.equal(ui.$('attention-pane').textContent, 'pane-b');
  assert.ok(ui.$('attention-workspace').textContent.includes('workspace-b') || ui.$('attention-workspace').textContent.includes('Beta project'));
  assert.ok(ui.$('attention-output-console').textContent.includes('/api/panes/pane-b/output'));
  assert.equal(ui.requests.filter((request) => request.path.endsWith('/output')).at(-1).path, '/api/panes/pane-b/output');
  for (const paneId of ['pane-a', 'pane-c']) {
    ui.click('tab-overview');
    ui.$('task-list').querySelector(`[data-open-pane="${paneId}"]`).click();
    await tick();
    assert.equal(ui.$('output-view').hidden, false);
    assert.equal(ui.$('context-pane').value, paneId);
    assert.ok(ui.$('output-console').textContent.includes(`/api/panes/${paneId}/output`));
  }
  assert.equal(ui.requests.some((request) => request.path.startsWith('/api/focus/')), false);
});

test('opening a pane on the computer preserves the mobile task and its output', async (t) => {
  const snapshot = taskState();
  const ui = page(t, { initialState: snapshot });
  await tick();
  ui.change('context-pane', 'pane-b');
  await tick();
  const output = ui.$('output-console').textContent;
  assert.ok(output.includes('/api/panes/pane-b/output'));
  ui.click('tab-focus');
  const pending = ui.hold('/api/focus/pane');
  ui.window.document.querySelector('[data-focus-pane="pane-c"]').click();
  assert.deepEqual(JSON.parse(pending.request.options.body), { pane_id: 'pane-c' });
  ui.setState({ ...snapshot, focused_pane_id: 'pane-c', focused_workspace_id: 'workspace-b' });
  pending.respond({ ok: true });
  await tick();
  assert.equal(ui.$('context-pane').value, 'pane-b');
  assertTargetIdentity(ui.$('control-target-name').textContent, 'pane-b', snapshot);
  assertTargetIdentity(ui.$('desktop-focus').textContent, 'pane-c', snapshot);
  assert.equal(ui.$('output-console').textContent, output);
  assert.equal(ui.requests.some((request) => request.path === '/api/panes/pane-c/output'), false);
});

for (const view of ['overview', 'control']) {
  test(`a pending output reply cannot pull the user out of the ${view} view`, async (t) => {
    const ui = page(t);
    await tick();
    ui.click('tab-output');
    await tick();
    const pending = ui.hold('/api/panes/pane-a/output');
    ui.click('output-refresh');
    ui.click(`tab-${view}`);
    assert.equal(ui.$(`${view}-view`).hidden, false);
    pending.respond({ text: 'Output received after changing views' });
    await tick();
    assert.equal(ui.$(`${view}-view`).hidden, false);
    assert.equal(ui.$('output-view').hidden, true);
    assert.equal(ui.$(`tab-${view}`).getAttribute('aria-selected'), 'true');
    assert.ok(ui.$('output-console').textContent.includes('Output received after changing views'));
  });
}

for (const status of ['blocked', 'done']) {
  test(`${status} attention places output before reply controls and keeps advanced actions collapsed`, async (t) => {
    const snapshot = taskState();
    snapshot.panes.find((pane) => pane.pane_id === 'pane-b').agent_status = status;
    const ui = page(t, { initialState: snapshot, url: `http://localhost/?view=attention&pane=pane-b&workspace=workspace-b&status=${status}` });
    await tick();
    const follows = ui.window.Node.DOCUMENT_POSITION_FOLLOWING;
    assert.equal(ui.$('attention-view').hidden, false);
    for (const id of ['attention-control-heading', 'attention-control-slot']) {
      assert.ok(ui.$('attention-output-block').compareDocumentPosition(ui.$(id)) & follows, `output must precede ${id} in the DOM`);
    }
    assert.equal(ui.$('control-surface').parentElement, ui.$('attention-control-slot'));
    assert.ok(ui.$('input-form').compareDocumentPosition(ui.$('prompt-form')) & follows);
    assert.equal(ui.$('input-form').closest('details'), null, 'terminal replies stay directly available');
    const promptDetails = ui.$('prompt-form').closest('details');
    assert.ok(promptDetails, 'new tasks belong in a details disclosure');
    assert.equal(promptDetails.open, false);
    const extraKeys = ui.window.document.querySelector('[data-input-key="escape"]').closest('details');
    assert.ok(extraKeys, 'extra terminal keys belong in a details disclosure');
    assert.equal(extraKeys.open, false);
    const enter = ui.window.document.querySelector('[data-input-key="enter"]');
    assert.equal(enter.closest('details'), null);
    assert.equal(enter.textContent.trim(), '输入并回车');
  });
}

test('reply and Enter sends the selected pane, text, and enter key through the existing input API', async (t) => {
  const ui = page(t, { initialState: taskState() });
  await tick();
  ui.$('task-list').querySelector('[data-open-pane="pane-b"]').click();
  await tick();
  ui.$('input-text').value = 'yes，继续';
  ui.window.document.querySelector('[data-input-key="enter"]').click();
  await tick();
  const inputs = ui.requests.filter((request) => request.path === '/api/control/input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(inputs[0].options.body), { pane_id: 'pane-b', text: 'yes，继续', keys: ['enter'] });
  assert.equal(ui.requests.some((request) => request.path === '/api/control/prompt' || request.path.startsWith('/api/focus/')), false);
});

test('desktop and mobile navigation name computer display and replies consistently with one output refresh entry', async (t) => {
  const ui = page(t);
  await tick();
  for (const navigation of ['.tabs', '.mobile-actions']) {
    const nav = ui.window.document.querySelector(navigation);
    for (const [view, name] of [['focus', '电脑显示'], ['control', '回复与任务']]) {
      const button = nav.querySelector(`[data-view="${view}"]`);
      assert.ok((button.getAttribute('aria-label') || button.textContent).includes(name));
    }
  }
  assert.equal(ui.window.document.querySelector('.utility-rail'), null);
  assert.equal(ui.$('load-output'), null);
  assert.equal(ui.$('output-view').querySelectorAll('#output-refresh').length, 1);
});

test('offline startup restores marked cached state without extending its lifetime', async (t) => {
  const cacheRecord = { saved_at: new Date(Date.now() - 60_000).toISOString(), data: state('offline-cache') };
  const ui = page(t, { initialOnline: false, cacheRecord, sessionMarker: true });
  await tick();
  assert.equal(ui.$('app-shell').hidden, false);
  assert.equal(ui.$('connection-label').textContent, '离线');
  assert.equal(ui.$('prompt-button').disabled, true);
  assert.equal(ui.$('context-pane').value, 'pane-a');
  assert.deepEqual(JSON.parse(ui.window.localStorage.getItem(CACHE_KEY)), cacheRecord);
  assert.equal(ui.requests.some((request) => request.path === '/api/state'), false);
  assert.equal(ui.streams.length, 0);
  ui.setState(state('after-offline-start'));
  ui.connectivity(true);
  await tick();
  assert.equal(ui.cache()?.version, 'after-offline-start');
  assert.equal(ui.$('prompt-button').disabled, false);
});

test('offline startup does not expose a cached snapshot without a session marker', async (t) => {
  const ui = page(t, { initialOnline: false, cacheRecord: { saved_at: new Date().toISOString(), data: state('unmarked-cache') } });
  await tick();
  assert.equal(ui.$('app-shell').hidden, true);
  assert.equal(ui.$('login-screen').hidden, false);
  assert.equal(ui.streams.length, 0);
});

test('a current startup 401 clears the cached snapshot and session marker', async (t) => {
  const ui = page(t, { signedIn: false, cacheRecord: { saved_at: new Date().toISOString(), data: state('expired-cache') }, sessionMarker: true });
  await tick();
  assert.equal(ui.$('app-shell').hidden, true);
  assert.equal(ui.cache(), undefined);
  assert.equal(ui.window.localStorage.getItem(SESSION_KEY), null);
  assert.equal(ui.streams.length, 0);
});

test('a temporary startup failure restores cached state without rewriting it', async (t) => {
  const cacheRecord = { saved_at: new Date(Date.now() - 60_000).toISOString(), data: state('fallback-cache') };
  const ui = page(t, { bootPending: true, cacheRecord, sessionMarker: true });
  ui.boot.respond({}, 503);
  await tick();
  assert.equal(ui.$('app-shell').hidden, false);
  assert.equal(ui.$('connection-label').textContent, '离线');
  assert.equal(ui.$('prompt-button').disabled, true);
  assert.deepEqual(JSON.parse(ui.window.localStorage.getItem(CACHE_KEY)), cacheRecord);
});

test('a startup response received after going offline cannot mark cached state connected', async (t) => {
  const cacheRecord = { saved_at: new Date().toISOString(), data: state('before-disconnect') };
  const ui = page(t, { bootPending: true, cacheRecord, sessionMarker: true });
  ui.connectivity(false);
  ui.boot.respond(state('received-offline'));
  await tick();
  assert.equal(ui.$('app-shell').hidden, false);
  assert.equal(ui.$('connection-label').textContent, '离线');
  assert.equal(ui.$('prompt-button').disabled, true);
  assert.equal(ui.cache()?.version, 'before-disconnect');
  assert.equal(ui.streams.length, 0);
});

test('logout discards late state and SSE events without restoring cleared cache or scheduling reads', async (t) => {
  const ui = page(t);
  await tick();
  const oldStream = ui.streams.at(-1);
  const pending = ui.hold('/api/state');
  ui.click('refresh-button');
  ui.click('refresh-button');
  ui.click('logout-button');
  await tick();
  assert.equal(ui.$('app-shell').hidden, true);
  const count = ui.requests.filter((r) => r.path === '/api/state').length;
  pending.respond(state('stale'));
  oldStream.emit('ready', { context: { generation: 'old-generation' } });
  oldStream.emit('pane_agent_status_changed', { context: { pane_id: 'pane-a', agent_status: 'done' } });
  await tick();
  assert.equal(ui.$('app-shell').hidden, true);
  assert.equal(ui.cache(), undefined);
  assert.equal(ui.$('connection-label').textContent, '离线');
  assert.equal(ui.window.localStorage.getItem(SESSION_KEY), null);
  assert.equal(ui.requests.filter((r) => r.path === '/api/state').length, count);
  assert.equal(pending.request.options.signal.aborted, true);
});

for (const status of [200, 401]) {
  test(`a late ${status} response from the old session cannot affect a new login`, async (t) => {
    const ui = page(t);
    await tick();
    const pending = ui.hold('/api/state');
    ui.click('refresh-button');
    ui.click('logout-button');
    await tick();
    ui.setState(state('new-session'));
    ui.login();
    await tick();
    assert.equal(ui.cache()?.version, 'new-session', 'login must start its own state request');
    pending.respond(state('old-session'), status);
    await tick();
    assert.equal(ui.$('app-shell').hidden, false);
    assert.equal(ui.cache().version, 'new-session');
    assert.equal(ui.$('connection-label').textContent, '已连接');
    assert.equal(ui.window.localStorage.getItem(SESSION_KEY), '1');
  });
}

test('a pending startup probe cannot undo a login or reopen the shell after logout', async (t) => {
  const ui = page(t, { bootPending: true, signedIn: false });
  ui.setState(state('login-state'));
  ui.login();
  await tick();
  assert.equal(ui.cache()?.version, 'login-state');
  ui.click('logout-button');
  await tick();
  ui.boot.respond(state('startup-state'));
  await tick();
  assert.equal(ui.$('app-shell').hidden, true);
  assert.equal(ui.cache(), undefined);
  assert.equal(ui.streams.every((stream) => stream.readyState === 2), true);
});

test('logout immediately hides state and waits for cookie revocation before enabling login', async (t) => {
  const ui = page(t);
  await tick();
  const logout = ui.hold('/api/auth/logout');
  ui.click('logout-button');
  assert.equal(ui.$('app-shell').hidden, true);
  assert.equal(ui.cache(), undefined);
  assert.equal(ui.$('login-button').disabled, true);
  ui.login();
  assert.equal(ui.requests.some((r) => r.path === '/api/auth/login'), false);
  logout.respond({ ok: true });
  await tick();
  assert.equal(ui.$('login-button').disabled, false);
});

test('logout timeout releases the login form while keeping local state cleared', async (t) => {
  const ui = page(t);
  await tick();
  const setTimeout = ui.window.setTimeout.bind(ui.window);
  t.mock.method(ui.window, 'setTimeout', (callback, delay, ...args) => setTimeout(callback, delay === 10_000 ? 0 : delay, ...args));
  const logout = ui.hold('/api/auth/logout', { honorAbort: true });
  ui.click('logout-button');
  assert.equal(ui.$('login-button').disabled, true);
  await tick();
  assert.equal(logout.request.options.signal.aborted, true);
  assert.equal(ui.$('login-button').disabled, false);
  assert.equal(ui.$('app-shell').hidden, true);
  assert.equal(ui.cache(), undefined);
  assert.equal(ui.window.localStorage.getItem(SESSION_KEY), null);
  ui.login();
  await tick();
  assert.equal(ui.$('app-shell').hidden, false);
});

test('logout during login state loading cannot be reversed by its continuation', async (t) => {
  const ui = page(t, { signedIn: false });
  await tick();
  const pending = ui.hold('/api/state');
  ui.login();
  await tick();
  ui.click('logout-button');
  await tick();
  pending.respond(state('cancelled-login'));
  await tick();
  assert.equal(ui.$('app-shell').hidden, true);
  assert.equal(ui.cache(), undefined);
  assert.equal(ui.streams.length, 0);
});

test('notification login interrupted by offline state loading restores its target after reconnect', async (t) => {
  const ui = page(t, { signedIn: false, url: 'http://localhost/?view=attention&pane=pane-b' });
  await tick();
  const pending = ui.hold('/api/state');
  ui.login();
  await tick();
  ui.connectivity(false);
  pending.respond(state('discarded-login-state'));
  await tick();
  assert.equal(ui.$('prompt-button').disabled, true);
  ui.connectivity(true);
  await tick();
  assert.equal(ui.$('attention-view').hidden, false);
  assert.equal(ui.$('context-pane').value, 'pane-b');
  assert.equal(ui.$('prompt-button').disabled, false);
});

test('offline invalidates pending reads and online resynchronizes before enabling control', async (t) => {
  const ui = page(t);
  await tick();
  const pending = ui.hold('/api/state');
  ui.click('refresh-button');
  ui.connectivity(false);
  pending.respond(state('late-online-state'));
  await tick();
  assert.equal(ui.$('connection-label').textContent, '离线');
  assert.equal(ui.$('prompt-button').disabled, true);
  assert.equal(ui.cache().version, 'initial');
  ui.setState(state('reconnected'));
  ui.connectivity(true);
  await tick();
  assert.equal(ui.cache().version, 'reconnected');
  assert.equal(ui.$('prompt-button').disabled, false);
});

test('SSE readiness after reconnect cannot enable controls before the fresh snapshot', async (t) => {
  const ui = page(t);
  await tick();
  ui.connectivity(false);
  const pending = ui.hold('/api/state');
  ui.connectivity(true);
  await tick();
  ui.streams.at(-1).emit('open');
  ui.streams.at(-1).emit('ready', { context: { generation: 'new-server' } });
  assert.equal(ui.$('prompt-button').disabled, true);
  pending.respond(state('fresh-after-ready'));
  await tick();
  assert.equal(ui.$('prompt-button').disabled, false);
});

test('an expired current login reports an error and permits another attempt', async (t) => {
  const ui = page(t, { signedIn: false });
  await tick();
  const pending = ui.hold('/api/state');
  ui.login();
  await tick();
  pending.respond({}, 401);
  await tick();
  assert.equal(ui.$('app-shell').hidden, true);
  assert.notEqual(ui.$('login-error').textContent, '');
  assert.equal(ui.$('login-button').disabled, false);
});

test('a failed manual refresh shows feedback without an unhandled rejection and can recover', async (t) => {
  const ui = page(t);
  await tick();
  const pending = ui.hold('/api/state');
  ui.click('refresh-button');
  pending.respond({}, 503);
  await tick();
  assert.equal(ui.$('connection-label').textContent, '离线');
  assert.equal(ui.$('refresh-button').classList.contains('is-spinning'), false);
  ui.click('refresh-button');
  await tick();
  assert.equal(ui.$('connection-label').textContent, '已连接');
});

for (const action of ['prompt', 'input', 'focus']) {
  test(`a late ${action} result cannot change a later session's form or selected pane`, async (t) => {
    const ui = page(t);
    await tick();
    const path = action === 'focus' ? '/api/focus/pane' : `/api/control/${action}`;
    const pending = ui.hold(path);
    if (action === 'focus') ui.window.document.querySelector('[data-focus-pane="pane-b"]').click();
    else {
      ui.$(`${action}-text`).value = 'old task';
      ui.submit(`${action}-form`);
    }
    ui.click('logout-button');
    await tick();
    ui.login();
    await tick();
    ui.$('prompt-text').value = 'new task';
    ui.$('input-text').value = 'new input';
    const count = ui.requests.filter((r) => r.path === '/api/state').length;
    pending.respond({ ok: true });
    await tick();
    assert.equal(ui.$('prompt-text').value, 'new task');
    assert.equal(ui.$('input-text').value, 'new input');
    assert.equal(ui.$('context-pane').value, 'pane-a');
    assert.equal(ui.requests.filter((r) => r.path === '/api/state').length, count);
  });
}

test('rapid pane changes retain the latest output even when replies arrive in reverse order', async (t) => {
  const ui = page(t);
  await tick();
  const first = ui.hold('/api/panes/pane-a/output');
  const second = ui.hold('/api/panes/pane-b/output');
  ui.change('context-pane', 'pane-a');
  ui.change('context-pane', 'pane-b');
  second.respond({ text: 'Output B' });
  await tick();
  first.respond({ text: 'Output A' });
  await tick();
  assert.equal(ui.$('context-pane').value, 'pane-b');
  assert.ok(ui.window.document.body.textContent.includes('Output B'));
  assert.ok(!ui.window.document.body.textContent.includes('Output A'));
});

for (const view of ['output', 'attention']) {
  test(`${view} refresh is enabled again after output succeeds or fails`, async (t) => {
    const ui = page(t, { url: view === 'attention' ? 'http://localhost/?view=attention&pane=pane-a' : 'http://localhost/' });
    await tick();
    const button = view === 'attention' ? 'attention-output-refresh' : 'output-refresh';
    const pending = ui.hold('/api/panes/pane-a/output');
    ui.change('context-pane', 'pane-a');
    if (view === 'attention') ui.click(button);
    assert.equal(ui.$(button).disabled, true);
    pending.respond({ text: 'Latest output' });
    await tick();
    assert.equal(ui.$(button).disabled, false);
    const failed = ui.hold('/api/panes/pane-a/output');
    ui.click(button);
    assert.equal(ui.$(button).disabled, true);
    failed.respond({}, 503);
    await tick();
    assert.equal(ui.$(button).disabled, false);
  });
}

for (const action of ['deselect', 'clear']) {
  test(`${action} discards output already in flight`, async (t) => {
    const ui = page(t);
    await tick();
    const pending = ui.hold('/api/panes/pane-a/output');
    ui.change('context-pane', 'pane-a');
    if (action === 'deselect') ui.change('context-pane', '');
    else ui.click('clear-output');
    pending.respond({ text: 'Output that was cleared' });
    await tick();
    assert.ok(!ui.window.document.body.textContent.includes('Output that was cleared'));
  });
}

test('notification menu and keyboard tabs update visibility, focus, and ARIA state', async (t) => {
  const ui = page(t);
  await tick();
  ui.click('notification-toggle');
  assert.equal(ui.$('push-card').hidden, false);
  assert.equal(ui.$('notification-toggle').getAttribute('aria-expanded'), 'true');
  ui.window.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.$('push-card').hidden, true);
  assert.equal(ui.window.document.activeElement, ui.$('notification-toggle'));
  ui.click('notification-toggle');
  ui.window.document.body.click();
  assert.equal(ui.$('push-card').hidden, true);
  const tabs = [...ui.window.document.querySelectorAll('[role="tab"]')].filter((tab) => !tab.hidden);
  tabs[0].dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[0].tabIndex, -1);
  assert.equal(ui.window.document.activeElement, tabs[1]);
  assert.equal(ui.$(tabs[1].getAttribute('aria-controls')).hidden, false);
});

test('keyboard navigation into the attention tab keeps focus in the tablist', async (t) => {
  const ui = page(t, { url: 'http://localhost/?view=attention&pane=pane-a' });
  await tick();
  const tabs = [...ui.window.document.querySelectorAll('[role="tab"]')].filter((tab) => !tab.hidden);
  tabs[0].click();
  tabs[0].focus();
  tabs[0].dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await tick();
  assert.equal(ui.window.document.activeElement, ui.$('tab-attention'));
  ui.window.document.activeElement.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await tick();
  assert.equal(ui.window.document.activeElement, tabs[0]);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(ui.$('context-pane').disabled, false, 'leaving attention must unlock the shared pane selector');
});
