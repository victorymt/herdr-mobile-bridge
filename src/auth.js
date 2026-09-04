import { randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_COOKIE = 'herdr_bridge_session';
const DEFAULT_CSRF_COOKIE = 'XSRF-TOKEN';

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch {
      cookies[key] = raw;
    }
  }
  return cookies;
}

export function parseBearer(header) {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function normaliseTtl(value, fallback) {
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : fallback;
}

/** In-memory login sessions backed by a static owner token. */
export class AuthManager {
  constructor(options = {}) {
    this.token = String(options.token || '');
    this.ttlMs = normaliseTtl(options.ttlMs, 7 * 24 * 60 * 60 * 1000);
    this.cookieName = options.cookieName || DEFAULT_COOKIE;
    this.csrfCookieName = options.csrfCookieName || DEFAULT_CSRF_COOKIE;
    this.cookieSecure = Boolean(options.cookieSecure);
    this.clock = options.clock || (() => Date.now());
    this.random = options.random || (() => randomBytes(32).toString('base64url'));
    this.sessions = new Map();
  }

  prune() {
    const now = this.clock();
    for (const [session, value] of this.sessions) {
      const expiry = typeof value === 'number' ? value : value?.expiresAt;
      if (!Number.isFinite(expiry) || expiry <= now) this.sessions.delete(session);
    }
  }

  verifyOwnerToken(candidate) {
    // An unconfigured owner token must fail closed. Without this guard an
    // empty candidate would compare equal to the empty constructor default.
    if (!this.token) return false;
    return constantTimeEqual(String(candidate || ''), this.token);
  }

  login(credentials = {}) {
    this.prune();
    const input = credentials && typeof credentials === 'object' ? credentials : {};
    // The hook secret authenticates only loopback event delivery. Never accept
    // it as a browser login credential: conflating the two secrets would let a
    // locally readable event-hook environment leak full mobile control.
    const candidate = input.token ?? input.access_token ?? input.password;
    if (!this.verifyOwnerToken(candidate)) return { ok: false, reason: 'invalid_credentials' };
    const session = this.random();
    const csrf = this.random();
    const expiresAt = this.clock() + this.ttlMs;
    this.sessions.set(session, { expiresAt, csrf });
    return { ok: true, session, csrf, expiresAt };
  }

  logout(requestOrSession) {
    const session = typeof requestOrSession === 'string'
      ? requestOrSession
      : this.extractSession(requestOrSession);
    if (session) this.sessions.delete(session);
    return Boolean(session);
  }

  extractSession(request, url, options = {}) {
    if (!request) return undefined;
    const bearer = parseBearer(request.headers?.authorization);
    if (bearer) return bearer;
    const headerToken = request.headers?.['x-bridge-token'] || request.headers?.['x-herdr-bridge-token'];
    if (headerToken) return String(headerToken);
    const cookies = parseCookies(request.headers?.cookie);
    if (cookies[this.cookieName]) return cookies[this.cookieName];
    // EventSource cannot set arbitrary headers. Query-token support is opt-in
    // and must not be accepted by ordinary API routes (URLs are logged).
    if (options.allowQuery) {
      if (url?.searchParams?.get('access_token')) return url.searchParams.get('access_token');
      if (url?.searchParams?.get('token')) return url.searchParams.get('token');
    }
    return undefined;
  }

  authenticate(request, url, options = {}) {
    this.prune();
    const candidate = this.extractSession(request, url, options);
    if (!candidate) return { ok: false, reason: 'missing_credentials' };
    if (this.verifyOwnerToken(candidate)) return { ok: true, kind: 'owner', token: candidate };
    const stored = this.sessions.get(candidate);
    const expiresAt = typeof stored === 'number' ? stored : stored?.expiresAt;
    if (expiresAt && expiresAt > this.clock()) {
      return {
        ok: true,
        kind: 'session',
        token: candidate,
        expiresAt,
        csrf: typeof stored === 'object' ? stored.csrf : undefined,
      };
    }
    if (expiresAt) this.sessions.delete(candidate);
    return { ok: false, reason: 'invalid_credentials' };
  }

  sessionCookie(session, maxAgeSeconds = Math.floor(this.ttlMs / 1000), secure = this.cookieSecure) {
    const attributes = [
      `${this.cookieName}=${encodeURIComponent(session)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ];
    if (secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  csrfCookie(csrf, maxAgeSeconds = Math.floor(this.ttlMs / 1000), secure = this.cookieSecure) {
    const attributes = [
      `${this.csrfCookieName}=${encodeURIComponent(String(csrf || ''))}`,
      'Path=/',
      'SameSite=Strict',
      `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ];
    if (secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  clearCookie(secure = this.cookieSecure) {
    const attributes = [
      `${this.cookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
    ];
    if (secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  clearCsrfCookie(secure = this.cookieSecure) {
    const attributes = [
      `${this.csrfCookieName}=`,
      'Path=/',
      'SameSite=Strict',
      'Max-Age=0',
    ];
    if (secure) attributes.push('Secure');
    return attributes.join('; ');
  }
}

export { constantTimeEqual, DEFAULT_COOKIE, DEFAULT_CSRF_COOKIE };
