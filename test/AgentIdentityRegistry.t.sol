// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentIdentityRegistry} from "../src/AgentIdentityRegistry.sol";

contract AgentIdentityRegistryTest is Test {
    AgentIdentityRegistry internal reg;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB   = address(0xB0B);

    function setUp() public {
        reg = new AgentIdentityRegistry();
    }

    function test_Register() public {
        uint256 tokenId = reg.registerAgent(ALICE, "https://alice.example/card.json", "alice.agent911.eth", ALICE);
        assertEq(reg.ownerOf(tokenId), ALICE);

        AgentIdentityRegistry.AgentCard memory card = reg.agentOf(tokenId);
        assertEq(card.uri, "https://alice.example/card.json");
        assertEq(card.ensName, "alice.agent911.eth");
        assertEq(card.operator, ALICE);
    }

    function test_Reputation_Accumulates() public {
        uint256 tokenId = reg.registerAgent(ALICE, "uri", "alice", ALICE);

        vm.prank(BOB);
        reg.submitFeedback(tokenId, 10, "tx://0xdeadbeef");
        vm.prank(BOB);
        reg.submitFeedback(tokenId, 15, "tx://0xcafe");
        vm.prank(BOB);
        reg.submitFeedback(tokenId, -5, "tx://0xbad");

        assertEq(reg.reputation(tokenId), 20);
        assertEq(reg.feedbackCount(tokenId), 3);
    }

    function test_Validation() public {
        uint256 tokenId = reg.registerAgent(ALICE, "uri", "alice", ALICE);
        bytes32 opId = keccak256("op/1");
        reg.recordValidation(tokenId, opId, true);
        assertTrue(reg.validated(tokenId, opId));
    }

    function test_SetOperator_OwnerOnly() public {
        uint256 tokenId = reg.registerAgent(ALICE, "uri", "alice", ALICE);
        vm.expectRevert(bytes("not owner"));
        reg.setOperator(tokenId, BOB);

        vm.prank(ALICE);
        reg.setOperator(tokenId, BOB);
        assertEq(reg.agentOf(tokenId).operator, BOB);
    }
}
