import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { once } from 'node:events';

/** Loopback-only protocol fixture; no company credentials or remote infrastructure. */
export async function createLocalFtpServer(options: { mode?: 'normal' | 'bounce' | 'auth-fail' | 'timeout'; tls?: { key: string; cert: string } } = {}) {
  const mode = options.mode ?? 'normal';
  const sockets = new Set<Socket>(), dataServers = new Set<Server>(), files = new Map<string, Buffer>(), commands: string[] = [];
  let connections = 0, closed = false;
  const secureContext = options.tls ? createSecureContext(options.tls) : undefined;
  const server = createServer(control => {
    connections++; sockets.add(control); control.on('close', () => sockets.delete(control)); control.on('error', () => {});
    control.write('220 local integration fixture\r\n');
    let pending = '', data: Socket | undefined;
    const consume = (chunk: Buffer) => {
      pending += chunk.toString();
      for (;;) {
        const end = pending.indexOf('\r\n'); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        const space = line.indexOf(' '), command = space < 0 ? line : line.slice(0, space), value = space < 0 ? '' : line.slice(space + 1);
        // Record command names only; USER/PASS arguments are deliberately omitted.
        commands.push(command);
        if (command === 'USER') control.write('331 Password required\r\n');
        else if (command === 'PASS') control.write(mode === 'auth-fail' ? '530 Login incorrect\r\n' : '230 Logged in\r\n');
        else if (command === 'AUTH') {
          if (!secureContext) control.write('502 TLS unavailable\r\n');
          else { control.write('234 TLS ready\r\n'); control.removeListener('data', consume); const secure = new TLSSocket(control, { isServer: true, secureContext }); control = secure; sockets.add(secure); secure.on('close', () => sockets.delete(secure)); secure.on('error', () => {}); secure.on('data', consume); }
        }
        else if (command === 'FEAT') control.write('211-Features\r\n SIZE\r\n UTF8\r\n211 End\r\n');
        else if (['TYPE', 'STRU', 'OPTS', 'PBSZ', 'PROT'].includes(command)) control.write('200 OK\r\n');
        else if (command === 'PWD') control.write('257 "/"\r\n');
        else if (command === 'CWD') control.write('250 Directory changed\r\n');
        else if (command === 'MKD') control.write('257 Directory created\r\n');
        else if (command === 'SIZE') { if (mode !== 'timeout') control.write(files.has(value) ? `213 ${files.get(value)!.length}\r\n` : '550 Not found\r\n'); }
        else if (command === 'EPSV') {
          if (mode === 'bounce') control.write('502 EPSV unavailable\r\n');
          else {
            const dataServer = createServer(raw => { const socket = secureContext ? new TLSSocket(raw, { isServer: true, secureContext }) : raw; data = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
            dataServers.add(dataServer);
            dataServer.listen(0, '127.0.0.1', () => { const address = dataServer.address(); if (address && typeof address !== 'string') control.write(`229 Entering Extended Passive Mode (|||${address.port}|)\r\n`); });
          }
        } else if (command === 'PASV') control.write('227 Entering Passive Mode (10,0,0,1,8,1)\r\n');
        else if (command === 'STOR') {
          if (!data) { control.write('425 Missing data connection\r\n'); continue; }
          const parts: Buffer[] = [];
          data.on('data', bytes => parts.push(Buffer.from(bytes)));
          data.once('end', () => { files.set(value, Buffer.concat(parts)); data?.end(); control.write('226 Transfer complete\r\n'); });
          control.write('150 Transfer ready\r\n');
        } else if (command === 'QUIT') control.end('221 Goodbye\r\n');
        else control.write('502 Unsupported\r\n');
      }
    };
    control.on('data', consume);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local fixture failed to bind');
  return {
    host: '127.0.0.1', port: address.port, files, commands, connections: () => connections,
    async close(): Promise<void> {
      if (closed) return; closed = true;
      for (const socket of sockets) socket.destroy();
      await Promise.all([...dataServers, server].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    },
  };
}
