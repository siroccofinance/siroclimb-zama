// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, ebool, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";

/// @title SiroccoDesk
/// @notice The Sirocco desk: where Siroclimb runs buy, sell, borrow and return the markets' real
///         confidential tokens (cTSLAx, cNVDAx, cAAPLx, cAMZNx, cXAUt, ctGBP). It holds inventories
///         of every market token and of cUSDC, quotes at the oracle price plus or minus `spreadBps`,
///         and lends its token inventory to shorts (its token-lending book).
///
/// Every amount is encrypted: quantities are `notional x 1e10 / price` on ciphertexts at a public
/// price (`FHE.mul`, `FHE.div` by a plaintext). The side is an encrypted bool and both legs of a
/// trade always move, one of them with an encrypted 0, so an observer sees the same transfers for a
/// long and a short:
///  - open: the desk sends the run `qty` tokens (a long buys them at the ask; a short borrows them),
///    the run pays `long ? notional : 0` cUSDC and sends back `long ? 0 : qty` tokens (a short sells
///    what it borrowed), the desk pays `long ? 0 : qty x bid` cUSDC;
///  - close: the run sends back `long ? qty : 0` tokens (a long sells them; a short's buy-back and
///    return cancel out), the desk pays `long ? qty x bid : 0` cUSDC, the run pays `long ? 0 : qty x ask`.
/// What is public: which market, when, and the public prices. Quantities, cash amounts and the side
/// are not. The desk's inventories are encrypted balances, readable by its owner only.
///
/// Only the game may trade (`setGame`, once). The game makes the desk its ERC-7984 operator for cUSDC
/// and every market token, so the desk pulls the run's legs itself.
contract SiroccoDesk is ZamaEthereumConfig, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Prices have 10 decimals; token amounts have 6 (cUSDC and every market token).
    uint64 public constant PRICE_ONE = 1e10;
    uint16 public constant BPS = 10_000;

    IERC7984 public immutable cash;
    /// @notice Half spread around the oracle price, in basis points: ask = price + spread, bid = price - spread.
    uint16 public immutable spreadBps;
    address public game;

    error NotGame();
    error GameAlreadySet();
    error BadSpread();

    event GameSet(address indexed game);
    event Opened(uint256 indexed runId, address indexed token, uint64 price, bytes32 qtyHandle);
    event Closed(uint256 indexed runId, address indexed token, uint64 price);
    event Stocked(address indexed token, uint256 publicAmount);

    constructor(address owner_, IERC7984 cash_, uint16 spreadBps_) Ownable(owner_) {
        if (spreadBps_ >= BPS) revert BadSpread();
        cash = cash_;
        spreadBps = spreadBps_;
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

    /// @notice The desk's quotes around a public price.
    function quotes(uint64 price) public view returns (uint64 bid, uint64 ask) {
        bid = uint64((uint256(price) * (BPS - spreadBps)) / BPS);
        ask = uint64((uint256(price) * (BPS + spreadBps)) / BPS);
    }

    /// @notice Opens a run's position in `token` at `price`. `notional` is the cUSDC the run puts in
    ///         (stake plus what it borrowed). Returns the tokens the run holds (long) or owes (short),
    ///         and its cash leg: what a long paid, or what a short's sale brought in.
    function open(
        uint256 runId,
        IERC7984 token,
        ebool long,
        euint64 notional,
        uint64 price
    ) external onlyGame returns (euint64 qty, euint64 cashLeg) {
        (uint64 bid, uint64 ask) = quotes(price);
        euint64 zero = FHE.asEuint64(0);
        // a long buys at the ask; a short borrows the same quantity, then sells it at the bid
        qty = _send(token, msg.sender, FHE.div(FHE.mul(notional, PRICE_ONE), ask));
        euint64 proceeds = FHE.div(FHE.mul(qty, bid), PRICE_ONE);
        _pull(cash, msg.sender, FHE.select(long, notional, zero));
        _pull(token, msg.sender, FHE.select(long, zero, qty));
        _send(cash, msg.sender, FHE.select(long, zero, proceeds));
        cashLeg = FHE.select(long, notional, proceeds);
        FHE.allowTransient(qty, msg.sender);
        FHE.allowTransient(cashLeg, msg.sender);
        emit Opened(runId, address(token), price, FHE.toBytes32(qty));
    }

    /// @notice Closes a run's position at `price`: a long sells its `qty` at the bid, a short buys
    ///         `qty` back at the ask and returns it. Returns what came in and what went out for the
    ///         run over its whole life: (long: sale, cost) or (short: sale at the open, buy-back).
    function close(
        uint256 runId,
        IERC7984 token,
        ebool long,
        euint64 qty,
        euint64 cashLeg,
        uint64 price
    ) external onlyGame returns (euint64 cashIn, euint64 cashOut) {
        (uint64 bid, uint64 ask) = quotes(price);
        euint64 zero = FHE.asEuint64(0);
        euint64 sale = FHE.div(FHE.mul(qty, bid), PRICE_ONE);
        euint64 buyBack = FHE.div(FHE.mul(qty, ask), PRICE_ONE);
        _pull(token, msg.sender, FHE.select(long, qty, zero));
        sale = _send(cash, msg.sender, FHE.select(long, sale, zero));
        buyBack = _pull(cash, msg.sender, FHE.select(long, zero, buyBack));
        cashIn = FHE.select(long, sale, cashLeg);
        cashOut = FHE.select(long, cashLeg, buyBack);
        FHE.allowTransient(cashIn, msg.sender);
        FHE.allowTransient(cashOut, msg.sender);
        emit Closed(runId, address(token), price);
    }

    // ---------------------------------------------------------------- inventory (owner)

    /// @notice Stocks the desk with `amount` of an ERC-7984 wrapper's public underlying (pulled from the
    ///         caller, wrapped here). The amount is public anyway (an ERC-20 transfer).
    function stock(IERC7984ERC20Wrapper wrapper, uint256 amount) external {
        IERC20 underlying = IERC20(wrapper.underlying());
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        underlying.forceApprove(address(wrapper), amount);
        wrapper.wrap(address(this), amount);
        emit Stocked(address(wrapper), amount);
    }

    /// @notice Lets the owner decrypt the desk's current balance of `token`.
    function revealInventoryTo(IERC7984 token, address viewer) external onlyOwner returns (euint64 balance) {
        balance = token.confidentialBalanceOf(address(this));
        FHE.allow(balance, viewer);
    }

    // ---------------------------------------------------------------- internals

    function _send(IERC7984 token, address to, euint64 amount) private returns (euint64 sent) {
        FHE.allowTransient(amount, address(token));
        sent = token.confidentialTransfer(to, amount);
    }

    function _pull(IERC7984 token, address from, euint64 amount) private returns (euint64 moved) {
        FHE.allowTransient(amount, address(token));
        moved = token.confidentialTransferFrom(from, address(this), amount);
    }
}
