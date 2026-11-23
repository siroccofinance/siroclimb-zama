// Loads the real front against Sepolia and reports console errors and the lobby state.
import puppeteer from 'puppeteer-core';
const base = process.argv[2] || 'http://127.0.0.1:3043';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const pg = await b.newPage();
pg.on('pageerror', e => console.log('PAGEERROR', e.message));
pg.on('console', c => ['error', 'warning'].includes(c.type()) && console.log('CONSOLE', c.type(), c.text()));
await pg.evaluateOnNewDocument(() => localStorage.setItem('siroclimb:ui:seenRules', 'true'));
await pg.setViewport({ width: 1440, height: 900 });
await pg.goto(`${base}/#play`, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));
console.log(await pg.evaluate(() => ({ markets: [...document.querySelectorAll('.market')].map(m => m.innerText.replace(/\n/g, ' ')), go: document.querySelector('#go').textContent, meta: document.querySelector('#goMeta').textContent, bal: document.querySelector('#bal').textContent })));
await pg.screenshot({ path: 'out/chain-lobby.png' });
await b.close();
