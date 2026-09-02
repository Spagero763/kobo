// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface IBroker {
    function swapIn(
        address exchangeProvider,
        bytes32 exchangeId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) external returns (uint256);
}

/// @title Payout
/// @notice Sends one currency and delivers another, in a single transaction.
///
/// The sender holds only naira. This pulls exactly the amount they approved,
/// swaps it on Mento, and forwards the entire proceeds to the recipient. It
/// holds no balance between transactions, has no owner, and cannot be paused or
/// upgraded. Anything left here would be a bug, so the contract checks it is
/// empty of the outgoing token before it returns.
contract Payout {
    IBroker public immutable broker;

    error TransferInFailed();
    error ApproveFailed();
    error TransferOutFailed();
    error NothingReceived();
    error BadRecipient();
    error ResidueLeftBehind();

    event Sent(
        address indexed from,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address _broker) {
        broker = IBroker(_broker);
    }

    /// @param minOut Floor on what the recipient receives. The swap reverts
    /// below it, so a moving price cannot fill at an arbitrary rate.
    function send(
        address exchangeProvider,
        bytes32 exchangeId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut) {
        if (recipient == address(0) || recipient == address(this)) revert BadRecipient();

        if (!IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn)) revert TransferInFailed();
        // Approved for exactly this swap and consumed by it, so no standing
        // allowance is left for the broker to draw on later.
        if (!IERC20(tokenIn).approve(address(broker), amountIn)) revert ApproveFailed();

        amountOut = broker.swapIn(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn, minOut);
        if (amountOut == 0) revert NothingReceived();

        if (!IERC20(tokenOut).transfer(recipient, amountOut)) revert TransferOutFailed();

        // The whole point is that nothing accumulates here. If a token took a
        // fee on transfer, or the broker returned more than it sent, this
        // catches it rather than quietly stranding someone's money.
        if (IERC20(tokenOut).balanceOf(address(this)) != 0) revert ResidueLeftBehind();

        emit Sent(msg.sender, recipient, tokenIn, tokenOut, amountIn, amountOut);
    }
}
