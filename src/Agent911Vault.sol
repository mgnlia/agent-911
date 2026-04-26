// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {WatchdogQuorum} from "./WatchdogQuorum.sol";
import {Agent911PolicyNFT} from "./Agent911PolicyNFT.sol";

/// @title Agent911Vault
/// @notice Holds user funds for an autonomous agent. Once a WatchdogQuorum
///         confirms the agent has failed, *anyone* can trigger `rescue()`
///         to sweep funds to the safe address encoded in the linked policy NFT.
///
///         This is the canonical demo use case for the WatchdogQuorum primitive.
///         Runbook selection + routing stays in KeeperHub/off-chain executors;
///         this contract only enforces "quorum confirmed → funds to owner's safe".
contract Agent911Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    WatchdogQuorum   public immutable quorum;
    Agent911PolicyNFT public immutable policyNFT;

    // --- binding: policyId → policy-NFT tokenId ---
    mapping(bytes32 => uint256) public policyNftId;
    mapping(bytes32 => bool) public rescued; // one-shot per policy

    // --- events ---
    event PolicyBound(bytes32 indexed policyId, uint256 indexed tokenId);
    event Rescued(
        bytes32 indexed policyId,
        address indexed caller,
        address indexed safe,
        IERC20  token,
        uint256 amount
    );
    event Deposited(IERC20 indexed token, address indexed from, uint256 amount);

    constructor(WatchdogQuorum q, Agent911PolicyNFT p) {
        quorum = q;
        policyNFT = p;
    }

    /// @notice Bind a policyId (WatchdogQuorum namespace) to a policy-NFT tokenId.
    ///         Must be called by the NFT owner — which is also who benefits from
    ///         the rescue, so misconfiguration hurts only them.
    function bindPolicy(bytes32 policyId, uint256 tokenId) external {
        require(policyNFT.ownerOf(tokenId) == msg.sender, "not policy owner");
        require(policyNftId[policyId] == 0, "already bound");
        policyNftId[policyId] = tokenId;
        emit PolicyBound(policyId, tokenId);
    }

    /// @notice Anyone can deposit any ERC20; the vault has no opinions
    ///         about what it holds until rescue time.
    function deposit(IERC20 token, uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, msg.sender, amount);
    }

    /// @notice Sweep the entire balance of `token` to the safe address in
    ///         the policy NFT. Permissionless: quorum confirmation is the
    ///         only gate.
    /// @dev    One-shot per policyId. The `rescued` flag is the single source
    ///         of truth: once flipped, no future rescue (any token) can run
    ///         under this policyId. Without this entry-guard the empty-vault
    ///         "nothing to rescue" check is the only thing stopping a second
    ///         rescue, which fails the moment anyone deposits more tokens.
    function rescue(bytes32 policyId, IERC20 token) external nonReentrant {
        require(!rescued[policyId], "already rescued");
        require(quorum.isFailed(policyId), "quorum not confirmed");

        uint256 tokenId = policyNftId[policyId];
        require(tokenId != 0, "policy not bound");

        address safe = policyNFT.safeAddressOf(tokenId);
        require(safe != address(0), "no safe address");

        uint256 bal = token.balanceOf(address(this));
        require(bal > 0, "nothing to rescue");

        // Mark before external transfer (CEI). Combined with the entry guard
        // above this makes rescue strictly one-shot per policyId.
        rescued[policyId] = true;

        token.safeTransfer(safe, bal);
        emit Rescued(policyId, msg.sender, safe, token, bal);
    }
}
