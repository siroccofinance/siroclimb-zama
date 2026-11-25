// First visit on Sepolia, timed: a brand-new wallet (funded with a little Sepolia ETH by the deployer)
// connects on the real front, then everything the player sees is logged with timestamps (wallet button,
// balance pill, setup line, status line, toast) and a screenshot is taken whenever it changes, until the
// 1,000 test cUSDC show as a decrypted balance. Optional: plays one run and opens the reserve.
// usage: node tests/chain/firstvisit.mjs [baseUrl] [outDir] [--play]
import puppeteer from 'puppeteer-core';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet, RPC } from './wallet.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3043', out = process.argv[3] || 'out/firstvisit', play = process.argv.includes('--play');
mkdirSync(out, { recursive: true });
const dir = `${homedir()}/.config/siroclimb/sepolia`;
const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const fresh = Wallet.createRandom();
writeFileSync(`${out}/wallet.txt`, `${fresh.address}\n${fresh.privateKey}\n`);
const funder = new Wallet(readFileSync(`${dir}/deployer.key`, 'utf8').trim(), provider);
const ft = await funder.sendTransaction({ to: fresh.address, value: parseEther(process.env.FUND || '0.035') });
await ft.wait();
console.log('fresh wallet', fresh.address, 'funded', ft.hash);

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const pg = await b.newPage();
pg.on('pageerror', e => console.log('PAGEERROR', e.message)); pg.on('console', c => ['error', 'warn'].includes(c.type()) && console.log('CONSOLE', c.type(), c.text().slice(0, 200)));
const w = await injectWallet(pg, fresh.privateKey);
await pg.evaluateOnNewDocument(() => { localStorage.setItem('siroclimb:ui:seenRules', 'true'); localStorage.setItem('siroclimb:ui:asset', JSON.stringify('XAUt')); });
await pg.setViewport({ width: 1440, height: 900 });
const t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const ui = () => pg.evaluate(() => {
  const q = s => document.querySelector(s), vis = el => el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  return {
    screen: document.body.dataset.screen,
    wallet: q('#wallet')?.textContent.trim(),
    bal: (q('.balance')?.innerText || '').replace(/\s+/g, ' ').trim() + (q('.balance')?.dataset.state ? ` [${q('.balance').dataset.state}]` : ''),
    setup: vis(q('#setup')) ? q('#setup').innerText.replace(/\s+/g, ' ').trim() : '',
    line: vis(q('#chainline')) && q('#chainline').classList.contains('is-on') ? q('#chainlineT').textContent : '',
    toast: q('#toast.is-on')?.textContent || '',
    go: q('#go')?.textContent, meta: q('#goMeta')?.textContent,
    rr: vis(q('#rR')) ? q('#rR').textContent.slice(0, 90) : '',
  };
});
let last = '', n = 0;
const log = [];
async function watch(until, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const u = await ui(), k = JSON.stringify(u);
    if (k !== last) { last = k; const row = `${T()} ${label.padEnd(8)} ${Object.entries(u).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' | ')}`; console.log(row); log.push(row); await pg.screenshot({ path: `${out}/${String(++n).padStart(3, '0')}-${label}.png` }); }
    if (await until(u)) return u;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await watch(() => false, 2500, 'load');
const tc = Date.now();
await pg.click('#wallet');
const okBal = u => /\d/.test(u.bal) && parseFloat(u.bal.replace(/,/g, '')) >= 1000;
const done = await watch(okBal, 240_000, 'setup');
const secs = ((Date.now() - tc) / 1000).toFixed(1);
console.log(done ? `FIRST VISIT: 1,000 cUSDC decrypted ${secs}s after the click` : `FIRST VISIT: not done after ${secs}s`);
log.push(`RESULT ${secs}s ${done ? 'ok' : 'timeout'}`);
if (play && done) {
  await pg.click('#stake button[data-v="10"]');
  await pg.click('#go');
  await watch(u => u.screen === 'game', 90_000, 'start');
  await watch(() => false, 9000, 'game');
  await pg.click('#cash');
  await watch(u => /Settled on chain/.test(u.rr), 150_000, 'cashout');
  await watch(() => false, 15000, 'after');
  await pg.click('[data-open=reserve]');
  await watch(() => false, 25000, 'reserve');
  await pg.type('#rvAmt', '20'); await pg.click('#rvDep');
  await watch(() => false, 90000, 'deposit');
  await pg.keyboard.press('Escape');
  await watch(() => false, 3000, 'end');
}
writeFileSync(`${out}/log.txt`, log.join('\n') + '\n');
console.log('wallet log', w.log.join(' '));
await b.close();
