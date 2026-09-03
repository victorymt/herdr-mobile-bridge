import net from 'node:net';

export const DEFAULT_LAN_PROXY_PORT = 18787;

function assertHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  if (!value || value === '0.0.0.0' || value === '::' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('LAN proxy host must be an explicit interface address');
  }
  return value;
}

function assertPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new TypeError('invalid LAN proxy port');
  return value;
}

/** A deliberately small, unauthenticated TCP forwarder for trusted LAN use. */
export class LanProxy {
  constructor(options = {}) {
    this.host = assertHost(options.host);
    this.port = assertPort(options.port ?? DEFAULT_LAN_PROXY_PORT);
    this.targetHost = options.targetHost || '127.0.0.1';
    this.targetPort = assertPort(options.targetPort ?? 8787);
    this.net = options.net || net;
    this.closeTimeoutMs = Math.max(100, Math.min(10_000, Number(options.closeTimeoutMs) || 1_500));
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.onClose = typeof options.onClose === 'function' ? options.onClose : null;
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

  healthCheck(timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const socket = this.net.createConnection({ host: this.host, port: this.port });
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

export { assertHost as assertLanProxyHost, assertPort as assertLanProxyPort };
