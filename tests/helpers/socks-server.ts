import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';

/** Synthetic local SOCKS endpoint; target names map only to our loopback FTP fixture. */
export async function localSocks(options: { refuse?: boolean; stall?: boolean; destinationFailure?: number } = {}) {
  const sockets = new Set<Socket>(), targets: { host: string; port: number }[] = [];
  let accepted!: () => void, disconnected!: () => void; const connected = new Promise<void>(resolve => { accepted = resolve; }), closedConnection = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer(socket => {
    accepted(); socket.once('close', disconnected);
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = Buffer.alloc(0), greeting = false, routed = false;
    const consume = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!greeting) {
        if (pending.length < 3) return;
        assertBytes(pending.subarray(0, 3), Buffer.from([5, 1, 0])); pending = pending.subarray(3); greeting = true;
        if (options.stall) return;
        socket.write(Buffer.from([5, options.refuse ? 255 : 0])); if (options.refuse) { socket.end(); return; }
      }
      if (routed || pending.length < 5) return;
      const hostSize = pending[4], size = 7 + hostSize; if (pending.length < size) return;
      assertBytes(pending.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
      const host = pending.subarray(5, 5 + hostSize).toString('ascii'), port = pending.readUInt16BE(5 + hostSize); targets.push({ host, port });
      if (host !== 'ftp.fixture.invalid') { socket.destroy(); return; }
      routed = true; socket.removeListener('data', consume);
      if (options.destinationFailure) { socket.end(Buffer.from([5, options.destinationFailure, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const upstream = connect({ host: '127.0.0.1', port }); sockets.add(upstream);
      upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); }); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
      upstream.once('connect', () => { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); socket.pipe(upstream); upstream.pipe(socket); });
    };
    socket.on('data', consume);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture bind failed');
  return { port: address.port, targets, connected, closedConnection, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function assertBytes(actual: Buffer, expected: Buffer) { if (!actual.equals(expected)) throw Error('unexpected local SOCKS request'); }
