// Visible stairs vs real price moves, during a live climb on Sepolia: every second, the steps the coin
// took (risers climbed, edges dropped) and the market's quote changes, summed per 10 s window. A frame is
// saved halfway. usage: node tests/chain/stairs.mjs [baseUrl] [market] [seconds] [outDir]
import puppeteer from 'puppeteer-core';
import { Wallet } from 'ethers';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet } from './wallet.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3043', market = process.argv[3] || 'TSLAx', secs = Number(process.argv[4] || 50), out = process.argv[5] || 'out/stairs';
mkdirSync(out, { recursive: true });
const key = readFileSync(`${homedir()}/.config/siroclimb/sepolia/player.key`, 'utf8').trim();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: `out/chrome-${new Wallet(key).address.slice(2, 10)}` });
const pg = await b.newPage();
await injectWallet(pg, key);
await pg.evaluateOnNewDocument(m => { localStorage.setItem('siroclimb:ui:seenRules', 'true'); localStorage.setItem('siroclimb:ui:asset', JSON.stringify(m)); }, market);
await pg.setViewport({ width: 1440, height: 900 });
const wait = ms => new Promise(r => setTimeout(r, ms));
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(3000);
if (/Connect/.test(await pg.$eval('#wallet', e => e.textContent))) await pg.click('#wallet');
for (let i = 0; i < 60 && /Connect/.test(await pg.$eval('#wallet', e => e.textContent)); i++) await wait(1000);
await wait(2000);
await pg.click(`.market[data-v="${market}"]`); await pg.click('#stake button[data-v="10"]');
await pg.click('#go');
for (let i = 0; i < 80 && await pg.evaluate(() => document.body.dataset.screen) !== 'game'; i++) await wait(500);
await wait(2000);
const read = () => pg.evaluate(() => ({ steps: window.__stairs?.steps ?? 0, quotes: window.__stairs?.quotes ?? 0 }));
// the stairs' level next to the price (side-adjusted log return), once a second: same shape?
const shape = [];
const sample = () => pg.evaluate(async () => { const s = window.__stairs, m = s.moves[s.moves.length - 1]; const api = await import('/js/api.js'); return { level: m ? m.level : 0, q: s.last }; });
const start = await read(), rows = [];
let prev = start;
for (let s = 1; s <= secs; s++) {
  await wait(1000);
  if (s === Math.round(secs / 2)) await pg.screenshot({ path: `${out}/${market}-climb.png` });
  if (process.env.FRAMES && s >= 10 && s < 20) await pg.screenshot({ path: `${out}/${market}-f${s}.png`, clip: { x: 300, y: 150, width: 1000, height: 600 } });
  shape.push(await sample());
  const now = await read();
  rows.push({ s, steps: now.steps - prev.steps, quotes: now.quotes - prev.quotes });
  prev = now;
}
const windows = [];
for (let i = 0; i < rows.length; i += 10) {
  const w = rows.slice(i, i + 10);
  windows.push({ from: i, steps: w.reduce((a, r) => a + r.steps, 0), quotes: w.reduce((a, r) => a + r.quotes, 0) });
}
const tot = { steps: prev.steps - start.steps, quotes: prev.quotes - start.quotes };
const st = await pg.evaluate(() => ({ sizes: window.__stairs.sizes, moves: window.__stairs.moves.map(m => m.n), ratios: window.__stairs.moves.map(m => m.r) }));
const q0 = shape.find(x => x.q)?.q, xs = shape.filter(x => x.q).map(x => Math.log(x.q / q0)), ys = shape.filter(x => x.q).map(x => x.level);
const corr = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return va && vb ? c / Math.sqrt(va * vb) : null; };
const absMoves = st.moves.map(Math.abs), hist = {}; absMoves.forEach(n => { hist[n] = (hist[n] || 0) + 1; });
console.log(JSON.stringify({ market, seconds: secs, windows, total: tot, levelsPerQuote: hist, stepSizes: st.sizes, shapeCorr: corr(xs, ys) && +corr(xs, ys).toFixed(3), movesVsTypical: st.ratios }));
await pg.click('#cash').catch(() => {});
await wait(15000);
await b.close();
