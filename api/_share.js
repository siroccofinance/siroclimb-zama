// Share links: a run result the player chose to reveal, packed into a short id and signed with a server
// secret (HMAC-SHA256), so a link cannot be edited into a better score. On Zama the side and the stake are
// encrypted on chain: the player decrypts their own result in the browser and picks what to show (the side
// and the cUSDC amount are optional). What the card shows is self-reported, decrypted by the player.
//
// id = <market>_<status>_<return, basis points>_<top leverage x10>_<seconds>_<pnl, cents | ''>_<side l|s | ''>.<sig>
//   e.g. TSLAx_c_1242_25_19_1227_l.Q2x...   status: c cashed out, e time's up, b the coin fell
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MARKETS } from './_markets.js';

const BY_ID = Object.fromEntries(MARKETS.map(m => [m.id, m]));
const STATUS = { c: 'cashed', e: 'expired', b: 'busted' };
const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };

function secret() {
  const s = process.env.SHARE_SECRET;
  if (s) return s;
  if (process.env.VERCEL_ENV === 'production') return null;
  return 'siroclimb-dev-only-share-secret';                       // local dev and previews without the variable
}
const mac = (payload, key) => createHmac('sha256', key).update('siroclimb-share:v1:' + payload).digest('base64url').slice(0, 22);

/** Result fields (from the browser) → normalized fields, or null when anything is off. */
export function normalize(b) {
  if (!b || typeof b !== 'object') return null;
  const m = BY_ID[b.market] ? b.market : null;
  const st = { cashed: 'c', expired: 'e', busted: 'b' }[b.status] || null;
  const r = int(Math.round(Number(b.pnlPct) * 100), -10000, 100000);   // −100 % .. +1000 %
  const l = int(Math.round(Number(b.maxLeverage) * 10), 10, 100);       // 1x .. 10x
  const d = int(Math.round(Number(b.duration)), 0, 3600);
  const p = b.pnl == null ? '' : int(Math.round(Number(b.pnl) * 100), -1e9, 1e9);
  const sd = b.side == null ? '' : ({ long: 'l', short: 's' }[b.side] ?? null);
  if (!m || !st || r == null || l == null || d == null || p == null || sd == null) return null;
  return { m, st, r, l, d, p, sd };
}

export function sign(n) {
  const key = secret(); if (!key) throw new Error('SHARE_SECRET is not set');
  const payload = [n.m, n.st, n.r, n.l, n.d, n.p, n.sd].join('_');
  return payload + '.' + mac(payload, key);
}

/** id → the result to show, or null when the id is malformed or the signature does not match. */
export function verify(id) {
  const key = secret(); if (!key || typeof id !== 'string' || id.length > 160) return null;
  const dot = id.lastIndexOf('.'); if (dot < 0) return null;
  const payload = id.slice(0, dot), sig = Buffer.from(id.slice(dot + 1)), want = Buffer.from(mac(payload, key));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  const [m, st, r, l, d, p, sd] = payload.split('_');
  const mk = BY_ID[m]; if (!mk || !STATUS[st]) return null;
  return {
    market: m, token: mk.token?.symbol || mk.ticker, name: mk.name, status: STATUS[st],
    pnlPct: Number(r) / 100, maxLeverage: Number(l) / 10, duration: Number(d),
    pnl: p === '' ? null : Number(p) / 100, side: sd === 'l' ? 'long' : sd === 's' ? 'short' : null,
  };
}

/** The share id of a request: ?id=, or the last path segment of /s/<id> (rewrites keep the original url). */
export function idOf(req) {
  if (req.query?.id) return String(req.query.id);
  const u = new URL(req.url, 'http://x');
  return u.searchParams.get('id') || decodeURIComponent(u.pathname.split('/').pop() || '').replace(/\.png$/, '');
}

export function origin(req) {
  const h = req.headers, host = String(h['x-forwarded-host'] || h.host || 'climb.sirocco.finance').split(',')[0].trim();
  const proto = String(h['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${host}`;
}

// ── wording, shared by the page and the card
const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt = {
  pct: v => (v < -0.0049 ? '−' : '+') + Math.abs(v).toFixed(2) + '%',
  amt: v => (v < -0.0049 ? '−' : '+') + nf.format(Math.abs(v)),
  lev: x => (x % 1 ? x.toFixed(1) : String(x)) + 'x',
  eyebrow: s => (s.status === 'busted' ? 'The coin fell' : s.status === 'expired' ? "Time's up, cashed out" : 'Cashed out'),
};
export function headline(s) {
  const on = `${s.token}${s.side ? ' ' + s.side : ''}`;
  return s.status === 'busted' ? `The coin fell at ${fmt.lev(s.maxLeverage)} on ${on}` : `${fmt.pct(s.pnlPct)} on ${on}, climbed to ${fmt.lev(s.maxLeverage)}`;
}
