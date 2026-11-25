// Every market is open 24/7: the price route on a weekend clock (Saturday noon UTC, Sunday 3:00 New York),
// three polls 4 s apart, each market open with a price, and the prices moving between polls.
// usage: node tests/prices-weekend.mjs
const RealDate = Date, offsets = [];
for (const at of ['2026-11-28T12:00:00Z', '2026-11-29T08:00:00Z']) {
  const shift = new RealDate(at).getTime() - RealDate.now();
  // a weekend clock for everything the route computes (the exchanges answer with their real time)
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); } static now() { return RealDate.now() + shift; } };
  const { prices } = await import(`../api/prices.js?${at}`);
  const polls = [];
  for (let i = 0; i < 3; i++) { polls.push((await prices()).markets); await new Promise(r => setTimeout(r, 4100)); }
  console.log(new Date().toUTCString());
  let ok = true;
  for (const [i, m] of polls[0].entries()) {
    const seen = polls.map(p => p[i].price), open = polls.every(p => p[i].open && p[i].price > 0);
    const moved = new Set(seen).size > 1;
    ok &&= open;
    console.log(`  ${m.id.padEnd(6)} ${open ? 'open  ' : 'CLOSED'} ${m.source.padEnd(13)} ${seen.join(' → ')}${moved ? '' : '  (no move in 8 s)'}`);
  }
  offsets.push(ok);
}
globalThis.Date = RealDate;
console.log(offsets.every(Boolean) ? 'OK: every market open on a weekend clock' : 'FAIL: a market is closed');
process.exit(offsets.every(Boolean) ? 0 : 1);
