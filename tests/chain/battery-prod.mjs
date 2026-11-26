// Production battery with a brand-new wallet (no Sepolia ETH): server drip + first 1,000 cUSDC, then a
// climb on every market, long and short (borrowed from the Sirocco Reserve once the leverage passes 1x),
// cash out and on-chain settlement, a reload and a fresh balance decryption, a reserve deposit and
// withdrawal. Every 250 ms the screen is checked for contradictions (a decrypting status anywhere while
// the pill shows a decrypted balance, a number in a sealed pill, a status line left over on the result).
// usage: node tests/chain/battery-prod.mjs [baseUrl] [outDir] [width] [markets]   (width 390 = phone)
import puppeteer from 'puppeteer-core';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet, RPC } from './wallet.mjs';

const base = process.argv[2] || 'https://climb.sirocco.finance', out = process.argv[3] || 'out/battery-prod', W = Number(process.argv[4] || 1440);
const MARKETS = (process.argv[5] || 'TSLAx,NVDAx,AAPLx,AMZNx,XAUt,tGBP').split(','), SIDES = (process.env.SIDES || 'long,short').split(',');
mkdirSync(out, { recursive: true });
const dir = `${homedir()}/.config/siroclimb/sepolia`;
const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const fresh = Wallet.createRandom();
writeFileSync(`${out}/wallet.txt`, `${fresh.address}\n${fresh.privateKey}\n`);
// a dust amount only: the wallet must not need Sepolia ETH (the server drip pays the game gas)
await (await new Wallet(readFileSync(`${dir}/deployer.key`, 'utf8').trim(), provider).sendTransaction({ to: fresh.address, value: parseEther('0.0000001') })).wait();

const mob = W < 768;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => { errs.push(e.message); console.log('PAGEERROR', e.message); });
const consoleErrors = [];
pg.on('console', c => {
  if (c.type() === 'error') consoleErrors.push(c.text().slice(0, 200));
  if (c.type() === 'warn' || c.type() === 'error') if (!/THREE|threads/.test(c.text())) console.log('CONSOLE', c.type(), c.text().slice(0, 160));
});
await injectWallet(pg, fresh.privateKey);
await pg.evaluateOnNewDocument(() => localStorage.setItem('siroclimb:ui:seenRules', 'true'));
await pg.setViewport({ width: W, height: mob ? 844 : 900, isMobile: mob, hasTouch: mob, deviceScaleFactor: mob ? 2 : 1 });
const t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', wait = ms => new Promise(r => setTimeout(r, ms));
const issues = [], results = [];
let n = 0;
const shot = name => pg.screenshot({ path: `${out}/${String(++n).padStart(3, '0')}-${name}.png` }).catch(() => {});
const ui = () => pg.evaluate(() => {
  const q = s => document.querySelector(s), on = el => el && !el.hidden && getComputedStyle(el).display !== 'none';
  const bal = q('.balance');
  return {
    screen: document.body.dataset.screen, state: bal?.dataset.state, bal: q('#bal')?.textContent,
    setup: on(q('#setup')) ? q('#setupT').textContent : '', line: on(q('#chainline')) && q('#chainline').classList.contains('is-on') ? q('#chainlineT').textContent : '',
    toast: q('#toast.is-on')?.textContent || '', rr: on(q('#rR')) ? q('#rR').textContent : '', borrowed: q('#bV')?.textContent, value: q('#rV')?.textContent,
  };
});
// the coherence rules, checked on every poll
let liveCap = null;   // during a run: the balance may not exceed what it was before minus the stake
function check(u, where) {
  if (liveCap != null && (u.screen === 'game' || u.screen === 'ending') && u.state === 'ready' && num(u.bal) > liveCap + 0.011)   // the pill rounds to cents
    issues.push(`${T()} ${where}: balance ${u.bal} during a run, above ${liveCap.toFixed(2)} (the stake came back before the payout)`);
  const shown = /\d/.test(u.bal || '');
  const decryptingText = /decrypt/i.test(`${u.line} ${u.toast}`);
  if (shown && u.state === 'ready' && decryptingText) issues.push(`${T()} ${where}: "${u.line || u.toast}" while the pill shows a decrypted ${u.bal}`);
  if (shown && (u.state === 'sealed' || u.state === 'locked')) issues.push(`${T()} ${where}: number ${u.bal} in a ${u.state} pill`);
  if (/error|reverted|failed|Panic/i.test(`${u.line} ${u.toast}`) && !/Not enough|closed/i.test(u.toast)) issues.push(`${T()} ${where}: error shown: ${u.line || u.toast}`);
}
let lastKey = '';
async function watch(until, ms, where, passive = false) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const u = await ui(); check(u, where);
    const k = JSON.stringify(u); if (k !== lastKey) { lastKey = k; console.log(T(), where.padEnd(14), Object.entries(u).filter(([, v]) => v).map(([k, v]) => `${k}=${String(v).slice(0, 70)}`).join(' | ')); }
    if (await until(u)) return u;
    await wait(250);
  }
  if (!passive) { issues.push(`${T()} ${where}: timed out`); await shot(`timeout-${where}`); }
  return null;
}
const num = s => parseFloat(String(s).replace(/[^\d.−-]/g, '').replace('−', '-'));

await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await watch(() => false, 2000, 'load', true); await shot('lobby');
// the lobby: every market open with a price, one row, the picked card's ring not clipped
const lobby = await pg.evaluate(() => {
  const row = document.querySelector('#markets'), r = row.getBoundingClientRect(), cards = [...row.children];
  const sel = cards.find(c => c.getAttribute('aria-pressed') === 'true'), sr = sel.getBoundingClientRect();
  const clipY = getComputedStyle(row).overflowY !== 'visible';
  return { open: cards.filter(c => !c.classList.contains('is-closed')).length, priced: cards.filter(c => /\d/.test(c.querySelector('.p').textContent)).length,
    oneLine: new Set(cards.map(c => Math.round(c.getBoundingClientRect().top))).size === 1,
    ringClipped: clipY && (sr.top - 2 < r.top || sr.bottom + 2 > r.bottom), scrolls: row.scrollWidth > row.clientWidth };
});
const p0 = await pg.evaluate(() => [...document.querySelectorAll('#markets .p')].map(e => e.textContent));
await wait(8000);
const p1 = await pg.evaluate(() => [...document.querySelectorAll('#markets .p')].map(e => e.textContent));
lobby.moved = p0.filter((v, i) => v !== p1[i]).length;
console.log('lobby', JSON.stringify(lobby));
const tc = Date.now();
await pg.click('#wallet');
await watch(u => u.state === 'ready' && num(u.bal) >= 1000, 120_000, 'first-visit');
const firstVisit = ((Date.now() - tc) / 1000).toFixed(1);
await shot('ready');
console.log('first visit', firstVisit, 's');

const PLANS = (process.env.PLANS || 'early,mid,late,expire').split(',');
let runIndex = 0;
for (const m of MARKETS) for (const side of SIDES) {
  const plan = PLANS[runIndex++ % PLANS.length];
  const tag = `${m}-${side}-${plan}`;
  await pg.click(`.market[data-v="${m}"]`).catch(() => {});
  await pg.click(`#side button[data-v="${side}"]`); await pg.click('#stake button[data-v="10"]');
  const open = await pg.$eval('#go', e => !e.disabled);
  if (!open) { results.push({ tag, skipped: await pg.$eval('#goMeta', e => e.textContent) }); continue; }
  const before = num((await ui()).bal), ts = Date.now();
  liveCap = before - 10;
  await pg.click('#go');
  const g = await watch(u => u.screen === 'game', 60_000, `${tag} start`);
  if (!g) { results.push({ tag, error: 'no start' }); await pg.reload(); await wait(4000); continue; }
  const startS = ((Date.now() - ts) / 1000).toFixed(1);
  const climb = { early: 5000, mid: 20000, late: 45000, expire: 0 }[plan];
  const st0 = await pg.evaluate(() => ({ ...window.__stairs }));
  if (plan === 'expire') await watch(u => u.screen !== 'game', 90_000, `${tag} climb`, true);    // nobody cashes out: the 60th second does
  else await watch(() => false, climb, `${tag} climb`, true);
  const st1 = await pg.evaluate(() => ({ ...window.__stairs }));
  const holding = await pg.$eval('#borrow', e => e.textContent.replace(/\s+/g, ' ').trim());
  const borrowed = (await ui()).borrowed; await shot(`${tag}-game`);
  const tcash = Date.now();
  liveCap = null;
  if (plan !== 'expire') await pg.click('#cash');
  const r = await watch(u => u.screen === 'result' && (/Settled on chain/.test(u.rr) || /did not go through/.test(u.rr)), 120_000, `${tag} cashout`);
  const settleS = ((Date.now() - tcash) / 1000).toFixed(1);
  await watch(u => u.state === 'ready', 30_000, `${tag} balance`);
  const after = num((await ui()).bal), u = await ui();
  const split = await pg.$eval('#rS', e => e.innerText.replace(/\s+/g, ' '));
  results.push({ tag, start_s: startS, settle_s: settleS, borrowed, holding, steps: st1.steps - st0.steps, quotes: st1.quotes - st0.quotes,
    split: /Real position/.test(split) && /Game boost/.test(split), value: u.value, balance: `${before} -> ${after}`, settled: !!r && /Settled/.test(r.rr) });
  await shot(`${tag}-result`);
  await pg.click('#again'); await watch(x => x.screen === 'lobby', 10_000, `${tag} again`); await wait(1200);   // the wash lifts
}

// a reload: the stored 7-day grant decrypts the balance again by itself (a click if it comes back sealed)
await pg.reload({ waitUntil: 'networkidle2' });
const back = await watch(u => u.state === 'ready' || u.state === 'sealed' || u.state === 'error', 30_000, 'reload');
if (back && back.state !== 'ready') await pg.click('#bal');
await watch(u => u.state === 'ready', 60_000, 'decrypt'); await shot('decrypted');

// the reserve: deposit, withdraw
await pg.click('[data-open=reserve]'); await watch(() => false, 6000, 'reserve', true);
const pos0 = await pg.$eval('#rvMe', e => e.textContent);
await pg.type('#rvAmt', '20'); await pg.click('#rvDep');
await watch(u => /Deposited/.test(u.toast), 120_000, 'deposit');
await watch(() => false, 12000, 'deposit-after', true);
const pos1 = await pg.$eval('#rvMe', e => e.textContent);
await pg.click('#rvAmt', { clickCount: 3 }); await pg.type('#rvAmt', '10'); await pg.click('#rvWd');
await watch(u => /Withdrew|Not withdrawn/.test(u.toast), 120_000, 'withdraw');
await watch(() => false, 12000, 'withdraw-after', true); await shot('reserve');
const pos2 = await pg.$eval('#rvMe', e => e.textContent);
const report = { base, width: W, wallet: fresh.address, firstVisit_s: firstVisit, lobby, consoleErrors, results, reserve: { before: pos0, afterDeposit: pos1, afterWithdraw: pos2 }, issues, pageErrors: errs };
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
