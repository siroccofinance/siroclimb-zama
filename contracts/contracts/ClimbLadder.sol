// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ClimbPriceOracle} from "./ClimbPriceOracle.sol";

/// @title ClimbLadder
/// @notice The rules of a Siroclimb run, in clear: given a market's oracle checkpoints between a
///         run's entry and its exit, what would a long and what would a short have made?
///
/// Every move between two consecutive checkpoints counts `moveScale` times (the game scale) at
/// the leverage of the ladder step the checkpoint lands on: 1x, 1.5x, 2x ... 4x, one step every
/// 6 seconds from the start. PnL adds up on the stake, like a position of constant notional; when
/// it reaches -100 % the coin falls and the run is worth 0 for good.
///
/// Both results are public (anyone can recompute them from the oracle); which one a player gets
/// depends on their encrypted side, which only the game contract combines on ciphertexts.
contract ClimbLadder {
    uint8 public constant TOP_STEP = 6;
    uint64 public constant STEP_SECONDS = 6;
    /// @notice Multipliers are fixed point with 6 decimals: 1_000_000 = the stake back.
    uint32 public constant SCALE = 1_000_000;
    uint32 public constant MAX_MULT = 10 * SCALE;
    /// @notice A single checkpoint-to-checkpoint move is clamped to +/-20 % before scaling.
    int256 public constant MAX_SEGMENT_MOVE = 200_000;
    /// @notice Bound on the checkpoints a run reads (the oracle writes at most one per block).
    uint256 public constant MAX_PATH = 64;

    ClimbPriceOracle public immutable oracle;
    /// @notice Game scale: how many times a real price move counts, before leverage.
    uint32 public immutable moveScale;

    constructor(ClimbPriceOracle oracle_, uint32 moveScale_) {
        oracle = oracle_;
        moveScale = moveScale_;
    }

    /// @notice The ladder in tenths of x: 10, 15, 20 ... 40.
    function ladder() external pure returns (uint8[7] memory tenths) {
        for (uint8 i; i <= TOP_STEP; ++i) tenths[i] = 10 + 5 * i;
    }

    /// @notice Value / stake (6 decimals) of a long and of a short that entered at checkpoint
    ///         `entryIndex` at time `start` and left at checkpoint `exitIndex`, the ladder capped
    ///         at `capStep`. Index bounds (not times) make the result reproducible by anyone, even
    ///         when another checkpoint lands later in the block of a cash out.
    function multipliers(
        uint256 market,
        uint256 entryIndex,
        uint256 exitIndex,
        uint64 start,
        uint8 capStep
    ) external view returns (uint32 multLong, uint32 multShort, uint64 exitPrice) {
        uint256 count = exitIndex >= entryIndex ? exitIndex - entryIndex + 1 : 1;
        if (count > MAX_PATH) count = MAX_PATH;
        (uint64[] memory ts, uint64[] memory px) = oracle.path(market, entryIndex, type(uint256).max, count);
        int256 one = int256(uint256(SCALE));
        int256 accL;
        int256 accS;
        bool fellL;
        bool fellS;
        for (uint256 j = 1; j < ts.length; ++j) {
            int256 move = ((int256(uint256(px[j])) - int256(uint256(px[j - 1]))) * one) / int256(uint256(px[j - 1]));
            if (move > MAX_SEGMENT_MOVE) move = MAX_SEGMENT_MOVE;
            if (move < -MAX_SEGMENT_MOVE) move = -MAX_SEGMENT_MOVE;
            uint64 step = (ts[j] > start ? ts[j] - start : 0) / STEP_SECONDS;
            if (step > capStep) step = capStep;
            int256 d = (move * int256(uint256(moveScale)) * int256(uint256(10 + 5 * step))) / 10;
            if (!fellL) {
                accL += d;
                if (accL <= -one) fellL = true;
            }
            if (!fellS) {
                accS -= d;
                if (accS <= -one) fellS = true;
            }
        }
        multLong = _mult(fellL, accL);
        multShort = _mult(fellS, accS);
        exitPrice = px[px.length - 1];
    }

    function _mult(bool fell, int256 acc) private pure returns (uint32) {
        if (fell) return 0;
        int256 m = int256(uint256(SCALE)) + acc;
        if (m <= 0) return 0;
        if (m > int256(uint256(MAX_MULT))) return MAX_MULT;
        return uint32(uint256(m));
    }
}
