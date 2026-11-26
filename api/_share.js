// Share links: a finished run, verified on chain. The id only names the run and what the player chose to
// show (the side or not); every number on the card is read from the Siroclimb contract (api/_run.js):
// market, top leverage, time, entry and exit, and the return the player published with the KMS proof.
// Nothing the browser sends ends up on the card. The id is HMAC-signed with a server secret so links
// cannot be minted for runs whose player did not ask (the side flag is the player's choice).
//
// v4 id = y<runId>[s].<sig11>    the current game, short (the whole link stays under ~50 characters); a 66-bit
//                                 tag: guessing one takes ~2^65 requests to the server, out of reach
// v3 id = x<runId>[s].<sig>      the current game (older, 22-character tag), still read; s: show the side (inferred from the published return, _run.js)
// v2 id = r<runId>[s].<sig>      the game before real positions (LEGACY_GAME), still read there
// v1 ids (<market>_<status>_…, self-reported, before 2026-11-25) still open the game, with a generic card.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { LEGACY_GAME } from './_run.js';

function secret() {
  const s = process.env.SHARE_SECRET;
  if (s) return s;
  if (process.env.VERCEL_ENV === 'production') return null;
  return 'siroclimb-dev-only-share-secret';                       // local dev and previews without the variable
}
const mac = (payload, key, v = 'v2') => createHmac('sha256', key).update(`siroclimb-share:${v}:` + payload).digest('base64url').slice(0, v === 'v4' ? 11 : 22);

export function sign({ runId, showSide }) {
  const key = secret(); if (!key) throw new Error('SHARE_SECRET is not set');
  const payload = `y${runId}${showSide ? 's' : ''}`;
  return payload + '.' + mac(payload, key, 'v4');
}

/** id → { runId, showSide, legacyGame } (v3, v2), { legacy: true } (a valid v1 link), or null. */
export function verify(id) {
  const key = secret(); if (!key || typeof id !== 'string' || id.length > 160) return null;
  const dot = id.lastIndexOf('.'); if (dot < 0) return null;
  const payload = id.slice(0, dot), sig = Buffer.from(id.slice(dot + 1));
  const ok = v => { const want = Buffer.from(mac(payload, key, v)); return sig.length === want.length && timingSafeEqual(sig, want); };
  const m = /^([xyr])(\d{1,9})(s?)$/.exec(payload);
  if (m) return ok({ x: 'v3', y: 'v4', r: 'v2' }[m[1]]) ? { runId: Number(m[2]), showSide: m[3] === 's', legacyGame: m[1] === 'r' } : null;
  return payload.includes('_') && ok('v1') ? { legacy: true } : null;
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
export const fmt = {
  pct: v => (v < -0.0049 ? '−' : '+') + Math.abs(v).toFixed(2) + '%',
  lev: x => (x % 1 ? x.toFixed(1) : String(x)) + 'x',
  eyebrow: s => (s.status === 'busted' ? 'The coin fell' : s.status === 'expired' ? "Time's up, cashed out" : 'Cashed out'),
};
export function headline(s) {
  const on = `${s.token}${s.showSide && s.side ? ' ' + s.side : ''}`;
  return s.status === 'busted' ? `The coin fell at ${fmt.lev(s.maxLeverage)} on ${on}` : `${fmt.pct(s.pnlPct)} on ${on}, climbed to ${fmt.lev(s.maxLeverage)}`;
}

/** What a share id shows: { kind: 'run', run, showSide } (read from the chain), { kind: 'game' } (a v1
 *  link, or a run that is not there), or null for an id that is not ours. */
// pending: a signed run the node does not show published yet (just recorded, or a node a block behind):
// the generic card for now, never cached, so the run card replaces it on the next read
export async function resolve(id, verifiedRun, atBlock = null) {
  if (id === 'game') return { kind: 'game' };
  const v = verify(id);
  if (!v) return null;
  if (v.legacy) return { kind: 'game' };
  const run = await (v.legacyGame ? verifiedRun(v.runId, LEGACY_GAME) : verifiedRun(v.runId, undefined, atBlock)).catch(() => null);
  return run && run.published ? { kind: 'run', run: { ...run, showSide: v.showSide }, showSide: v.showSide } : { kind: 'game', pending: true };
}

// ?b=<block>: the block of the record, from the share route (a node behind it would not see it published)
export function blockOf(req) {
  const u = new URL(req.url, 'http://x'), b = Number(req.query?.b ?? u.searchParams.get('b'));
  return Number.isInteger(b) && b > 0 ? b : null;
}
