import { defineConfig } from 'vite';

// Dev-time stand-in for the Vercel serverless function in /api/proxy.js,
// so `npm run dev` behaves exactly like production.
function apiProxyPlugin() {
  return {
    name: 'dev-api-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/proxy')) return next();
        const { proxyRequest } = await import('./api/proxy.js');
        const query = new URL(req.url, 'http://localhost').searchParams;
        try {
          const out = await proxyRequest(query);
          res.statusCode = out.status;
          for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
          if (out.json) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(out.json));
          } else {
            res.end(out.body);
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err && err.message) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [apiProxyPlugin()],
});
