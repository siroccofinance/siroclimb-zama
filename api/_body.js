// JSON body of a POST, on Vercel (parsed already) and in dev.mjs (a stream).
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let s = ''; for await (const c of req) { s += c; if (s.length > 4096) throw new Error('too large'); }
  return JSON.parse(s || '{}');
}
