// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {WatchdogQuorum}   from "../src/WatchdogQuorum.sol";
import {Agent911Vault}    from "../src/Agent911Vault.sol";
import {Agent911PolicyNFT} from "../src/Agent911PolicyNFT.sol";
import {MockERC20}        from "../src/mocks/MockERC20.sol";

/// End-to-end: policy minted → vault bound → quorum confirms failure → rescue sweeps to safe.
contract Agent911VaultTest is Test {
    WatchdogQuorum   internal q;
    Agent911PolicyNFT internal nft;
    Agent911Vault    internal vault;
    MockERC20        internal usdc;

    uint256 internal constant W1_PK = 0xA11CE;
    uint256 internal constant W2_PK = 0xB0B00;
    uint256 internal constant W3_PK = 0xCA7C0;

    address internal w1;
    address internal w2;
    address internal w3;

    address internal constant ALICE = address(0xA11CE000A);
    address internal constant SAFE  = address(0x5AFE5AFE);

    bytes32 internal constant POLICY_ID   = keccak256("policy/alice/vault/v1");
    bytes32 internal constant RUNBOOK_HASH = keccak256("runbook/alice/vault/v1");
    bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
        "FailureAttestation(bytes32 policyId,bytes32 runbookHash,uint64 observedAt,uint64 expiry,uint256 chainId)"
    );

    function setUp() public {
        w1 = vm.addr(W1_PK);
        w2 = vm.addr(W2_PK);
        w3 = vm.addr(W3_PK);

        q     = new WatchdogQuorum();
        nft   = new Agent911PolicyNFT();
        vault = new Agent911Vault(q, nft);
        usdc  = new MockERC20("USD Coin", "USDC", 6);

        // Alice mints a policy NFT pointing at her safe
        uint256 tokenId = nft.mintPolicy(
            ALICE,
            "ipfs://placeholder/encrypted-runbook.json",
            RUNBOOK_HASH,
            SAFE
        );
        assertEq(tokenId, 1);

        // Alice binds the policy to the vault
        vm.prank(ALICE);
        vault.bindPolicy(POLICY_ID, tokenId);

        // Register the quorum policy with the three watchdogs
        address[] memory ws = new address[](3);
        ws[0] = w1; ws[1] = w2; ws[2] = w3;
        q.registerPolicy({
            policyId: POLICY_ID,
            vault: address(vault),
            runbookHash: RUNBOOK_HASH,
            watchdogs: ws,
            threshold: 2,
            heartbeatTimeout: 30,
            expiry: 0
        });

        // Alice deposits 10,000 USDC into the vault
        usdc.mint(ALICE, 10_000e6);
        vm.startPrank(ALICE);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(usdc, 10_000e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(vault)), 10_000e6);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
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

    function test_EndToEndRescue() public {
        uint64 expiry = uint64(block.timestamp + 5 minutes);

        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = WatchdogQuorum.Attestation({
            observedAt: uint64(block.timestamp),
            expiry: expiry,
            signature: _sign(W1_PK, uint64(block.timestamp), expiry)
        });
        atts[1] = WatchdogQuorum.Attestation({
            observedAt: uint64(block.timestamp),
            expiry: expiry,
            signature: _sign(W2_PK, uint64(block.timestamp), expiry)
        });

        q.confirmFailure(POLICY_ID, atts);
        assertTrue(q.isFailed(POLICY_ID));

        // Anyone can trigger rescue once quorum confirmed
        address keeper = address(0xDEADB07);
        vm.prank(keeper);
        vault.rescue(POLICY_ID, usdc);

        // Funds land at the safe, not at the keeper
        assertEq(usdc.balanceOf(SAFE), 10_000e6, "safe receives rescue");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault drained");
        assertEq(usdc.balanceOf(keeper), 0, "keeper gets nothing");
    }

    function test_Rescue_RevertsWithoutQuorum() public {
        vm.expectRevert(bytes("quorum not confirmed"));
        vault.rescue(POLICY_ID, usdc);
    }

    function test_Rescue_IsOneShotPerPolicyId() public {
        // First rescue path (canonical happy path).
        uint64 expiry = uint64(block.timestamp + 5 minutes);
        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = WatchdogQuorum.Attestation({
            observedAt: uint64(block.timestamp),
            expiry: expiry,
            signature: _sign(W1_PK, uint64(block.timestamp), expiry)
        });
        atts[1] = WatchdogQuorum.Attestation({
            observedAt: uint64(block.timestamp),
            expiry: expiry,
            signature: _sign(W2_PK, uint64(block.timestamp), expiry)
        });
        q.confirmFailure(POLICY_ID, atts);

        vault.rescue(POLICY_ID, usdc);
        assertEq(usdc.balanceOf(SAFE), 10_000e6, "first rescue sweeps balance");
        assertTrue(vault.rescued(POLICY_ID), "rescued flag set");

        // Re-fund the vault — without an entry-guard the second rescue would
        // sweep again. The fix must reject before reading any balance.
        usdc.mint(address(vault), 5_000e6);
        assertEq(usdc.balanceOf(address(vault)), 5_000e6);

        vm.expectRevert(bytes("already rescued"));
        vault.rescue(POLICY_ID, usdc);

        // Funds remain in the vault — the safe was paid exactly once.
        assertEq(usdc.balanceOf(address(vault)), 5_000e6, "second rescue did NOT sweep");
        assertEq(usdc.balanceOf(SAFE), 10_000e6, "safe balance unchanged");
    }

    function test_TransferPolicyNFT_ChangesSafe() public {
        // Alice transfers the policy NFT to Bob who has a different safe preference
        address bob = address(0xB0B);
        address bobSafe = address(0xB0B5A3E);

        vm.prank(ALICE);
        nft.transferFrom(ALICE, bob, 1);

        // Bob updates the safe address on his now-owned policy
        vm.prank(bob);
        nft.setSafeAddress(1, bobSafe);

        // Quorum fires
        uint64 expiry = uint64(block.timestamp + 5 minutes);
        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = WatchdogQuorum.Attestation({
            observedAt: uint64(block.timestamp),
            expiry: expiry,
            signature: _sign(W1_PK, uint64(block.timestamp), expiry)
        });
        atts[1] = WatchdogQuorum.Attestation({
            observedAt: uint64(block.timestamp),
            expiry: expiry,
            signature: _sign(W2_PK, uint64(block.timestamp), expiry)
        });
        q.confirmFailure(POLICY_ID, atts);

        // Rescue goes to Bob's safe now, not Alice's — no vault redeploy needed.
        vault.rescue(POLICY_ID, usdc);
        assertEq(usdc.balanceOf(bobSafe), 10_000e6, "bob's safe receives rescue");
        assertEq(usdc.balanceOf(SAFE), 0, "alice's safe does not");
    }
}
