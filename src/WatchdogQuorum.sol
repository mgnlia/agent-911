// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title WatchdogQuorum
/// @notice External failure oracle for autonomous onchain agents.
///         Independent watchdogs sign EIP-712 FailureAttestations; an
///         m-of-n quorum fires FailureConfirmed, unblocking a preauthorized
///         recovery action at a linked vault.
///
///         This is the reusable primitive behind Agent-911. Vaults and
///         policy-NFT contracts read `isFailed(policyId)` to gate rescue.
contract WatchdogQuorum is EIP712 {
    using ECDSA for bytes32;

    // --- storage ---

    struct Policy {
        address vault;           // callback target; informational here
        bytes32 runbookHash;     // content-address of the encrypted runbook
        uint64  heartbeatTimeout;// seconds of silence before failure is signable
        uint64  expiry;          // absolute unix ts; 0 = never
        uint8   threshold;       // required sigs (2-of-N etc.)
        bool    confirmed;       // one-shot; once true, rescue is authorized
        uint64  confirmedAt;
        address[] watchdogs;     // authorized signers
    }

    mapping(bytes32 => Policy) private _policies;

    // --- events ---

    event PolicyRegistered(
        bytes32 indexed policyId,
        address indexed vault,
        bytes32 runbookHash,
        uint8   threshold,
        uint64  heartbeatTimeout
    );
    event FailureConfirmed(
        bytes32 indexed policyId,
        uint64 confirmedAt,
        address[] signers
    );

    // --- EIP-712 typehash ---
    // FailureAttestation(bytes32 policyId,bytes32 runbookHash,uint64 observedAt,uint64 expiry,uint256 chainId)
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "FailureAttestation(bytes32 policyId,bytes32 runbookHash,uint64 observedAt,uint64 expiry,uint256 chainId)"
    );

    constructor() EIP712("WatchdogQuorum", "1") {}

    // --- registration ---

    function registerPolicy(
        bytes32 policyId,
        address vault,
        bytes32 runbookHash,
        address[] calldata watchdogs,
        uint8 threshold,
        uint64 heartbeatTimeout,
        uint64 expiry
    ) external {
        require(_policies[policyId].threshold == 0, "policy exists");
        require(watchdogs.length >= threshold && threshold >= 1, "bad threshold");
        require(runbookHash != bytes32(0), "runbook hash required");

        Policy storage p = _policies[policyId];
        p.vault             = vault;
        p.runbookHash       = runbookHash;
        p.threshold         = threshold;
        p.heartbeatTimeout  = heartbeatTimeout;
        p.expiry            = expiry;
        for (uint256 i; i < watchdogs.length; ++i) {
            p.watchdogs.push(watchdogs[i]);
        }

        emit PolicyRegistered(policyId, vault, runbookHash, threshold, heartbeatTimeout);
    }

    // --- confirmation (bundled quorum tx) ---

    struct Attestation {
        uint64 observedAt;   // watchdog observation ts
        uint64 expiry;       // attestation expiry (anti-replay)
        bytes  signature;    // 65-byte sig over EIP-712 struct
    }

    /// @notice Submit m attestations from distinct authorized watchdogs.
    /// @dev   Recovers each signer, rejects duplicates and unauthorized,
    ///         emits FailureConfirmed once threshold is met.
    function confirmFailure(bytes32 policyId, Attestation[] calldata atts) external {
        Policy storage p = _policies[policyId];
        require(p.threshold != 0, "no policy");
        require(!p.confirmed, "already confirmed");
        require(p.expiry == 0 || block.timestamp < p.expiry, "policy expired");
        require(atts.length >= p.threshold, "insufficient attestations");

        address[] memory signers = new address[](atts.length);
        uint256 valid;

        for (uint256 i; i < atts.length; ++i) {
            require(block.timestamp < atts[i].expiry, "attestation expired");

            bytes32 structHash = keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    policyId,
                    p.runbookHash,
                    atts[i].observedAt,
                    atts[i].expiry,
                    block.chainid
                )
            );
            bytes32 digest = _hashTypedDataV4(structHash);
            address signer = digest.recover(atts[i].signature);

            require(_isAuthorized(p, signer), "unauthorized signer");
            // reject duplicate signers in this bundle
            for (uint256 j; j < valid; ++j) {
                require(signers[j] != signer, "duplicate signer");
            }
            signers[valid] = signer;
            ++valid;

            if (valid >= p.threshold) break;
        }

        require(valid >= p.threshold, "threshold not met");

        address[] memory trimmed = new address[](valid);
        for (uint256 k; k < valid; ++k) trimmed[k] = signers[k];

        p.confirmed   = true;
        p.confirmedAt = uint64(block.timestamp);

        emit FailureConfirmed(policyId, p.confirmedAt, trimmed);
    }

    // --- views ---

    function isFailed(bytes32 policyId) external view returns (bool) {
        return _policies[policyId].confirmed;
    }

    function policyOf(bytes32 policyId) external view returns (
        address vault,
        bytes32 runbookHash,
        uint64  heartbeatTimeout,
        uint64  expiry,
        uint8   threshold,
        bool    confirmed,
        uint64  confirmedAt,
        address[] memory watchdogs
    ) {
        Policy storage p = _policies[policyId];
        return (
            p.vault,
            p.runbookHash,
            p.heartbeatTimeout,
            p.expiry,
            p.threshold,
            p.confirmed,
            p.confirmedAt,
            p.watchdogs
        );
    }
    // --- internal ---

    function _isAuthorized(Policy storage p, address signer) private view returns (bool) {
        address[] storage ws = p.watchdogs;
        for (uint256 i; i < ws.length; ++i) {
            if (ws[i] == signer) return true;
        }
        return false;
    }
}
