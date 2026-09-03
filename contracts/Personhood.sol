// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SelfVerificationRoot } from "@selfxyz/contracts/contracts/abstract/SelfVerificationRoot.sol";
import { ISelfVerificationRoot } from "@selfxyz/contracts/contracts/interfaces/ISelfVerificationRoot.sol";
import { SelfStructs } from "@selfxyz/contracts/contracts/libraries/SelfStructs.sol";
import { SelfUtils } from "@selfxyz/contracts/contracts/libraries/SelfUtils.sol";
import { IIdentityVerificationHubV2 } from "@selfxyz/contracts/contracts/interfaces/IIdentityVerificationHubV2.sol";

/// @title Personhood
/// @notice Binds a Celo address to a real person, proven by a passport through
/// Self, so a savings circle can tell one member from the same member twice.
///
/// It stores a nullifier and an address. The nullifier is derived from the
/// document and is stable for a person across every proof they ever make, but it
/// discloses nothing about them: no name, no number, no date of birth. None of
/// that is requested and none is kept.
contract Personhood is SelfVerificationRoot {
    /// @notice The person behind an address, or zero if unverified.
    mapping(address => uint256) public nullifierOf;

    /// @notice The address a person currently holds, or zero.
    mapping(uint256 => address) public addressOf;

    uint256 public verifiedCount;

    SelfStructs.VerificationConfigV2 public verificationConfig;
    bytes32 public verificationConfigId;

    event Verified(address indexed account, uint256 indexed nullifier);
    event Moved(uint256 indexed nullifier, address indexed from, address indexed to);

    constructor(
        address hub,
        string memory scopeSeed,
        SelfUtils.UnformattedVerificationConfigV2 memory config
    ) SelfVerificationRoot(hub, scopeSeed) {
        verificationConfig = SelfUtils.formatVerificationConfigV2(config);
        verificationConfigId = IIdentityVerificationHubV2(hub).setVerificationConfigV2(verificationConfig);
    }

    /// @notice True when this address has been proven to belong to a person.
    function isVerified(address account) external view returns (bool) {
        return nullifierOf[account] != 0;
    }

    /// @notice Whether two addresses are the same person. This is the check a
    /// circle needs: an address can be replaced, a person cannot.
    function sameHuman(address a, address b) external view returns (bool) {
        uint256 x = nullifierOf[a];
        return x != 0 && x == nullifierOf[b];
    }

    /**
     * @dev Called by the hub once a proof verifies.
     *
     * A person is allowed to move to a new address, because wallets get lost and
     * a permanent binding would lock someone out for good. Moving clears the old
     * address, so a person still holds exactly one at a time and cannot verify
     * twice to take two seats in the same circle.
     */
    function customVerificationHook(
        ISelfVerificationRoot.GenericDiscloseOutputV2 memory output,
        bytes memory
    ) internal override {
        address account = address(uint160(output.userIdentifier));
        uint256 nullifier = output.nullifier;

        address held = addressOf[nullifier];
        if (held == account) return;

        if (held != address(0)) {
            delete nullifierOf[held];
            emit Moved(nullifier, held, account);
        } else {
            verifiedCount += 1;
        }

        // An address that already belonged to someone else is released, so two
        // people cannot end up sharing one.
        uint256 previous = nullifierOf[account];
        if (previous != 0) delete addressOf[previous];

        nullifierOf[account] = nullifier;
        addressOf[nullifier] = account;
        emit Verified(account, nullifier);
    }

    function getConfigId(bytes32, bytes32, bytes memory) public view override returns (bytes32) {
        return verificationConfigId;
    }
}
