// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MirrorToken
/// @notice Testnet ERC-20 with the name, symbol and decimals of a real token and a public `mint`
///         capped at 1,000,000 whole tokens per call, built like the underlyings of Zama's Sepolia
///         confidential tokens. Underlying of the Sirocco mirrors (TSLAx, NVDAx, AAPLx) and the
///         local stand-in for USDC.
contract MirrorToken is ERC20 {
    uint8 private immutable _decimals;
    uint256 public immutable maxMintPerCall;

    error MaxMintExceeded(uint256 amount, uint256 max);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        maxMintPerCall = 1_000_000 * 10 ** decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        if (amount > maxMintPerCall) revert MaxMintExceeded(amount, maxMintPerCall);
        _mint(to, amount);
    }
}
