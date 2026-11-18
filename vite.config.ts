import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/** Ships LetterOff's licence and the word list notice with the build, next to index.html. */
function notices(): Plugin {
  return {
    name: 'letteroff-notices',
    apply: 'build',
    generateBundle() {
      const files: [from: string, to: string][] = [
        ['LICENSE', 'LICENSE.txt'],
        ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
      ];
      for (const [from, to] of files) {
        this.emitFile({ type: 'asset', fileName: to, source: readFileSync(from, 'utf8') });
      }
    },
  };
}

/**
 * In AGS mode the dev server proxies AGS paths, so the browser only ever talks
 * to localhost. AGS Public Cloud has no setting for allowed browser origins,
 * so direct calls from localhost would be blocked. The Origin header is
 * rewritten to the AGS host for both HTTP and the Lobby WebSocket.
 */
function agsProxy(target: string): Record<string, ProxyOptions> {
  const rewriteOrigin: ProxyOptions['configure'] = (proxy) => {
    proxy.on('proxyReq', (req) => req.setHeader('origin', target));
    proxy.on('proxyReqWs', (req) => req.setHeader('origin', target));
  };
  const http: ProxyOptions = { target, changeOrigin: true, secure: true, configure: rewriteOrigin };
  return {
    '/iam': http,
    '/session': http,
    '/match2': http,
    '/basic': http,
    '/cloudsave': http,
    '/social': http,
    '/leaderboard': http,
    '/lobby': { ...http, ws: true },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const useAgs = env.VITE_BACKEND_MODE === 'ags' && !!env.VITE_AGS_BASE_URL;
  return {
    plugins: [react(), notices()],
    // Licences of the npm packages bundled into the build (React), as dist/third-party-licenses.md.
    build: { license: { fileName: 'third-party-licenses.md' } },
    server: useAgs ? { proxy: agsProxy(env.VITE_AGS_BASE_URL!.replace(/\/+$/, '')) } : undefined,
  };
});
