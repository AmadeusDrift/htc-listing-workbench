import { Client } from 'basic-ftp';
import type { FTPResponse } from 'basic-ftp';
import { connect as connectTcp, isIP } from 'node:net';
import type { Socket } from 'node:net';
import { connect as connectTls, TLSSocket } from 'node:tls';
import type { HostingRoute } from '../../shared/hosting-contracts.ts';
import { HostingError, classifyHostingError } from './errors.ts';

/** Local, unauthenticated SOCKS5; target DNS is resolved by the proxy for BOTH sockets.
 * EPSV keeps the original target host. PASV host redirects are intentionally unsupported
 * on this route because a remote-DNS tunnel does not expose the authenticated target IP.
 */
export class SocksFtpClient extends Client {
  private route: Extract<HostingRoute, { mode: 'socks5' }>;
  private sockets = new Set<Socket>();
  private target = '';
  constructor(timeout: number, route: Extract<HostingRoute, { mode: 'socks5' }>) {
    super(timeout, { allowSeparateTransferHost: false }); this.route = route;
    this.prepareTransfer = async ftp => {
      let response: FTPResponse;
      try { response = await ftp.request('EPSV'); }
      catch (error) {
        const safe = classifyHostingError(error), code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : 0;
        throw new HostingError(code >= 500 && code <= 599 ? 'PROXY_PASSIVE_UNSUPPORTED' : safe.code, 'upload', 'not-sent');
      }
      const match = response.message.match(/\(([!|])\1\1(\d+)\1\)/), port = match ? Number(match[2]) : 0;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostingError('PROXY_PASSIVE_UNSUPPORTED', 'upload', 'not-sent');
      let raw: Socket;
      try { raw = await this.tunnel(this.target, port); }
      catch (error) { const safe = classifyHostingError(error); throw new HostingError(safe.code, 'upload', 'not-sent'); }
      if (ftp.socket instanceof TLSSocket) {
        // Retain original host identity, certificate validation and session binding.
        const data = connectTls({ ...ftp.tlsOptions, socket: raw, host: this.target, servername: isIP(this.target) ? undefined : this.target, rejectUnauthorized: true, session: ftp.tlsSessionStore ?? ftp.socket.getSession() });
        data.on('session', session => { ftp.tlsSessionStore = session; }); ftp.dataSocket = data;
      } else ftp.dataSocket = raw;
      return response;
    };
  }
  override close(): void { for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); super.close(); }
  override async connect(host = 'localhost', port = 21): Promise<FTPResponse> {
    this.ftp.reset(); this.target = host;
    const socket = await this.tunnel(host, port); this.ftp.socket = socket;
    return this.ftp.handle(undefined, (response, task) => {
      if (response instanceof Error) task.reject(response);
      else if (response.code >= 200 && response.code < 300) task.resolve(response);
      else task.reject(new HostingError('UPLOAD_FAILED', 'connect', 'not-sent'));
    });
  }
  private async tunnel(host: string, port: number): Promise<Socket> {
    const name = Buffer.from(host, 'ascii');
    if (name.length < 1 || name.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host)) throw new HostingError('INVALID_CONFIG');
    const socket = connectTcp({ host: this.route.host, port: this.route.port }); this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    // A bounded handshake covers connect, greeting and destination acknowledgement.
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('SOCKS timeout'), { code: 'ETIMEDOUT' })), this.ftp.timeout);
    const read = (length: number) => new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => { socket.removeListener('readable', ready); socket.removeListener('error', failed); socket.removeListener('close', closed); };
      const failed = (error: Error) => { cleanup(); reject(error); }, closed = () => failed(new HostingError('PROXY_FAILED'));
      const ready = () => { const data = socket.read(length) as Buffer | null; if (data) { cleanup(); resolve(data); } };
      socket.on('readable', ready); socket.once('error', failed); socket.once('close', closed); ready();
    });
    try {
      // Reads are registered synchronously; socket buffering retains a coalesced FTP greeting.
      socket.write(Buffer.from([5, 1, 0])); const greeting = await read(2);
      if (greeting[0] !== 5 || greeting[1] !== 0) throw new HostingError('PROXY_AUTH_REQUIRED');
      const destination = Buffer.alloc(name.length + 7); destination.set([5, 1, 0, 3, name.length]); name.copy(destination, 5); destination.writeUInt16BE(port, name.length + 5);
      socket.write(destination); const reply = await read(4);
      if (reply[0] !== 5 || reply[2] !== 0) throw new HostingError('PROXY_FAILED');
      if (reply[1] !== 0) throw new HostingError(reply[1] === 4 ? 'DNS_FAILED' : 'PROXY_FAILED');
      if (reply[3] === 1) await read(6);
      else if (reply[3] === 4) await read(18);
      else if (reply[3] === 3) { const size = await read(1); await read(size[0] + 2); }
      else throw new HostingError('PROXY_FAILED');
      return socket;
    } catch (error) { socket.destroy(); const safe = classifyHostingError(error); throw new HostingError(safe.code === 'UPLOAD_FAILED' ? 'PROXY_FAILED' : safe.code); }
    finally { clearTimeout(timer); }
  }
}
