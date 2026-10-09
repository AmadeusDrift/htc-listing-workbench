import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), { name: 'red-csp', transformIndexHtml(html: string) {
    return command === 'serve' ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
      : html.replace("connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173;", "connect-src 'none';");
  } }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
}));
