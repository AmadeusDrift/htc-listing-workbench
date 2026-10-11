import http from 'node:http';
import { readFile } from 'node:fs/promises';

const page = new URL('./index.html', import.meta.url);
http.createServer(async (_request, response) => {
  try {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await readFile(page));
  } catch {
    response.end('Preview file unavailable.');
  }
}).listen(4179, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:4179'));
