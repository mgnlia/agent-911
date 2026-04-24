// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {WatchdogQuorum}    from "../src/WatchdogQuorum.sol";
import {Agent911PolicyNFT} from "../src/Agent911PolicyNFT.sol";
import {Agent911Vault}    from "../src/Agent911Vault.sol";
import {MockERC20}        from "../src/mocks/MockERC20.sol";

/// @dev The invariant the whole system hinges on:
///      1. A vault can only be drained AFTER WatchdogQuorum.isFailed == true.
///      2. A drained vault sent funds to the CURRENT owner's safe, never
///         anywhere else.
///
/// We restrict the harness to a small set of valid operations. If you can
/// break these invariants, you can steal user funds.
contract InvariantHandler is Test {
    WatchdogQuorum    public q;
    Agent911PolicyNFT public nft;
    Agent911Vault    public vault;
    MockERC20         public token;

    bytes32 public constant POLICY = keccak256("invariant/policy");
    bytes32 public constant RUN_H  = keccak256("invariant/runbook");

    constructor(WatchdogQuorum _q, Agent911PolicyNFT _n, Agent911Vault _v, MockERC20 _t) {
        q = _q;
        nft = _n;
        vault = _v;
        token = _t;
    }

    // Fuzz entrypoints — Foundry calls these randomly
    function deposit(address from, uint96 amount) external {
        vm.assume(from != address(0) && from != address(vault));
        amount = uint96(bound(amount, 1, 10_000_000_000e6));
        token.mint(from, amount);
        vm.startPrank(from);
        token.approve(address(vault), amount);
        vault.deposit(token, amount);
        vm.stopPrank();
    }

    /// Anyone can *try* to rescue — the invariant says this MUST revert
    /// unless quorum is confirmed.
    function tryRescue(address who) external {
        vm.prank(who);
        try vault.rescue(POLICY, token) {
            // If rescue succeeded, quorum MUST be confirmed.
            require(q.isFailed(POLICY), "rescue succeeded without quorum");
        } catch {
            /* expected revert path */
        }
    }
}

contract InvariantsTest is StdInvariant, Test {
    WatchdogQuorum    internal q;
    Agent911PolicyNFT internal nft;
    Agent911Vault    internal vault;
    MockERC20         internal token;
    InvariantHandler  internal h;

    address internal constant SAFE = address(0x5AFE5AFE);
    address internal constant ALICE = address(0xA11CE);
    bytes32 internal constant POLICY = keccak256("invariant/policy");
    bytes32 internal constant RUN_H  = keccak256("invariant/runbook");

    function setUp() public {
        q     = new WatchdogQuorum();
        nft   = new Agent911PolicyNFT();
        vault = new Agent911Vault(q, nft);
        token = new MockERC20("T", "T", 18);

        // Mint policy NFT and bind
        uint256 tokenId = nft.mintPolicy(ALICE, "uri", RUN_H, SAFE);
        vm.prank(ALICE);
        vault.bindPolicy(POLICY, tokenId);

        // Register a 2-of-3 quorum with throwaway watchdogs (signatures won't land)
        address[] memory ws = new address[](3);
        ws[0] = address(0x1); ws[1] = address(0x2); ws[2] = address(0x3);
        q.registerPolicy(POLICY, address(vault), RUN_H, ws, 2, 30, 0);

        h = new InvariantHandler(q, nft, vault, token);
        targetContract(address(h));
    }

    /// No pathway in InvariantHandler can confirm the quorum without valid
    /// sigs from {0x1, 0x2, 0x3} (which the handler cannot produce), so
    /// quorum MUST stay unconfirmed throughout the fuzz campaign.
    function invariant_QuorumNeverSpontaneouslyConfirms() public view {
        assertFalse(q.isFailed(POLICY), "quorum confirmed without valid sigs");
    }

    /// The SAFE address MUST have zero token balance as long as quorum is
    /// unconfirmed (because rescue is the only path to transfer to SAFE).
    function invariant_SafeUnfundedUntilQuorumConfirmed() public view {
        if (!q.isFailed(POLICY)) {
            assertEq(token.balanceOf(SAFE), 0, "safe funded without quorum");
        }
    }
}
