// The real position behind every run (Siroclimb + SiroccoDesk on chain): stake + borrowed cUSDC
// = POSITION_LEVERAGE x the stake, in the market's confidential token, traded with the Sirocco desk at
// the oracle price plus or minus its half spread. A long buys at the ask and sells at the bid; a short
// borrows the same quantity, sells it at the bid, buys it back at the ask and returns it. The loan,
// (POSITION_LEVERAGE - 1) x the stake, pays the reserve's APR for the run's time.
// Mirrors the contracts' integer math (6-decimal amounts, 10-decimal prices) so the screen shows what
// the player decrypts. The payout itself follows the game ladder (moves x25); the difference between
// the payout and this position is the "game boost", settled with the reserve.
export const POSITION_LEVERAGE = 4;
export const SPREAD_BPS = 10;
export const APR_BPS = 2000;
const U = 1_000_000n, P = 10_000_000_000n, YEAR = 365n * 86_400n;
const units = v => BigInt(Math.round(v * 1e6));
const price10 = p => BigInt(Math.round(p * 1e10));
const quotes = p => ({ bid: (p * BigInt(10_000 - SPREAD_BPS)) / 10_000n, ask: (p * BigInt(10_000 + SPREAD_BPS)) / 10_000n });

/** Interest on the loan, in cUSDC: (L - 1) x stake x APR x seconds (the contracts' borrowedTenthSeconds). */
export function loanInterest(stake, seconds) {
  const paid = units(stake), tenths = 10n * BigInt(POSITION_LEVERAGE - 1) * BigInt(Math.max(0, Math.floor(seconds)));
  return Number((paid * BigInt(APR_BPS) * tenths) / (10_000n * 10n * YEAR)) / 1e6;
}

/** The position at the open: tokens held (long) or owed (short), and the cash leg. */
export function openPosition(stake, long, entry) {
  const notional = units(stake) * BigInt(POSITION_LEVERAGE), q = quotes(price10(entry));
  const qty = (notional * P) / q.ask, proceeds = (qty * q.bid) / P;
  return { qty: Number(qty) / 1e6, notional: Number(notional) / 1e6, borrowed: Number(notional - units(stake)) / 1e6, cashLeg: Number(long ? notional : proceeds) / 1e6, _qty: qty, _cash: long ? notional : proceeds };
}

/** What the real position is worth at the end (stake + cash in - cash out - interest, floored at 0). */
export function closePosition(stake, long, entry, exit, seconds) {
  const o = openPosition(stake, long, entry), q = quotes(price10(exit));
  const cashIn = long ? (o._qty * q.bid) / P : o._cash;
  const cashOut = long ? o._cash : (o._qty * q.ask) / P;
  const pin = units(stake) + cashIn, pout = cashOut + units(loanInterest(stake, seconds));
  return { ...o, value: Number(pin >= pout ? pin - pout : 0n) / 1e6 };
}
