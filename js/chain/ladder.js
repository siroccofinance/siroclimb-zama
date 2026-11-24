// The run rules of ClimbLadder.multipliers, in exact integer math (BigInt), so the value on screen
// is the value the contract pays: same checkpoints, same rounding, same fall at -100 %.
const SCALE = 1_000_000n, MAX_MULT = 10n * SCALE, MAX_MOVE = 200_000n, STEP = 6n, TOP = 6n;

/**
 * Value / stake (6 decimals) of a long and a short over `points` ([{ ts: seconds, price: bigint 1e10 }],
 * the entry first), for a run that started at `start` (seconds), ladder capped at `cap`.
 */
export function multipliers(points, start, moveScale, cap = TOP) {
  let accL = 0n, accS = 0n, fellL = false, fellS = false;
  const s0 = BigInt(start), scale = BigInt(moveScale);
  for (let j = 1; j < points.length; j++) {
    const prev = points[j - 1].price, cur = points[j].price;
    let move = ((cur - prev) * SCALE) / prev;                 // BigInt division truncates toward zero, like Solidity
    if (move > MAX_MOVE) move = MAX_MOVE;
    if (move < -MAX_MOVE) move = -MAX_MOVE;
    const ts = BigInt(points[j - 1].ts);                          // the leverage when the move began
    let step = (ts > s0 ? ts - s0 : 0n) / STEP;
    if (step > BigInt(cap)) step = BigInt(cap);
    const d = (move * scale * (10n + 5n * step)) / 10n;
    if (!fellL) { accL += d; if (accL <= -SCALE) fellL = true; }
    if (!fellS) { accS -= d; if (accS <= -SCALE) fellS = true; }
  }
  const mult = (fell, acc) => { if (fell) return 0n; const m = SCALE + acc; return m <= 0n ? 0n : m > MAX_MULT ? MAX_MULT : m; };
  return { long: mult(fellL, accL), short: mult(fellS, accS) };
}

/** A Pyth price (mantissa x 10^expo) in the oracle's 10-decimal fixed point, like the contract. */
export function pythToFixed10(mantissa, expo) {
  const m = BigInt(mantissa), shift = 10 + Number(expo);
  return shift >= 0 ? m * 10n ** BigInt(shift) : m / 10n ** BigInt(-shift);
}
