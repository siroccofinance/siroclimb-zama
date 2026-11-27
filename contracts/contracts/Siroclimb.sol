// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, ebool, euint8, euint32, euint64, externalEbool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ClimbPriceOracle} from "./ClimbPriceOracle.sol";
import {ClimbLadder} from "./ClimbLadder.sol";
import {SiroccoReserve} from "./SiroccoReserve.sol";
import {SiroccoDesk} from "./SiroccoDesk.sol";

/// @title Siroclimb
/// @notice The Sirocco climbing game on the Zama Protocol: pick a market, go long or short, the
///         leverage climbs from 1x to 4x every 6 seconds over a 60 second run, cash out whenever.
///
/// What is confidential (see README, "Confidentiality design"):
///  - the side (long / short) of every run is an encrypted `ebool`: nobody can copy or fade a
///    player;
///  - the stake of a run is an encrypted `euint64` in Zama's confidential USDC (ERC-7984);
///  - a run's value is computed on ciphertexts: the contract computes, in clear, what a long and
///    a short would have made on the public oracle path (`multLong`, `multShort`), then picks one
///    with the encrypted side (`FHE.select`) and multiplies the encrypted stake by it. The payout
///    is an encrypted transfer in the same transaction: money never waits for a decryption;
///  - leverage is borrowed from the Sirocco Reserve (`SiroccoReserve`), a confidential cUSDC lending
///    pool: a run of stake S at leverage L borrows S x (L - 1), and pays interest on it for the
///    time it is borrowed. The borrowed amount and the interest follow the encrypted stake, so they
///    stay encrypted; the reserve commits liquidity in clear with the public bound of a run;
///  - every run holds a real position in its market's confidential token, traded with the Sirocco
///    desk (`SiroccoDesk`) at the oracle price plus or minus a spread: stake + borrowed cUSDC
///    (`POSITION_LEVERAGE` x the stake) buys the token for a long; a short borrows the token from the
///    desk and sells it. At the end the long sells, the short buys back and returns, the loan and its
///    interest go back to the reserve. Quantities and cash legs are encrypted, and both legs of every
///    trade move whatever the side (one with an encrypted 0);
///  - the payout keeps the game's amplification: every move counts `moveScale(market)` times on the ladder
///    (`ClimbLadder`). The part of the payout beyond the real position ("game boost", positive or
///    negative) is settled with the reserve, encrypted; the player can decrypt both parts;
///  - leverage packs are drawn with the on-chain encrypted PRNG and stay private: a packed run's
///    leverage cap is selected on ciphertexts.
///
/// Every lifecycle step after a player's own action is permissionless (`settleRun`, `recordRun`,
/// price pushes), so the players' browsers can run the game with nothing else.
contract Siroclimb is ZamaEthereumConfig, Ownable2Step {
    // ---------------------------------------------------------------- constants

    uint8 public constant TOP_STEP = 6;
    uint64 public constant STEP_SECONDS = 6;
    uint64 public constant RUN_SECONDS = 60;
    /// @notice A run that reaches its 60th second exits on the first checkpoint written in the
    ///         `EXIT_GRACE` seconds after its end, if any (else the last one before it): the player's
    ///         browser writes the price it showed at the 60th second, then settles, in the same block.
    ///         Without it the exit was the last checkpoint before the end, seconds older than the screen.
    uint64 public constant EXIT_GRACE = 30;
    /// @notice Multipliers are fixed point with 6 decimals: 1_000_000 = the stake back.
    uint32 public constant SCALE = 1_000_000;
    uint32 public constant MAX_MULT = 10 * SCALE;
    uint64 public constant MAX_STAKE = 100_000_000; // 100 cUSDC (6 decimals)
    uint64 public constant MAX_PAYOUT = (MAX_STAKE * MAX_MULT) / SCALE;
    /// @notice The entry price of a run must be at most this old (Sepolia inclusion can take
    ///         a few blocks); a fallback price can ride along to refresh it in the same transaction.
    uint64 public constant MAX_ENTRY_AGE = 60;
    uint64 public constant PACK_COOLDOWN = 10 minutes;
    /// @notice The real position of a run: stake + borrowed cUSDC = this many times the stake, held
    ///         from the start to the end (the borrowed part is (POSITION_LEVERAGE - 1) x the stake).
    uint64 public constant POSITION_LEVERAGE = 4;

    // ---------------------------------------------------------------- types

    enum RunStatus {
        None,
        Live,
        Ended
    }

    struct Run {
        address player;
        uint8 market;
        RunStatus status;
        bool packed;
        uint8 topStep; // ladder step reached at the exit (before any pack cap)
        uint64 startAt;
        uint64 endAt;
        uint64 entryPrice;
        uint64 exitPrice;
        uint32 multLong; // public at the end: value / stake for a long (6 decimals), uncapped ladder
        uint32 multShort; // same for a short
        uint32 entryIndex; // oracle checkpoint of the entry
        uint32 exitIndex; // last oracle checkpoint counted (written at or before the exit, known at settlement)
        bool publishRequested;
        bool published;
    }

    /// @notice Encrypted part of a run. Handles are public, plaintexts are ACL protected.
    struct Sealed {
        ebool long;
        euint64 paid; // stake actually transferred (ERC-7984 moves 0 on insufficient balance)
        euint64 value; // payout of the run (net of interest)
        euint64 lent; // liquidity the reserve lent for the run: MAX_PAYOUT, or 0 if it was short
        euint64 interest; // borrow interest charged at the end
        euint32 mult; // the player's own multiplier (selected with the encrypted side)
        euint8 cap; // packed runs: encrypted top ladder step
        euint64 qty; // market tokens held (long) or owed to the desk (short)
        euint64 cashLeg; // long: cUSDC paid for them; short: cUSDC the sale brought in
        euint64 position; // what the real position is worth at the end: stake + sale - cost - interest, floored at 0
    }

    struct Result {
        address player;
        uint64 timestamp;
        int32 pnlPpm; // value / stake - 1, in millionths
        uint32 runId;
    }

    struct SessionGrant {
        address player;
        uint64 expiry;
    }

    // ---------------------------------------------------------------- storage

    IERC7984 public immutable token;
    ClimbPriceOracle public immutable oracle;
    /// @notice The ladder rules: what a long and a short make on the oracle path of a run.
    ClimbLadder public immutable ladder;
    /// @notice The Sirocco Reserve: lends the leverage of every run, receives its PnL and interest.
    SiroccoReserve public immutable reserve;
    /// @notice The Sirocco desk: real trades of the market tokens for every run's position.
    SiroccoDesk public immutable desk;
    /// @notice Borrow rate (reserve's APR in basis points) and its divisor, see `interestOf`.
    uint64 public immutable borrowAprBps;
    uint64 public immutable interestDivisor;
    uint256 public immutable marketCount;

    /// @notice The confidential token of each market (cTSLAx, cNVDAx, cAAPLx, cAMZNx, cXAUt, ctGBP).
    IERC7984[] public marketTokens;

    Run[] private _runs;
    mapping(uint256 runId => Sealed) private _sealed;
    Result[] private _results;

    mapping(address player => string) public nameOf;
    mapping(address session => SessionGrant) public sessions;
    mapping(address player => address) public sessionOf;

    mapping(address player => euint8) private _packTier;
    mapping(address player => bool) public hasPack;
    mapping(address player => uint64) public lastPackAt;

    // ---------------------------------------------------------------- errors / events

    error UnknownMarket(uint256 market);
    error BadLadder();
    error NotPlayer(uint256 runId);
    error WrongRunStatus(uint256 runId);
    error RunNotOver(uint256 runId, uint256 endsAt);
    error StaleEntry(uint256 market, uint256 checkpointAt);
    error NoPack();
    error PackCooldown(uint256 availableAt);
    error BadSession();
    error NameTooLong();
    error AlreadyPublished(uint256 runId);

    event SessionAuthorized(address indexed player, address indexed session, uint64 expiry);
    event SessionRevoked(address indexed player, address indexed session);
    event NameSet(address indexed player, string name);
    event RunStarted(
        uint256 indexed runId,
        address indexed player,
        uint8 market,
        uint64 startAt,
        uint64 entryPrice,
        bool packed,
        bytes32 sideHandle,
        bytes32 paidHandle
    );
    event RunEnded(
        uint256 indexed runId,
        address indexed player,
        uint64 endAt,
        uint64 exitPrice,
        uint32 multLong,
        uint32 multShort,
        bytes32 valueHandle
    );
    event ResultRecorded(uint256 indexed index, address indexed player, int32 pnlPpm, uint32 runId);
    event PackOpened(address indexed player, bytes32 tierHandle);
    event PublishRequested(uint256 indexed runId, bytes32 multHandle);
    event Borrowed(uint256 indexed runId, bytes32 lentHandle);
    event InterestCharged(uint256 indexed runId, bytes32 interestHandle);
    event PositionOpened(uint256 indexed runId, address indexed token, uint64 price, bytes32 qtyHandle, bytes32 cashHandle);
    event PositionClosed(uint256 indexed runId, uint64 price, bytes32 positionHandle);

    constructor(
        address owner_,
        IERC7984 token_,
        ClimbLadder ladder_,
        SiroccoReserve reserve_,
        SiroccoDesk desk_,
        IERC7984[] memory marketTokens_
    ) Ownable(owner_) {
        token = token_;
        ladder = ladder_;
        reserve = reserve_;
        desk = desk_;
        oracle = ladder_.oracle();
        marketCount = oracle.marketCount();
        borrowAprBps = reserve_.borrowAprBps();
        interestDivisor = reserve_.interestDivisor();
        if (ladder_.SCALE() != SCALE || ladder_.MAX_MULT() != MAX_MULT) revert BadLadder();
        if (address(reserve_.asset()) != address(token_)) revert BadLadder();
        if (address(desk_.cash()) != address(token_) || marketTokens_.length != marketCount) revert BadLadder();
        // the desk pulls the runs' legs itself (ERC-7984 operator of the game's cUSDC and market tokens)
        token_.setOperator(address(desk_), type(uint48).max);
        for (uint256 i; i < marketTokens_.length; ++i) {
            marketTokens.push(marketTokens_[i]);
            marketTokens_[i].setOperator(address(desk_), type(uint48).max);
        }
    }

    // ---------------------------------------------------------------- players and sessions

    /// @notice Lets a browser session key act for the caller (start runs, cash out),
    ///         so a run needs no wallet pop-up. The session proves it consents by signing
    ///         `sessionDigest(player, expiry)`. Any ETH sent is forwarded to the session for gas.
    ///         A session can only play with the stake the player approved (ERC-7984 operator);
    ///         it can never withdraw.
    function authorizeSession(address session, uint64 expiry, bytes calldata sessionSig) external payable {
        if (session == address(0) || session == msg.sender || sessions[msg.sender].player != address(0)) revert BadSession();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(sessionDigest(msg.sender, expiry));
        if (ECDSA.recover(digest, sessionSig) != session) revert BadSession();
        address previous = sessionOf[msg.sender];
        if (previous != address(0) && previous != session) delete sessions[previous];
        SessionGrant storage existing = sessions[session];
        if (existing.player != address(0) && existing.player != msg.sender) sessionOf[existing.player] = address(0);
        sessions[session] = SessionGrant({player: msg.sender, expiry: expiry});
        sessionOf[msg.sender] = session;
        emit SessionAuthorized(msg.sender, session, expiry);
        if (msg.value != 0) {
            (bool ok, ) = session.call{value: msg.value}("");
            ok;
        }
    }

    function revokeSession() external {
        address session = sessionOf[msg.sender];
        if (session == address(0)) revert BadSession();
        delete sessions[session];
        delete sessionOf[msg.sender];
        emit SessionRevoked(msg.sender, session);
    }

    /// @notice What a session key signs (EIP-191) to accept acting for `player`.
    function sessionDigest(address player, uint64 expiry) public view returns (bytes32) {
        return keccak256(abi.encodePacked("Siroclimb session", block.chainid, address(this), player, expiry));
    }

    /// @notice The player a caller acts for: the session's player, or the caller itself.
    function playerOf(address caller) public view returns (address) {
        SessionGrant storage s = sessions[caller];
        if (s.player != address(0) && s.expiry >= block.timestamp) return s.player;
        return caller;
    }

    function setName(string calldata name_) external {
        if (bytes(name_).length > 24) revert NameTooLong();
        address player = playerOf(msg.sender);
        nameOf[player] = name_;
        emit NameSet(player, name_);
    }

    // ---------------------------------------------------------------- runs

    /// @notice Opens a run. Side and stake are encrypted inputs (bound to the caller); the
    ///         stake is clamped to `MAX_STAKE` on ciphertexts and pulled from the player as an
    ///         ERC-7984 operator. A signed Pyth update can ride along so the entry is fresh; for a
    ///         market Pyth does not cover, a public price can ride along instead (the oracle's
    ///         bounds apply, exactly as for `pushPublic`).
    function startRun(
        uint8 market,
        externalEbool side,
        externalEuint64 stake,
        bytes calldata inputProof,
        bool usePack,
        bytes[] calldata pythUpdate,
        uint64 fallbackPrice
    ) external payable returns (uint256 runId) {
        if (market >= marketCount) revert UnknownMarket(market);
        if (pythUpdate.length != 0) oracle.pushPyth{value: msg.value}(pythUpdate);
        if (fallbackPrice != 0) {
            uint256[] memory ms = new uint256[](1);
            uint64[] memory ps = new uint64[](1);
            (ms[0], ps[0]) = (market, fallbackPrice);
            try oracle.pushPublic(ms, ps) {} catch {}
        }
        (uint256 index, uint64 at, uint64 price, ) = oracle.latest(market);
        if (block.timestamp > at + MAX_ENTRY_AGE) revert StaleEntry(market, at);
        address player = playerOf(msg.sender);

        runId = _runs.length;
        _runs.push();
        Run storage r = _runs[runId];
        r.player = player;
        r.market = market;
        r.status = RunStatus.Live;
        r.startAt = uint64(block.timestamp);
        r.entryPrice = price;
        r.entryIndex = uint32(index);

        Sealed storage s = _sealed[runId];
        s.long = FHE.fromExternal(side, inputProof);
        euint64 amount = FHE.min(FHE.fromExternal(stake, inputProof), MAX_STAKE);
        FHE.allowTransient(amount, address(token));
        s.paid = token.confidentialTransferFrom(player, address(this), amount);
        _own(s.long, player);
        _own64(s.paid, player);

        if (usePack) {
            if (!hasPack[player]) revert NoPack();
            hasPack[player] = false;
            r.packed = true;
            // tier 0..3 (Bronze, Silver, Gold, Diamond) -> top step 1, 2, 4, 6 (1.5x, 2x, 3x, 4x)
            euint8 t = _packTier[player];
            s.cap = FHE.select(
                FHE.eq(t, 0),
                FHE.asEuint8(1),
                FHE.select(FHE.eq(t, 1), FHE.asEuint8(2), FHE.select(FHE.eq(t, 2), FHE.asEuint8(4), FHE.asEuint8(6)))
            );
            FHE.allowThis(s.cap);
            FHE.allow(s.cap, player);
        }

        // the leverage: the reserve lends the run's public bound into the game (encrypted transfer)
        s.lent = reserve.lend(runId, MAX_PAYOUT);
        FHE.allowThis(s.lent);
        emit Borrowed(runId, FHE.toBytes32(s.lent));

        // the real position: stake + borrowed cUSDC buys the market token (long), or the token is
        // borrowed from the desk and sold (short). A run the reserve could not fund takes no position.
        euint64 notional = FHE.select(FHE.eq(s.lent, MAX_PAYOUT), FHE.mul(s.paid, POSITION_LEVERAGE), FHE.asEuint64(0));
        FHE.allowTransient(s.long, address(desk));
        FHE.allowTransient(notional, address(desk));
        IERC7984 mt = marketTokens[market];
        (s.qty, s.cashLeg) = desk.open(runId, mt, s.long, notional, price);
        _own64(s.qty, player);
        _own64(s.cashLeg, player);
        emit PositionOpened(runId, address(mt), price, FHE.toBytes32(s.qty), FHE.toBytes32(s.cashLeg));
        emit RunStarted(runId, player, market, r.startAt, price, r.packed, FHE.toBytes32(s.long), FHE.toBytes32(s.paid));
    }

    /// @notice Ends the caller's run now and pays it in the same transaction. A signed Pyth
    ///         update can ride along so the exit is the freshest verified price.
    /// @param exitPrice the price the player's screen showed at the click (10 decimals; 0: none). Written as
    ///        the market's checkpoint in this block, bounded like a public price (+/-0.49 % of the last
    ///        checkpoint), and the run exits on it: the player is paid the value they clicked on.
    function cashOut(uint256 runId, bytes[] calldata pythUpdate, uint64 exitPrice) external payable {
        Run storage r = _runs[runId];
        if (r.player != playerOf(msg.sender)) revert NotPlayer(runId);
        if (r.status != RunStatus.Live) revert WrongRunStatus(runId);
        uint64 end = r.startAt + RUN_SECONDS;
        if (pythUpdate.length != 0) oracle.pushPyth{value: msg.value}(pythUpdate);
        bool wrote = _writeExit(r.market, exitPrice);
        if (block.timestamp < end) _endRun(runId, uint64(block.timestamp), uint64(block.timestamp), false);
        else _endRun(runId, end, _expiryPriceAt(end), wrote && block.timestamp <= end + EXIT_GRACE);
    }

    /// @notice Permissionless: settles a run whose 60 seconds are over, at its last second.
    ///         `exitPrice`: from the player (or their session) only, the price their screen showed at the 60th
    ///         second, written as the exit checkpoint (bounded, see cashOut) when settled within `EXIT_GRACE`.
    ///         Anyone else's call settles on the checkpoints as they are.
    function settleRun(uint256 runId, uint64 exitPrice) external {
        Run storage r = _runs[runId];
        if (r.status != RunStatus.Live) revert WrongRunStatus(runId);
        uint64 end = r.startAt + RUN_SECONDS;
        if (block.timestamp < end) revert RunNotOver(runId, end);
        bool wrote = r.player == playerOf(msg.sender) && block.timestamp <= end + EXIT_GRACE && _writeExit(r.market, exitPrice);
        _endRun(runId, end, _expiryPriceAt(end), wrote);
    }

    uint256 private constant EXIT_MAX_MOVE_BPS = 49;

    /// @dev Writes the player's shown price as the market's checkpoint in this block, clamped to +/-0.49 % of
    ///      the last one (the bound any public price has). Nothing when the block already has one.
    function _writeExit(uint256 market, uint64 exitPrice) private returns (bool) {
        if (exitPrice == 0) return false;
        (, uint64 ts, uint64 last, ) = oracle.latest(market);
        if (ts >= block.timestamp) return false;
        uint256 lo = (uint256(last) * (10_000 - EXIT_MAX_MOVE_BPS)) / 10_000;
        uint256 hi = (uint256(last) * (10_000 + EXIT_MAX_MOVE_BPS)) / 10_000;
        uint256 p = exitPrice < lo ? lo : exitPrice > hi ? hi : exitPrice;
        uint256[] memory ms = new uint256[](1);
        uint64[] memory ps = new uint64[](1);
        ms[0] = market;
        ps[0] = uint64(p);
        oracle.pushPrices(ms, ps);
        return true;
    }

    /// @dev The time whose checkpoint prices an expired run: the first checkpoint after `end`, within the
    ///      grace and already written, or else the last one at or before `end`.
    function _expiryPriceAt(uint64 end) private view returns (uint64) {
        uint64 limit = end + EXIT_GRACE;
        return block.timestamp < limit ? uint64(block.timestamp) : limit;
    }

    /// @notice Owner of a finished run: reveal its result for the leaderboard. Makes the
    ///         run's multiplier publicly decryptable (the stake stays private).
    function publishRun(uint256 runId) external {
        Run storage r = _runs[runId];
        if (r.player != playerOf(msg.sender)) revert NotPlayer(runId);
        if (r.status != RunStatus.Ended) revert WrongRunStatus(runId);
        if (r.publishRequested) revert AlreadyPublished(runId);
        r.publishRequested = true;
        FHE.makePubliclyDecryptable(_sealed[runId].mult);
        emit PublishRequested(runId, FHE.toBytes32(_sealed[runId].mult));
    }

    /// @notice Permissionless: records a published run with the KMS decryption proof.
    function recordRun(uint256 runId, uint32 mult, bytes calldata proof) external {
        Run storage r = _runs[runId];
        if (!r.publishRequested || r.published) revert WrongRunStatus(runId);
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_sealed[runId].mult);
        FHE.checkSignatures(handles, abi.encode(mult), proof);
        r.published = true;
        _record(r.player, int32(int256(uint256(mult)) - int256(uint256(SCALE))), uint32(runId));
    }

    // ---------------------------------------------------------------- leverage packs

    /// @notice Draws a leverage pack with the FHEVM encrypted PRNG. The tier stays encrypted
    ///         (only the player can decrypt it): Bronze 45 %, Silver 28 %, Gold 18 %, Diamond 9 %.
    ///         A packed run caps its ladder at the pack's leverage, selected on ciphertexts.
    function openPack() external returns (bytes32 tierHandle) {
        address player = playerOf(msg.sender);
        uint64 last = lastPackAt[player];
        if (last != 0 && block.timestamp < last + PACK_COOLDOWN) revert PackCooldown(last + PACK_COOLDOWN);
        lastPackAt[player] = uint64(block.timestamp);
        euint8 r = FHE.randEuint8();
        euint8 tier = FHE.select(
            FHE.lt(r, 115),
            FHE.asEuint8(0),
            FHE.select(FHE.lt(r, 187), FHE.asEuint8(1), FHE.select(FHE.lt(r, 233), FHE.asEuint8(2), FHE.asEuint8(3)))
        );
        FHE.allowThis(tier);
        FHE.allow(tier, player);
        _packTier[player] = tier;
        hasPack[player] = true;
        tierHandle = FHE.toBytes32(tier);
        emit PackOpened(player, tierHandle);
    }

    function packHandle(address player) external view returns (bytes32) {
        return FHE.toBytes32(_packTier[player]);
    }

    // ---------------------------------------------------------------- views

    function runCount() external view returns (uint256) {
        return _runs.length;
    }

    function getRun(uint256 runId) external view returns (Run memory) {
        return _runs[runId];
    }

    function runHandles(
        uint256 runId
    ) external view returns (bytes32 long, bytes32 paid, bytes32 value, bytes32 mult, bytes32 cap, bytes32 lent, bytes32 interest) {
        Sealed storage s = _sealed[runId];
        return (
            FHE.toBytes32(s.long),
            FHE.toBytes32(s.paid),
            FHE.toBytes32(s.value),
            FHE.toBytes32(s.mult),
            FHE.toBytes32(s.cap),
            FHE.toBytes32(s.lent),
            FHE.toBytes32(s.interest)
        );
    }

    /// @notice What a run borrows over `elapsed` seconds, in leverage tenths x seconds: the position
    ///         borrows (POSITION_LEVERAGE - 1) x the stake for the whole run (30 tenths at 4x).
    ///         Interest = paid x borrowAprBps x this / interestDivisor.
    function borrowedTenthSeconds(uint64 elapsed) public pure returns (uint64) {
        return 10 * (POSITION_LEVERAGE - 1) * elapsed;
    }

    /// @notice Handles of a run's real position: market tokens held (long) or owed (short), its cash leg,
    ///         and what the position was worth at the end. Player only.
    function positionHandles(uint256 runId) external view returns (bytes32 qty, bytes32 cashLeg, bytes32 position) {
        Sealed storage s = _sealed[runId];
        return (FHE.toBytes32(s.qty), FHE.toBytes32(s.cashLeg), FHE.toBytes32(s.position));
    }

    function resultCount() external view returns (uint256) {
        return _results.length;
    }

    /// @notice Results [from, from + count), oldest first.
    function results(uint256 from, uint256 count) external view returns (Result[] memory out) {
        uint256 n = _results.length;
        if (from > n) from = n;
        if (from + count > n) count = n - from;
        out = new Result[](count);
        for (uint256 i; i < count; ++i) out[i] = _results[from + i];
    }

    // ---------------------------------------------------------------- internals

    function _endRun(uint256 runId, uint64 exitAt, uint64 priceAt, bool playerExit) private {
        Run storage r = _runs[runId];
        Sealed storage s = _sealed[runId];
        uint256 exitIndex = oracle.indexAtOrBefore(r.market, priceAt);
        // an expiry takes the first checkpoint after the end (within the grace), not a later one; or the one
        // its player just wrote in this transaction
        if (playerExit) {
            (exitIndex, , , ) = oracle.latest(r.market);
        } else if (priceAt > exitAt) {
            uint256 atEnd = oracle.indexAtOrBefore(r.market, exitAt);
            if (exitIndex > atEnd) exitIndex = atEnd + 1;
        }
        r.exitIndex = uint32(exitIndex);
        (uint32 ml, uint32 ms, uint64 exitPrice) = ladder.multipliers(r.market, r.entryIndex, exitIndex, r.startAt, TOP_STEP);
        r.status = RunStatus.Ended;
        r.endAt = exitAt;
        r.exitPrice = exitPrice;
        r.multLong = ml;
        r.multShort = ms;
        uint64 t = exitAt > r.startAt ? exitAt - r.startAt : 0;
        r.topStep = uint8(t / STEP_SECONDS > TOP_STEP ? TOP_STEP : t / STEP_SECONDS);

        euint32 mult = FHE.select(s.long, FHE.asEuint32(ml), FHE.asEuint32(ms));
        if (r.packed) {
            // the cap is encrypted: pick among the capped paths on ciphertexts
            uint8[3] memory caps = [uint8(1), 2, 4];
            for (uint256 k; k < 3; ++k) {
                (uint32 cl, uint32 cs, ) = ladder.multipliers(r.market, r.entryIndex, exitIndex, r.startAt, caps[k]);
                mult = FHE.select(FHE.eq(s.cap, caps[k]), FHE.select(s.long, FHE.asEuint32(cl), FHE.asEuint32(cs)), mult);
            }
        }
        // interest on what the position borrowed, (POSITION_LEVERAGE - 1) x the stake, for the run's time
        euint64 interest = FHE.div(FHE.mul(s.paid, borrowAprBps * borrowedTenthSeconds(t)), interestDivisor);
        euint64 gross = FHE.div(FHE.mul(s.paid, FHE.asEuint64(mult)), SCALE);
        // the reserve could not lend: no leverage was taken, the stake goes back as it came
        ebool funded = FHE.eq(s.lent, MAX_PAYOUT);
        euint64 charged = FHE.select(funded, FHE.min(interest, gross), FHE.asEuint64(0));
        euint64 value = FHE.select(funded, FHE.sub(gross, charged), s.paid);
        mult = FHE.select(funded, mult, FHE.asEuint32(SCALE));

        s.mult = mult;
        FHE.allowThis(mult);
        FHE.allow(mult, r.player);
        s.value = value;
        s.interest = charged;
        _own64(value, r.player);
        _own64(charged, r.player);

        // close the real position with the desk: the long sells, the short buys back and returns
        FHE.allowTransient(s.long, address(desk));
        FHE.allowTransient(s.qty, address(desk));
        FHE.allowTransient(s.cashLeg, address(desk));
        (euint64 cashIn, euint64 cashPaid) = desk.close(runId, marketTokens[r.market], s.long, s.qty, s.cashLeg, exitPrice);
        // the real position: stake + what came in - what went out - interest on the loan (never below 0)
        euint64 posIn = FHE.add(s.paid, cashIn);
        euint64 posOut = FHE.add(cashPaid, FHE.select(funded, interest, FHE.asEuint64(0)));
        s.position = FHE.select(FHE.ge(posIn, posOut), FHE.sub(posIn, posOut), FHE.asEuint64(0));
        _own64(s.position, r.player);

        _pay(r.player, value);
        // everything else goes back to the reserve: stake + lent + cash in - cash out - payout. It repays the
        // loan with its interest, and settles the game boost (payout minus the real position) either way.
        euint64 held = FHE.add(posIn, s.lent);
        euint64 owed = FHE.add(cashPaid, value);
        _pay(address(reserve), FHE.select(FHE.ge(held, owed), FHE.sub(held, owed), FHE.asEuint64(0)));
        FHE.allowTransient(s.lent, address(reserve));
        FHE.allowTransient(charged, address(reserve));
        reserve.repaid(runId, MAX_PAYOUT, s.lent, charged);
        emit InterestCharged(runId, FHE.toBytes32(charged));
        emit PositionClosed(runId, exitPrice, FHE.toBytes32(s.position));
        emit RunEnded(runId, r.player, exitAt, exitPrice, ml, ms, FHE.toBytes32(s.value));
    }

    function _record(address player, int32 pnlPpm, uint32 runId) private {
        _results.push(Result({player: player, timestamp: uint64(block.timestamp), pnlPpm: pnlPpm, runId: runId}));
        emit ResultRecorded(_results.length - 1, player, pnlPpm, runId);
    }

    function _pay(address to, euint64 amount) private {
        FHE.allowTransient(amount, address(token));
        token.confidentialTransfer(to, amount);
    }

    function _own(ebool v, address player) private {
        FHE.allowThis(v);
        FHE.allow(v, player);
    }

    function _own64(euint64 v, address player) private {
        FHE.allowThis(v);
        FHE.allow(v, player);
    }
}
