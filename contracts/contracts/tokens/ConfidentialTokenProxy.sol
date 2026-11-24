// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title ConfidentialTokenProxy
/// @notice The proxy of the Sirocco mirrors on Sepolia (cTSLAx, cNVDAx, cAAPLx, cAMZNx). Each one
///         points at Zama's own `ConfidentialWrapper` implementation, the very contract behind
///         Zama's cUSDCMock, ctGBPMock and cXAUtMock, and is initialized the same way (no pauser,
///         no observers, deny-list off). Only the wrapped underlying and the owner differ.
contract ConfidentialTokenProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory initData) ERC1967Proxy(implementation, initData) {}
}
