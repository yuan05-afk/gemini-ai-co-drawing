import { Readable } from 'node:stream';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Serves api/*.ts during `npm run dev`, with the same Request/Response handlers Vercel runs,
 * so there is no second code path to keep in sync.
 */
function devApi(): Plugin {
  return {
    name: 'dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        try {
          const module = (await server.ssrLoadModule(`/api${url.pathname.slice(4)}.ts`)) as Record<string, unknown>;
          const handler = module[(req.method ?? 'GET').toUpperCase()] as ((request: Request) => Promise<Response> | Response) | undefined;
          if (!handler) {
            res.statusCode = 405;
            res.end('Method not allowed');
            return;
          }
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
          const request = new Request(url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
            // @ts-expect-error Node requires this when a body is a stream
            duplex: 'half',
          });
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          server.ssrFixStacktrace(error as Error);
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, code: 'unknown', error: String((error as Error).message) }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Only the dev API route needs the key, and only on the server side. Nothing is injected into the browser bundle.
  const env = loadEnv(mode, process.cwd(), '');
  for (const name of ['GEMINI_API_KEY', 'GEMINI_API_ORIGIN']) {
    if (env[name] && !process.env[name]) process.env[name] = env[name];
  }
  return {
    plugins: [react(), tailwindcss(), devApi()],
    build: { target: 'es2022', sourcemap: false },
  };
});
