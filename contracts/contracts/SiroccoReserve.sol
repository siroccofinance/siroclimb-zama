// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";

/// @title SiroccoReserve
/// @notice The Sirocco Reserve: a confidential cUSDC lending pool that funds Siroclimb's leverage.
///
/// Lenders deposit cUSDC and receive reserve shares, an ERC-7984 token (`rcUSDC`): every share
/// balance is encrypted. A share is worth `syncedAssets / syncedShares` cUSDC: the reserve's
/// assets grow with the borrow interest players pay and with the stakes they lose, and shrink with
/// what they win, so lenders carry the game's PnL.
///
/// Leverage: a run of stake S at leverage L has a notional of S x L, of which S x (L - 1) is
/// borrowed from the reserve; the borrowed amount climbs with the ladder. S is encrypted, so the
/// reserve commits liquidity in clear with the public bound of a run: at the start it lends
/// `MAX_PAYOUT` (what a 100 cUSDC stake can be paid at most) into the game as an encrypted transfer
/// of a public amount, and the game sends back `stake + lent - payout` at the end. Each live run is
/// thereby fully funded on its own: whatever lenders withdraw meanwhile, the payout of a live run is
/// already in the game. If the reserve cannot lend the full amount, the transfer moves 0 (ERC-7984)
/// and the run is a plain refund, without leverage; the outcome stays encrypted.
///
/// What is public, what is not:
///  - deposit and withdrawal amounts and every lender's shares: encrypted. Withdrawals are
///    all-or-nothing on ciphertexts (enough shares, enough free cUSDC), so a failed one moves 0;
///  - the reserve's total assets, total shares and total interest earned: encrypted between syncs,
///    revealed together at most every `SYNC_INTERVAL` by public decryption, checked on chain with
///    the KMS proof (`finalizeSync`). Share price, TVL and APY come from these synced aggregates;
///  - the liquidity committed to live runs (`lockedAssets`, the public bound per run): public.
///    Utilization is `lockedAssets / syncedAssets`.
contract SiroccoReserve is ERC7984, ZamaEthereumConfig, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Aggregates are revealed at most this often, so one sync mixes many runs and flows.
    uint64 public constant SYNC_INTERVAL = 10 minutes;
    /// @notice A sync the KMS never answered can be requested again after this long.
    uint64 public constant SYNC_TIMEOUT = 1 hours;
    uint256 private constant YEAR = 365 days;

    /// @notice Zama's confidential USDC (ERC-7984 wrapper of USDCMock on Sepolia).
    IERC7984ERC20Wrapper public immutable asset;
    /// @notice Borrow rate charged on the borrowed part of a run, per year, in basis points.
    uint16 public immutable borrowAprBps;
    /// @notice The game allowed to borrow (set once).
    address public game;

    /// @notice cUSDC committed to live runs (clear: the public bound of each run).
    uint256 public lockedAssets;
    uint256 public openLoans;

    // encrypted running totals (6 decimals)
    euint64 private _outstanding; // lent to live runs and not back yet (uninitialized = 0)
    euint64 private _interest; // borrow interest earned since launch (uninitialized = 0)

    // last synced aggregates (public, KMS-verified)
    uint64 public syncedAssets;
    uint64 public syncedShares;
    uint64 public syncedInterest;
    uint64 public syncedAt;
    uint64 public syncRequestedAt;
    bytes32[3] private _pending; // assets, shares, interest handles of the requested sync

    error NotGame();
    error GameAlreadySet();
    error SyncTooSoon(uint256 availableAt);
    error NoSyncPending();
    error ReserveFull(uint256 locked, uint256 assets);
    error ZeroAmount();

    event GameSet(address indexed game);
    event Deposited(address indexed lender, bytes32 sharesHandle, uint256 publicAmount);
    event WithdrawRequested(address indexed lender, bytes32 sharesHandle, bytes32 assetsHandle);
    event Lent(uint256 indexed runId, bytes32 lentHandle, uint256 lockedAssets);
    event Repaid(uint256 indexed runId, uint256 lockedAssets);
    event SyncRequested(uint64 at, bytes32 assetsHandle, bytes32 sharesHandle, bytes32 interestHandle);
    event Synced(uint64 at, uint64 assets, uint64 shares, uint64 interest);

    constructor(
        address owner_,
        IERC7984ERC20Wrapper asset_,
        uint16 borrowAprBps_
    ) ERC7984("Sirocco Reserve cUSDC", "rcUSDC", "") Ownable(owner_) {
        asset = asset_;
        borrowAprBps = borrowAprBps_;
        IERC20(asset_.underlying()).forceApprove(address(asset_), type(uint256).max);
    }

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    function setGame(address game_) external onlyOwner {
        if (game != address(0)) revert GameAlreadySet();
        game = game_;
        emit GameSet(game_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ---------------------------------------------------------------- lenders

    /// @notice Deposits an encrypted amount of cUSDC (the reserve must be the caller's ERC-7984
    ///         operator) for shares at the synced price.
    function deposit(externalEuint64 amount, bytes calldata inputProof) external returns (euint64 shares) {
        euint64 a = FHE.fromExternal(amount, inputProof);
        FHE.allowTransient(a, address(asset));
        euint64 moved = asset.confidentialTransferFrom(msg.sender, address(this), a);
        shares = _mint(msg.sender, _toShares(moved));
        emit Deposited(msg.sender, FHE.toBytes32(shares), 0);
    }

    /// @notice Deposits a public amount of the underlying USDC (wrapped into cUSDC here). The
    ///         amount is public anyway (an ERC-20 transfer), so the synced totals follow it at once.
    function depositUnderlying(uint256 amount) external returns (euint64 shares) {
        uint256 rate = asset.rate();
        uint64 units = uint64(amount / rate);
        if (units == 0) revert ZeroAmount();
        IERC20(asset.underlying()).safeTransferFrom(msg.sender, address(this), uint256(units) * rate);
        asset.wrap(address(this), uint256(units) * rate);
        uint64 s = syncedShares == 0 ? units : uint64((uint256(units) * syncedShares) / syncedAssets);
        shares = _mint(msg.sender, FHE.asEuint64(s));
        syncedAssets += units;
        syncedShares += s;
        emit Deposited(msg.sender, FHE.toBytes32(shares), units);
    }

    /// @notice Redeems an encrypted number of shares at the synced price. All or nothing on
    ///         ciphertexts: the caller must hold the shares and the reserve must hold the cUSDC
    ///         outside live runs; otherwise nothing moves (both amounts stay encrypted).
    function withdraw(externalEuint64 shares, bytes calldata inputProof) external returns (euint64 out) {
        euint64 s = FHE.fromExternal(shares, inputProof);
        euint64 owed = _toAssets(s);
        ebool ok = FHE.and(FHE.le(s, confidentialBalanceOf(msg.sender)), FHE.le(owed, asset.confidentialBalanceOf(address(this))));
        euint64 burned = _burn(msg.sender, FHE.select(ok, s, FHE.asEuint64(0)));
        out = FHE.select(ok, owed, FHE.asEuint64(0));
        FHE.allowTransient(out, address(asset));
        out = asset.confidentialTransfer(msg.sender, out);
        FHE.allow(out, msg.sender);
        emit WithdrawRequested(msg.sender, FHE.toBytes32(burned), FHE.toBytes32(out));
    }

    // ---------------------------------------------------------------- the game

    /// @notice Lends `amount` cUSDC (the public bound of a run) into the game for a new run.
    ///         Returns what actually moved: `amount`, or 0 if the reserve is short (encrypted).
    function lend(uint256 runId, uint64 amount) external onlyGame returns (euint64 lent) {
        if (lockedAssets + amount > syncedAssets) revert ReserveFull(lockedAssets + amount, syncedAssets);
        euint64 a = FHE.asEuint64(amount);
        FHE.allowTransient(a, address(asset));
        lent = asset.confidentialTransfer(msg.sender, a);
        _outstanding = FHE.add(_outstanding, lent);
        FHE.allowThis(_outstanding);
        FHE.allow(lent, msg.sender);
        lockedAssets += amount;
        ++openLoans;
        emit Lent(runId, FHE.toBytes32(lent), lockedAssets);
    }

    /// @notice The game sent the run's `stake + lent - payout` back; books the loan as closed.
    function repaid(uint256 runId, uint64 amount, euint64 lent, euint64 interest) external onlyGame {
        _outstanding = FHE.sub(_outstanding, lent);
        _interest = FHE.add(_interest, interest);
        FHE.allowThis(_outstanding);
        FHE.allowThis(_interest);
        lockedAssets -= amount;
        --openLoans;
        emit Repaid(runId, lockedAssets);
    }

    // ---------------------------------------------------------------- sync

    /// @notice Permissionless: makes the current totals publicly decryptable (assets = cUSDC held
    ///         + lent to live runs; shares; interest earned). At most every `SYNC_INTERVAL`.
    function requestSync() external {
        uint64 nowTs = uint64(block.timestamp);
        if (syncRequestedAt != 0 && nowTs < syncRequestedAt + SYNC_TIMEOUT) revert SyncTooSoon(syncRequestedAt + SYNC_TIMEOUT);
        if (syncedAt != 0 && nowTs < syncedAt + SYNC_INTERVAL) revert SyncTooSoon(syncedAt + SYNC_INTERVAL);
        euint64 assets = FHE.add(asset.confidentialBalanceOf(address(this)), _outstanding);
        euint64 interest = FHE.add(_interest, FHE.asEuint64(0)); // a handle even before the first run
        euint64 supply = FHE.add(confidentialTotalSupply(), FHE.asEuint64(0));
        FHE.makePubliclyDecryptable(assets);
        FHE.makePubliclyDecryptable(supply);
        FHE.makePubliclyDecryptable(interest);
        _pending = [FHE.toBytes32(assets), FHE.toBytes32(supply), FHE.toBytes32(interest)];
        syncRequestedAt = nowTs;
        emit SyncRequested(nowTs, _pending[0], _pending[1], _pending[2]);
    }

    /// @notice Permissionless: records the decrypted totals with the KMS proof.
    function finalizeSync(uint64 assets, uint64 shares, uint64 interest, bytes calldata proof) external {
        if (syncRequestedAt == 0) revert NoSyncPending();
        bytes32[] memory handles = new bytes32[](3);
        (handles[0], handles[1], handles[2]) = (_pending[0], _pending[1], _pending[2]);
        FHE.checkSignatures(handles, abi.encode(assets, shares, interest), proof);
        (syncedAssets, syncedShares, syncedInterest, syncedAt) = (assets, shares, interest, syncRequestedAt);
        syncRequestedAt = 0;
        emit Synced(syncedAt, assets, shares, interest);
    }

    function pendingSync() external view returns (bytes32 assets, bytes32 shares, bytes32 interest) {
        return (_pending[0], _pending[1], _pending[2]);
    }

    // ---------------------------------------------------------------- views

    /// @notice Interest on a borrowed amount: `paid x aprBps x borrowedTenthSeconds / (1e4 x 10 x YEAR)`.
    ///         The divisor of the rate, for the game.
    function interestDivisor() external pure returns (uint64) {
        return uint64(10_000 * 10 * YEAR);
    }

    /// @notice Share price with 6 decimals (1_000_000 = 1 cUSDC per share), from the last sync.
    function sharePrice() external view returns (uint256) {
        return syncedShares == 0 ? 1e6 : (uint256(syncedAssets) * 1e6) / syncedShares;
    }

    /// @notice Committed liquidity over synced assets, in basis points.
    function utilizationBps() external view returns (uint256) {
        return syncedAssets == 0 ? 0 : (lockedAssets * 10_000) / syncedAssets;
    }

    // ---------------------------------------------------------------- internals

    function _toShares(euint64 assets) private returns (euint64) {
        if (syncedShares == 0 || syncedAssets == 0) return assets;
        return FHE.asEuint64(FHE.div(FHE.mul(FHE.asEuint128(assets), uint128(syncedShares)), uint128(syncedAssets)));
    }

    function _toAssets(euint64 shares) private returns (euint64) {
        if (syncedShares == 0) return shares;
        return FHE.asEuint64(FHE.div(FHE.mul(FHE.asEuint128(shares), uint128(syncedAssets)), uint128(syncedShares)));
    }
}
