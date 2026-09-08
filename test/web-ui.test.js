import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('responsive console keeps discovery controls and selectors at touch size', async (t) => {
  const [html, css, app] = await Promise.all([
    readFile(join(ROOT, 'public', 'index.html'), 'utf8'),
    readFile(join(ROOT, 'public', 'styles.css'), 'utf8'),
    readFile(join(ROOT, 'public', 'app.js'), 'utf8'),
  ]);
  assert.match(html, /class="mobile-actions"/);
  assert.match(html, /id="mobile-attention"/);
  assert.match(html, /id="live-label"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="notification-toggle"[^>]+aria-expanded="false"[^>]+aria-controls="push-card"/);
  assert.match(html, /class="push-card notification-popover" id="push-card"[^>]+hidden/);
  assert.match(html, /<details class="connection-guide" id="connection-guide">/);
  assert.match(html, /id="context-pane"/);
  assert.match(html, /id="attention-back"/);
  assert.match(html, /id="attention-dismiss"/);
  assert.match(html, /data-max-bytes="32768"/);
  assert.match(html, /data-max-bytes="8192"/);
  assert.match(app, /class="discovery-link"/);
  assert.match(app, /outputScrollState = new WeakMap/);
  assert.match(app, /previousView !== requested/);
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  style.textContent = css;
  dom.window.document.head.appendChild(style);
  // Discovery rows are produced at runtime; use their actual class contract
  // to check the CSS cascade instead of depending on duplicated CSS rules.
  const discoveryRow = dom.window.document.createElement('div');
  discoveryRow.className = 'discovery-url';
  discoveryRow.innerHTML = '<button class="secondary-button">复制地址</button>';
  dom.window.document.body.appendChild(discoveryRow);
  for (const selector of ['.discovery-url .secondary-button', '.discovery-actions button', 'select', '.token-field input']) {
    const controls = [...dom.window.document.querySelectorAll(selector)];
    assert.ok(controls.length > 0, `expected controls matching ${selector}`);
    for (const control of controls) {
      assert.ok(Number.parseFloat(dom.window.getComputedStyle(control).minHeight) >= 44, `${selector} must retain a 44px touch target`);
    }
  }
  assert.match(css, /\.tabs \{ display: none; \}/);
  assert.match(css, /@media \(max-width: \d+px\)[\s\S]*\.shell\s*\{[^}]*padding:[^;}]*safe-area-inset-bottom/);
  assert.match(css, /\.notification-menu \{ position: relative;/);
  assert.match(css, /\.notification-popover \{/);
  assert.match(app, /notificationOpen: false/);
  assert.match(app, /function setNotificationOpen\(open/);
  assert.match(app, /event\.key !== 'Escape' \|\| !model\.notificationOpen/);
});

test('offline cache and attention controls cannot become stale write surfaces', async () => {
  const app = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(!cached\) saveCachedState\(body\)/);
  assert.match(app, /focus\.disabled = !model\.connected \|\| model\.focusBusy/);
  assert.match(app, /model\.streamReset = true/);
});

test('attention output remains scoped to the notification pane', async () => {
  const app = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /outputPaneId: ''/);
  assert.match(app, /function enterAttentionTarget\(\)/);
  assert.match(app, /view === 'attention' && model\.attention\?\.pane\) id = model\.attention\.pane/);
  assert.match(app, /requested === 'attention'[\s\S]*enterAttentionTarget\(\)/);
  assert.match(app, /model\.activeView === 'attention' && model\.attention\?\.pane && model\.outputPaneId !== model\.attention\.pane/);
});

test('output view requests ANSI snapshots and keeps clipboard output plain', async () => {
  const [app, sw] = await Promise.all([
    readFile(join(ROOT, 'public', 'app.js'), 'utf8'),
    readFile(join(ROOT, 'public', 'sw.js'), 'utf8'),
  ]);
  assert.match(app, /from '\.\/ansi\.js'/);
  assert.match(app, /source=recent_unwrapped&format=ansi&strip_ansi=0/);
  assert.match(app, /renderAnsi\(node, value\)/);
  assert.match(app, /ansiToText\(model\.output/);
  assert.match(sw, /'\/ansi\.js'/);
});

test('short mobile screens schedule overlap protection after layout and viewport changes', async () => {
  const app = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /function protectMobileNavOverlap\(view = model\.activeView\)/);
  assert.match(app, /panel\.querySelector\('\.task-card'\)/);
  assert.match(app, /function scheduleMobileNavProtection\(\)/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /document\.scrollingElement/);
  assert.match(app, /window\.addEventListener\('pageshow', schedule\)/);
  assert.match(app, /window\.addEventListener\('resize', schedule/);
  assert.match(app, /if \(model\.authenticated\) scheduleMobileNavProtection\(\)/);
});
