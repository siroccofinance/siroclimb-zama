// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, ebool, euint8, euint32, euint64, externalEbool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";
import {ClimbPriceOracle} from "./ClimbPriceOracle.sol";
import {ClimbLadder} from "./ClimbLadder.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title Siroclimb
/// @notice The Sirocco climbing game on the Zama Protocol: pick a market, go long or short, the
///         leverage climbs from 1x to 4x every 6 seconds over a 60 second run, cash out whenever.
///
/// What is confidential (see README, "Confidentiality design"):
///  - the side (long / short) of every run is an encrypted `ebool`: nobody can copy or fade a
///    player, or the crowd of a round;
///  - the stake of a solo run is an encrypted `euint64` in Zama's confidential USDC (ERC-7984);
///  - a run's value is computed on ciphertexts: the contract computes, in clear, what a long and
///    a short would have made on the public oracle path (`multLong`, `multShort`), then picks one
///    with the encrypted side (`FHE.select`) and multiplies the encrypted stake by it. The payout
///    is an encrypted transfer in the same transaction: money never waits for a decryption;
///  - round standings stay encrypted while the round is live and are revealed once at the end by
///    public decryption, verified on chain with the KMS proof (`FHE.checkSignatures`);
///  - leverage packs are drawn with the on-chain encrypted PRNG and stay private: a packed run's
///    leverage cap is selected on ciphertexts.
///
/// Every lifecycle step after a player's own action is permissionless (`settleRun`, `closeRound`,
/// `finalizeRound`, price pushes), so the players' browsers can run the game with nothing else.
contract Siroclimb is ZamaEthereumConfig, Ownable2Step {
    // ---------------------------------------------------------------- constants

    uint8 public constant TOP_STEP = 6;
    uint64 public constant STEP_SECONDS = 6;
    uint64 public constant RUN_SECONDS = 60;
    /// @notice Multipliers are fixed point with 6 decimals: 1_000_000 = the stake back.
    uint32 public constant SCALE = 1_000_000;
    uint32 public constant MAX_MULT = 10 * SCALE;
    uint64 public constant MAX_STAKE = 100_000_000; // 100 cUSDC (6 decimals)
    uint64 public constant MAX_PAYOUT = (MAX_STAKE * MAX_MULT) / SCALE;
    /// @notice The entry price of a solo run must be at most this old (Sepolia inclusion can take
    ///         a few blocks); a fallback price can ride along to refresh it in the same transaction.
    uint64 public constant MAX_ENTRY_AGE = 60;
    uint256 public constant MAX_ROUND_PLAYERS = 24;
    uint64 public constant ROUND_REFUND_AFTER = 1 days;
    uint64 public constant PACK_COOLDOWN = 10 minutes;
    /// @notice House bankroll top-up (testnet: USDCMock is publicly mintable), in token units.
    uint256 public constant RESERVE_REFILL = 1_000_000 * 1e6;

    // ---------------------------------------------------------------- types

    enum RunStatus {
        None,
        Live,
        Ended
    }

    enum RoundStatus {
        None,
        Open, // joinable until startsAt, live until endsAt
        Closed, // standings made publicly decryptable
        Finalized, // standings verified with the KMS proof, prizes paid
        Refunded // the KMS never answered: every entry refunded
    }

    struct Run {
        address player;
        uint8 market;
        bool inRound;
        RunStatus status;
        bool packed;
        uint8 topStep; // ladder step reached at the exit (before any pack cap)
        uint32 roundId;
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
        euint64 value; // payout of a solo run
        euint32 mult; // the player's own multiplier (selected with the encrypted side)
        euint32 score; // rounds: mult + 1 when funded, 0 when not
        euint8 cap; // packed runs: encrypted top ladder step
        ebool funded; // rounds: paid == entry
    }

    struct Round {
        uint8 market;
        RoundStatus status;
        uint64 opensAt;
        uint64 startsAt;
        uint64 endsAt;
        uint64 entry;
        uint32 fundedCount;
        uint64 pot;
    }

    struct Result {
        address player;
        uint64 timestamp;
        int32 pnlPpm; // value / stake - 1, in millionths
        bool inRound;
        uint8 rank; // rounds: 1-based rank, 0 for solo
        uint32 ref; // run id (solo) or round id
        uint64 prize; // rounds: prize paid, token units
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
    uint64 public immutable roundEntry;
    uint64 public immutable joinSeconds;
    uint256 public immutable marketCount;
    /// @notice Markets rounds rotate over (Pyth-verified ones: players compete with each other).
    uint8[] public roundMarkets;

    Run[] private _runs;
    mapping(uint256 runId => Sealed) private _sealed;
    Round[] private _rounds;
    mapping(uint256 roundId => uint256[]) private _roundRuns;
    mapping(uint256 roundId => mapping(address player => uint256)) public runOfPlayerInRound; // runId + 1
    Result[] private _results;

    mapping(address player => string) public nameOf;
    mapping(address session => SessionGrant) public sessions;
    mapping(address player => address) public sessionOf;

    mapping(address player => euint8) private _packTier;
    mapping(address player => bool) public hasPack;
    mapping(address player => uint64) public lastPackAt;

    /// @notice Lower bound of the house's cUSDC that is not yet promised to a live solo run.
    uint256 public reserveFloor;

    // ---------------------------------------------------------------- errors / events

    error UnknownMarket(uint256 market);
    error BadLadder();
    error NotPlayer(uint256 runId);
    error WrongRunStatus(uint256 runId);
    error RunNotOver(uint256 runId, uint256 endsAt);
    error StaleEntry(uint256 market, uint256 checkpointAt);
    error RoundRun(uint256 runId);
    error RoundNotJoinable(uint256 roundId);
    error AlreadyJoined(uint256 roundId);
    error RoundFull(uint256 roundId);
    error RoundNotLive(uint256 roundId);
    error WrongRoundStatus(uint256 roundId);
    error RoundNotOver(uint256 roundId, uint256 endsAt);
    error TooEarly(uint256 at);
    error LengthMismatch();
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
        uint32 roundId,
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
    event RoundOpened(uint256 indexed roundId, uint8 market, uint64 opensAt, uint64 startsAt, uint64 endsAt, uint64 entry);
    event RoundJoined(uint256 indexed roundId, uint256 indexed runId, address indexed player);
    event RoundClosed(uint256 indexed roundId);
    event RoundFinalized(uint256 indexed roundId, uint32 fundedCount, uint64 pot);
    event RoundRefunded(uint256 indexed roundId);
    event ResultRecorded(uint256 indexed index, address indexed player, bool inRound, int32 pnlPpm, uint8 rank, uint64 prize);
    event PackOpened(address indexed player, bytes32 tierHandle);
    event PublishRequested(uint256 indexed runId, bytes32 multHandle);
    event ReserveRefilled(uint256 amount);

    constructor(
        address owner_,
        IERC7984 token_,
        ClimbLadder ladder_,
        uint64 roundEntry_,
        uint64 joinSeconds_,
        uint8[] memory roundMarkets_
    ) Ownable(owner_) {
        token = token_;
        ladder = ladder_;
        oracle = ladder_.oracle();
        roundEntry = roundEntry_;
        joinSeconds = joinSeconds_;
        marketCount = oracle.marketCount();
        roundMarkets = roundMarkets_;
        address underlying = IERC7984ERC20Wrapper(address(token_)).underlying();
        if (ladder_.SCALE() != SCALE || ladder_.MAX_MULT() != MAX_MULT) revert BadLadder();
        IERC20(underlying).approve(address(token_), type(uint256).max);
    }

    // ---------------------------------------------------------------- players and sessions

    /// @notice Lets a browser session key act for the caller (start runs, join rounds, cash out),
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

    // ---------------------------------------------------------------- solo runs

    /// @notice Opens a solo run. Side and stake are encrypted inputs (bound to the caller); the
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

        _reserve();
        emit RunStarted(runId, player, market, 0, r.startAt, price, r.packed, FHE.toBytes32(s.long), FHE.toBytes32(s.paid));
    }

    /// @notice Ends the caller's run now (solo: paid in the same transaction; round: the exit is
    ///         recorded and scored on ciphertexts). A signed Pyth update can ride along so the
    ///         exit is the freshest verified price.
    function cashOut(uint256 runId, bytes[] calldata pythUpdate) external payable {
        Run storage r = _runs[runId];
        if (r.player != playerOf(msg.sender)) revert NotPlayer(runId);
        if (r.status != RunStatus.Live) revert WrongRunStatus(runId);
        uint64 end = r.startAt + RUN_SECONDS;
        if (r.inRound) {
            Round storage rd = _rounds[r.roundId];
            if (block.timestamp < rd.startsAt) revert RoundNotLive(r.roundId);
            end = rd.endsAt;
        }
        if (pythUpdate.length != 0) oracle.pushPyth{value: msg.value}(pythUpdate);
        _endRun(runId, block.timestamp < end ? uint64(block.timestamp) : end);
    }

    /// @notice Permissionless: settles a solo run whose 60 seconds are over, at its last second.
    function settleRun(uint256 runId) external {
        Run storage r = _runs[runId];
        if (r.status != RunStatus.Live) revert WrongRunStatus(runId);
        if (r.inRound) revert RoundRun(runId);
        uint64 end = r.startAt + RUN_SECONDS;
        if (block.timestamp < end) revert RunNotOver(runId, end);
        _endRun(runId, end);
    }

    /// @notice Owner of a finished solo run: reveal its result for the leaderboard. Makes the
    ///         run's multiplier publicly decryptable (the stake stays private).
    function publishRun(uint256 runId) external {
        Run storage r = _runs[runId];
        if (r.player != playerOf(msg.sender)) revert NotPlayer(runId);
        if (r.status != RunStatus.Ended || r.inRound) revert WrongRunStatus(runId);
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
        _record(r.player, int32(int256(uint256(mult)) - int256(uint256(SCALE))), false, 0, uint32(runId), 0);
    }

    // ---------------------------------------------------------------- rounds

    /// @notice Joins round `roundId` with an encrypted side; the entry is a public amount moved
    ///         as an encrypted transfer. Joining `roundCount()` while no round is open opens it
    ///         on `nextRoundMarket()`.
    function joinRound(uint256 roundId, externalEbool side, bytes calldata inputProof) external returns (uint256 runId) {
        address player = playerOf(msg.sender);
        uint256 n = _rounds.length;
        bool open = n != 0 && block.timestamp < _rounds[n - 1].startsAt;
        if (roundId == n && !open) {
            uint8 market = nextRoundMarket();
            _rounds.push(
                Round({
                    market: market,
                    status: RoundStatus.Open,
                    opensAt: uint64(block.timestamp),
                    startsAt: uint64(block.timestamp) + joinSeconds,
                    endsAt: uint64(block.timestamp) + joinSeconds + RUN_SECONDS,
                    entry: roundEntry,
                    fundedCount: 0,
                    pot: 0
                })
            );
            Round storage nr = _rounds[n];
            emit RoundOpened(n, market, nr.opensAt, nr.startsAt, nr.endsAt, roundEntry);
        } else if (!open || roundId != n - 1) revert RoundNotJoinable(roundId);
        Round storage rd = _rounds[roundId];
        if (runOfPlayerInRound[roundId][player] != 0) revert AlreadyJoined(roundId);
        if (_roundRuns[roundId].length >= MAX_ROUND_PLAYERS) revert RoundFull(roundId);

        runId = _runs.length;
        _runs.push();
        Run storage r = _runs[runId];
        r.player = player;
        r.market = rd.market;
        r.inRound = true;
        r.status = RunStatus.Live;
        r.roundId = uint32(roundId);
        r.startAt = rd.startsAt;
        _roundRuns[roundId].push(runId);
        runOfPlayerInRound[roundId][player] = runId + 1;

        Sealed storage s = _sealed[runId];
        s.long = FHE.fromExternal(side, inputProof);
        euint64 amount = FHE.asEuint64(rd.entry);
        FHE.allowTransient(amount, address(token));
        s.paid = token.confidentialTransferFrom(player, address(this), amount);
        s.funded = FHE.eq(s.paid, rd.entry);
        _own(s.long, player);
        _own64(s.paid, player);
        FHE.allowThis(s.funded);
        FHE.allow(s.funded, player);
        emit RoundJoined(roundId, runId, player);
        emit RunStarted(runId, player, rd.market, uint32(roundId), rd.startsAt, 0, false, FHE.toBytes32(s.long), FHE.toBytes32(s.paid));
    }

    /// @notice Permissionless, after the round's end: one run still climbing exits at the bell.
    ///         Each exit costs about 1M gas on Sepolia, so a full round is closed in chunks: exits
    ///         first (any number of transactions), then `closeRound` (cheap once every run exited).
    function exitAtBell(uint256 runId) external {
        Run storage r = _runs[runId];
        if (!r.inRound || r.status != RunStatus.Live) revert WrongRunStatus(runId);
        Round storage rd = _rounds[r.roundId];
        if (block.timestamp < rd.endsAt) revert RoundNotOver(r.roundId, rd.endsAt);
        _endRun(runId, rd.endsAt);
    }

    /// @notice Permissionless, after the round's end: every run still climbing exits at the bell,
    ///         and every encrypted score becomes publicly decryptable (the standings reveal).
    function closeRound(uint256 roundId) external {
        Round storage rd = _rounds[roundId];
        if (rd.status != RoundStatus.Open) revert WrongRoundStatus(roundId);
        if (block.timestamp < rd.endsAt) revert RoundNotOver(roundId, rd.endsAt);
        uint256[] storage ids = _roundRuns[roundId];
        for (uint256 i; i < ids.length; ++i) {
            if (_runs[ids[i]].status == RunStatus.Live) _endRun(ids[i], rd.endsAt);
            FHE.makePubliclyDecryptable(_sealed[ids[i]].score);
        }
        rd.status = RoundStatus.Closed;
        emit RoundClosed(roundId);
    }

    /// @notice Permissionless: verifies the decrypted standings with the KMS proof, ranks the
    ///         players and pays the pot (50 / 30 / 20 %, ties share their places).
    /// @param scores decrypted scores in join order (0 = unfunded entry, else multiplier + 1)
    function finalizeRound(uint256 roundId, uint32[] calldata scores, bytes calldata proof) external {
        Round storage rd = _rounds[roundId];
        if (rd.status != RoundStatus.Closed) revert WrongRoundStatus(roundId);
        uint256[] storage ids = _roundRuns[roundId];
        uint256 n = ids.length;
        if (scores.length != n) revert LengthMismatch();
        bytes32[] memory handles = new bytes32[](n);
        for (uint256 i; i < n; ++i) handles[i] = FHE.toBytes32(_sealed[ids[i]].score);
        // the KMS signs abi.encode(score_0, ..., score_n-1): one 32-byte word per value
        uint256[] memory words = new uint256[](n);
        for (uint256 i; i < n; ++i) words[i] = scores[i];
        FHE.checkSignatures(handles, abi.encodePacked(words), proof);
        rd.status = RoundStatus.Finalized;
        _payRound(roundId, rd, ids, scores);
    }

    /// @notice Permissionless safety valve: a round the KMS never finalized refunds every entry.
    function refundRound(uint256 roundId) external {
        Round storage rd = _rounds[roundId];
        if (rd.status != RoundStatus.Closed) revert WrongRoundStatus(roundId);
        if (block.timestamp < rd.endsAt + ROUND_REFUND_AFTER) revert TooEarly(rd.endsAt + ROUND_REFUND_AFTER);
        rd.status = RoundStatus.Refunded;
        uint256[] storage ids = _roundRuns[roundId];
        for (uint256 i; i < ids.length; ++i) _pay(_runs[ids[i]].player, _sealed[ids[i]].paid);
        emit RoundRefunded(roundId);
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
    ) external view returns (bytes32 long, bytes32 paid, bytes32 value, bytes32 mult, bytes32 score, bytes32 cap) {
        Sealed storage s = _sealed[runId];
        return (
            FHE.toBytes32(s.long),
            FHE.toBytes32(s.paid),
            FHE.toBytes32(s.value),
            FHE.toBytes32(s.mult),
            FHE.toBytes32(s.score),
            FHE.toBytes32(s.cap)
        );
    }

    function roundCount() external view returns (uint256) {
        return _rounds.length;
    }

    function getRound(uint256 roundId) external view returns (Round memory round, uint256[] memory runIds) {
        return (_rounds[roundId], _roundRuns[roundId]);
    }

    /// @notice Score handles of a round, in join order (publicly decryptable once closed).
    function roundScoreHandles(uint256 roundId) external view returns (bytes32[] memory handles) {
        uint256[] storage ids = _roundRuns[roundId];
        handles = new bytes32[](ids.length);
        for (uint256 i; i < ids.length; ++i) handles[i] = FHE.toBytes32(_sealed[ids[i]].score);
    }

    /// @notice Market of the next round to open: the next one in the rotation that has a live
    ///         price (a checkpoint in the last 60 s), so a round never opens on a closed market.
    function nextRoundMarket() public view returns (uint8) {
        uint256 len = roundMarkets.length;
        uint256 k = _rounds.length;
        for (uint256 i; i < len; ++i) {
            uint8 m = roundMarkets[(k + i) % len];
            (, uint64 at, , ) = oracle.latest(m);
            if (block.timestamp <= at + 2 * MAX_ENTRY_AGE) return m;
        }
        return roundMarkets[k % len];
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

    function _endRun(uint256 runId, uint64 exitAt) private {
        Run storage r = _runs[runId];
        Sealed storage s = _sealed[runId];
        if (r.inRound && r.entryPrice == 0) {
            uint256 idx = oracle.indexAtOrBefore(r.market, r.startAt);
            r.entryIndex = uint32(idx);
            r.entryPrice = oracle.getCheckpoint(r.market, idx).price;
        }
        uint256 exitIndex = oracle.indexAtOrBefore(r.market, exitAt);
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
        s.mult = mult;
        FHE.allowThis(mult);
        FHE.allow(mult, r.player);

        if (r.inRound) {
            s.score = FHE.select(s.funded, FHE.add(mult, 1), FHE.asEuint32(0));
            FHE.allowThis(s.score);
            FHE.allow(s.score, r.player);
        } else {
            euint64 value = FHE.div(FHE.mul(s.paid, FHE.asEuint64(mult)), SCALE);
            s.value = value;
            _own64(value, r.player);
            _pay(r.player, value);
        }
        emit RunEnded(runId, r.player, exitAt, exitPrice, ml, ms, FHE.toBytes32(s.value));
    }

    function _payRound(uint256 roundId, Round storage rd, uint256[] storage ids, uint32[] calldata scores) private {
        uint256 n = ids.length;
        // order: score desc, then join order (insertion sort, n <= 24)
        uint256[] memory order = new uint256[](n);
        uint32 funded;
        for (uint256 i; i < n; ++i) {
            order[i] = i;
            if (scores[i] != 0) ++funded;
            uint256 j = i;
            while (j > 0 && scores[order[j - 1]] < scores[order[j]]) {
                (order[j - 1], order[j]) = (order[j], order[j - 1]);
                --j;
            }
        }
        uint64 pot = rd.entry * funded;
        rd.fundedCount = funded;
        rd.pot = pot;
        uint256 places = funded < 3 ? funded : 3;
        uint256 shareSum;
        for (uint256 k; k < places; ++k) shareSum += _prizeBps(k);
        uint256 pos;
        while (pos < n) {
            uint256 end = pos + 1;
            while (end < n && scores[order[end]] == scores[order[pos]]) ++end;
            uint64 prize;
            if (scores[order[pos]] != 0 && pos < places) {
                uint256 bps;
                for (uint256 k = pos; k < end && k < places; ++k) bps += _prizeBps(k);
                prize = uint64((uint256(pot) * bps) / shareSum / (end - pos));
            }
            for (uint256 k = pos; k < end; ++k) {
                uint256 i = order[k];
                if (scores[i] == 0) continue; // unfunded entry: paid nothing, ranks last, wins nothing
                address player = _runs[ids[i]].player;
                if (prize != 0) _pay(player, FHE.asEuint64(prize));
                int32 pnl = int32(int256(uint256(scores[i])) - 1 - int256(uint256(SCALE)));
                _record(player, pnl, true, uint8(pos + 1), uint32(roundId), prize);
            }
            pos = end;
        }
        emit RoundFinalized(roundId, funded, pot);
    }

    /// @dev Prize split of the pot: 50 / 30 / 20 % (renormalised when fewer than 3 are funded).
    function _prizeBps(uint256 place) private pure returns (uint256) {
        return place == 0 ? 5000 : place == 1 ? 3000 : 2000;
    }

    function _record(address player, int32 pnlPpm, bool inRound, uint8 rank, uint32 ref, uint64 prize) private {
        _results.push(
            Result({
                player: player,
                timestamp: uint64(block.timestamp),
                pnlPpm: pnlPpm,
                inRound: inRound,
                rank: rank,
                ref: ref,
                prize: prize
            })
        );
        emit ResultRecorded(_results.length - 1, player, inRound, pnlPpm, rank, prize);
    }

    /// @dev Keeps the house able to pay every live solo run at its maximum (testnet bankroll:
    ///      the underlying is publicly mintable and wrapped into the confidential token).
    function _reserve() private {
        if (reserveFloor < MAX_PAYOUT) {
            IERC7984ERC20Wrapper w = IERC7984ERC20Wrapper(address(token));
            IMintable(w.underlying()).mint(address(this), RESERVE_REFILL);
            w.wrap(address(this), RESERVE_REFILL);
            reserveFloor += RESERVE_REFILL / w.rate();
            emit ReserveRefilled(RESERVE_REFILL);
        }
        reserveFloor -= MAX_PAYOUT;
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
