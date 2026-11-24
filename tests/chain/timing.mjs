// Times a solo run in the real front the way a player feels it: click -> coin moving, click -> result
// on screen, click -> settled on chain, and the value shown at the cash out vs the value paid.
// usage: node tests/chain/timing.mjs [baseUrl] [market] [runs]   (PLAYER=<n> for a battery wallet)
import puppeteer from 'puppeteer-core';
import { HDNodeWallet, Mnemonic, Wallet } from 'ethers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet } from './wallet.mjs';

const base = process.argv[2] || 'https://climb.sirocco.finance', market = process.argv[3] || 'TSLAx', runs = Number(process.argv[4] || 2), idx = Number(process.env.PLAYER || 0);
const dir = `${homedir()}/.config/siroclimb/sepolia`;
const key = process.env.PLAYER
  ? HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(readFileSync(`${dir}/battery.mnemonic`, 'utf8').trim()), `m/44'/60'/0'/0/${idx}`).privateKey
  : readFileSync(`${dir}/player.key`, 'utf8').trim();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: `out/chrome-${new Wallet(key).address.slice(2, 10)}` });
const pg = await b.newPage();
pg.on('pageerror', e => console.log('PAGEERROR', e.message));
await injectWallet(pg, key);
await pg.evaluateOnNewDocument((m) => { localStorage.setItem('siroclimb:ui:seenRules', 'true'); localStorage.setItem('siroclimb:ui:asset', JSON.stringify(m)); localStorage.setItem('siroclimb:ui:mode', JSON.stringify('solo')); }, market);
await pg.setViewport({ width: 1440, height: 900 });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 300_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn)) return Date.now(); await wait(100); } return null; };
const text = s => pg.$eval(s, e => e.textContent).catch(() => '');
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(3000);
if (/Connect/.test(await text('#wallet'))) { await pg.click('#wallet'); await until(() => !/Connecting/.test(document.querySelector('#wallet').textContent), 300_000); }
await until(() => /\d/.test(document.querySelector('#bal').textContent), 5000) || (await pg.click('#bal'), await until(() => /\d/.test(document.querySelector('#bal').textContent), 120_000));
const out = [];
for (let k = 0; k < runs; k++) {
  await until(() => document.body.dataset.screen === 'lobby' && !document.querySelector('#go').disabled, 120_000);
  await wait(4000);                                    // a player looks at the lobby for a moment
  const t0 = Date.now();
  await pg.click('#go');
  const tGame = await until(() => document.body.dataset.screen === 'game', 180_000);
  console.log('  in game', (tGame - t0) / 1000);
  await wait(15000);
  const shown = await text('#cashV');
  const t1 = Date.now();
  await pg.click('#cash');
  const tResult = await until(() => document.body.dataset.screen === 'result', 180_000);
  const shownOnResult = await text('#rV');                // the frozen value, before the chain answers
  // the value on screen just before the chain answers (after the re-check against the exact path)
  let shownBeforeSettle = shownOnResult, tSettled = null;
  for (const tEnd = Date.now() + 180_000; Date.now() < tEnd;) {
    if (/Settled on chain/.test(await text('#rR'))) { tSettled = Date.now(); break; }
    shownBeforeSettle = await text('#rV'); await wait(100);
  }
  const paid = (/Paid ([\d.,]+)/.exec(await text('#rR')) || [])[1];
  const settledOnResult = await text('#rV');
  const r = { run: k + 1, clickToCoin: (tGame - t0) / 1000, cashToResult: (tResult - t1) / 1000, cashToSettled: (tSettled - t1) / 1000, shownAtCashOut: shown, shownOnResult, shownBeforeSettle, settledOnResult, paid };
  console.log(JSON.stringify(r)); out.push(r);
  await pg.click('#again'); await wait(1500);
}
console.log('SUMMARY', JSON.stringify(out));
await b.close();
