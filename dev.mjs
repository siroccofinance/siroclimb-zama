// Local dev server: the static site plus the server routes (/api/pyth, /api/prices, the share links), the way
// Vercel serves them. One process, port 3043 by default.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3043);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.woff': 'font/woff' };
const routes = { '/api/pyth': () => import('./api/pyth.js'), '/api/prices': () => import('./api/prices.js'), '/api/change': () => import('./api/change.js'),
  '/api/share': () => import('./api/share.js'), '/api/og': () => import('./api/og.js'), '/api/s': () => import('./api/s.js'),
  '/api/drip': () => import('./api/drip.js'), '/api/keep': () => import('./api/keep.js') };

http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (routes[url]) return (await routes[url]()).default(req, res);
  if (url.startsWith('/s/')) return (await routes['/api/s']()).default(req, res);   // vercel.json rewrite
  let p = path.join(root, url === '/' ? 'index.html' : url);
  if (!p.startsWith(root) || /\/(contracts|ops|node_modules|\.git)\//.test(p)) { res.writeHead(404); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(p).size, range = req.headers.range;
  const head = { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  if (range) {
    const [a, b] = range.replace('bytes=', '').split('-'), s = Number(a), e = b ? Number(b) : size - 1;
    res.writeHead(206, { ...head, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1 });
    return fs.createReadStream(p, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': size });
  fs.createReadStream(p).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`siroclimb dev http://127.0.0.1:${PORT}`));
