// Bump the shell cache whenever the dashboard assets change.  The service
// worker is cache-first for the app shell, so keeping the old name would leave
// existing phones serving stale JavaScript (including missing control views).
const CACHE_NAME = 'herdr-mobile-v30';
const APP_SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/ansi.js', '/deep-link.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  // Keep an updated worker in the waiting phase until the open page gives
  // explicit consent through the update banner. This prevents a background
  // update from swapping the app shell halfway through an interaction.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  ]));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // API calls must stay network-only so an offline snapshot is never mistaken
  // for current Herdr state.
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (!response.ok) return response;
    const copy = response.clone();
    void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match('/index.html'))));
});

self.addEventListener('push', (event) => {
  let data = { title: 'Herdr', body: '有新的会话更新', url: '/' };
  try {
    const parsed = event.data ? event.data.json() : {};
    const envelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const nested = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? envelope.data
      : {};
    // Accept both the bridge's top-level payload and relays that wrap it in a
    // `data` object. Top-level values win, while arbitrary nested fields are
    // still ignored by notificationMetadata below.
    data = { ...data, ...nested, ...envelope };
  } catch { /* malformed push uses the safe default */ }
  const title = typeof data.title === 'string' ? data.title.slice(0, 120) : 'Herdr';
  const body = typeof data.body === 'string' ? data.body.slice(0, 240) : '有新的会话更新';
  const target = safeNotificationUrl(data.url);
  const metadata = notificationMetadata(data, target);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: notificationTag(metadata),
    renotify: true,
    // Keep only the fields needed to restore the action panel. In particular,
    // do not copy arbitrary push properties (or terminal output) into the
    // notification object, which may be persisted by the browser.
    data: metadata,
  }));
});

// Push payloads are received from a remote browser push service. Keep the
// click target same-origin and reject protocol-relative URLs (`//host/...`),
// which otherwise look like relative paths but navigate to an attacker host.
function safeNotificationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const parsed = new URL(value, self.location.origin);
    return parsed.origin === self.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
  } catch {
    return '/';
  }
}

// Notification data is a browser-persisted boundary. Copy a small, explicit
// metadata allowlist and bound each value before it can be read by a click
// handler or another window. The URL has already passed same-origin checks.
function notificationMetadata(data, target) {
  const result = { url: target };
  const fields = [
    ['view', 32],
    ['event', 80],
    ['status', 32],
    ['pane_id', 256],
    ['workspace_id', 256],
    ['agent', 120],
  ];
  for (const [name, limit] of fields) {
    const value = safeNotificationText(data?.[name], limit);
    if (value) result[name] = value;
  }
  return result;
}

function safeNotificationText(value, limit) {
  if (value === undefined || value === null) return '';
  let text;
  try {
    text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  } catch {
    return '';
  }
  if (typeof text.toWellFormed === 'function') text = text.toWellFormed();
  else if (/[\uD800-\uDFFF]/.test(text)) text = text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  return text.slice(0, limit);
}

function notificationTag(metadata) {
  const identity = metadata.pane_id || metadata.workspace_id || 'status';
  // A tag is not navigated to, but bounding it avoids browser-specific limits
  // and keeps notification replacement deterministic for hostile identifiers.
  return `herdr-${safeNotificationText(identity, 128) || 'status'}`;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeNotificationUrl(event.notification.data?.url);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => 'focus' in client);
    if (existing) {
      // Await navigation before focusing so the action panel sees the full
      // query string even when an existing tab was showing the login screen.
      try { await existing.navigate(target); } catch { /* a closing tab may reject navigation */ }
      try { return await existing.focus(); } catch { return existing; }
    }
    return self.clients.openWindow(target);
  }));
});
