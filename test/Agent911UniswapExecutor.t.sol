// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WatchdogQuorum}           from "../src/WatchdogQuorum.sol";
import {Agent911PolicyNFT}        from "../src/Agent911PolicyNFT.sol";
import {Agent911Vault}           from "../src/Agent911Vault.sol";
import {Agent911UniswapExecutor, ISwapRouter} from "../src/Agent911UniswapExecutor.sol";
import {MockERC20}               from "../src/mocks/MockERC20.sol";

/// A minimal SwapRouter mock so we can test the executor without a fork.
contract MockSwapRouter is ISwapRouter {
    // burn tokenIn, mint tokenOut to recipient at 1:2 rate for tests
    function exactInputSingle(ExactInputSingleParams calldata p) external payable override returns (uint256 amountOut) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn * 2;
        // Mint via MockERC20.mint if tokenOut is one of ours
        MockERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}

contract Agent911UniswapExecutorTest is Test {
    WatchdogQuorum             internal q;
    Agent911PolicyNFT           internal nft;
    Agent911Vault              internal vault;
    Agent911UniswapExecutor    internal exec;
    MockSwapRouter              internal router;
    MockERC20                   internal volatile_;
    MockERC20                   internal usdc;

    uint256 internal constant W1_PK = 0xA11CE;
    uint256 internal constant W2_PK = 0xB0B00;
    uint256 internal constant W3_PK = 0xCA7C0;

    address internal w1;
    address internal w2;
    address internal w3;

    address internal constant ALICE    = address(0xA11CE000A);
    address internal constant SAFE     = address(0x5AFE5AFE);

    bytes32 internal constant POLICY_ID    = keccak256("policy/exec/v1");
    bytes32 internal constant RUNBOOK_HASH = keccak256("runbook/exec/v1");
    bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
        "FailureAttestation(bytes32 policyId,bytes32 runbookHash,uint64 observedAt,uint64 expiry,uint256 chainId)"
    );

    function setUp() public {
        w1 = vm.addr(W1_PK);
        w2 = vm.addr(W2_PK);
        w3 = vm.addr(W3_PK);

        nft      = new Agent911PolicyNFT();
        q        = new WatchdogQuorum(nft);
        vault    = new Agent911Vault(q, nft);
        router   = new MockSwapRouter();
        exec     = new Agent911UniswapExecutor(q, nft, vault, router);
        volatile_ = new MockERC20("Volatile", "VOL", 18);
        usdc     = new MockERC20("USD Coin", "USDC", 6);

        // Alice mints policy + binds vault
        uint256 tokenId = nft.mintPolicy(ALICE, "ipfs://runbook.json", RUNBOOK_HASH, SAFE);
        vm.prank(ALICE);
        vault.bindPolicy(POLICY_ID, tokenId);

        // register quorum (NFT-owner gated)
        address[] memory ws = new address[](3);
        ws[0] = w1; ws[1] = w2; ws[2] = w3;
        vm.prank(ALICE);
        q.registerPolicy(POLICY_ID, tokenId, address(vault), RUNBOOK_HASH, ws, 2, 30, 0);

        // Alice deposits 1000 VOL into vault
        volatile_.mint(ALICE, 1000e18);
        vm.startPrank(ALICE);
        volatile_.approve(address(vault), 1000e18);
        vault.deposit(IERC20(address(volatile_)), 1000e18);
        vm.stopPrank();
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("WatchdogQuorum")),
            keccak256(bytes("1")),
            block.chainid,
            address(q)
        ));
    }

    function _sign(uint256 pk, uint64 observedAt, uint64 expiry) internal view returns (bytes memory) {
        bytes32 s = keccak256(abi.encode(ATTESTATION_TYPEHASH, POLICY_ID, RUNBOOK_HASH, observedAt, expiry, block.chainid));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(), s));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, digest);
        return abi.encodePacked(r, ss, v);
    }

    function test_RescueWithSwap_FullRoute() public {
        // Fire quorum
        uint64 expiry = uint64(block.timestamp + 5 minutes);
        WatchdogQuorum.Attestation[] memory atts = new WatchdogQuorum.Attestation[](2);
        atts[0] = WatchdogQuorum.Attestation({ observedAt: uint64(block.timestamp), expiry: expiry, signature: _sign(W1_PK, uint64(block.timestamp), expiry) });
        atts[1] = WatchdogQuorum.Attestation({ observedAt: uint64(block.timestamp), expiry: expiry, signature: _sign(W2_PK, uint64(block.timestamp), expiry) });
        q.confirmFailure(POLICY_ID, atts);

        // Keeper first sweeps VOL out of vault to executor, then runs swap
        vault.rescue(POLICY_ID, IERC20(address(volatile_)));
        assertEq(volatile_.balanceOf(SAFE), 1000e18, "base rescue put VOL at SAFE");

        // For the swap case, simulate the vault sending to the executor instead
        // (the production flow would have the runbook choose the path). Move VOL
        // from SAFE back to executor to replay the swap test deterministically.
        vm.prank(SAFE);
        volatile_.transfer(address(exec), 1000e18);

        // rescueWithSwap is now restricted to the policy NFT owner.
        vm.prank(ALICE);
        uint256 amountOut = exec.rescueWithSwap(
            POLICY_ID,
            1,
            Agent911UniswapExecutor.SwapPlan({
                tokenIn: address(volatile_),
                tokenOut: address(usdc),
                fee: 3000,
                amountOutMinimum: 2000e18, // MockSwapRouter gives 2x
                deadline: block.timestamp + 10 minutes
            })
        );

        assertEq(amountOut, 2000e18, "mock router returns 2x");
        assertEq(usdc.balanceOf(SAFE), 2000e18, "USDC lands at SAFE");
        assertEq(volatile_.balanceOf(address(exec)), 0, "executor drained");
    }

    function test_RescueWithSwap_RevertsWithoutQuorum() public {
        volatile_.mint(address(exec), 100e18);
        vm.prank(ALICE);
        vm.expectRevert(bytes("quorum not confirmed"));
        exec.rescueWithSwap(POLICY_ID, 1, Agent911UniswapExecutor.SwapPlan({
            tokenIn: address(volatile_),
            tokenOut: address(usdc),
            fee: 3000,
            amountOutMinimum: 0,
            deadline: block.timestamp + 10 minutes
        }));
    }

    /// @notice The exact MEV scenario: quorum has fired, an MEV searcher
    ///         calls rescueWithSwap with `amountOutMinimum = 0` to extract
    ///         value via a sandwich. With the auth gate, only the policy
    ///         NFT owner can call — searchers and other keepers revert.
    function test_RescueWithSwap_RevertsForNonOwner() public {
        // Fire quorum so we are past the quorum check.
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

        // Fund the executor so the swap path would otherwise execute.
        volatile_.mint(address(exec), 100e18);

        address mev = address(0xBADBADBAD);
        vm.prank(mev);
        vm.expectRevert(bytes("not policy NFT owner"));
        exec.rescueWithSwap(POLICY_ID, 1, Agent911UniswapExecutor.SwapPlan({
            tokenIn: address(volatile_),
            tokenOut: address(usdc),
            fee: 3000,
            amountOutMinimum: 0, // sandwich-friendly minOut
            deadline: block.timestamp + 10 minutes
        }));

        // The owner can still call (smoke test that the gate doesn't lock everyone out).
        vm.prank(ALICE);
        exec.rescueWithSwap(POLICY_ID, 1, Agent911UniswapExecutor.SwapPlan({
            tokenIn: address(volatile_),
            tokenOut: address(usdc),
            fee: 3000,
            amountOutMinimum: 200e18,
            deadline: block.timestamp + 10 minutes
        }));
        assertEq(usdc.balanceOf(SAFE), 200e18, "owner-call delivered USDC");
    }
}
