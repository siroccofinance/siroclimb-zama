// Siroclimb game front. Screens: lobby → game → result. All data goes through ./api.js (Sepolia by default, ?mock for the simulation).
// The 3D scene is the hero's: in the lobby the belt loops; on start it brakes, the coin's box climbs one level
// per leverage step; cash out tosses the coin (camera follows), a bust drops it.
import * as api from './api.js';
import { createEscalatorScene } from './sirocco-escalator-scene.js?v=11';
import { CARD, drawCard, loadLogo, toBlob } from './share-card.js?v=1';

const $ = s => document.querySelector(s);
const body = document.body;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STAIRS = !new URLSearchParams(location.search).has('classic');   // stairs game (default) or the first version
document.documentElement.classList.toggle('stairs', STAIRS);
const mobile = () => innerWidth < 768;
const store = {
  get(k, d) { try { const v = localStorage.getItem('siroclimb:ui:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('siroclimb:ui:' + k, JSON.stringify(v)); } catch {} },
};

// ── formatting
const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MINUS = '−';
const money = v => nf.format(v);
const sgn = v => (v < -0.0049 ? MINUS : '+');
const signed = v => sgn(v) + nf.format(Math.abs(v));
/** Small amounts (interest on a minute of borrowing) keep their 6 decimals. */
const tiny = v => (v > 0 && v < 0.0000005 ? '<0.000001' : v > 0 && v < 0.01 ? v.toFixed(6) : money(v));
const pct = v => sgn(v) + Math.abs(v).toFixed(2) + '%';
// enough decimals for the microprice's moves: 3 for the stocks, 5 for the pound (gold: a cent is 0.0003 %)
const price = p => (p >= 1000 ? nf.format(p) : p >= 10 ? p.toFixed(3) : p.toFixed(5));
// in the climb, three decimals for gold too (the lobby cards keep two to fit): the microprice's small moves show
const nf3 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const livePrice = p => (p >= 1000 ? nf3.format(p) : price(p));
const levTxt = x => (x % 1 ? x.toFixed(1) : String(x)) + 'x';
const mmss = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const shortAddr = a => a.slice(0, 4) + '…' + a.slice(-4);

// ── state
const assets = api.listAssets();
const byId = Object.fromEntries(assets.map(a => [a.id, a]));
const C = { asset: store.get('asset', 'TSLAx'), side: store.get('side', 'long'), stake: store.get('stake', 25) };
if (!byId[C.asset]) C.asset = assets[0].id;
let screen = body.dataset.screen || 'intro', busy = false;
let run = null, upd = null, shownStep = 0, ended = null;
const D = { value: 0, pnl: 0, pct: 0, danger: 0 };           // displayed values, eased toward the feed every frame

function setScreen(s) { screen = s; body.dataset.screen = s; }

// ── toast
let toastT = 0;
function toast(msg, ms = Math.max(2400, String(msg).length * 70)) { const t = $('#toast'); t.textContent = msg; t.classList.add('is-on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('is-on'), ms); }

// ── chain status line: wallet steps, encryption, transactions, decryption, keeper duties
const chainline = $('#chainline');
api.onStatus(st => {
  if (!st) { chainline.classList.remove('is-on'); clearTimeout(chainline._t); chainline._t = setTimeout(() => { chainline.hidden = true; }, 250); return; }
  clearTimeout(chainline._t); chainline.hidden = false; chainline.dataset.kind = st.kind; $('#chainlineT').textContent = st.text;
  requestAnimationFrame(() => chainline.classList.add('is-on'));
  if (st.kind === 'error') chainline._t = setTimeout(() => api.onStatus && chainline.classList.remove('is-on'), 6000);
});
if (api.unavailable) setTimeout(() => toast('Sepolia unavailable, playing the simulation', 5000), 1500);

// ── sound: a few synthesized notes, nothing to load
const sound = (() => {
  let ctx = null, on = store.get('sound', true);
  const btn = $('#sound'); btn.setAttribute('aria-pressed', on);
  btn.onclick = () => { on = !on; store.set('sound', on); btn.setAttribute('aria-pressed', on); if (on) note(660, 0.12, 'sine', 0.05); };
  function note(f, d, type = 'sine', g = 0.06, slide = 1, at = 0) {
    if (!on) return;
    try { ctx ||= new AudioContext(); if (ctx.state === 'suspended') ctx.resume(); } catch { return; }
    const t0 = ctx.currentTime + at, o = ctx.createOscillator(), a = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0); if (slide !== 1) o.frequency.exponentialRampToValueAtTime(f * slide, t0 + d);
    a.gain.setValueAtTime(0.0001, t0); a.gain.exponentialRampToValueAtTime(g, t0 + 0.012); a.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(a).connect(ctx.destination); o.start(t0); o.stop(t0 + d + 0.03);
  }
  const SCALE = [0, 2, 4, 7, 9, 12, 14];
  return {
    unlock() { note(1, 0.01, 'sine', 0.0002); },
    start() { note(392, 0.18, 'triangle', 0.05); note(587, 0.22, 'triangle', 0.04, 1, 0.07); },
    step(n) { const f = 392 * 2 ** (SCALE[Math.min(n, 6)] / 12); note(f, 0.32, 'triangle', 0.07); note(f * 2, 0.22, 'sine', 0.025, 1, 0.02); },
    cash() { [0, 4, 7, 12].forEach((s, i) => note(523 * 2 ** (s / 12), 0.5, 'triangle', 0.06, 1, i * 0.07)); },
    bust() { note(220, 0.7, 'triangle', 0.08, 0.35); note(110, 0.5, 'sine', 0.08, 0.5, 0.08); },
    tick() { note(1200, 0.04, 'sine', 0.02); },
    up(l) { const f = 440 * 2 ** (Math.max(-12, Math.min(12, l)) / 24); note(f, 0.16, 'triangle', 0.045); },
    down(l) { const f = 440 * 2 ** (Math.max(-12, Math.min(12, l)) / 24); note(f, 0.18, 'sine', 0.05, 0.8); },
    drop() { note(330, 0.45, 'triangle', 0.07, 0.5); },
  };
})();
const haptic = p => { try { navigator.vibrate?.(p); } catch {} };

// ── scene
const stage = $('#stage');
let repose = () => {}, wantCard = false, card = null;
let TK = null, sc = null, idleT = 0, last = performance.now(), G = null, live = false, syncing = true;
const film = $('#film');
const cover = () => ({ aspect: 16 / 9, x: mobile() ? 0.64 : 0.6, y: 0.3 });
const dpr = () => Math.min(devicePixelRatio || 1, 1.5);
function initScene() {
  try { sc = createEscalatorScene({ width: innerWidth, height: innerHeight, pixelRatio: dpr(), framing: 'site', theme: 'terracotta-gloss' }); }
  catch { sc = null; return; }
  if (mobile()) sc.key.shadow.mapSize.set(2048, 2048);
  if (innerHeight > innerWidth) { sc.L.FOLLOW_T = 0.45; sc.L.DOLLY = 0.28; }   // portrait: lock on sooner, stay further back
  stage.appendChild(sc.canvas);
  sc.setSize(innerWidth, innerHeight, dpr(), cover());
  idleT = film.currentTime || 0;
  if (screen !== 'intro') park(0.15);
  // two drawn frames, then the live scene fades in over the (still synced) film, which then stops
  let n = 0;
  const reveal = () => {
    if (++n < 3) return requestAnimationFrame(reveal);
    sc.canvas.classList.add('is-live'); live = true; $('#wash').classList.remove('is-on');
    setTimeout(() => { syncing = false; film.pause(); }, 700);
  };
  requestAnimationFrame(reveal);
}
// the coin stops on the box under it and waits there; `hop` = seconds after the stop for the ready hop (null: none)
function park(hop = null, braked = true) {
  if (!sc) return;
  const tt = idleT % sc.LOOP;
  G = { plan: sc.planLaunch(tt * sc.SPEED, tt), steps: [], danger: 0, dangerTo: 0, end: null,
    t0: performance.now() - (braked ? sc.L.TS * 1000 : 0), hop: hop == null ? null : sc.L.TS + hop };
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  idleT = syncing && !film.paused && film.currentTime ? film.currentTime : idleT + dt;   // locked to the film until it is hidden
  if (sc) {
    if (TK) {
      TK.danger += (TK.dangerTo - TK.danger) * (1 - Math.exp(-dt * 4));
      sc.trackStep(TK, dt, lvl.level); repose = () => sc.trackPose(TK, now / 1000, TK.danger); repose(); bubbleFrame();
      if (screen === 'ending' && TK.end && TK.end.ready) setScreen('result');
    }
    else if (G) { G.danger += ((G.dangerTo || 0) - G.danger) * (1 - Math.exp(-dt * 4)); repose = () => sc.gamePose(G, (now - G.t0) / 1000, now / 1000); repose(); }
    else sc.setTime(idleT % sc.LOOP);
    sc.draw();
    if (wantCard && (screen === 'result' || (screen === 'ending' && ended && ended.status === 'busted')))   // a fall is shot as it starts, coin still in frame
      { wantCard = false; makeCard(grabScene()); }
  }
  if (screen === 'game' || screen === 'ending') hudFrame(dt);
  if (screen === 'game') drawSpark();
  requestAnimationFrame(frame);
}

// ── wallet + balance
const walletBtn = $('#wallet'), walletMenu = $('#walletMenu');
// the label depends on the width: redraw it when the window crosses the phone breakpoint
addEventListener('resize', () => renderWallet());
function renderWallet() {
  const a = api.account();
  walletBtn.classList.toggle('is-on', !!a);
  walletBtn.textContent = a ? (innerWidth <= 420 ? a.slice(0, 4) + '…' + a.slice(-2) : shortAddr(a)) : mobile() ? 'Connect' : 'Connect wallet';
}
async function connect(quiet) {
  if (api.account()) return true;
  walletBtn.classList.add('is-busy'); walletBtn.textContent = 'Connecting…';
  try { await api.connect(); renderWallet(); renderBalance(); api.prepare({ side: C.side, stake: C.stake }); return true; }   // the setup line next to the balance says the rest
  catch (e) { renderWallet(); toast(e.message || 'Could not connect'); return false; }
  finally { walletBtn.classList.remove('is-busy'); }
}
walletBtn.onclick = e => {
  e.stopPropagation();
  if (!api.account()) return connect();
  const open = walletMenu.hidden; walletMenu.hidden = !open; walletBtn.setAttribute('aria-expanded', open);
};
walletMenu.onclick = async e => {
  const act = e.target.dataset.act; walletMenu.hidden = true; walletBtn.setAttribute('aria-expanded', false);
  if (act === 'copy') { try { await navigator.clipboard.writeText(api.account()); toast('Address copied'); } catch { toast(api.account()); } }
  if (act === 'out') { api.disconnect(); renderWallet(); renderBalance(); toast('Wallet disconnected'); }
  if (act === 'decrypt') decrypt();
  if (act === 'explorer') window.open(`https://sepolia.etherscan.io/address/${api.account()}`, '_blank', 'noopener');
  if (act === 'name') { const n = prompt('Your name on the leaderboard (24 characters max)'); if (n) { try { await api.setName(n.trim()); toast('Name saved on chain'); } catch (e) { toast(e.message); } } }
};
addEventListener('click', () => { if (!walletMenu.hidden) { walletMenu.hidden = true; walletBtn.setAttribute('aria-expanded', false); } });

// enough to play: a sealed balance is not a reason to block (the contract moves 0 when short)
const canPay = amount => { const b = api.balance(); return b == null || b >= amount; };
const balEl = $('#bal'), faucetBtn = $('#faucet'), balBox = balEl.parentElement;
// the balance is an encrypted ERC-7984 handle: one state at a time, in the pill itself (no separate toast).
// Never a number that was not decrypted: locked ••••, sealed "Decrypt", decrypting (spinner, the last
// decrypted value if any), ready, error "Retry".
let setupOn = false;
function renderBalance(v, bump) {
  const info = api.mode === 'chain' ? api.balanceInfo() : { state: 'ready', value: api.balance() ?? 0 };
  const st = !api.account() && api.mode === 'chain' ? 'locked' : info.state, val = info.value;
  balBox.dataset.state = st;
  const known = val != null && st !== 'locked';
  balEl.textContent = known ? money(val) : st === 'decrypting' ? 'Decrypting…' : st === 'error' ? 'Retry' : st === 'sealed' ? 'Decrypt' : '••••';
  balEl.classList.toggle('is-sealed', !known);
  balEl.disabled = st === 'decrypting';
  balEl.title = st === 'locked' ? 'Connect your wallet to see your encrypted balance'
    : st === 'sealed' ? 'Encrypted on chain. Click to decrypt it in your browser'
    : st === 'decrypting' ? (known ? 'Updating: decrypting your new balance' : 'Decrypting your balance in your browser')
    : st === 'error' ? `Could not decrypt${info.error ? `: ${info.error}` : ''}. Click to retry` : 'Your cUSDC, decrypted in your browser';
  // the faucet "+" only when it can be used: not during the first-visit setup, not while decrypting
  faucetBtn.hidden = setupOn || st === 'decrypting' || st === 'locked' || (known && val >= 1000);
  if (bump && known) { balBox.classList.remove('is-bump'); void balBox.offsetWidth; balBox.classList.add('is-bump'); }
  renderGo();
}
api.onBalance(v => renderBalance(v, true));
// first visit: one compact line under the balance, step by step, then "Ready"
const setupEl = $('#setup');
api.onSetup(st => {
  setupOn = !!st && !st.done;
  if (!st) { if (setupEl.hidden) return; setupEl.classList.remove('is-on'); clearTimeout(setupEl._t); setupEl._t = setTimeout(() => { setupEl.hidden = true; }, 250); renderBalance(); return; }
  clearTimeout(setupEl._t); setupEl.hidden = false; setupEl.classList.toggle('is-done', !!st.done);
  $('#setupT').textContent = st.text; $('#setupN').textContent = st.done ? '' : `${st.step}/${st.steps}`;
  requestAnimationFrame(() => setupEl.classList.add('is-on'));
  renderBalance();
});
faucetBtn.onclick = async () => {
  if (!(await connect(true))) return;
  try { await api.faucet(); toast('+1,000 test cUSDC, minted and wrapped for you'); } catch (e) { toast(e.message); }
};
async function decrypt() {
  if (!(await connect(true))) return;
  try { await api.decryptBalance(); } catch { /* the pill shows Retry */ }
}
balEl.onclick = () => { if (api.mode === 'chain' && !balEl.disabled) decrypt(); };
const KIND = { stock: 'Stock', gold: 'Gold', fx: 'FX', crypto: 'Crypto' };
/** A market is named by the confidential token it trades (cTSLAx, cXAUt, ctGBP), the plain name in small. */
const label = a => a.token || a.ticker;

// ── lobby
const marketsEl = $('#markets');
const chip = {};
const day = { ref: {}, at: 0 };   // 24 h reference price per market (api/change.js), before any price arrives
for (const a of assets) {
  const b = document.createElement('button');
  b.className = 'market'; b.dataset.v = a.id;
  b.innerHTML = `<b>${label(a)}</b><span class="k">${KIND[a.kind] || a.kind}</span><span class="n">${a.name}</span><span class="p"></span><span class="c"></span>`;
  b.title = `${label(a)}: confidential ${a.name} token (ERC-7984)`;
  b.onclick = () => { C.asset = a.id; store.set('asset', a.id); renderLobby(); };
  marketsEl.appendChild(b);
  chip[a.id] = { b, p: b.querySelector('.p'), c: b.querySelector('.c') };
  api.subscribePrice(a.id, ({ price: p }) => { if (screen === 'lobby') chipChange(a.id, p); });
}
// the 24 h change on each card: the price 24 h ago from Kraken's hourly candles (api/change.js), against
// the live price. No reference (no server, no data): no figure, never a made-up 0.00 %.
function chipChange(id, p = api.quote(id)) {
  const c = chip[id]; if (!c) return;
  if (p > 0) c.p.textContent = price(p);
  const open = api.marketOpen(id), ref = day.ref[id];
  c.b.classList.toggle('is-closed', !open);
  if (!open) { c.c.textContent = 'Closed'; c.c.className = 'c is-closed'; return; }
  if (!(ref > 0) || !(p > 0)) { c.c.textContent = ''; c.c.className = 'c'; return; }
  const ch = (p / ref - 1) * 100;
  c.c.innerHTML = `${sgn(ch)}${Math.abs(ch).toFixed(2)}%<i>24h</i>`; c.c.className = 'c ' + (ch >= 0 ? 'is-up' : 'is-down');
  c.c.title = `${sgn(ch)}${Math.abs(ch).toFixed(2)}% over 24 hours (Hyperliquid)`;
}
async function loadDay() {
  if (api.mode !== 'chain' || Date.now() - day.at < 55_000) return;   // the simulation's prices are not Kraken's
  day.at = Date.now();
  try {
    const r = await fetch('/api/change', { signal: AbortSignal.timeout(8000) }); if (!r.ok) return;
    const d = await r.json();
    for (const m of d.markets || []) if (m.pct != null && m.ref > 0) day.ref[m.id] = m.ref; else delete day.ref[m.id];
  } catch { /* static hosting or Kraken down: the cards show no change */ }
  for (const id of Object.keys(chip)) chipChange(id);
  $('#l-day').hidden = !Object.keys(day.ref).length;
}
loadDay(); setInterval(() => { if (screen === 'lobby' && !document.hidden) loadDay(); }, 60_000);
function bindSeg(el, key, parse = v => v) {
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    C[key] = parse(b.dataset.v); store.set(key, C[key]); renderLobby(); sound.tick();
  }));
}
bindSeg($('#side'), 'side'); bindSeg($('#stake'), 'stake', Number);
const press = (el, v) => el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
// sliding thumb under the picked option; flashes a sheen when the pick changes
function thumb(el) {
  let t = el.querySelector('.seg__thumb');
  if (!t) { t = document.createElement('i'); t.className = 'seg__thumb'; t.setAttribute('aria-hidden', 'true'); el.prepend(t); }
  const b = el.querySelector('button[aria-pressed="true"]');
  el.classList.toggle('has-thumb', !!b); if (!b || !b.offsetWidth) return;
  if (el.dataset.v && el.dataset.v !== b.dataset.v) { el.classList.remove('is-flash'); void el.offsetWidth; el.classList.add('is-flash'); }
  el.dataset.v = b.dataset.v;
  t.style.width = b.offsetWidth + 'px'; t.style.transform = `translateX(${b.offsetLeft}px)`;
  if (!el.classList.contains('is-ready')) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-ready')));
}
const segs = ['#side', '#stake'].map(s => $(s));
const thumbs = () => segs.forEach(thumb);
if (window.ResizeObserver) { const ro = new ResizeObserver(thumbs); segs.forEach(s => s.querySelectorAll('button').forEach(b => ro.observe(b))); }
document.fonts && document.fonts.ready.then(thumbs);

function renderLobby() {
  press($('#side'), C.side); press($('#stake'), C.stake);
  body.dataset.side = C.side; thumbs();
  for (const [id, c] of Object.entries(chip)) c.b.setAttribute('aria-pressed', String(id === C.asset));
  api.focus(C.asset);
  api.prepare({ side: C.side, stake: C.stake });     // encrypt the pick now, so the click only sends it
  $('#lobbyHint').textContent = STAIRS ? 'You hold real tokens, 4x your stake. The coin rolls on the live price, moves count ×' + (byId[C.asset].boost || 25) + ' on this market, the game leverage grows every 6 seconds. Side and stake stay encrypted.' : 'Climb at your own pace. The coin steps up every 6 seconds.';
  renderGo();
}
function renderGo() {
  if (screen !== 'lobby') return;
  const go = $('#go'), meta = $('#goMeta');
  const open = api.marketOpen(C.asset);
  go.disabled = busy || !open;
  go.textContent = busy ? 'Starting…' : !open ? 'Market closed' : !canPay(C.stake) ? 'Get test cUSDC' : 'Start climbing';
  meta.textContent = open ? `${C.stake} cUSDC on ${label(byId[C.asset])} ${C.side}, up to 4x, encrypted on chain` : `${label(byId[C.asset])} (${byId[C.asset].name}) has no live price right now. Pick another market`;
}

$('#go').onclick = async () => {
  if (busy) return;
  sound.unlock();
  if (!(await connect(true))) return;
  if (!canPay(C.stake)) { try { await api.faucet(); toast('+1,000 test cUSDC'); } catch (e) { toast(e.message); } return; }
  busy = true; renderGo();
  try { const r = await api.startRun({ assetId: C.asset, side: C.side, stake: C.stake }); enterGame(r); }
  catch (e) { toast(e.message); }
  finally { busy = false; renderGo(); }
};

// ── game
const ladderEl = $('#ladder');
let rungs = [];
function buildLadder(l) {
  ladderEl.innerHTML = l.map(x => `<li><i></i><span>${levTxt(x)}</span></li>`).join('');
  rungs = [...ladderEl.children];
  // the side gauge: every level from 1x at the bottom to the max at the top
  const n = l.length - 1;
  $('#gTicks').innerHTML = l.map((x, i) => `<li style="bottom:${(i / n * 100).toFixed(2)}%"><span>${levTxt(x)}</span></li>`).join('');
  gTicks = [...$('#gTicks').children];
}
let gTicks = [];
function gaugeFrame(tr) {
  const n = run.ladder.length - 1, k = shownStep, last = k >= n;
  const p = last ? 0 : (tr % run.stepEvery) / run.stepEvery;
  const f = Math.min(1, (k + p) / n);
  $('#gFill').style.transform = `scaleY(${f.toFixed(4)})`;
  $('#gKnob').style.bottom = (k / n * 100).toFixed(2) + '%';        // the cursor sits on the current level, the bar fills toward the next
  $('#gNow').textContent = levTxt(run.ladder[k]);
  gTicks.forEach((li, i) => { li.classList.toggle('is-done', i < k); li.classList.toggle('is-now', i === k); });
  $('#gNext').textContent = last ? 'Max leverage' : `Next ${levTxt(run.ladder[k + 1])} in ${Math.max(1, Math.ceil(run.stepEvery * (1 - p)))}s`;
}
function enterGame(r) {
  if (!r || run) return;
  run = r; upd = null; shownStep = 0; ended = null;
  $('#gBoost').textContent = `×${byId[r.assetId]?.boost || 25}`;
  Object.assign(D, { value: r.stake, pnl: 0, pct: 0, danger: 0 });
  if (sc && (!G || G.end)) park();                    // normally the coin is already parked from the lobby
  if (G) { G.steps = []; G.dangerTo = 0; G.end = null; G.go = (performance.now() - G.t0) / 1000; }
  if (STAIRS) startTrack(r);
  const a = byId[r.assetId];
  $('#hT').textContent = label(a); $('#hN').textContent = a.name; $('#hSide').textContent = r.side === 'long' ? 'Long' : 'Short'; $('#hSide').className = 'pill is-' + r.side;
  buildLadder(r.ladder); rungs[0].classList.add('is-now');
  spark.entry = r.entryPrice; spark.asset = r.assetId;
  setScreen('game');
  sound.start(); haptic(10);
  api.onRun(r.id, onUpdate);
  api.whenEnded(r.id).then(onEnd);
}
function onUpdate(u) {
  if (!run) return;
  const info = api.runInfo(run.id);
  if (info) run.startedAt = info.startedAt;              // optimistic start: the chain's start time snaps in when mined
  run.entryPrice = spark.entry = runEntry();             // the chain's entry price snaps in when mined
  if (TK) lvl.entry = run.entryPrice;
  upd = u;
  if (u.step > shownStep && u.status === 'live') {
    for (let s = shownStep + 1; s <= u.step; s++) G?.steps.push((performance.now() - G.t0) / 1000);
    shownStep = u.step;
    rungs.forEach((li, i) => { li.classList.toggle('is-done', i < u.step); li.classList.toggle('is-now', i === u.step); });
    const li = rungs[u.step]; li.classList.remove('is-hit'); void li.offsetWidth; li.classList.add('is-hit');
    sound.step(u.step); haptic(14);
    const kn = $('#gKnob'); kn.classList.remove('is-hit'); void kn.offsetWidth; kn.classList.add('is-hit');
  }
  if (G) G.dangerTo = u.risk > 0.3 ? Math.min(1, (u.risk - 0.3) / 0.6) : 0;
  if (TK) { TK.dangerTo = u.risk > 0.3 ? Math.min(1, (u.risk - 0.3) / 0.6) : 0; levelFrom(); }
}
function runEntry() { const i = api.runInfo(run.id); return i ? i.entryPrice : run.entryPrice; }

const ringV = $('#ringV'), RING = 2 * Math.PI * 28;
function hudFrame(dt) {
  if (!run) return;
  const u = upd, k = 1 - Math.exp(-dt * 10);
  if (u) { D.value += (u.value - D.value) * k; D.pnl += (u.pnl - D.pnl) * k; D.pct += (u.pnlPct - D.pct) * k; D.danger += (u.risk - D.danger) * k; }
  $('#pV').textContent = signed(D.pnl);
  $('.pnl').classList.toggle('is-up', D.pnl > 0.005);
  $('#pP').textContent = pct(D.pct);
  $('#pL').textContent = levTxt(run.ladder[shownStep]);
  $('#cashV').textContent = money(Math.max(0, upd ? upd.value : D.value));   // the exact value a click freezes (the big number eases)
  $('#bV').textContent = money(u && u.borrowed != null ? u.borrowed : 0);
  if (u && u.qty != null) $('#bQ').textContent = `${u.qty.toFixed(u.qty < 1 ? 4 : 2)} ${label(byId[run.assetId])}`;
  $('#bS').textContent = run.side === 'short' ? 'Short' : 'Holding';
  const left = Math.max(0, 1 - D.danger);
  $('#sBar').style.transform = `scaleX(${left})`;
  $('#sTxt').textContent = D.danger < 0.02 ? 'Stake safe' : `${Math.round(left * 100)}% of stake left`;
  const sf = $('#sBar').parentElement.parentElement;
  sf.classList.toggle('is-warn', D.danger >= 0.3 && D.danger < 0.6); sf.classList.toggle('is-hot', D.danger >= 0.6);
  // clock + next step progress, from the run's own clock
  const tr = Math.min(run.duration, Math.max(0, (Date.now() - run.startedAt) / 1000));
  if (screen === 'game') {
    $('#clock').textContent = mmss(run.duration - tr);
    ringV.style.strokeDashoffset = String(RING * (tr / run.duration));
    $('.hud__clock').classList.toggle('is-late', run.duration - tr <= 10);
    const next = rungs[shownStep + 1];
    rungs.forEach((li, i) => li.style.setProperty('--p', i === shownStep + 1 ? ((tr % run.stepEvery) / run.stepEvery).toFixed(3) : 0));
    if (!next) rungs.forEach(li => li.style.setProperty('--p', 0));
    gaugeFrame(tr);
    const p = u ? u.price : run.entryPrice, ch = (p / run.entryPrice - 1) * 100;
    $('#hP').textContent = livePrice(p); const bst = byId[run.assetId]?.boost; $('#hC').textContent = pct(ch) + ' since entry' + (bst ? ` · moves ×${bst}` : '');
  }
}

async function cash() {
  if (screen !== 'game' || !run || ended) return;
  $('#cash').disabled = true;
  try { await api.cashOut(run.id); } catch (e) { toast(e.message); $('#cash').disabled = false; }
}
$('#cash').onclick = cash;
addEventListener('keydown', e => {
  if (e.code === 'Space' && screen === 'game' && !e.repeat && !document.querySelector('.sheet:not([hidden])')) { e.preventDefault(); cash(); }
  if (e.key === 'Escape') closeSheet();
});

function onEnd(res) {
  if (ended) return;
  ended = res;
  const bust = res.status === 'busted';
  if (G) G.end = { type: bust ? 'bust' : 'cash', at: (performance.now() - G.t0) / 1000 };
  if (TK) sc.trackEnd(TK, bust ? 'bust' : 'cash');
  setScreen('ending');
  if (bust) { sound.bust(); haptic([30, 40, 60]); } else { sound.cash(); haptic([12, 30, 12]); }
  showResult(res);
  card = null; wantCard = true; hideTip();
  // stairs: the result waits for the scene (the box has pushed the coin, or the coin has fallen), wherever it ended
  // the result comes up fast; on chain it says "settling" until the payout is confirmed
  if (TK) setTimeout(() => { if (screen === 'ending') setScreen('result'); }, api.mode === 'chain' ? 1500 : 4000);
  else setTimeout(() => setScreen('result'), bust ? 1250 : 1350);
  if (res.pending && res.status !== 'failed') {
    const id = run.id;
    api.whenSettled(id).then(f => { if (run && run.id === id) settled(f); }).catch(() => {});
  }
}
// the value frozen at the cash out, re-checked against the exact path, before the chain answers
api.onRefine((id, r) => { if (run && run.id === id && ended && !ended.chain) { ended = { ...ended, ...r }; showResult(ended); } });
// the chain's verdict replaces the screen's estimate (same rules, oracle checkpoints)
function settled(f) {
  ended = { ...ended, ...f };
  showResult(f);
  const rr = $('#rR'); rr.hidden = false;
  const tx = f.tx ? ` <a href="https://sepolia.etherscan.io/tx/${f.tx}" target="_blank" rel="noopener">View the transaction</a>` : '';
  rr.innerHTML = `<b>Settled on chain.</b> Paid ${money(f.value)} cUSDC as an encrypted transfer.${tx} <button class="linkish" id="publish">Post to the leaderboard</button>`;
  const pb = $('#publish');
  if (pb) pb.onclick = async () => {
    pb.disabled = true; pb.textContent = 'Revealing your return through the KMS…';
    try { await api.publishRun(f.runId); pb.textContent = 'Posted: return public, stake still private'; } catch (e) { pb.disabled = false; pb.textContent = 'Post to the leaderboard'; toast(e.message); }
  };
  card = null; wantCard = false; if (sc && screen === 'result') makeCard(grabScene());
  if (openSheetEl && openSheetEl.id === 'shareSheet') refreshShare();
}
function showResult(res) {
  const bust = res.status === 'busted';
  $('#rE').textContent = res.status === 'failed' ? 'Start failed, nothing was staked' : bust ? 'The coin fell' : res.status === 'expired' ? "Time's up, cashed out" : 'Cashed out';
  $('#rV').innerHTML = `${signed(res.pnl)}<small> cUSDC</small>`;
  const m = byId[run.assetId]; $('#rM').innerHTML = `<b>${label(m)}</b><span class="pill is-${run.side}">${run.side === 'short' ? 'Short' : 'Long'}</span>`;
  $('.result').classList.toggle('is-win', res.pnl > 0.005);
  const a = byId[run.assetId];
  const stats = [['Return', pct(res.pnlPct)], ['Top leverage', levTxt(res.maxLeverage)], ['Time', `${Math.max(1, Math.round(res.duration))}s`],
    [`${label(a)} entry → exit`, `${price(res.entryPrice)} → ${price(res.exitPrice)}`]];
  // the payout = the real position (tokens bought or borrowed at the real price) + the game boost (moves x the market's boost)
  if (res.position != null) stats.push([`Real position (${res.qty != null ? `${res.qty.toFixed(res.qty < 1 ? 4 : 2)} ` : ''}${res.token || label(a)})`, `${money(res.position)} cUSDC`],
    [`Game boost (moves ×${byId[run.assetId]?.boost || 25})`, `${signed(res.boost)} cUSDC`]);
  if (res.interest != null) stats.push(['Borrowed', `${money(res.borrowed || 0)} cUSDC`], ['Interest paid', `${tiny(res.interest)} cUSDC`]);
  $('#rS').innerHTML = stats.map(([k, v], i) => `<div${i ? '' : ` class="is-key${res.pnlPct > 0.005 ? ' is-up' : ''}"`}><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const rr = $('#rR'); rr.hidden = !res.pending;
  if (res.status === 'failed') rr.innerHTML = 'The start transaction did not go through, so your stake never left your account.';
  else if (res.pending) rr.innerHTML = 'Settling on chain: encrypted payout…';
}
$('#again').onclick = () => {
  hideTip();
  const wash = $('#wash'); wash.classList.add('is-on');
  setTimeout(() => {
    run = null; upd = null; ended = null; $('#cash').disabled = false;
    if (TK) { idleT = (TK.dist / sc.SPEED) % sc.LOOP; TK = null; }
    park(0.32);                                       // back on a box, the coin hops as the wash lifts
    setScreen('lobby'); renderLobby();
    requestAnimationFrame(() => wash.classList.remove('is-on'));
  }, 430);
};
// ── share: a picture of the end of the run (coin in the middle, result over it) goes with the post
// the scene is drawn once more at card size, in the same frame, so the picture is sharp on every screen
function grabScene() {
  const c = document.createElement('canvas'); c.width = CARD.w; c.height = CARD.h;
  const keep = [sc.L.DOLLY, sc.L.FOLLOW_T];
  try {
    sc.L.DOLLY = 0.55; sc.L.FOLLOW_T = 0.75;          // same framing on every device (phones keep the camera further back)
    sc.setSize(CARD.w, CARD.h, 1, { aspect: 16 / 9, x: 0.5, y: 0.5 }); repose(); sc.draw();
    c.getContext('2d').drawImage(sc.canvas, 0, 0, CARD.w, CARD.h);
  } catch { return null; }
  finally { [sc.L.DOLLY, sc.L.FOLLOW_T] = keep; sc.setSize(innerWidth, innerHeight, dpr(), cover()); repose(); sc.draw(); }
  return c;
}
async function makeCard(scene) {
  const r = ended, mine = run; if (!r || !mine) return;
  const a = byId[mine.assetId], bust = r.status === 'busted';
  const d = {
    eyebrow: bust ? 'The coin fell' : r.status === 'expired' ? "Time's up, cashed out" : 'Cashed out',
    value: signed(r.pnl), unit: 'cUSDC', win: r.pnl > 0.005,
    side: mine.side, ticker: label(a), logo: await loadLogo('assets/brand/sirocco-mark-safran.svg'),
    stats: [['Stake', `${money(mine.stake)} cUSDC`], ['Return', pct(r.pnlPct)], ['Top leverage', levTxt(r.maxLeverage)], ['Entry', price(r.entryPrice)], ['Exit', price(r.exitPrice)], ['Time', `${Math.max(1, Math.round(r.duration))}s`]],
  };
  const blob = await toBlob(drawCard(scene, d));
  if (ended !== r || !blob) return;
  card = { blob, src: URL.createObjectURL(blob), page: null };
  api.shareCard(blob, r).then(u => { if (card && card.blob === blob) card.page = u; }).catch(() => {});
}
// the post: the result, a punchy line, then what made it private (Zama's handle is @zama, from zama.org).
// v: the run as the chain has it (from /api/share), or the screen's result when there is no chain run
function shareText(o = {}) {
  const v = o.run, a = byId[run.assetId], r = v || ended;
  const side = v ? (o.side && v.side) : (o.side !== false && run.side);
  const on = `${side ? ` going ${side}` : ''} on ${label(a)}`;
  const zama = v ? "My stake stayed encrypted on-chain with @zama's FHE, confidential tokens (ERC-7984); the result is verified on Sepolia."
    : "My side and stake stayed encrypted on-chain with @zama's FHE, confidential tokens (ERC-7984).";
  const text = r.status === 'busted'
    ? `My coin fell off the stairs at ${levTxt(r.maxLeverage)}${on} 🪙 Rematch incoming.\n\n${zama}\n\nCan you climb higher?`
    : r.pnlPct > 0.005 ? `Climbed to ${levTxt(r.maxLeverage)}${on} and cashed out ${pct(r.pnlPct)} 🪙📈\n\n${zama}\n\nYour turn on Siroclimb:`
    : `Cashed out at ${levTxt(r.maxLeverage)}${on} (${pct(r.pnlPct)}) before the stairs gave way 🪙\n\n${zama}\n\nYour turn on Siroclimb:`;
  const url = o.url || (card && card.page) || location.origin + location.pathname.replace(/(play|index)\.html$/, '');
  return { text, url };
}
const intent = ({ text, url }) => 'https://x.com/intent/post?' + new URLSearchParams({ text, url }).toString();

// ── share sheet: the server reads the finished run on chain and renders the card (api/share, api/og).
//    Only a published return can be shared: the sheet offers to publish it (KMS public decryption) first.
const sh = { seq: 0, link: null };
const shEl = { card: $('#shCard'), img: $('#shImg'), side: $('#shSide'), dl: $('#shDl'), x: $('#shX'), copy: $('#shCopy'), veil: $('#shVeil'), veilT: $('#shVeilT'), pub: $('#shPub') };
shEl.side.checked = store.get('shareSide', true);
const shareable = () => ended && run && ended.status !== 'failed';
const chainRunId = () => (api.mode !== 'chain' ? null : ended?.chain ? ended.runId : (run && api.runInfo(run.id)?.chainId) ?? sh.runId ?? null);
function veil(text, button = false) {
  shEl.veil.hidden = !text; shEl.veilT.textContent = text || ''; shEl.pub.hidden = !button;
  [shEl.dl, shEl.x].forEach(a => a.setAttribute('aria-disabled', 'true'));
}
async function signShare(runId) {
  const res = await fetch('/api/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: Number(runId), showSide: shEl.side.checked, atBlock: sh.atBlock || undefined }) });
  const b = await res.json().catch(() => ({}));
  if (res.status === 409) return { unpublished: true };
  if (!res.ok) throw Object.assign(new Error(b.error || 'Share links unavailable'), { status: res.status });
  return b;
}
async function refreshShare() {
  if (!shareable()) return;
  const n = ++sh.seq, id = chainRunId();
  if (id == null) { closeSheet(true); legacyShare(); return; }          // simulation: the picture drawn in the browser
  shEl.card.classList.add('is-loading'); [shEl.dl, shEl.x].forEach(a => a.setAttribute('aria-disabled', 'true'));
  if (!ended.chain) { veil('Settling on chain. The card is read from the settled run…'); shEl.card.classList.remove('is-loading'); return; }
  try {
    const l = await signShare(id); if (n !== sh.seq) return;
    if (l.unpublished) { shEl.card.classList.remove('is-loading'); veil('Your return is still encrypted. Publishing it decrypts it publicly (Zama KMS proof, one transaction), then the card can show it.', true); return; }
    sh.link = l; veil(null);
    await new Promise(res => { shEl.img.onload = shEl.img.onerror = res; shEl.img.src = l.image; });
    if (n !== sh.seq) return;
    shEl.dl.href = l.image; shEl.dl.download = `siroclimb-${label(byId[run.assetId])}.png`;
    shEl.x.href = intent(shareText({ url: l.url, run: l.run, side: shEl.side.checked }));
    sh.file = null;
    if (phoneShare) {                                   // the PNG ready before the tap (sharing needs the tap's activation)
      fetch(l.image).then(r => (r.ok ? r.blob() : null)).then(b => {
        if (!b || n !== sh.seq) return;
        const f = new File([b], `siroclimb-${label(byId[run.assetId])}.png`, { type: 'image/png' });
        if (navigator.canShare({ files: [f] })) sh.file = f;
      }).catch(() => {});
    }
    [shEl.dl, shEl.x].forEach(a => a.removeAttribute('aria-disabled'));
    shEl.card.classList.remove('is-loading');
  } catch (e) {
    if (n !== sh.seq) return;
    shEl.card.classList.remove('is-loading');
    if (e.status == null || e.status === 503) { closeSheet(true); legacyShare(); return; }   // no share server (static hosting)
    veil(e.message);
    // just settled: the share server's node may be a block behind, ask again shortly
    if (e.status === 404 || e.status === 502) { sh.retries = (sh.retries || 0) + 1; if (sh.retries <= 20) setTimeout(() => { if (n === sh.seq && openSheetEl?.id === 'shareSheet') refreshShare(); }, 3000); }
  }
}
shEl.pub.onclick = async () => {
  const id = sh.runId ?? chainRunId(); if (id == null) return;
  shEl.pub.disabled = true; veil('Publishing your return: one transaction, then the KMS proof…');
  try {
    const pub = await api.publishRun(id);
    sh.atBlock = pub && pub.block ? pub.block : null;          // the share server reads the chain as of the record
    // the share server reads the chain on its own node, which may be a block behind: wait for it to see the record
    veil('Published. Building your card from the chain…');
    for (let i = 0; i < 24 && (await signShare(id).catch(() => ({}))).unpublished; i++) await new Promise(r => setTimeout(r, 2500));
    await refreshShare();
  }
  catch (e) { veil(`Could not publish: ${e.message}`, true); }
  finally { shEl.pub.disabled = false; }
};
shEl.side.addEventListener('change', () => { store.set('shareSide', shEl.side.checked); sound.tick(); refreshShare(); });
// phones: the native share sheet with the card's PNG, the text and the link (X, Messages, anywhere);
// desktop: the X intent, whose link unfolds into the same card
const phoneShare = matchMedia('(pointer: coarse)').matches && !!navigator.canShare && !!window.File;
shEl.x.addEventListener('click', async e => {
  sound.tick();
  if (sh.file && sh.link) {
    e.preventDefault();
    const { text, url } = shareText({ url: sh.link.url, run: sh.link.run, side: shEl.side.checked });
    try { await navigator.share({ files: [sh.file], text: `${text}\n${url}` }); closeSheet(); return; }
    catch (err) { if (err.name === 'AbortError') return; }
    openTab(shEl.x.href);   // share refused: the intent
  }
  setTimeout(closeSheet, 300);
});
shEl.copy.onclick = async () => { if (!sh.link) return; try { await navigator.clipboard.writeText(sh.link.url); toast('Link copied'); } catch { toast(sh.link.url); } };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
let tipT = 0;
function showTip(copied, href) {
  const t = $('#sharetip');
  $('#tipImg').src = card ? card.src : '';
  $('#tipDl').href = card ? card.src : '#';
  $('#tipMsg').innerHTML = copied ? `Picture copied. Press <kbd>${isMac ? '⌘' : 'Ctrl'}</kbd> <kbd>V</kbd> in your post to add it.` : 'Save the picture and add it to your post.';
  $('#tipX').href = href;
  t.hidden = false; requestAnimationFrame(() => t.classList.add('is-on'));
  clearTimeout(tipT); tipT = setTimeout(hideTip, 12000);
}
// a new tab for X, this one stays on the game: window.open with 'noopener' always returns null,
// so it can't tell a blocked popup; open it plain, cut the opener by hand, and only fall back to this tab when blocked
function openTab(href) { const w = window.open(href, '_blank'); if (w) { try { w.opener = null; } catch {} } else location.href = href; }
function hideTip() { const t = $('#sharetip'); t.classList.remove('is-on'); clearTimeout(tipT); tipT = setTimeout(() => { t.hidden = true; }, 300); }
$('#tipClose').onclick = hideTip;
$('#share').onclick = () => {
  if (!shareable()) return;
  sound.tick();
  sh.link = null; sh.retries = 0; sh.runId = null; shEl.img.removeAttribute('src');
  sh.runId = chainRunId();                           // the sheet keeps its run, whatever the screen does meanwhile
  openSheet('shareSheet'); refreshShare();
};
// fallback: the post is written, the picture drawn in the browser goes to the clipboard (desktop) or the share sheet (phones)
async function legacyShare() {
  if (!ended) return;
  const { text, url } = shareText(), href = intent({ text, url });
  if (card && card.page) { openTab(href); return; }
  const file = card && new File([card.blob], 'siroclimb.png', { type: 'image/png' });
  if (file && matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text: `${text}\n${url}` }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  let copied = false;
  if (card && navigator.clipboard && window.ClipboardItem) { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': card.blob })]); copied = true; } catch {} }
  window.open(href, '_blank', 'noopener');
  if (card) showTip(copied, href);
}

// ── sparkline: last 60 s, scrolls smoothly, entry line while playing
const spark = { el: $('#spark'), entry: 0, asset: 'BTC' };
function drawSpark() {
  const c = spark.el; if (screen !== 'game' || !c.offsetWidth) return;
  const w = c.offsetWidth, h = c.offsetHeight, r = Math.min(devicePixelRatio || 1, 2);
  if (c.width !== w * r) { c.width = w * r; c.height = h * r; }
  const x = c.getContext('2d'); x.setTransform(r, 0, 0, r, 0, 0); x.clearRect(0, 0, w, h);
  const span = 45, pts = api.history(spark.asset, span + 1); if (pts.length < 2) return;
  const now = Date.now();
  let lo = Infinity, hi = -Infinity; for (const p of pts) { lo = Math.min(lo, p.price); hi = Math.max(hi, p.price); }
  if (spark.entry) { lo = Math.min(lo, spark.entry); hi = Math.max(hi, spark.entry); }
  const pad = (hi - lo) * 0.15 || hi * 0.0005; lo -= pad; hi += pad;
  const X = ts => w - ((now - ts) / 1000 / span) * w, Y = p => h - ((p - lo) / (hi - lo)) * h;
  x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(X(p.ts), Y(p.price)) : x.moveTo(X(p.ts), Y(p.price))));
  const lp = pts[pts.length - 1]; x.lineTo(w, Y(lp.price));
  x.lineWidth = 1.6; x.strokeStyle = '#fff'; x.lineJoin = 'round'; x.stroke();
  x.lineTo(w, h); x.lineTo(X(pts[0].ts), h); x.closePath();
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fill();
  if (spark.entry) { x.setLineDash([3, 4]); x.strokeStyle = 'rgba(242,201,76,.95)'; x.lineWidth = 1.2; x.beginPath(); x.moveTo(0, Y(spark.entry)); x.lineTo(w, Y(spark.entry)); x.stroke(); x.setLineDash([]); }
  x.fillStyle = '#fff'; x.beginPath(); x.arc(w - 2.5, Y(lp.price), 2.5, 0, Math.PI * 2); x.fill();
}

// ── sheets
let openSheetEl = null, lastFocus = null;
function openSheet(id) {
  closeSheet(true);
  const el = document.getElementById(id); el.hidden = false; openSheetEl = el; lastFocus = document.activeElement;
  el.querySelector('.sheet__card').focus({ preventScroll: true });
  if (id === 'board') loadBoard(store.get('board', 'today') === 'all' ? 'all' : 'today');
  if (id === 'reserve') loadReserve();
}
function closeSheet(now) {
  const el = openSheetEl; if (!el) return; openSheetEl = null;
  if (id(el) === 'rules') store.set('seenRules', true);
  if (now === true || reduce) { el.hidden = true; return; }
  el.classList.add('is-closing');
  setTimeout(() => { el.hidden = true; el.classList.remove('is-closing'); lastFocus?.focus?.({ preventScroll: true }); }, 220);
}
const id = el => el.id;
document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openSheet(b.dataset.open); }));
document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s || e.target.closest('[data-close]')) closeSheet(); }));
$('#boardTabs').querySelectorAll('button').forEach(b => b.onclick = () => loadBoard(b.dataset.v));
async function loadBoard(scope) {
  store.set('board', scope);
  $('#boardTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.v === scope)));
  const list = await api.leaderboard(scope);
  $('#boardList').innerHTML = list.length ? list.slice(0, 10).map((s, i) =>
    `<li class="${s.you ? 'is-you' : ''}"><span class="n">${i + 1}</span><span>${s.you ? 'You' : s.name}</span><span class="v">${pct(s.pnlPct)}</span></li>`).join('')
    : `<li class="empty">No run posted yet. Cash out, then post your return.</li>`;
}

// ── Sirocco Reserve: public synced figures, the player's own position, deposit and withdraw
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return !ms ? 'never' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
async function loadReserve(atBlock = null) {
  const stats = $('#rvStats'), me = $('#rvMe');
  if (api.account()) me.innerHTML = '<i class="mini-spin" aria-hidden="true"></i>Decrypting your position…';
  try {
    const r = await api.reserveStats();
    stats.innerHTML = [['Total value locked, cUSDC', money(r.tvl)], ['Utilization', `${(r.utilization * 100).toFixed(1)}%`], ['Share price, cUSDC', r.sharePrice.toFixed(6)],
      ['APY', r.apyPct == null ? `${pct(r.returnPct)} so far` : pct(r.apyPct)], ['Borrow APR', `${r.aprPct.toFixed(0)}%`], ['Interest earned, cUSDC', tiny(r.interestEarned)],
      ['In live runs, cUSDC', money(r.locked)], ['Open loans', String(r.openLoans)], ['Last reveal', r.syncPending ? 'in progress' : ago(r.syncedAt)]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  } catch (e) { stats.innerHTML = `<div><dt>Reserve</dt><dd>unavailable</dd></div>`; }
  if (!api.account()) { me.textContent = 'Connect to see it'; return; }
  try { const p = await api.reservePosition(atBlock); me.textContent = p ? `${money(p.value)} cUSDC (${money(p.shares)} shares)` : '—'; }
  catch { me.innerHTML = 'Could not decrypt. <button class="share__copy" id="rvRetry">Retry</button>'; $('#rvRetry').onclick = () => loadReserve(atBlock); }
}
async function reserveAction(kind) {
  const amt = Number($('#rvAmt').value);
  if (!(amt > 0)) { toast('Enter an amount in cUSDC'); return; }
  if (!(await connect(true))) return;
  const btns = [$('#rvDep'), $('#rvWd')]; btns.forEach(b => (b.disabled = true));
  let block = null;
  try {
    if (kind === 'deposit') { const r = await api.reserveDeposit(amt); block = r?.block ?? null; toast(`Deposited ${money(amt)} cUSDC, encrypted`); }
    else { const r = await api.reserveWithdraw(amt); block = r?.block ?? null; toast(r && r.out === 0 ? 'Not withdrawn: not enough shares, or the cash is lent to live runs' : `Withdrew ${money(r?.out ?? amt)} cUSDC`); }
    $('#rvAmt').value = '';
  } catch (e) { toast(e.message); }
  finally { btns.forEach(b => (b.disabled = false)); loadReserve(block); }
}
$('#rvDep').onclick = () => reserveAction('deposit');
$('#rvWd').onclick = () => reserveAction('withdraw');

// ── resize, boot
addEventListener('resize', () => { if (sc) sc.setSize(innerWidth, innerHeight, dpr(), cover()); });
document.addEventListener('visibilitychange', () => { last = performance.now(); });

(async function boot() {
  await api.init();
  renderWallet(); renderBalance(); renderLobby();
  const start = () => { if (sc || reduce) return; initScene(); if (!sc) $('#wash').classList.remove('is-on'); };
  if (reduce) $('#wash').classList.remove('is-on');
  if (screen !== 'intro' || film.readyState >= 2) start(); else film.addEventListener('loadeddata', start, { once: true });
  setTimeout(start, screen === 'intro' ? 2500 : 0);           // film blocked or slow: start anyway
  if (screen !== 'intro') { film.pause(); syncing = false; maybeRules(1200); }
  requestAnimationFrame(frame);
  setInterval(() => { if (screen === 'lobby') renderGo(); }, 250);
  resume();
})();

// a reload during a run: the climb goes on where it is (or its result shows, if it ended meanwhile)
async function resume() {
  const got = await api.resumeRun().catch(() => null);
  if (!got) return;
  for (let i = 0; i < 40 && !sc && !reduce; i++) await new Promise(r => setTimeout(r, 100));   // the scene first
  if (screen === 'intro') { history.replaceState(null, '', '#play'); toLobby(); }
  if (got.result) {
    enterGame(got.run);                                // its end is already known: the result follows at once
    setTimeout(() => { if (run && ended) settled(got.result); }, 600);
    toast('Your last run ended while you were away: here is its result');
  } else {
    enterGame(got.run);
    toast('Your run is back: the climb goes on');
  }
}

// ── landing → lobby: one page, one scene. The copy steps aside, the belt brakes, the coin settles on its box
//    and hops once (one full turn), then the bar and the lobby rise over the very same shot.
function maybeRules(ms) { if (!store.get('seenRules', false)) setTimeout(() => { if (screen === 'lobby') openSheet('rules'); }, ms); }
function toLobby() {
  if (screen !== 'intro') return;
  sound.unlock(); sound.tick();
  body.classList.add('from-intro');
  syncing = false;
  if (sc && live) { film.pause(); park(0.06, false); }
  setScreen('lobby'); renderLobby();
  setTimeout(() => body.classList.remove('from-intro'), 2200);
  maybeRules(2000);
}
$('#startPlaying').addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
  e.preventDefault();
  history.pushState(null, '', '#play');
  toLobby();
});
// back button: from the lobby, return to the landing (the belt rolls again under a quick wash)
addEventListener('popstate', () => {
  if (location.hash === '#play') { if (screen === 'intro') toLobby(); return; }
  if (screen !== 'lobby') { history.pushState(null, '', '#play'); return; }
  closeSheet(true);
  const wash = $('#wash'); wash.classList.add('is-on');
  setTimeout(() => { G = null; setScreen('intro'); requestAnimationFrame(() => wash.classList.remove('is-on')); }, 430);
});

// ── stairs game: the path follows the price. One step = a typical half-second move of this market,
//    measured from its own recent ticks, so calm and wild markets both climb at a readable pace.
const lvl = { level: 0, q: 0.0015, entry: 0, sign: 1 };
function stepSize(assetId) {
  const h = api.history(assetId, 60); if (h.length < 10) return 0.0015;
  const t0 = h[0].ts, t1 = h[h.length - 1].ts, px = []; let j = 0;
  for (let t = t0; t <= t1; t += 500) { while (j < h.length - 1 && h[j + 1].ts <= t) j++; px.push(h[j].price); }
  const r = []; for (let i = 1; i < px.length; i++) r.push(Math.log(px[i] / px[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  return Math.max(1e-5, sd * 1.4);
}
/// The typical size of one price change of this market (median of its recent non-zero quote changes).
function typicalMove(assetId) {
  const h = api.quotes(assetId, 90), r = [];
  for (let i = 1; i < h.length; i++) if (h[i].price !== h[i - 1].price) r.push(Math.abs(Math.log(h[i].price / h[i - 1].price)));
  if (r.length < 5) return 0;
  r.sort((a, b) => a - b);
  return r[Math.floor(r.length / 2)];
}
// counters for the stairs check (tests/chain/stairs.mjs): visible steps, and real quote changes
const stairs = window.__stairs = { steps: 0, quotes: 0, last: null, sizes: {}, moves: [] };
function countQuote() {
  const q = run && api.quote(run.assetId);
  if (q != null && q !== stairs.last) { if (stairs.last != null) stairs.quotes++; stairs.last = q; }
}
// Every price change is a step in its own direction (up when it goes the player's way), sized by the move in
// this market's typical tick, on a log scale: an ordinary tick is one step, twice that three, four times five,
// eight times or more seven (taller walls hid the coin).
// Purely visual: the climb's value, the bust and the payout come from the chain.
const MAX_STEP = 7;
const stepsFor = size => Math.max(1, Math.min(MAX_STEP, 1 + Math.round(2 * Math.log2(Math.max(1, size)))));
function levelFrom() {
  countQuote();
  const q = api.quote(run.assetId); if (!(q > 0)) return;
  if (lvl.lastQ == null) { lvl.lastQ = q; return; }
  if (q === lvl.lastQ) return;                                   // unchanged: the stairs stay flat
  const mv = lvl.sign * Math.log(q / lvl.lastQ); lvl.lastQ = q;
  if (!mv) return;
  if (!lvl.tick) lvl.tick = Math.abs(mv);                        // no history yet: the first change is the unit
  const n = Math.sign(mv) * stepsFor(Math.abs(mv) / lvl.tick);
  lvl.level += n;
  stairs.moves.push({ t: Date.now(), mv, n, level: lvl.level, r: +(Math.abs(mv) / lvl.tick).toFixed(2) }); if (stairs.moves.length > 400) stairs.moves.shift();
}
function startTrack(r) {
  if (!sc || !G) return;
  lvl.level = 0; lvl.entry = r.entryPrice; lvl.sign = r.side === 'short' ? -1 : 1; lvl.q = stepSize(r.assetId); lvl.lastQ = api.quote(r.assetId) ?? null; lvl.tick = typicalMove(r.assetId);
  TK = sc.createTrack(G.plan); TK.dangerTo = 0;
  G = null;
  TK.onStep = (n, big) => {
    stairs.steps++; stairs.sizes[n] = (stairs.sizes[n] || 0) + 1;
    bubble(n, big);
    if (big) { (n > 0 ? sound.cash : sound.drop)(); haptic(n > 0 ? [10, 20, 10] : 26); }
    else { (n > 0 ? sound.up : sound.down)(lvl.level); haptic(8); }
  };
}

// floating "+1" / "−2" over the coin on each step
const bubbles = [];
function bubble(n, big) {
  const el = document.createElement('span');
  el.className = 'bubble' + (n > 0 ? ' is-up' : ' is-down') + (big ? ' is-big' : '');
  el.textContent = (n > 0 ? '+' : '−') + Math.abs(n);
  $('.hud').appendChild(el);
  bubbles.push({ el, t: performance.now() });
}
function bubbleFrame() {
  if (!bubbles.length) return;
  const p = sc.coinNDC(), x = (p.x + 1) / 2 * innerWidth, y = (1 - p.y) / 2 * innerHeight, now = performance.now();
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i], k = (now - b.t) / 750;
    if (k >= 1) { b.el.remove(); bubbles.splice(i, 1); continue; }
    const e = 1 - (1 - k) ** 3;
    b.el.style.transform = `translate(${x + 34}px, ${y - 40 - e * 46}px) translate(-50%, -50%) scale(${0.8 + 0.2 * Math.min(1, k * 5)})`;
    b.el.style.opacity = String(k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.55) / 0.45));
  }
}
