// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WatchdogQuorum} from "../src/WatchdogQuorum.sol";

contract WatchdogQuorumTest is Test {
    WatchdogQuorum internal q;

    // three watchdogs + one imposter
    uint256 internal constant W1_PK = 0xA11CE0001;
    uint256 internal constant W2_PK = 0xB0B0002;
    uint256 internal constant W3_PK = 0xCA7C0003;
    uint256 internal constant IMPOSTER_PK = 0xDEAD0000;

    address internal w1;
    address internal w2;
    address internal w3;
    address internal imposter;

    bytes32 internal constant POLICY_ID = keccak256("policy/alice/treasury/v1");
    bytes32 internal constant RUNBOOK_HASH = keccak256("runbook/alice/treasury/v1");
    address internal constant VAULT = address(0xBA5E);

    bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
        "FailureAttestation(bytes32 policyId,bytes32 runbookHash,uint64 observedAt,uint64 expiry,uint256 chainId)"
    );

    function setUp() public {
        w1 = vm.addr(W1_PK);
        w2 = vm.addr(W2_PK);
        w3 = vm.addr(W3_PK);
        imposter = vm.addr(IMPOSTER_PK);

        q = new WatchdogQuorum();

        address[] memory watchdogs = new address[](3);
        watchdogs[0] = w1;
        watchdogs[1] = w2;
        watchdogs[2] = w3;

        q.registerPolicy({
            policyId: POLICY_ID,
            vault: VAULT,
            runbookHash: RUNBOOK_HASH,
            watchdogs: watchdogs,
            threshold: 2,
            heartbeatTimeout: 30,
            expiry: 0
        });
    }

    // --- helpers ---

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("WatchdogQuorum")),
                keccak256(bytes("1")),
                block.chainid,
                address(q)
            )
        );
    }

    function _sign(uint256 pk, uint64 observedAt, uint64 expiry) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                POLICY_ID,
                RUNBOOK_HASH,
                observedAt,
                expiry,
                block.chainid
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _att(uint256 pk, uint64 observedAt, uint64 expiry)
        internal
        view
        returns (WatchdogQuorum.Attestation memory)
    {
        return WatchdogQuorum.Attestation({
            observedAt: observedAt,
            expiry: expiry,
            signature: _sign(pk, observedAt, expiry)
        });
    }

    // --- happy path ---

    function test_HappyPath_TwoOfThree() public {
        uint64 expiry = uint64(block.timestamp + 5 minutes);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = _att(W1_PK, uint64(block.timestamp), expiry);
        atts[1] = _att(W2_PK, uint64(block.timestamp), expiry);

        vm.expectEmit(true, false, false, false);
        emit WatchdogQuorum.FailureConfirmed(POLICY_ID, uint64(block.timestamp), new address[](0));

        q.confirmFailure(POLICY_ID, atts);

        assertTrue(q.isFailed(POLICY_ID), "policy should be confirmed failed");
    }

    function test_HappyPath_AllThreeSigned_EarlyExit() public {
        // Pass all three; contract should short-circuit after threshold met.
        uint64 expiry = uint64(block.timestamp + 5 minutes);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](3);
        atts[0] = _att(W1_PK, uint64(block.timestamp), expiry);
        atts[1] = _att(W2_PK, uint64(block.timestamp), expiry);
        atts[2] = _att(W3_PK, uint64(block.timestamp), expiry);

        q.confirmFailure(POLICY_ID, atts);
        assertTrue(q.isFailed(POLICY_ID));
    }

    // --- rejection cases ---

    function test_Reject_DuplicateSigner() public {
        uint64 expiry = uint64(block.timestamp + 5 minutes);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = _att(W1_PK, uint64(block.timestamp), expiry);
        atts[1] = _att(W1_PK, uint64(block.timestamp + 1), expiry); // same signer, different observedAt

        vm.expectRevert(bytes("duplicate signer"));
        q.confirmFailure(POLICY_ID, atts);
    }

    function test_Reject_UnauthorizedSigner() public {
        uint64 expiry = uint64(block.timestamp + 5 minutes);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = _att(W1_PK, uint64(block.timestamp), expiry);
        atts[1] = _att(IMPOSTER_PK, uint64(block.timestamp), expiry);

        vm.expectRevert(bytes("unauthorized signer"));
        q.confirmFailure(POLICY_ID, atts);
    }

    function test_Reject_InsufficientAttestations() public {
        uint64 expiry = uint64(block.timestamp + 5 minutes);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](1);
        atts[0] = _att(W1_PK, uint64(block.timestamp), expiry);

        vm.expectRevert(bytes("insufficient attestations"));
        q.confirmFailure(POLICY_ID, atts);
    }

    function test_Reject_ExpiredAttestation() public {
        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = _att(W1_PK, uint64(block.timestamp), uint64(block.timestamp + 10));
        atts[1] = _att(W2_PK, uint64(block.timestamp), uint64(block.timestamp + 10));

        // advance past expiry
        vm.warp(block.timestamp + 11);

        vm.expectRevert(bytes("attestation expired"));
        q.confirmFailure(POLICY_ID, atts);
    }

    function test_Reject_AlreadyConfirmed() public {
        uint64 expiry = uint64(block.timestamp + 5 minutes);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = _att(W1_PK, uint64(block.timestamp), expiry);
        atts[1] = _att(W2_PK, uint64(block.timestamp), expiry);

        q.confirmFailure(POLICY_ID, atts);

        vm.expectRevert(bytes("already confirmed"));
        q.confirmFailure(POLICY_ID, atts);
    }

    function test_Reject_PolicyExpired() public {
        // register a separate policy with near-term expiry
        bytes32 pid2 = keccak256("policy/bob/v1");
        address[] memory ws = new address[](2);
        ws[0] = w1;
        ws[1] = w2;

        q.registerPolicy({
            policyId: pid2,
            vault: VAULT,
            runbookHash: RUNBOOK_HASH,
            watchdogs: ws,
            threshold: 2,
            heartbeatTimeout: 30,
            expiry: uint64(block.timestamp + 60)
        });

        vm.warp(block.timestamp + 61);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = _attFor(pid2, W1_PK, uint64(block.timestamp), uint64(block.timestamp + 5 minutes));
        atts[1] = _attFor(pid2, W2_PK, uint64(block.timestamp), uint64(block.timestamp + 5 minutes));

        vm.expectRevert(bytes("policy expired"));
        q.confirmFailure(pid2, atts);
    }

    // --- helper variant for non-default policy ---

    function _attFor(bytes32 policyId, uint256 pk, uint64 observedAt, uint64 expiry)
        internal
        view
        returns (WatchdogQuorum.Attestation memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                policyId,
                RUNBOOK_HASH,
                observedAt,
                expiry,
                block.chainid
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return WatchdogQuorum.Attestation({
            observedAt: observedAt,
            expiry: expiry,
            signature: abi.encodePacked(r, s, v)
        });
    }

    // --- registration edge cases ---

    function test_Reject_DuplicatePolicyRegistration() public {
        address[] memory ws = new address[](3);
        ws[0] = w1;
        ws[1] = w2;
        ws[2] = w3;

        vm.expectRevert(bytes("policy exists"));
        q.registerPolicy({
            policyId: POLICY_ID,
            vault: VAULT,
            runbookHash: RUNBOOK_HASH,
            watchdogs: ws,
            threshold: 2,
            heartbeatTimeout: 30,
            expiry: 0
        });
    }

    function test_Reject_BadThreshold() public {
        address[] memory ws = new address[](2);
        ws[0] = w1;
        ws[1] = w2;

        vm.expectRevert(bytes("bad threshold"));
        q.registerPolicy({
            policyId: keccak256("new"),
            vault: VAULT,
            runbookHash: RUNBOOK_HASH,
            watchdogs: ws,
            threshold: 3, // > watchdogs.length
            heartbeatTimeout: 30,
            expiry: 0
        });
    }
}
