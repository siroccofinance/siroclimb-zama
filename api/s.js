// GET /s/<id> (rewritten here): the page a shared link opens. Crawlers (X, Discord, Slack…) read the
// summary_large_image card; people are sent on to the game.
import { fmt, headline, idOf, origin, resolve } from './_share.js';
import { verifiedRun } from './_run.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function handler(req, res) {
  const id = idOf(req), o = origin(req), r = await resolve(id, verifiedRun).catch(() => null);
  const play = `${o}/#play`;
  // an id that fails its signature (tampered, mistyped): 404, no card; a person still gets the game
  if (!r) {
    res.statusCode = 404; res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Siroclimb: unknown share link</title><meta name="robots" content="noindex"></head><body><p>This share link is not valid. <a href="${esc(play)}">Play Siroclimb</a></p><script>location.replace(${JSON.stringify(play)});</script></body></html>`);
  }
  const s = r.run;
  const title = s ? `Siroclimb: ${headline(s)}` : 'Siroclimb: climb the live price, confidentially';
  const desc = s ? `${fmt.eyebrow(s)}. Verified on Sepolia (run #${s.runId}): the return was published with Zama's KMS proof; the stake stays encrypted with Zama's FHE. Can you climb higher?`
    : 'A climbing game on live prices. Side and stake stay encrypted on chain with Zama\'s FHE, confidential tokens (ERC-7984).';
  const img = `${o}/api/og?id=${encodeURIComponent(s ? id : 'game')}`, url = `${o}/s/${id}`;
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', r && r.pending ? 'no-store' : 'public, max-age=300, s-maxage=86400');
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Siroclimb">
<meta property="og:url" content="${esc(url)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}"><meta name="twitter:image:alt" content="${esc(title)}">
<meta name="theme-color" content="#c2552d">
<style>html,body{margin:0;min-height:100%;background:#c2552d;color:#fff;font:600 16px/1.4 Inter,-apple-system,"Segoe UI",sans-serif}main{min-height:100vh;display:grid;place-items:center;gap:20px;padding:24px;box-sizing:border-box;text-align:center}img{width:min(720px,100%);height:auto;border-radius:16px;box-shadow:0 24px 60px -24px rgba(43,20,10,.7)}a{display:inline-block;padding:14px 28px;border-radius:10px;background:linear-gradient(#f2c94c,#e6b25c);color:#2b211a;text-decoration:none}</style>
</head><body><main><img src="${esc(img)}" alt="${esc(title)}" width="1200" height="630"><a href="${esc(play)}">Play Siroclimb</a></main>
<script>location.replace(${JSON.stringify(play)});</script>
</body></html>`);
}
