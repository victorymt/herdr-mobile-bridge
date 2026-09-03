import net from 'node:net';

export const DEFAULT_LAN_PROXY_PORT = 18787;

function assertHost(host) {
  if (typeof host !== 'string' || !host.trim() || host === '0.0.0.0' || host === '::') {
    throw new TypeError('LAN proxy host must be an explicit interface address');
  }
  return host.trim();
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
    this.server = null;
  }

  async start() {
    if (this.server) return this.address();
    this.server = this.net.createServer((client) => {
      const target = this.net.createConnection({ host: this.targetHost, port: this.targetPort });
      client.pipe(target);
      target.pipe(client);
      const close = () => { client.destroy(); target.destroy(); };
      client.once('error', close);
      target.once('error', close);
    });
    await new Promise((resolve, reject) => {
      const fail = (error) => { this.server?.off('listening', ready); reject(error); };
      const ready = () => { this.server?.off('error', fail); resolve(); };
      this.server.once('error', fail);
      this.server.once('listening', ready);
      this.server.listen(this.port, this.host);
    });
    return this.address();
  }

  address() {
    const value = this.server?.address?.();
    return value && typeof value === 'object' ? { host: value.address, port: value.port } : { host: this.host, port: this.port };
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

export { assertHost as assertLanProxyHost, assertPort as assertLanProxyPort };
