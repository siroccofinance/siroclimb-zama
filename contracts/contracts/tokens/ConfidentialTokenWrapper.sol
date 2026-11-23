// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/// @title ConfidentialTokenWrapper
/// @notice The OpenZeppelin ERC-7984 ERC-20 wrapper, as used by Zama's registry tokens.
/// @dev Local tests and local deployments only: on Sepolia the game uses Zama's own cUSDCMock,
///      resolved through the Wrappers Registry.
contract ConfidentialTokenWrapper is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(
        IERC20 underlying_,
        string memory name_,
        string memory symbol_
    ) ERC7984(name_, symbol_, "") ERC7984ERC20Wrapper(underlying_) {}
}
