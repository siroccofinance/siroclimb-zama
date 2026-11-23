import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import puppeteer from 'puppeteer-core';
const [root, out, W = 1440, H = 900, tag = 'd', flow = 'solo'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mp4': 'video/mp4', '.webm': 'video/webm', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; const p = path.join(root, u); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r); }).listen(0);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pg = await b.newPage(); pg.on('pageerror', e => console.log('ERR', e.message)); pg.on('console', c => ['error', 'warning'].includes(c.type()) && console.log('CONSOLE', c.text()));
const mob = +W < 768;
await pg.setViewport({ width: +W, height: +H, isMobile: mob, hasTouch: mob, deviceScaleFactor: 1 });
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = n => pg.screenshot({ path: `${out}/${tag}-${n}.png` });
const scr = () => pg.evaluate(() => document.body.dataset.screen);
await pg.goto(`http://localhost:${srv.address().port}/index.html?mock#play`, { waitUntil: 'networkidle2' });
await wait(1800); await pg.click('.sheet__ok').catch(() => {}); await wait(600);
const waits = [700, 2300, 3900, 5200, 7700, 9400, 12100, 15000];
for (const [i, w] of waits.entries()) {
  await pg.click('#go'); await wait(w);
  const st = await pg.evaluate(() => document.body.dataset.screen);
  const t0 = Date.now(); await pg.click('#cash');
  let seen = 0; const shots = [];
  while (Date.now() - t0 < 5000) { const sc = await pg.evaluate(() => document.body.dataset.screen); if (sc === 'result') { seen = Date.now() - t0; break; } await wait(30); }
  await wait(300); await shot('end' + i);
  console.log('game', i, 'cash after', w, 'ms (', st, ') result shown after', seen, 'ms', await pg.$eval('#rE', e => e.textContent));
  await pg.click('#again'); await wait(1400);
}
await pg.click('#go'); await wait(5000); const tb = Date.now(); await pg.evaluate(async () => (await import('/js/api.js'))._debug.bust());
while (Date.now() - tb < 5000) { if (await pg.evaluate(() => document.body.dataset.screen) === 'result') break; await wait(30); }
console.log('bust result after', Date.now() - tb, 'ms'); await shot('endbust');
await b.close(); srv.close();
