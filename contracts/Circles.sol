// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Circles
/// @notice Membership registry for rotating savings groups.
///
/// This contract never holds, moves, or is approved to spend a single token.
/// Members pay each round's recipient directly, wallet to wallet. The registry
/// only records who is in a circle and whose turn it is, so there is nothing
/// here to drain, no admin key, and no upgrade path.
contract Circles {
    struct Circle {
        address organiser;
        uint128 amount; // per member per round, in the token's own units
        uint64 interval; // seconds between rounds
        uint64 startedAt; // 0 until the organiser starts it
    }

    uint256 public constant MAX_MEMBERS = 20;

    mapping(bytes32 => Circle) private _circles;
    mapping(bytes32 => address[]) private _members;
    mapping(bytes32 => mapping(address => bool)) public isMember;

    event Created(
        bytes32 indexed id,
        address indexed organiser,
        uint128 amount,
        uint64 interval,
        string name
    );
    event Joined(bytes32 indexed id, address indexed member, string name);
    event Started(bytes32 indexed id, uint64 startedAt, uint256 memberCount);

    error CircleExists();
    error NoSuchCircle();
    error AlreadyStarted();
    error NotStarted();
    error NotOrganiser();
    error AlreadyMember();
    error CircleFull();
    error TooFewMembers();
    error BadAmount();
    error BadInterval();

    /// @dev The id is derived from the creator and a salt they choose, so a
    /// caller can compute it before sending and two people cannot collide.
    function circleId(address organiser, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(organiser, salt));
    }

    function create(bytes32 salt, uint128 amount, uint64 interval, string calldata name)
        external
        returns (bytes32 id)
    {
        if (amount == 0) revert BadAmount();
        if (interval < 60) revert BadInterval();

        id = circleId(msg.sender, salt);
        if (_circles[id].organiser != address(0)) revert CircleExists();

        _circles[id] = Circle({
            organiser: msg.sender,
            amount: amount,
            interval: interval,
            startedAt: 0
        });
        _members[id].push(msg.sender);
        isMember[id][msg.sender] = true;

        emit Created(id, msg.sender, amount, interval, name);
        emit Joined(id, msg.sender, name);
    }

    function join(bytes32 id, string calldata name) external {
        Circle storage c = _circles[id];
        if (c.organiser == address(0)) revert NoSuchCircle();
        if (c.startedAt != 0) revert AlreadyStarted();
        if (isMember[id][msg.sender]) revert AlreadyMember();
        if (_members[id].length >= MAX_MEMBERS) revert CircleFull();

        _members[id].push(msg.sender);
        isMember[id][msg.sender] = true;
        emit Joined(id, msg.sender, name);
    }

    /// @notice Freezes membership and starts the clock.
    /// @dev Payout order is simply the order people joined. Onchain randomness
    /// is manipulable by whoever submits the transaction, so a shuffle here
    /// would look fairer than it is. Join order is transparent and cannot be
    /// gamed after the fact.
    function start(bytes32 id) external {
        Circle storage c = _circles[id];
        if (c.organiser == address(0)) revert NoSuchCircle();
        if (msg.sender != c.organiser) revert NotOrganiser();
        if (c.startedAt != 0) revert AlreadyStarted();
        if (_members[id].length < 2) revert TooFewMembers();

        c.startedAt = uint64(block.timestamp);
        emit Started(id, c.startedAt, _members[id].length);
    }

    function getCircle(bytes32 id)
        external
        view
        returns (
            address organiser,
            uint128 amount,
            uint64 interval,
            uint64 startedAt,
            address[] memory members
        )
    {
        Circle storage c = _circles[id];
        if (c.organiser == address(0)) revert NoSuchCircle();
        return (c.organiser, c.amount, c.interval, c.startedAt, _members[id]);
    }

    function memberCount(bytes32 id) external view returns (uint256) {
        return _members[id].length;
    }

    /// @notice Whose turn it is now, and which round we are in.
    function currentRound(bytes32 id) public view returns (uint256 round, address recipient) {
        Circle storage c = _circles[id];
        if (c.organiser == address(0)) revert NoSuchCircle();
        if (c.startedAt == 0) revert NotStarted();

        uint256 count = _members[id].length;
        round = (block.timestamp - c.startedAt) / c.interval;
        // The circle completes after one round per member and stays there.
        if (round >= count) round = count - 1;
        recipient = _members[id][round];
    }

    /// @notice What `member` owes right now, and to whom. Zero when it is their
    /// turn to collect, or when the circle has not started.
    function dues(bytes32 id, address member)
        external
        view
        returns (uint256 owed, address recipient, uint256 round)
    {
        Circle storage c = _circles[id];
        if (c.organiser == address(0)) revert NoSuchCircle();
        if (c.startedAt == 0 || !isMember[id][member]) return (0, address(0), 0);

        (round, recipient) = currentRound(id);
        owed = recipient == member ? 0 : c.amount;
    }
}
