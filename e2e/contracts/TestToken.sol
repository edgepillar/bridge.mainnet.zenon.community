// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// A wrapped token as the bridge expects an "owned" one to be: the bridge mints
// on redeem and burns on unwrap (bridge.sol IToken). 8 decimals, like wZNN.
// For the e2e tests only.
contract TestToken is ERC20 {
    address public minter;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        minter = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function setMinter(address m) external {
        require(msg.sender == minter, "not minter");
        minter = m;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
