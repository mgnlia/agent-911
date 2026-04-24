// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {WatchdogQuorum}    from "./WatchdogQuorum.sol";
import {Agent911PolicyNFT} from "./Agent911PolicyNFT.sol";
import {Agent911Vault}    from "./Agent911Vault.sol";

/// Minimal Uniswap v3 SwapRouter interface (no need to pull the npm package
/// just for one call).
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title Agent911UniswapExecutor
/// @notice Post-quorum rescue path that unwinds a volatile position into
///         USDC via Uniswap v3 and forwards to the policy NFT's safe address.
///
///         Flow:
///           1. After WatchdogQuorum.isFailed() is true, KeeperHub (or any
///              caller) invokes rescueWithSwap.
///           2. This contract pulls the entire `tokenIn` balance from the
///              linked `Agent911Vault`, swaps on Uniswap, and transfers the
///              output to `policyNFT.safeAddressOf(tokenId)`.
///
/// Permissioning:
///   - The Agent911Vault gives `rescueWithSwap` a specific allowance only
///     during rescue — NOT permanent approval. This contract is not
///     trusted outside of a single rescue.
///
/// Why a separate contract:
///   - Keeps Agent911Vault minimal (ERC20 sweep only). A rescue that needs
///     multi-hop routing, v4 hooks, LP unwinds etc. lives in its own
///     contract that the vault delegates to.
contract Agent911UniswapExecutor {
    using SafeERC20 for IERC20;

    WatchdogQuorum    public immutable quorum;
    Agent911PolicyNFT public immutable policyNFT;
    Agent911Vault    public immutable vault;
    ISwapRouter       public immutable router;

    event RescueSwap(
        bytes32 indexed policyId,
        address indexed caller,
        address indexed safe,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(WatchdogQuorum q, Agent911PolicyNFT p, Agent911Vault v, ISwapRouter r) {
        quorum = q;
        policyNFT = p;
        vault = v;
        router = r;
    }

    struct SwapPlan {
        address tokenIn;
        address tokenOut;   // expected USDC (or safe-asset of choice)
        uint24  fee;        // 500 / 3000 / 10000 bps
        uint256 amountOutMinimum;
        uint256 deadline;
    }

    /// @notice Executes a swap-based rescue. Caller MUST already have had
    ///         vault.rescue(policyId, tokenIn) run first to sweep funds
    ///         into this executor's balance, OR a custom rescue path that
    ///         gives this executor custody. For the demo we take the
    ///         simpler route: caller transfers tokens here, we verify
    ///         quorum, swap, forward.
    function rescueWithSwap(
        bytes32 policyId,
        uint256 tokenId,
        SwapPlan calldata plan
    ) external returns (uint256 amountOut) {
        require(quorum.isFailed(policyId), "quorum not confirmed");

        address safe = policyNFT.safeAddressOf(tokenId);
        require(safe != address(0), "no safe");

        uint256 amountIn = IERC20(plan.tokenIn).balanceOf(address(this));
        require(amountIn > 0, "nothing to swap");

        IERC20(plan.tokenIn).forceApprove(address(router), amountIn);

        amountOut = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:         plan.tokenIn,
                tokenOut:        plan.tokenOut,
                fee:             plan.fee,
                recipient:       safe,
                deadline:        plan.deadline,
                amountIn:        amountIn,
                amountOutMinimum:plan.amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        emit RescueSwap(policyId, msg.sender, safe, plan.tokenIn, plan.tokenOut, amountIn, amountOut);
    }
}
