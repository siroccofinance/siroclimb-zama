// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/// @title ClimbFaucet
/// @notice Test stakes in one call: mints the public underlying of Zama's confidential USDC
///         (USDCMock, publicly mintable on Sepolia) and wraps it straight to the player, who
///         receives an encrypted cUSDCMock balance. Anyone may claim for anyone (the browser's
///         session key tops the player up without a wallet pop-up), once per cooldown per account.
contract ClimbFaucet {
    IMintableERC20 public immutable underlying;
    IERC7984ERC20Wrapper public immutable wrapper;
    /// @notice Underlying units minted and wrapped per claim.
    uint256 public immutable amount;
    uint256 public immutable cooldown;

    mapping(address account => uint256) public lastClaim;

    error FaucetCooldown(address account, uint256 availableAt);

    event Claimed(address indexed account, address indexed by, uint256 amount);

    constructor(IERC7984ERC20Wrapper wrapper_, uint256 amount_, uint256 cooldown_) {
        wrapper = wrapper_;
        underlying = IMintableERC20(wrapper_.underlying());
        amount = amount_;
        cooldown = cooldown_;
        IERC20(address(underlying)).approve(address(wrapper_), type(uint256).max);
    }

    function claim() external {
        _claim(msg.sender);
    }

    function claimFor(address account) external {
        _claim(account);
    }

    /// @notice Seconds until `account` may claim again (0 = now).
    function waitOf(address account) external view returns (uint256) {
        uint256 last = lastClaim[account];
        if (last == 0 || block.timestamp >= last + cooldown) return 0;
        return last + cooldown - block.timestamp;
    }

    function _claim(address account) private {
        uint256 last = lastClaim[account];
        if (last != 0 && block.timestamp < last + cooldown) revert FaucetCooldown(account, last + cooldown);
        lastClaim[account] = block.timestamp;
        underlying.mint(address(this), amount);
        wrapper.wrap(account, amount);
        emit Claimed(account, msg.sender, amount);
    }
}
