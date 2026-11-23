import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import puppeteer from 'puppeteer-core';
const [root, out, W = 1440, H = 900, tag = 'r'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; const p = path.join(root, u); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r); }).listen(0);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pg = await b.newPage(); pg.on('pageerror', e => console.log('ERR', e.message)); pg.on('console', c => ['error', 'warning'].includes(c.type()) && console.log('CONSOLE', c.text()));
const mob = +W < 768; await pg.setViewport({ width: +W, height: +H, isMobile: mob, hasTouch: mob });
const wait = ms => new Promise(r => setTimeout(r, ms)), shot = n => pg.screenshot({ path: `${out}/${tag}-${n}.png` });
await pg.evaluateOnNewDocument(() => localStorage.setItem('siroclimb:ui:seenRules', 'true'));
await pg.goto(`http://localhost:${srv.address().port}/play.html?mock`, { waitUntil: 'networkidle2' });
await wait(1500); await shot('0top');
await pg.click('#mode button[data-v=round]'); await wait(600);
// wait for an open round with at least 8 s left to join
for (;;) { const r = await pg.evaluate(async () => (await import('/js/api.js')).currentRound()); const left = r.startsAt - Date.now(); if (r.status === 'open' && !r.late && left > 8000) break; await wait(1000); }
await shot('1open'); await pg.click('#go'); await wait(1200); await shot('2joined');
console.log('go', await pg.$eval('#go', e => e.textContent), '|', await pg.$eval('#goMeta', e => e.textContent));
await pg.waitForFunction(() => document.body.dataset.screen === 'game', { timeout: 30000 });
await wait(9000); await shot('3live');
await wait(9000); await pg.click('#cash'); await wait(1800); await shot('4cashed');
console.log('round line', await pg.$eval('#rR', e => e.textContent));
await pg.waitForFunction(() => !/Waiting/.test(document.querySelector('#rR').textContent), { timeout: 70000 });
await wait(500); await shot('5final'); console.log('final', await pg.$eval('#rR', e => e.textContent), 'bal', await pg.$eval('#bal', e => e.textContent));
await pg.click('#again'); await wait(1000); await pg.click('[data-open=board]'); await wait(300); await pg.click('#boardTabs button[data-v=round]'); await wait(600); await shot('6board');
await b.close(); srv.close();
