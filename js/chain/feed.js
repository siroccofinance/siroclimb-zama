// Live prices for the screen. The game is settled on chain on oracle checkpoints (a few per
// minute, Sepolia blocks are 12 s); the screen moves smoothly on the live market in between:
//  - Pyth (through our server route, signed update + parsed price) for every entitled feed;
//  - our /api/prices route for the others: the stocks' 24/7 xStock book, XAUt and GBP spot, all on
//    Kraken, all 24/7;
//  - the oracle's latest checkpoints when the routes never answered (static hosting).
// One source per market: a market priced by Pyth keeps Pyth through a missed poll (no switch to the
// reference and back, which drew spikes), and a failed poll after a working one just waits.
// Ticks are emitted every 250 ms, easing from the previous quote to the new one.
//  - Hyperliquid's WebSocket first (2026-11-26): the browser subscribes to the best bid and offer ('bbo')
//    of every market's xyz perp (several messages a second; the 'l2Book' channel only sent a few a minute)
//    and applies the microprice (top of book, size-weighted) of every message as it arrives (about 7 a
//    second on NVDA); the screen eases between them and the stairs queue their steps. The book moves several times a second, far more than a 1 s poll sees. A market whose socket
//    closed, or stayed silent a full minute, falls back to /api/prices (the server's own l2Book read) on the next poll.
import { MARKETS, PRICE_DECIMALS } from './config.js';
import { oracle } from './wallet.js';

const TICK_MS = 100, POLL_MS = 1000, KEEP_MS = 15 * 60_000, WS_FRESH_MS = 60_000;
const feeds = MARKETS.map(m => ({ id: m.id, price: null, from: null, to: null, t0: 0, dur: POLL_MS, hist: [], subs: new Set(), open: true, source: null, pyth: false, quoteAt: 0, ws: null, wsAt: 0 }));
const metaSubs = new Set();
export const pythPayload = { at: 0, body: null };
let started = false, routeOk = null;

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

function quote(i, price, source, open) {
  const f = feeds[i];
  if (!(price > 0)) return;
  f.dur = Math.max(TICK_MS, Math.min(POLL_MS, Date.now() - (f.quoteAt || 0)));   // ease over the gap between quotes
  if (price !== f.to) { (f.raw ||= []).push({ price, ts: Date.now() }); if (f.raw.length > 2000) f.raw.splice(0, 500); }   // the quotes themselves (not eased)
  f.from = f.price ?? price; f.to = price; f.t0 = Date.now(); f.source = source; f.quoteAt = Date.now();
  if (open != null) f.open = open;
  if (f.price == null) { f.price = price; seed(f); }
}
// a short flat history so the first chart and step size have something to work with
// (marked `seed`: the chart leaves them out and stretches the real history over its width instead)
function seed(f) { const now = Date.now(); for (let k = 40; k > 0; k--) f.hist.push({ price: f.price, ts: now - k * 1000, seed: true }); }

let pythOffUntil = 0;   // no entitled Pyth feed: ask again once a minute, not every poll
async function poll() {
  const askPyth = Date.now() >= pythOffUntil;
  const [pyth, ref] = await Promise.allSettled([askPyth ? getJson('/api/pyth') : Promise.reject(new Error('off')), getJson('/api/prices')]);
  if (askPyth && pyth.status === 'fulfilled' && !pyth.value.ok) pythOffUntil = Date.now() + 60_000;
  const covered = new Set();
  if (pyth.status === 'fulfilled' && pyth.value.ok) {
    pythPayload.at = Date.now(); pythPayload.body = pyth.value;
    for (const p of pyth.value.prices) if (p.market >= 0 && Date.now() / 1000 - p.publishTime < 60) { covered.add(p.market); feeds[p.market].pyth = true; feeds[p.market].pythAt = Date.now(); quote(p.market, p.price, 'pyth'); }
  }
  // a Pyth market that missed this poll keeps its Pyth price for 20 s rather than jumping to another source
  feeds.forEach((f, i) => { if (f.pyth && !covered.has(i) && Date.now() - (f.pythAt || 0) < 20_000) covered.add(i); });
  if (ref.status === 'fulfilled' && ref.value.ok) {
    routeOk = true;
    for (const m of ref.value.markets) {
      const live = wsLive(m.market);
      if (!covered.has(m.market) && !live) quote(m.market, m.price, m.source, m.open);
      else if (live && m.open != null) feeds[m.market].open = m.open;
      else feeds[m.market].open = m.open || feeds[m.market].open;
      feeds[m.market].ref = m.price; feeds[m.market].session = m.session;
    }
  } else if (!covered.size && routeOk !== true) {             // never answered: static hosting
    routeOk = false;
    try {
      const [ts, px] = await oracle.latestAll();
      px.forEach((p, i) => { const age = Date.now() / 1000 - Number(ts[i]); quote(i, Number(p) / 10 ** PRICE_DECIMALS, 'oracle', age < 300); });
    } catch {}
  }
  metaSubs.forEach(cb => cb(markets()));
}

function tick() {
  const now = Date.now();
  for (const f of feeds) {
    if (f.to == null) continue;
    const k = Math.min(1, (now - f.t0) / (f.dur || POLL_MS));
    f.price = f.from + (f.to - f.from) * (1 - (1 - k) ** 2);
    f.hist.push({ price: f.price, ts: now });
    while (f.hist.length && f.hist[0].ts < now - KEEP_MS) f.hist.shift();
    const last = f.hist[f.hist.length - 1];
    f.subs.forEach(cb => cb(last));
  }
}

// ── Hyperliquid WebSocket (best bid and offer per market), reconnecting with a backoff
// 'bbo' only sends when the book changes: a quiet market (GBP sends every few seconds) is not a dead socket.
// The socket's price stands while the socket is open and the market spoke within a minute; only then does
// the server's read take over (it lags the book and drew square spikes when the two alternated).
const wsLive = i => sock?.readyState === 1 && Date.now() - feeds[i].wsAt < WS_FRESH_MS && feeds[i].ws > 0;
const coinIdx = new Map(MARKETS.map((m, i) => [m.hyperliquid, i]).filter(([c]) => c));
let sock = null, wsBackoff = 1000;
function microOf(bbo) {
  const b = bbo?.[0], a = bbo?.[1];
  const bp = Number(b?.px), bs = Number(b?.sz), ap = Number(a?.px), as = Number(a?.sz);
  return bp > 0 && ap >= bp && bs > 0 && as > 0 ? (bp * as + ap * bs) / (bs + as) : null;
}
function openSocket() {
  if (!coinIdx.size || typeof WebSocket === 'undefined' || /[?&]nows\b/.test(location.search)) return;
  try { sock = new WebSocket('wss://api.hyperliquid.xyz/ws'); } catch { return; }
  sock.onopen = () => {
    wsBackoff = 1000;
    for (const coin of coinIdx.keys()) sock.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin } }));
  };
  sock.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.channel !== 'bbo' || !d.data) return;
    const i = coinIdx.get(d.data.coin), p = microOf(d.data.bbo);
    if (i == null || !(p > 0)) return;
    const f = feeds[i]; f.ws = p; f.wsAt = Date.now();
    if (p !== f.to && !f.pyth) quote(i, p, 'hyperliquid-ws');
  };
  sock.onclose = () => { sock = null; setTimeout(openSocket, wsBackoff); wsBackoff = Math.min(30_000, wsBackoff * 2); };
  sock.onerror = () => { try { sock.close(); } catch {} };
}
export function start() {
  if (started) return; started = true;
  poll(); setInterval(poll, POLL_MS); setInterval(tick, TICK_MS);
  openSocket();
}
export function subscribe(i, cb) {
  start();
  const f = feeds[i]; f.subs.add(cb);
  if (f.hist.length) cb(f.hist[f.hist.length - 1]);
  return () => f.subs.delete(cb);
}
/** The market's own quotes (each change, not the eased screen price) over the last `seconds`. */
export function quotes(i, seconds = 90) { const from = Date.now() - seconds * 1000; return (feeds[i].raw || []).filter(h => h.ts >= from); }
export function history(i, seconds = 60) { const from = Date.now() - seconds * 1000; return feeds[i].hist.filter(h => h.ts >= from); }
export const last = i => feeds[i].price;
export const isOpen = i => feeds[i].open;
// the checkpoint price: what the player sees (the socket's microprice) when it agrees with the server's own
// fresh l2Book read (/api/prices) within 0.15 %; else the server's read. The oracle bounds every checkpoint.
export const refPrice = i => {
  const f = feeds[i], srv = f.ref ?? f.price;
  if (wsLive(i) && srv > 0 && Math.abs(f.ws / srv - 1) <= 0.0015) return f.ws;
  return srv;
};
export const isPyth = i => feeds[i].pyth;
export const sourceOf = i => feeds[i].source;
/** The latest quote itself (not the eased screen price): it changes only when the market does. */
export const quoteOf = i => feeds[i].to ?? feeds[i].price;
export const markets = () => feeds.map((f, i) => ({ index: i, id: f.id, open: f.open, source: f.source, pyth: f.pyth, price: f.price, session: f.session }));
export function onMarkets(cb) { metaSubs.add(cb); return () => metaSubs.delete(cb); }
export const routeAvailable = () => routeOk;
/** Waits until every market has a first quote (or `ms` passed). */
export async function ready(ms = 6000) {
  start();
  const t0 = Date.now();
  while (feeds.some(f => f.price == null) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 100));
}
