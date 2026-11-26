// A live climb on Sepolia with a price timing log: what the HUD shows every second (price, change,
// source, value, level of the coin), then the run's on-chain checkpoints (price and source).
// usage: node tests/chain/climb.mjs [baseUrl] [market] [seconds]   SHARE=1: publish and share the result
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
// PHONE=1: a 390 px touch screen whose share sheet takes files (stubbed: records what would be shared)
if (process.env.PHONE) {
  await pg.emulateMediaFeatures([{ name: 'pointer', value: 'coarse' }]).catch(() => {});
  await pg.evaluateOnNewDocument(() => {
    const mm = window.matchMedia.bind(window);
    window.matchMedia = q => (/pointer:\s*coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q));
    navigator.canShare = d => !!(d && d.files && d.files.length);
    navigator.share = async d => { window.__shared = { files: (d.files || []).map(f => ({ name: f.name, type: f.type, size: f.size })), text: d.text, url: d.url }; };
  });
}
await pg.setViewport(process.env.PHONE ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
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
if (process.env.SHARE) {                       // verified share: publish the return from the sheet, then the chain-built card
  await pg.click('#share'); await wait(3000);
  console.log(T(), 'sheet:', await pg.$eval('#shVeilT', e => e.textContent));
  await pg.screenshot({ path: 'out/share-0veil.png' });
  if (await pg.$eval('#shPub', e => !e.hidden)) await pg.click('#shPub');
  for (let i = 0; i < 90; i++) { const src = await pg.$eval('#shImg', e => e.getAttribute('src') || ''); const v = await pg.$eval('#shVeilT', e => e.textContent); if (i % 5 === 0) console.log(T(), 'share:', v || src.slice(-40)); if (/api\/og\?id=[gxyr]/.test(src) && !v) break; await wait(2000); }
  await wait(1500); await pg.screenshot({ path: 'out/share-1card.png' });
  console.log(T(), 'post:', decodeURIComponent(await pg.$eval('#shX', e => e.href)));
  if (process.env.PHONE) { await wait(2000); await pg.$eval('#shX', e => e.click()); await wait(1500); console.log(T(), 'native share:', JSON.stringify(await pg.evaluate(() => window.__shared || null))); }
}
await b.close();
