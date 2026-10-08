// Minimal stand-in for the Kong gateway of `supabase start`: one port that maps
//   /auth/v1/*  -> GoTrue   (prefix stripped)
//   /rest/v1/*  -> PostgREST (prefix stripped)
//   /storage/v1/* -> Storage API (prefix stripped)
// so supabase-js works against the throwaway stack exactly as it does against a real project.
// Local use only. No dependencies.
import http from 'node:http';

const listen = Number(process.env.GATEWAY_PORT ?? 54321);
const routes = [
  { prefix: '/auth/v1', port: Number(process.env.GOTRUE_PORT ?? 54324) },
  { prefix: '/rest/v1', port: Number(process.env.POSTGREST_PORT ?? 54323) },
  { prefix: '/storage/v1', port: Number(process.env.STORAGE_PORT ?? 54325) },
];

http
  .createServer((req, res) => {
    const url = req.url ?? '/';
    const route = routes.find(
      (r) => url === r.prefix || url.startsWith(`${r.prefix}/`) || url.startsWith(`${r.prefix}?`),
    );
    if (route === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: route.port,
        method: req.method,
        path: url.slice(route.prefix.length) || '/',
        headers: { ...req.headers, host: `127.0.0.1:${route.port}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end('bad gateway'));
    req.pipe(upstream);
  })
  .listen(listen, '127.0.0.1');
