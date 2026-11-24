// A live climb on Sepolia with a price timing log: what the HUD shows every second (price, change,
// source, value, level of the coin), then the run's on-chain checkpoints (price and source).
// usage: node tests/chain/climb.mjs [baseUrl] [market] [seconds]
import puppeteer from 'puppeteer-core';
import { Wallet } from 'ethers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet } from './wallet.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3043', market = process.argv[3] || 'TSLAx', secs = Number(process.argv[4] || 40);
const key = readFileSync(`${homedir()}/.config/siroclimb/sepolia/player.key`, 'utf8').trim();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: `out/chrome-${new Wallet(key).address.slice(2, 10)}` });
const pg = await b.newPage();
pg.on('pageerror', e => console.log('PAGEERROR', e.message));
await injectWallet(pg, key);
await pg.evaluateOnNewDocument(m => { localStorage.setItem('siroclimb:ui:seenRules', 'true'); localStorage.setItem('siroclimb:ui:asset', JSON.stringify(m)); }, market);
await pg.setViewport({ width: 1440, height: 900 });
const wait = ms => new Promise(r => setTimeout(r, ms)), t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(3000);
if (/Connect/.test(await pg.$eval('#wallet', e => e.textContent))) await pg.click('#wallet');
for (let i = 0; i < 60 && /Connect/.test(await pg.$eval('#wallet', e => e.textContent)); i++) await wait(1000);
await wait(2000);
await pg.click(`.market[data-v="${market}"]`); await pg.click('#stake button[data-v="10"]');
console.log(T(), 'lobby', await pg.$eval(`.market[data-v="${market}"]`, e => e.innerText.replace(/\n/g, ' ')), '|', await pg.$eval('#goMeta', e => e.textContent));
await pg.click('#go');
for (let i = 0; i < 60 && await pg.evaluate(() => document.body.dataset.screen) !== 'game'; i++) await wait(500);
const seen = new Set();
for (let s = 0; s < secs; s++) {
  const h = await pg.evaluate(() => ({ p: document.querySelector('#hP').textContent, c: document.querySelector('#hC').textContent, v: document.querySelector('#pV').textContent, lev: document.querySelector('#pL').textContent }));
  seen.add(h.p);
  console.log(T(), h.p.padStart(9), h.v.padStart(7), h.lev, '|', h.c);
  if (s === 12) await pg.screenshot({ path: `out/climb-${market}.png` });
  await wait(1000);
}
console.log('distinct prices shown:', seen.size);
const runId = await pg.evaluate(async () => { const { _debug } = await import('/js/api.js'); const r = [..._debug.runs.values()].pop(); return r?.cid; });
await pg.click('#cash');
for (let i = 0; i < 60; i++) { const r = await pg.$eval('#rR', e => e.textContent); if (/Settled/.test(r)) { console.log(T(), r.slice(0, 80)); break; } await wait(2000); }
console.log('run', runId);
await b.close();
