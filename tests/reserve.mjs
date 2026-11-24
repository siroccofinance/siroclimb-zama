// The Sirocco Reserve in the simulation (?mock): the HUD's borrowed line, the result's borrowed and
// interest stats, the reserve panel, a deposit and a withdrawal.
// usage: node tests/reserve.mjs . out
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import puppeteer from 'puppeteer-core';
const [root = '.', out = 'out'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mp4': 'video/mp4', '.webm': 'video/webm', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; const p = path.join(root, u); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r); }).listen(0);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const pg = await b.newPage();
const errors = [];
pg.on('pageerror', e => errors.push(e.message)); pg.on('console', c => c.type() === 'error' && errors.push(c.text()));
await pg.setViewport({ width: 1440, height: 900 });
await pg.evaluateOnNewDocument(() => localStorage.setItem('siroclimb:ui:seenRules', 'true'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const text = s => pg.$eval(s, e => e.textContent.trim());
const fail = m => { console.log('FAIL', m); process.exitCode = 1; };
await pg.goto(`http://localhost:${srv.address().port}/index.html?mock#play`, { waitUntil: 'networkidle2' });
await wait(2500);
// a run: the borrowed amount follows the leverage (25 cUSDC stake at 2x borrows 25)
await pg.click('#stake button[data-v="25"]');
await pg.click('#go'); await wait(14000);
const borrowed = await text('#borrow');
console.log('hud', borrowed);
if (!/Borrowed [\d.,]+ cUSDC from the Sirocco Reserve/.test(borrowed)) fail('no borrowed line');
await pg.click('#cash');
for (let i = 0; i < 60 && (await pg.evaluate(() => document.body.dataset.screen)) !== 'result'; i++) await wait(100);
const stats = await text('#rS');
console.log('result', stats);
if (!/Borrowed[\d.,]+ cUSDC/.test(stats) || !/Interest paid0\.0000\d\d cUSDC|Interest paid0\.00 cUSDC/.test(stats)) fail('no borrowed or interest stat');
await pg.screenshot({ path: `${out}/reserve-1result.png` });
// the reserve panel
await pg.click('[data-open=reserve]'); await wait(800);
const kpis = await text('#rvStats');
console.log('panel', kpis);
for (const k of ['Total value locked', 'Utilization', 'Share price', 'APY', 'Borrow APR', 'Interest earned']) if (!kpis.includes(k)) fail(`missing ${k}`);
await pg.screenshot({ path: `${out}/reserve-2panel.png` });
await pg.type('#rvAmt', '100'); await pg.click('#rvDep'); await wait(800);
const pos1 = await text('#rvMe');
console.log('after deposit', pos1);
if (!/^100\.00 cUSDC/.test(pos1)) fail('deposit not shown');
await pg.type('#rvAmt', '40'); await pg.click('#rvWd'); await wait(800);
const pos2 = await text('#rvMe');
console.log('after withdrawal', pos2);
if (!/^60\.00 cUSDC/.test(pos2)) fail('withdrawal not shown');
await pg.screenshot({ path: `${out}/reserve-3position.png` });
if (errors.length) fail(errors.join(' | '));
console.log(process.exitCode ? 'FAILED' : 'OK');
await b.close(); srv.close();
