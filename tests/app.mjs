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
await pg.goto(`http://localhost:${srv.address().port}/play.html?mock`, { waitUntil: 'networkidle2' });
await wait(2200); await shot('0rules');
await pg.click('.sheet__ok'); await wait(700); await shot('1lobby');
if (flow === 'solo') {
  await pg.click('#go'); await wait(2000); console.log('screen', await scr()); await shot('2game');
  await wait(6500); await shot('3step1');
  await wait(6000); await shot('4step2');
  const t0 = Date.now(); await pg.click('#cash');
  for (const ms of [400, 900, 1600]) { await wait(ms - (Date.now() - t0)); await shot('5cash' + ms); }
  console.log('screen', await scr(), await pg.$eval('#rV', e => e.textContent));
  for (let i = 0; i < 30 && await scr() !== 'result'; i++) await wait(100);   // the result waits for the coin, up to ~2 s
  await wait(300);
  await pg.click('#again'); await wait(1200); await shot('6lobby'); console.log('screen', await scr());
  await pg.click('#go'); await wait(7600);
  const t1 = Date.now(); await pg.evaluate(async () => (await import('/js/api.js'))._debug.bust());
  for (const ms of [500, 900, 1800]) { await wait(ms - (Date.now() - t1)); await shot('7bust' + ms); }
  console.log('screen', await scr(), await pg.$eval('#rV', e => e.textContent), 'bal', await pg.$eval('#bal', e => e.textContent));
  await pg.click('[data-open=board]'); await wait(700); await shot('8board');
}
await b.close(); srv.close();
