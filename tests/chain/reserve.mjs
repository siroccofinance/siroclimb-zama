// End to end on Sepolia through the real front: the Sirocco Reserve panel. Public synced figures,
// an encrypted deposit from the game account, the position decrypted in the browser, an encrypted
// withdrawal (all or nothing), and the KMS-verified sync the autopilot runs.
// usage: node tests/chain/reserve.mjs [baseUrl] [deposit=50] [withdraw=20]
import puppeteer from 'puppeteer-core';
import { Wallet } from 'ethers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet } from './wallet.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3043', dep = Number(process.argv[3] || 50), wd = Number(process.argv[4] || 20);
const key = readFileSync(`${homedir()}/.config/siroclimb/sepolia/player.key`, 'utf8').trim();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: `out/chrome-${new Wallet(key).address.slice(2, 10)}` });
const pg = await b.newPage();
const errors = [];
pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
pg.on('console', c => { if (c.type() === 'error') { errors.push(c.text()); console.log('CONSOLE', c.text()); } });
await injectWallet(pg, key);
await pg.evaluateOnNewDocument(() => localStorage.setItem('siroclimb:ui:seenRules', 'true'));
await pg.setViewport({ width: 1440, height: 900 });
const wait = ms => new Promise(r => setTimeout(r, ms)), t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
const text = s => pg.$eval(s, e => e.textContent.trim());
const num = s => parseFloat(s.replace(/,/g, ''));
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(3000);
if (/Connect/.test(await text('#wallet'))) await pg.click('#wallet');
for (let i = 0; i < 60 && /Connecting/.test(await text('#wallet')); i++) await wait(2000);
await pg.click('[data-open=reserve]');
for (let i = 0; i < 60 && /Decrypting|Connect/.test(await text('#rvMe')); i++) await wait(1000);
console.log(T(), 'panel', (await pg.$eval('#rvStats', e => e.innerText)).replace(/\n/g, ' '));
const p0 = await text('#rvMe');
console.log(T(), 'position before', p0);
const v0 = /^[\d,.]+/.test(p0) ? num(p0) : 0;
await pg.type('#rvAmt', String(dep)); await pg.click('#rvDep');
for (let i = 0; i < 120 && (await pg.$eval('#rvDep', e => e.disabled)); i++) await wait(1000);
for (let i = 0; i < 60 && /Decrypting/.test(await text('#rvMe')); i++) await wait(1000);
const p1 = await text('#rvMe');
console.log(T(), 'after deposit', p1, '|', await text('#toast'));
await pg.type('#rvAmt', String(wd)); await pg.click('#rvWd');
for (let i = 0; i < 120 && (await pg.$eval('#rvWd', e => e.disabled)); i++) await wait(1000);
for (let i = 0; i < 60 && /Decrypting/.test(await text('#rvMe')); i++) await wait(1000);
const toast = await text('#toast');
const p2 = await text('#rvMe');
console.log(T(), 'after withdrawal', p2, '|', toast);
await pg.screenshot({ path: 'out/chain-reserve.png' });
const ok = Math.abs(num(p1) - v0 - dep) < 0.02 && Math.abs(num(p2) - num(p1) + wd) < 0.02 && /Withdrew/.test(toast);
console.log(ok ? 'PASS' : 'FAIL', 'errors', errors.length);
await b.close();
process.exit(ok ? 0 : 1);
