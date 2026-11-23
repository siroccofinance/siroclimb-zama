// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title ClimbPriceOracle
/// @notice Per-market, append-only price checkpoints for Siroclimb runs.
///
/// A run is settled on the checkpoints that were on chain between its entry and its exit, so the
/// result never depends on when settlement is called. Every checkpoint carries the block time at
/// which it was written (not the time the price was observed), which makes "the prices known at
/// time t" deterministic.
///
/// Three ways to write a checkpoint, each tagged with its source:
///  - `pushPyth` (anyone, trustless): a signed Pyth Hermes update is posted to the Pyth contract
///    (Wormhole-verified); every market whose feed is fresh after the update takes its price.
///    The players' browsers (and the game itself on entry and cash out) do this.
///  - `pushPublic` (anyone, bounded fallback): for a market without a fresh Pyth price (feed not
///    covered by the Hermes plan, or Pyth down), public market data is accepted at most every
///    `PUBLIC_MIN_SPACING` seconds, within `PUBLIC_MAX_MOVE_BPS` of the last checkpoint and within
///    `PUBLIC_MAX_PYTH_DRIFT_BPS` of the last Pyth checkpoint (if one is recent). Reporters are
///    semi-trusted within those bounds; the source of every checkpoint is public.
///  - `pushPrices` (authorised updaters): seeding at deployment and the optional ops keeper.
///
/// Prices use 10 decimals (sub-cent tokens keep precision, BTC still fits a uint64).
contract ClimbPriceOracle is Ownable2Step {
    uint256 public constant PRICE_DECIMALS = 10;

    uint8 public constant SOURCE_KEEPER = 0;
    uint8 public constant SOURCE_PYTH = 1;
    uint8 public constant SOURCE_PUBLIC = 2;

    /// @notice A Pyth price older than this (vs the block time) is not taken.
    uint256 public constant PYTH_MAX_AGE = 25;
    /// @notice Public checkpoints are refused while the market has a Pyth checkpoint this recent.
    uint256 public constant PYTH_FRESH = 120;
    uint256 public constant PUBLIC_MIN_SPACING = 10;
    uint256 public constant PUBLIC_MAX_MOVE_BPS = 50; // 0.5 % vs the last checkpoint
    uint256 public constant PUBLIC_MAX_PYTH_DRIFT_BPS = 300; // 3 % vs the last Pyth checkpoint
    /// @notice The Pyth drift bound only applies while the last Pyth checkpoint is this recent.
    uint256 public constant PYTH_DRIFT_WINDOW = 1 hours;

    struct Checkpoint {
        uint64 timestamp;
        uint64 price;
        uint8 source;
    }

    IPyth public immutable pyth;
    uint256 public immutable marketCount;
    bytes32[] private _feedIds;

    mapping(uint256 market => Checkpoint[]) private _checkpoints;
    /// @notice 1 + index of the last Pyth checkpoint of a market (0 = none yet).
    mapping(uint256 market => uint256) public lastPythPlusOne;
    mapping(address account => bool) public isUpdater;

    error NotUpdater(address account);
    error UnknownMarket(uint256 market);
    error ZeroPrice(uint256 market);
    error NoCheckpoint(uint256 market);
    error NoCheckpointBefore(uint256 market, uint256 timestamp);
    error TooSoon(uint256 market, uint256 nextAt);
    error PythIsFresh(uint256 market);
    error PriceJump(uint256 market);
    error LengthMismatch();

    event UpdaterSet(address indexed account, bool allowed);
    event PricePushed(uint256 indexed market, uint256 indexed index, uint64 timestamp, uint64 price, uint8 source);

    constructor(address owner_, IPyth pyth_, bytes32[] memory feedIds_) Ownable(owner_) {
        pyth = pyth_;
        marketCount = feedIds_.length;
        _feedIds = feedIds_;
    }

    modifier onlyUpdater() {
        if (!isUpdater[msg.sender]) revert NotUpdater(msg.sender);
        _;
    }

    function setUpdater(address account, bool allowed) external onlyOwner {
        isUpdater[account] = allowed;
        emit UpdaterSet(account, allowed);
    }

    // ---------------------------------------------------------------- writes

    /// @notice Trusted checkpoints (deployment seed, optional keeper).
    function pushPrices(uint256[] calldata markets, uint64[] calldata prices) external onlyUpdater {
        if (markets.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < markets.length; ++i) {
            _checkMarket(markets[i]);
            if (prices[i] == 0) revert ZeroPrice(markets[i]);
            _append(markets[i], prices[i], SOURCE_KEEPER);
        }
    }

    /// @notice Posts a signed Pyth update (pays the Pyth fee, refunds the rest to the caller) and
    ///         writes a checkpoint for every market whose Pyth price is now fresh. Never reverts
    ///         because a market had nothing new, so it can ride along with game transactions.
    /// @return mask bit i set when market i got a new Pyth checkpoint.
    function pushPyth(bytes[] calldata updateData) external payable returns (uint256 mask) {
        uint256 fee = pyth.getUpdateFee(updateData);
        pyth.updatePriceFeeds{value: fee}(updateData);
        for (uint256 i; i < marketCount; ++i) {
            if (_feedIds[i] == bytes32(0)) continue;
            Checkpoint[] storage cps = _checkpoints[i];
            if (cps.length != 0 && cps[cps.length - 1].timestamp >= block.timestamp) continue; // one per block
            try pyth.getPriceNoOlderThan(_feedIds[i], PYTH_MAX_AGE) returns (PythStructs.Price memory p) {
                uint64 price = _toFixed10(p);
                if (price == 0) continue;
                _append(i, price, SOURCE_PYTH);
                lastPythPlusOne[i] = cps.length;
                mask |= 1 << i;
            } catch {}
        }
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            ok;
        }
    }

    /// @notice Bounded fallback checkpoints from public market data, callable by anyone.
    function pushPublic(uint256[] calldata markets, uint64[] calldata prices) external {
        if (markets.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < markets.length; ++i) {
            uint256 m = markets[i];
            _checkMarket(m);
            Checkpoint[] storage cps = _checkpoints[m];
            uint256 n = cps.length;
            if (n == 0) revert NoCheckpoint(m);
            Checkpoint storage last = cps[n - 1];
            if (block.timestamp < last.timestamp + PUBLIC_MIN_SPACING) revert TooSoon(m, last.timestamp + PUBLIC_MIN_SPACING);
            if (prices[i] == 0) revert ZeroPrice(m);
            if (!_within(prices[i], last.price, PUBLIC_MAX_MOVE_BPS)) revert PriceJump(m);
            uint256 lp = lastPythPlusOne[m];
            if (lp != 0) {
                Checkpoint storage py = cps[lp - 1];
                if (block.timestamp < py.timestamp + PYTH_FRESH) revert PythIsFresh(m);
                if (block.timestamp < py.timestamp + PYTH_DRIFT_WINDOW && !_within(prices[i], py.price, PUBLIC_MAX_PYTH_DRIFT_BPS))
                    revert PriceJump(m);
            }
            _append(m, prices[i], SOURCE_PUBLIC);
        }
    }

    // ---------------------------------------------------------------- views

    function feedIds() external view returns (bytes32[] memory) {
        return _feedIds;
    }

    function checkpointCount(uint256 market) external view returns (uint256) {
        return _checkpoints[market].length;
    }

    function getCheckpoint(uint256 market, uint256 index) external view returns (Checkpoint memory) {
        return _checkpoints[market][index];
    }

    /// @notice The last checkpoint of a market.
    function latest(uint256 market) public view returns (uint256 index, uint64 timestamp, uint64 price, uint8 source) {
        uint256 n = _checkpoints[market].length;
        if (n == 0) revert NoCheckpoint(market);
        Checkpoint storage c = _checkpoints[market][n - 1];
        return (n - 1, c.timestamp, c.price, c.source);
    }

    /// @notice Latest checkpoint of every market (timestamps and prices), for the front.
    function latestAll() external view returns (uint64[] memory timestamps, uint64[] memory prices, uint8[] memory sources) {
        timestamps = new uint64[](marketCount);
        prices = new uint64[](marketCount);
        sources = new uint8[](marketCount);
        for (uint256 i; i < marketCount; ++i) {
            uint256 n = _checkpoints[i].length;
            if (n == 0) continue;
            Checkpoint storage c = _checkpoints[i][n - 1];
            (timestamps[i], prices[i], sources[i]) = (c.timestamp, c.price, c.source);
        }
    }

    /// @notice Index of the last checkpoint written at or before `timestamp` (binary search).
    function indexAtOrBefore(uint256 market, uint256 timestamp) public view returns (uint256) {
        Checkpoint[] storage cps = _checkpoints[market];
        uint256 n = cps.length;
        if (n == 0 || cps[0].timestamp > timestamp) revert NoCheckpointBefore(market, timestamp);
        uint256 lo = 0;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (cps[mid].timestamp <= timestamp) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// @notice Checkpoints from index `from` on, as long as they were written at or before `until`,
    ///         at most `max` of them. Element 0 is checkpoint `from` itself.
    function path(
        uint256 market,
        uint256 from,
        uint256 until,
        uint256 max
    ) external view returns (uint64[] memory timestamps, uint64[] memory prices) {
        Checkpoint[] storage cps = _checkpoints[market];
        uint256 n = cps.length;
        uint256 end = from;
        while (end < n && end - from < max && (end == from || cps[end].timestamp <= until)) ++end;
        timestamps = new uint64[](end - from);
        prices = new uint64[](end - from);
        for (uint256 i = from; i < end; ++i) {
            timestamps[i - from] = cps[i].timestamp;
            prices[i - from] = cps[i].price;
        }
    }

    // ---------------------------------------------------------------- internals

    function _checkMarket(uint256 market) private view {
        if (market >= marketCount) revert UnknownMarket(market);
    }

    function _append(uint256 market, uint64 price, uint8 source) private {
        Checkpoint[] storage cps = _checkpoints[market];
        uint256 n = cps.length;
        // at most one checkpoint per market and block: bounds the path of a run and keeps time strictly increasing
        if (n != 0 && cps[n - 1].timestamp >= block.timestamp) revert TooSoon(market, cps[n - 1].timestamp + 1);
        cps.push(Checkpoint({timestamp: uint64(block.timestamp), price: price, source: source}));
        emit PricePushed(market, n, uint64(block.timestamp), price, source);
    }

    /// @dev Pyth price (mantissa x 10^expo) to 10-decimal fixed point; 0 when unusable.
    function _toFixed10(PythStructs.Price memory p) private pure returns (uint64) {
        if (p.price <= 0) return 0;
        int256 shift = int256(PRICE_DECIMALS) + int256(p.expo);
        uint256 v = uint256(uint64(p.price));
        if (shift >= 0) v *= 10 ** uint256(shift);
        else v /= 10 ** uint256(-shift);
        if (v > type(uint64).max) return 0;
        return uint64(v);
    }

    function _within(uint64 a, uint64 b, uint256 bps) private pure returns (bool) {
        uint256 diff = a > b ? a - b : b - a;
        return diff * 10_000 <= uint256(b) * bps;
    }
}
