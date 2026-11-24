// GET /api/og?id=<share id>: the 1200×630 result card (PNG) for X and other link previews.
// Rendered with satori (layout to SVG) and resvg (SVG to PNG): the 3D coin still, the result the player revealed, the Zama note.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { fmt, idOf, verify } from './_share.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = p => readFileSync(join(root, p));
const COIN = 'data:image/png;base64,' + file('assets/share/coin.png').toString('base64');
const MARK = 'data:image/svg+xml;base64,' + file('assets/brand/sirocco-mark-safran.svg').toString('base64');
const FONTS = [500, 600, 700].map(weight => ({ name: 'Inter', weight, style: 'normal', data: file(`assets/share/fonts/inter-latin-${weight}-normal.woff`) }));

const INK = '#fff', SOFT = 'rgba(255,255,255,.84)', MUTE = 'rgba(255,255,255,.62)', GOLD = '#ffe6a6', DARK = '#2b211a';
// tiny element helper: satori takes React-like objects
const h = (type, style, ...children) => ({ type, props: { style: { display: 'flex', ...style }, children: children.flat().filter(c => c != null && c !== false) } });
const img = (src, style) => ({ type: 'img', props: { src, style } });

function stat(k, v, extra = {}) {
  return h('div', { flexDirection: 'column', gap: 6 },
    h('div', { fontSize: 19, fontWeight: 500, color: MUTE, letterSpacing: 0.3 }, k),
    h('div', { fontSize: 30, fontWeight: 600, color: INK, ...extra }, v));
}

export function card(s) {
  const win = s.status !== 'busted' && s.pnlPct > 0.0049, hero = fmt.pct(s.pnlPct);
  const side = s.side
    ? h('div', { fontSize: 20, fontWeight: 700, letterSpacing: 1, color: '#fff', background: s.side === 'long' ? '#22c55e' : '#ef4444', padding: '6px 12px', borderRadius: 8, marginTop: 2 }, s.side.toUpperCase())
    : h('div', { fontSize: 20, fontWeight: 600, color: SOFT, border: '1.5px solid rgba(255,255,255,.4)', padding: '5px 12px', borderRadius: 8, marginTop: 2 }, 'Encrypted');
  return h('div', { width: 1200, height: 630, position: 'relative', flexDirection: 'column', fontFamily: 'Inter', color: INK, padding: '52px 64px 44px',
    backgroundImage: 'radial-gradient(circle at 76% 44%, #e57a45 0%, #c9592f 30%, #a8441f 62%, #7c2c12 100%)' },
    // the coin, with a warm glow behind it
    h('div', { position: 'absolute', left: 560, top: -10, width: 640, height: 640, borderRadius: 320, backgroundImage: 'radial-gradient(circle, rgba(255,214,150,.55) 0%, rgba(255,190,120,.18) 38%, rgba(255,170,100,0) 68%)' }),
    img(COIN, { position: 'absolute', left: 692, top: 68, width: 440, height: 471 }),
    // brand
    h('div', { alignItems: 'center', gap: 14 },
      img(MARK, { width: 40, height: 49 }),
      h('div', { fontSize: 34, fontWeight: 600, letterSpacing: -0.5 }, 'Siroclimb'),
      h('div', { fontSize: 17, fontWeight: 600, color: SOFT, border: '1.5px solid rgba(255,255,255,.38)', borderRadius: 8, padding: '4px 10px', marginLeft: 4 }, 'Zama · Sepolia')),
    // result
    h('div', { flexDirection: 'column', marginTop: 46, width: 620 },
      h('div', { fontSize: 24, fontWeight: 600, color: SOFT, alignItems: 'center', gap: 12 },
        h('span', { letterSpacing: 2.4, textTransform: 'uppercase' }, fmt.eyebrow(s)), h('span', { color: MUTE }, '·'), h('span', { color: INK }, s.token)),
      h('div', { fontSize: hero.length > 7 ? 112 : 132, fontWeight: 700, letterSpacing: -5.5, lineHeight: 1, marginTop: 12, color: win ? GOLD : INK }, hero),
      s.pnl != null ? h('div', { fontSize: 38, fontWeight: 600, marginTop: 14, color: win ? GOLD : SOFT, alignItems: 'baseline', gap: 10 }, fmt.amt(s.pnl), h('span', { fontSize: 26, fontWeight: 500, color: SOFT }, 'cUSDC')) : null),
    // stats and footer at fixed heights (satori resolves `bottom` against the content, not the 630 px frame)
    h('div', { position: 'absolute', left: 64, top: 462, gap: 48, alignItems: 'flex-end' },
      stat('Top leverage', fmt.lev(s.maxLeverage)),
      h('div', { flexDirection: 'column', gap: 6 }, h('div', { fontSize: 19, fontWeight: 500, color: MUTE, letterSpacing: 0.3 }, 'Side'), side),
      stat('Token', s.token),
      stat('Time', `${Math.max(1, s.duration)}s`)),
    // footer
    h('div', { position: 'absolute', left: 64, top: 562, width: 1072, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,.2)', justifyContent: 'space-between', alignItems: 'center', fontSize: 18, color: MUTE },
      h('div', { fontWeight: 600, color: SOFT, fontSize: 20 }, 'climb.sirocco.finance'),
      h('div', { fontWeight: 500 }, 'Side and stake encrypted on chain with Zama FHE · self-reported, decrypted by the player')));
}

export default async function handler(req, res) {
  const s = verify(idOf(req));
  if (!s) { res.statusCode = 404; res.setHeader('content-type', 'text/plain'); return res.end('Unknown share card'); }
  try {
    const svg = await satori(card(s), { width: 1200, height: 630, fonts: FONTS });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: false } }).render().asPng();
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', png.length);
    res.setHeader('cache-control', 'public, max-age=86400, s-maxage=31536000, immutable');   // a signed id never changes
    res.end(png);
  } catch (e) {
    console.error('og', e);
    res.statusCode = 500; res.setHeader('content-type', 'text/plain'); res.end('Card unavailable');
  }
}
