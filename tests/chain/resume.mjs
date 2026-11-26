// A reload in the middle of a live run (Sepolia): the climb comes back on the same run, the cash out
// settles it on chain, and the balance decrypts to what it should be. usage: node tests/chain/resume.mjs [baseUrl] [market]
import puppeteer from 'puppeteer-core';
import { Wallet } from 'ethers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet } from './wallet.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3043', market = process.argv[3] || 'XAUt';
const key = readFileSync(`${homedir()}/.config/siroclimb/sepolia/player.key`, 'utf8').trim();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: `out/chrome-${new Wallet(key).address.slice(2, 10)}` });
const pg = await b.newPage();
const errors = [];
pg.on('pageerror', e => errors.push(e.message));
await injectWallet(pg, key);
await pg.evaluateOnNewDocument(m => { localStorage.setItem('siroclimb:ui:seenRules', 'true'); localStorage.setItem('siroclimb:ui:asset', JSON.stringify(m)); }, market);
await pg.setViewport({ width: 1440, height: 900 });
const wait = ms => new Promise(r => setTimeout(r, ms)), t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const ui = () => pg.evaluate(() => ({ screen: document.body.dataset.screen, bal: document.querySelector('#bal')?.textContent, state: document.querySelector('.balance')?.dataset.state,
  clock: document.querySelector('#clock')?.textContent, toast: document.querySelector('#toast.is-on')?.textContent || '', rr: document.querySelector('#rR')?.textContent || '' }));
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(3000);
if (/Connect/.test(await pg.$eval('#wallet', e => e.textContent))) await pg.click('#wallet');
for (let i = 0; i < 60 && (await ui()).state !== 'ready'; i++) await wait(1000);
const before = (await ui()).bal;
await pg.click(`.market[data-v="${market}"]`); await pg.click('#stake button[data-v="10"]');
await pg.click('#go');
for (let i = 0; i < 80 && (await ui()).screen !== 'game'; i++) await wait(500);
await wait(14000);   // the start is mined, the run is remembered
console.log(T(), 'before reload', JSON.stringify(await ui()), 'balance before the run', before);
await pg.reload({ waitUntil: 'networkidle2' });
let u;
for (let i = 0; i < 60; i++) { u = await ui(); if (u.screen === 'game') break; await wait(500); }
console.log(T(), 'after reload', JSON.stringify(u));
const back = u.screen === 'game';
await wait(5000);
await pg.click('#cash').catch(() => {});
for (let i = 0; i < 60; i++) { u = await ui(); if (/Settled on chain/.test(u.rr)) break; await wait(2000); }
console.log(T(), 'settled', u.rr.slice(0, 70));
for (let i = 0; i < 30; i++) { u = await ui(); if (u.state === 'ready') break; await wait(1000); }
console.log(T(), 'balance after', u.bal, u.state);
console.log(back && /Settled on chain/.test(u.rr) ? 'RESUME OK' : 'RESUME FAIL', 'page errors', errors.length, errors.slice(0, 3));
await b.close();
