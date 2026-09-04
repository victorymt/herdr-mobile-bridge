import net from 'node:net';

import { assertBridgeHost, assertLanProxyHost } from './config.js';
import { compileAllowedCidrs, isLocalAddress } from './network-acl.js';
import {
  canonicalizeAddress,
  TokenBucketLimiter,
  DEFAULT_RATE_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_ENTRIES,
} from './rate-limit.js';

export const DEFAULT_LAN_PROXY_PORT = 18787;

function assertPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new TypeError('invalid LAN proxy port');
  return value;
}

/** A deliberately small, unauthenticated TCP forwarder for trusted LAN use. */
export class LanProxy {
  constructor(options = {}) {
    this.host = assertLanProxyHost(options.host);
    this.port = assertPort(options.port ?? DEFAULT_LAN_PROXY_PORT);
    // The forwarding target is intentionally constrained to loopback.  The
    // LAN listener is unauthenticated at the TCP layer; accepting a DNS name
    // or a remote IP here would turn it into an SSRF/open-proxy primitive.
    this.targetHost = assertBridgeHost(options.targetHost || '127.0.0.1');
    this.targetPort = assertPort(options.targetPort ?? 8787);
    this.net = options.net || net;
    // `allowedCidrs` is the transport-level option used by embedders; retain
    // the config-facing name as an alias so callers can pass a loaded config
    // object directly. Undefined deliberately means ACL disabled for backwards
    // compatibility. Explicit empty/invalid values throw here at construction
    // time, before a listener can be published.
    const allowedCidrs = options.allowedCidrs !== undefined
      ? options.allowedCidrs
      : options.lanProxyAllowedCidrs;
    this.acl = compileAllowedCidrs(allowedCidrs);
    this.allowedCidrs = this.acl?.cidrs;
    this.allowLocalSource = options.allowLocalSource !== false;
    this.connectionRateLimiter = options.connectionRateLimiter === false
      ? null
      : (options.connectionRateLimiter || new TokenBucketLimiter({
        ratePerMinute: options.rateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE,
        burst: options.rateLimitBurst ?? DEFAULT_RATE_LIMIT_BURST,
        maxEntries: options.rateLimitMaxEntries ?? DEFAULT_RATE_LIMIT_MAX_ENTRIES,
        now: options.now,
      }));
    this.closeTimeoutMs = Math.max(100, Math.min(10_000, Number(options.closeTimeoutMs) || 1_500));
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.onClose = typeof options.onClose === 'function' ? options.onClose : null;
    this.onReject = typeof options.onReject === 'function' ? options.onReject : null;
    this.server = null;
    this.connections = new Set();
    this.serverErrorHandler = null;
    this.closeNotified = false;
    this.healthy = false;
    // Serialize lifecycle transitions. A mobile client can trigger a restart
    // while the previous listener is still probing its backend; without a
    // queue, a second start() could report an address before the first one is
    // actually ready, or a close() could race the startup cleanup.
    this.lifecycle = Promise.resolve();
    this.lifecycleGeneration = 0;
    this.starting = false;
    this.serverCloseTarget = null;
    this.serverClosePromise = null;
  }

  start() {
    const generation = this.lifecycleGeneration;
    const run = this.lifecycle.then(() => this.startInternal(generation));
    // Keep the queue usable after a failed transition while preserving the
    // rejection for the caller that requested this transition.
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async startInternal(generation) {
    if (generation !== this.lifecycleGeneration) throw this.startCancelledError();
    if (this.server && this.healthy) return this.address();
    if (this.server) await this.closeServer(this.server);
    if (generation !== this.lifecycleGeneration) throw this.startCancelledError();

    this.closeNotified = false;
    this.healthy = false;
    this.starting = true;
    let server;
    try {
      server = this.net.createServer((client) => {
      // Check the peer address before opening or tracking a backend socket.
      // This is intentionally L4-only: forwarded headers are never consulted,
      // and an ACL rejection is a normal policy outcome rather than a listener
      // failure. Destroy immediately so raw HTTP/TLS clients cannot receive a
      // misleading response from the unauthenticated forwarding layer.
      if (!this.isClientAllowed(client)) {
        this.rejectClient(client, 'acl');
        return;
      }
      if (!this.isConnectionRateAllowed(client)) {
        this.rejectClient(client, 'rate_limit');
        return;
      }
      let target;
      try {
        target = this.net.createConnection({ host: this.targetHost, port: this.targetPort });
      } catch {
        try { client.destroy?.(); } catch { /* ignore */ }
        return;
      }
      this.track(client);
      this.track(target);
      const close = () => {
        try { client.destroy?.(); } catch { /* ignore */ }
        try { target.destroy?.(); } catch { /* ignore */ }
      };
      client.once?.('error', close);
      target.once?.('error', close);
      client.pipe?.(target);
      target.pipe?.(client);
      });
      this.server = server;
      await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          server.off?.('listening', ready);
          server.off?.('error', fail);
          server.off?.('close', closed);
          reject(error);
        };
        const ready = () => {
          if (settled) return;
          settled = true;
          server.off?.('error', fail);
          server.off?.('close', closed);
          resolve();
        };
        const closed = () => fail(this.startCancelledError());
        server.once?.('error', fail);
        server.once?.('listening', ready);
        server.once?.('close', closed);
        server.listen(this.port, this.host);
      });
      if (generation !== this.lifecycleGeneration) throw this.startCancelledError();
      this.serverErrorHandler = (error) => {
        if (this.server !== server) return;
        this.healthy = false;
        try { this.onError?.(error); } catch { /* callbacks must not crash the proxy */ }
        // An error emitted after listening means the forwarding listener is no
        // longer trustworthy. Clear the public server reference immediately,
        // then finish closing it asynchronously so discovery does not report a
        // dead listener as healthy.
        void this.closeServer(server).catch(() => {});
      };
      server.on?.('error', this.serverErrorHandler);
      await this.healthCheck();
      if (generation !== this.lifecycleGeneration || this.server !== server) throw this.startCancelledError();
      this.healthy = true;
      return this.address();
    } catch (error) {
      // A listener may already be bound when the health probe fails. Always
      // release it so a later retry cannot mistake the stale proxy for live.
      await this.closeServer(server);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  startCancelledError() {
    const error = new Error('LAN proxy start cancelled');
    error.code = 'ERR_LAN_PROXY_START_CANCELLED';
    return error;
  }

  track(socket) {
    if (!socket || typeof socket !== 'object') return;
    this.connections.add(socket);
    socket.once?.('close', () => this.connections.delete(socket));
  }

  isClientAllowed(client) {
    if (!this.acl) return true;
    let address;
    try { address = client?.remoteAddress; } catch { return false; }
    if (this.acl.allows(address)) return true;
    // A health probe originates on the listener host (or loopback on a few
    // platforms). Keep that local-source exception so enabling an ACL cannot
    // make the proxy fail its own startup check. It is based solely on the
    // kernel-reported socket address, never on X-Forwarded-For or similar data.
    return this.allowLocalSource && isLocalAddress(address, this.host);
  }

  isConnectionRateAllowed(client) {
    if (!this.connectionRateLimiter) return true;
    let address;
    try { address = client?.remoteAddress; } catch { return false; }
    // The in-process health probe (and other loopback maintenance clients)
    // must not consume the external connection budget, especially when an
    // embedder intentionally configures a burst of one.
    if (this.allowLocalSource && isLocalAddress(address, this.host)) return true;
    const key = `lan:connection:ip:${canonicalizeAddress(address)}`;
    try {
      const consume = typeof this.connectionRateLimiter.tryConsume === 'function'
        ? this.connectionRateLimiter.tryConsume
        : this.connectionRateLimiter.consume;
      if (typeof consume !== 'function') throw new TypeError('connection limiter must expose tryConsume() or consume()');
      const result = consume.call(this.connectionRateLimiter, [{ key }]);
      return result === true || result?.allowed === true;
    } catch {
      // A limiter failure must not turn an unbounded unauthenticated listener
      // into a bypass. Treat it as a policy rejection, without escalating to
      // the fatal listener onError callback.
      return false;
    }
  }

  rejectClient(client, reason = 'policy') {
    let address;
    try { address = client?.remoteAddress; } catch { address = undefined; }
    try { client?.destroy?.(); } catch { /* best effort */ }
    // Tear down the untrusted socket before invoking an observer callback so a
    // slow or faulty callback cannot postpone the policy decision.
    try { this.onReject?.(address, reason); } catch { /* callbacks must not crash the proxy */ }
  }

  healthCheck(timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      // Pin the probe's source interface. Without localAddress a host with
      // multiple routes can select an address outside the configured ACL and
      // make a valid listener appear unhealthy.
      const socket = this.net.createConnection({ host: this.host, port: this.port, localAddress: this.host });
      let data = '';
      let settled = false;
      let timer;
      const onData = (chunk) => {
        data += chunk.toString();
        if (/^HTTP\/1\.[01] 200\b/m.test(data)) done();
      };
      const onClose = () => done(new Error('LAN proxy health check connection closed before a healthy response'));
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off?.('data', onData);
        socket.off?.('error', done);
        socket.off?.('close', onClose);
        try { socket.destroy?.(); } catch { /* ignore */ }
        error ? reject(error) : resolve(true);
      };
      timer = setTimeout(() => done(new Error('LAN proxy health check timed out')), timeoutMs);
      socket.on?.('data', onData);
      socket.once?.('error', done);
      socket.once?.('close', onClose);
      socket.once?.('connect', () => {
        try { socket.write?.('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); } catch (error) { done(error); }
      });
    });
  }

  address() {
    const value = this.server?.address?.();
    return value && typeof value === 'object' ? { host: value.address, port: value.port } : { host: this.host, port: this.port };
  }

  close() {
    this.lifecycleGeneration += 1;
    // Interrupt a listener that is still in the listen phase. The startup
    // promise will observe the generation change and perform idempotent
    // cleanup in its catch path.
    if (this.starting && this.server) void this.closeServer(this.server).catch(() => {});
    const run = this.lifecycle.then(() => this.closeInternal());
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async closeInternal() {
    if (this.serverClosePromise) return this.serverClosePromise;
    if (this.server) return this.closeServer(this.server);
    this.healthy = false;
  }

  closeServer(server) {
    if (!server) return Promise.resolve();
    if (this.serverCloseTarget === server && this.serverClosePromise) return this.serverClosePromise;
    for (const socket of this.connections) {
      try { socket.destroy?.(); } catch { /* ignore */ }
    }
    this.connections.clear();
    if (this.server === server) this.server = null;
    this.healthy = false;
    if (this.serverErrorHandler) server.off?.('error', this.serverErrorHandler);
    this.serverErrorHandler = null;
    const closing = new Promise((resolve) => {
      let settled = false;
      let timer;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      // Give existing tunnels a short grace period, then force-close any
      // connections that did not react to destroy().
      timer = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch { /* best effort */ }
        done();
      }, this.closeTimeoutMs);
      try {
        server.close(done);
      } catch {
        done();
      }
    });
    const result = closing.then(() => {
      if (this.serverCloseTarget === server) {
        this.serverCloseTarget = null;
        this.serverClosePromise = null;
      }
      this.notifyClose();
    });
    this.serverCloseTarget = server;
    this.serverClosePromise = result;
    return result;
  }

  notifyClose() {
    if (this.closeNotified) return;
    this.closeNotified = true;
    try { this.onClose?.(); } catch { /* callbacks must not crash shutdown */ }
  }
}

export { assertLanProxyHost, assertPort as assertLanProxyPort };
