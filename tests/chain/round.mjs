// End to end on Sepolia through the real front: a timed round. The player opens (or joins) a
// round with an encrypted side, the in-browser practice bots fill the empty seats, the run starts
// on the bell, the player cashes out, the autopilot closes the round, the KMS reveals the
// standings, the pot is paid. Nothing runs on our side.
// usage: node tests/chain/round.mjs [baseUrl]   (PLAYER=<index> to pick the test wallet)
import puppeteer from 'puppeteer-core';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { injectWallet } from './wallet.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3043', idx = Number(process.env.PLAYER || 0);
const m = Mnemonic.fromPhrase(readFileSync(`${homedir()}/.config/zama/siroclimb-battery.mnemonic`, 'utf8').trim());
const key = HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${idx}`).privateKey;
// a persistent profile per test wallet: the game session (and its gas) carries over between runs
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: `out/chrome-player-${idx}` });
const pg = await b.newPage();
const errors = [];
pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
pg.on('console', c => { if (c.type() === 'error' || /autopilot|bot/.test(c.text())) console.log('CONSOLE', c.type(), c.text()); if (c.type() === 'error') errors.push(c.text()); });
const w = await injectWallet(pg, key);
await pg.evaluateOnNewDocument(() => { localStorage.setItem('siroclimb:ui:seenRules', 'true'); localStorage.setItem('siroclimb:ui:mode', JSON.stringify('round')); });
await pg.setViewport({ width: 1440, height: 900 });
const wait = ms => new Promise(r => setTimeout(r, ms)), t0 = Date.now(), T = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
const shot = n => pg.screenshot({ path: `out/chain-round-${n}.png` });
const line = () => pg.evaluate(() => [document.querySelector('#chainline')?.hidden ? '' : document.querySelector('#chainlineT')?.textContent, document.querySelector('#toast.is-on')?.textContent].filter(Boolean).join(' / '));
const text = s => pg.$eval(s, e => e.textContent);
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(3000);
console.log(T(), 'player', w.address);
await pg.click('#wallet');
for (let i = 0; i < 120; i++) { if (!/Connecting/.test(await text('#wallet'))) break; await wait(2000); }
await pg.click('#bal');
for (let i = 0; i < 60; i++) { const v = await text('#bal'); if (/\d/.test(v)) { console.log(T(), 'balance', v); break; } await wait(2000); }
console.log(T(), 'lobby', await text('#go'), '|', await text('#goMeta'));
await shot('1lobby');
await pg.click('#side button[data-v="short"]');
await pg.click('#go');
for (let i = 0; i < 60; i++) { const g = await text('#go'); if (/Starts in/.test(g)) { console.log(T(), 'joined:', g, '|', await text('#goMeta')); break; } if (i % 4 === 0) console.log(T(), 'joining:', g, '|', await line()); await wait(1500); }
await shot('2joined');
for (let i = 0; i < 80; i++) { const s = await pg.evaluate(() => document.body.dataset.screen); if (s === 'game') break; if (i % 6 === 0) console.log(T(), 'waiting:', await text('#go'), '|', await text('#goMeta'), '|', await line()); await wait(1500); }
console.log(T(), 'round live');
await wait(12000); await shot('3live');
console.log(T(), 'standings', await pg.evaluate(() => [...document.querySelectorAll('#standings li')].map(l => l.innerText.replace(/\n/g, ' '))), await text('#rank'));
await wait(10000);
await pg.click('#cash'); console.log(T(), 'cash out');
for (let i = 0; i < 160; i++) { const r = await text('#rR'); if (/ of /.test(r)) { console.log(T(), 'final:', r); break; } if (i % 6 === 0) console.log(T(), 'result:', r, '|', await line()); await wait(2000); }
await shot('4final');
await pg.click('#again'); await wait(1500); await pg.click('[data-open=board]'); await wait(500); await pg.click('#boardTabs button[data-v=round]'); await wait(4000);
console.log(T(), 'board', await pg.evaluate(() => [...document.querySelectorAll('#boardList li')].map(l => l.innerText.replace(/\n/g, ' '))));
await shot('5board');
console.log('errors', errors.length);
await b.close();
