// End to end on Sepolia through the real front: connect (operator approval + session grant),
// faucet, balance decryption, an encrypted solo run, cash out, on-chain settlement.
// usage: node tests/chain/solo.mjs [baseUrl] [market]
import puppeteer from 'puppeteer-core';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet } from './wallet.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3043', market = process.argv[3] || 'XAUt', idx = Number(process.env.PLAYER || 0);
const m = Mnemonic.fromPhrase(readFileSync(`${homedir()}/.config/zama/siroclimb-battery.mnemonic`, 'utf8').trim());
const key = HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${idx}`).privateKey;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const pg = await b.newPage();
const errors = [];
pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
pg.on('console', c => { if (c.type() === 'error') { errors.push(c.text()); console.log('CONSOLE', c.text()); } });
const w = await injectWallet(pg, key);
await pg.evaluateOnNewDocument(() => { localStorage.setItem('siroclimb:ui:seenRules', 'true'); localStorage.setItem('siroclimb:ui:asset', JSON.stringify('XAUt')); });
await pg.setViewport({ width: 1440, height: 900 });
const wait = ms => new Promise(r => setTimeout(r, ms)), t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
const shot = n => pg.screenshot({ path: `out/chain-solo-${n}.png` });
const line = () => pg.evaluate(() => document.querySelector('#chainline')?.hidden ? '' : document.querySelector('#chainlineT')?.textContent);
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(3000);
console.log(T(), 'player', w.address);
await pg.click(`.market[data-v="${market}"]`);
await pg.click('#wallet');
for (let i = 0; i < 120; i++) { const t = await pg.$eval('#wallet', e => e.textContent); const l = await line(); if (i % 5 === 0) console.log(T(), 'connect:', t, '|', l); if (!/Connecting/.test(t)) break; await wait(2000); }
await shot('1connected');
// decrypt the balance (wallet signs the daily grant)
await pg.click('#bal');
for (let i = 0; i < 90; i++) { const v = await pg.$eval('#bal', e => e.textContent); if (/\d/.test(v) && parseFloat(v.replace(/,/g, '')) >= 10) { console.log(T(), 'balance', v); break; } if (i % 10 === 9) await pg.click('#bal'); await wait(2000); }
const before = await pg.$eval('#bal', e => e.textContent);
await pg.click('#side button[data-v="long"]'); await pg.click('#stake button[data-v="10"]');
await pg.click('#go');
for (let i = 0; i < 90; i++) { const s = await pg.evaluate(() => document.body.dataset.screen); const l = await line(); if (i % 3 === 0) console.log(T(), 'start:', s, '|', l); if (s === 'game') break; await wait(1000); }
await wait(8000); await shot('2live');
console.log(T(), 'hud', await pg.evaluate(() => ({ pnl: document.querySelector('#pV').textContent, pct: document.querySelector('#pP').textContent, lev: document.querySelector('#pL').textContent, clock: document.querySelector('#clock').textContent })));
await wait(8000);
await pg.click('#cash');
console.log(T(), 'cash out clicked');
for (let i = 0; i < 120; i++) { const r = await pg.$eval('#rR', e => e.textContent); if (/Settled on chain/.test(r)) { console.log(T(), 'settled:', r); break; } if (i % 5 === 0) console.log(T(), 'settling:', r, '|', await line()); await wait(2000); }
await shot('3result');
console.log(T(), 'result', await pg.evaluate(() => ({ eyebrow: document.querySelector('#rE').textContent, value: document.querySelector('#rV').textContent, stats: document.querySelector('#rS').innerText.replace(/\n/g, ' ') })));
await wait(6000);
console.log(T(), 'balance before', before, 'after', await pg.$eval('#bal', e => e.textContent));
console.log('wallet log', w.log.length, 'errors', errors.length);
await b.close();
