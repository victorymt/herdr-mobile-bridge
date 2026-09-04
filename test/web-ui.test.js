import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('responsive console keeps discovery controls and selectors at touch size', async () => {
  const [html, css, app] = await Promise.all([
    readFile(join(ROOT, 'public', 'index.html'), 'utf8'),
    readFile(join(ROOT, 'public', 'styles.css'), 'utf8'),
    readFile(join(ROOT, 'public', 'app.js'), 'utf8'),
  ]);
  assert.match(html, /class="mobile-actions"/);
  assert.match(html, /id="mobile-attention"/);
  assert.match(html, /id="live-label"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /data-max-bytes="32768"/);
  assert.match(html, /data-max-bytes="8192"/);
  assert.match(app, /class="discovery-link"/);
  assert.match(app, /outputScrollState = new WeakMap/);
  assert.match(app, /previousView !== requested/);
  assert.match(css, /\.discovery-url \.secondary-button, \.discovery-actions button \{ min-height: 44px; \}/);
  assert.match(css, /select, \.token-field input \{ min-height: 44px; \}/);
  assert.match(css, /\.tabs \{ display: none; \}/);
  assert.match(css, /\.main-column > \.view \{ padding-bottom:/);
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
  assert.match(app, /panel\.querySelector\('\.status-grid'\) \|\| panel\.querySelector\('\.section-heading, \.control-target'\)/);
  assert.match(app, /function scheduleMobileNavProtection\(\)/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /document\.scrollingElement/);
  assert.match(app, /window\.addEventListener\('pageshow', schedule\)/);
  assert.match(app, /window\.addEventListener\('resize', schedule/);
  assert.match(app, /if \(model\.authenticated\) scheduleMobileNavProtection\(\)/);
});
