// POST /api/share { runId, showSide } → { id, url, image }
// Signs a link to a finished run, after reading it on chain (api/_run.js): only a run that is over and
// whose return the player published (KMS proof on chain) gets a card. Nothing else from the browser is used.
import { limited, send } from './_markets.js';
import { readJson } from './_body.js';
import { verifiedRun } from './_run.js';
import { origin, sign } from './_share.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { error: 'POST only' }); }
  if (limited(req, 30, 'share')) return send(res, 429, { error: 'Too many share links, try again in a minute' });
  let b;
  try { b = await readJson(req); } catch { return send(res, 400, { error: 'Bad request' }); }
  const runId = Number(b.runId);
  if (!Number.isInteger(runId) || runId < 0) return send(res, 400, { error: 'Not a run' });
  let run;
  try { run = await verifiedRun(runId); } catch { return send(res, 502, { error: 'Sepolia did not answer, try again' }); }
  if (!run) return send(res, 404, { error: 'This run is not over on chain yet' });
  if (!run.published) return send(res, 409, { error: 'not-published', runId });
  let id;
  try { id = sign({ runId, showSide: !!b.showSide }); } catch { return send(res, 503, { error: 'Sharing is not configured' }); }
  const o = origin(req);
  send(res, 200, { id, url: `${o}/s/${id}`, image: `${o}/api/og?id=${encodeURIComponent(id)}`, run: { ...run, side: b.showSide ? run.side : null } });
}
