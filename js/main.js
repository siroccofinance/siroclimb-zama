// Siroclimb hero: the film plays first (instant), then the same scene takes over live in WebGL,
// in sync with the video so the handoff is invisible. "Start playing" brakes the belt, the box under
// the coin springs up and tosses it, the camera follows it into the terracotta, then the page changes.
import { createEscalatorScene } from './sirocco-escalator-scene.js?v=3';

const hero = document.querySelector('.hero');
const media = hero.querySelector('.hero__media');
const video = hero.querySelector('.hero__video');
const cta = hero.querySelector('.hero__cta');
const wash = document.querySelector('.wash');
const NEXT = cta.getAttribute('href');
const LEAVE_AT = 1.38;      // s after the click: the coin is alone, centred, mid-flip
const WASH_MS = 420;

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let s = null, live = false, syncing = true, t = 0, last = 0, plan = null, clickAt = 0, leaving = false;

const size = () => [hero.clientWidth, hero.clientHeight];
const cover = () => ({ aspect: 16 / 9, x: innerWidth < 768 ? 0.64 : 0.6, y: 0.3 });   // same crop as the video's object-position
const dpr = () => Math.min(devicePixelRatio || 1, 1.5);

function start() {
  if (reduce) return;
  try {
    const [w, h] = size();
    s = createEscalatorScene({ width: w, height: h, pixelRatio: dpr(), framing: 'site', theme: 'terracotta-gloss' });
  } catch (e) { s = null; return; }               // no WebGL: the film stays, the click still works
  if (innerWidth < 768) s.key.shadow.mapSize.set(2048, 2048);
  if (innerHeight > innerWidth) s.L.FOLLOW_T = 0.45;      // portrait: less headroom, the camera locks on sooner
  const c = s.canvas; c.className = 'hero__canvas'; c.setAttribute('aria-hidden', 'true');
  media.appendChild(c);
  s.setSize(...size(), dpr(), cover());
  t = video.currentTime || 0;
  last = performance.now();
  requestAnimationFrame(frame);
  // two drawn frames, then fade the live scene in over the (still synced) film
  let n = 0;
  const reveal = () => { if (++n < 3) return requestAnimationFrame(reveal); c.classList.add('is-live'); live = true;
    setTimeout(() => { syncing = false; video.pause(); }, 700); };
  requestAnimationFrame(reveal);
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (plan) {
    const tl = (now - clickAt) / 1000;
    s.launchPose(plan, tl);
    if (tl >= LEAVE_AT && !leaving) leave();
  } else {
    t = syncing && !video.paused ? video.currentTime : t + dt;   // locked to the film until it is hidden
    s.setTime(t % s.LOOP);
  }
  s.draw();
  requestAnimationFrame(frame);
}

function leave() {
  leaving = true;
  wash.classList.add('is-on');
  setTimeout(() => { location.href = NEXT; }, WASH_MS);
}

cta.addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // new tab: plain link
  e.preventDefault();
  if (plan || leaving) return;
  hero.classList.add('is-launching');
  if (!live) { leave(); return; }
  syncing = false;
  plan = s.planLaunch((t % s.LOOP) * s.SPEED, t % s.LOOP);
  clickAt = performance.now();
});

addEventListener('resize', () => { if (s) s.setSize(...size(), dpr(), cover()); });
// back button (bfcache): come back to the idle loop
addEventListener('pageshow', e => { if (!e.persisted) return; plan = null; leaving = false; hero.classList.remove('is-launching'); wash.classList.remove('is-on'); });

if (video.readyState >= 2) start(); else video.addEventListener('loadeddata', start, { once: true });
setTimeout(() => { if (!s && !reduce) start(); }, 2500);   // video blocked or slow: start anyway
