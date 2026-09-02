// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test fixtures. Never deployed to a real network.

contract MockERC20 {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// Basis points withheld on every transfer, to stand in for a
    /// fee-on-transfer token.
    uint256 public feeBps;

    constructor(string memory _name, uint256 _feeBps) {
        name = _name;
        feeBps = _feeBps;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        uint256 received = value - (value * feeBps) / 10_000;
        balanceOf[to] += received;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }
}

/// Returns false rather than reverting, the way some older tokens do.
contract LyingERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

interface IMockERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract MockBroker {
    /// tokenOut per tokenIn, in basis points. 20000 means two out for one in.
    uint256 public rateBps = 20_000;

    /// Extra tokenOut handed over beyond what swapIn reports, to stand in for a
    /// broker whose accounting and transfers disagree.
    uint256 public surplus;

    function setRate(uint256 bps) external {
        rateBps = bps;
    }

    function setSurplus(uint256 value) external {
        surplus = value;
    }

    function swapIn(
        address,
        bytes32,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) external returns (uint256 amountOut) {
        IMockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rateBps) / 10_000;
        require(amountOut >= amountOutMin, "min out");
        IMockERC20(tokenOut).transfer(msg.sender, amountOut + surplus);
    }
}
