// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title AgentIdentityRegistry
/// @notice ERC-8004-style trustless agent identity + reputation + validation.
///         Each agent identity is an ERC-721 token pointing at an off-chain
///         agent card (JSON) resolvable by ENS or direct URI.
///
/// @dev    Full ERC-8004 specifies three registries (Identity, Reputation,
///         Validation) with specific interfaces we haven't fully modelled yet.
///         This contract ships the minimum for the Agent-911 demo and a
///         migration path forward:
///           - Identity: register(agentCardURI, ensName) → tokenId
///           - Reputation: submitFeedback(tokenId, signal, metadataURI)
///           - Validation: requestValidation / recordValidation hooks
contract AgentIdentityRegistry is ERC721 {
    // --- storage ---

    struct AgentCard {
        string  uri;       // https://... or ipfs://... or 0g://...
        string  ensName;   // e.g. watchdog-1.agent-911.eth
        address operator;  // hot wallet that actually signs for this agent
    }

    mapping(uint256 => AgentCard) private _agents;

    struct Feedback {
        int8    signal;        // -100..100; positive = good, negative = bad
        string  metadataURI;   // off-chain evidence (tx hash, runbook, etc.)
        uint64  at;
        address reporter;
    }

    mapping(uint256 => Feedback[]) private _feedback;
    // cached reputation: running sum of signals, clamped to int256 for safety
    mapping(uint256 => int256) public reputation;

    mapping(uint256 => mapping(bytes32 => bool)) public validated; // tokenId → validatorOpId

    uint256 private _nextId = 1;

    // --- events ---
    event AgentRegistered(uint256 indexed tokenId, address indexed owner, string uri, string ensName);
    event OperatorUpdated(uint256 indexed tokenId, address indexed newOperator);
    event FeedbackSubmitted(uint256 indexed tokenId, address indexed reporter, int8 signal, string metadataURI);
    event ValidationRecorded(uint256 indexed tokenId, bytes32 indexed validatorOpId, bool approved);

    constructor() ERC721("Agent-911 Identity", "A911I") {}

    // --- identity ---

    function registerAgent(
        address to,
        string calldata uri,
        string calldata ensName,
        address operator
    ) external returns (uint256 tokenId) {
        require(bytes(uri).length > 0, "uri required");
        tokenId = _nextId++;
        _safeMint(to, tokenId);
        _agents[tokenId] = AgentCard({ uri: uri, ensName: ensName, operator: operator });
        emit AgentRegistered(tokenId, to, uri, ensName);
    }

    function setOperator(uint256 tokenId, address newOperator) external {
        require(ownerOf(tokenId) == msg.sender, "not owner");
        _agents[tokenId].operator = newOperator;
        emit OperatorUpdated(tokenId, newOperator);
    }

    function agentOf(uint256 tokenId) external view returns (AgentCard memory) {
        _requireOwned(tokenId);
        return _agents[tokenId];
    }

    // --- reputation ---

    function submitFeedback(uint256 tokenId, int8 signal, string calldata metadataURI) external {
        _requireOwned(tokenId); // only register'd tokens get feedback
        require(signal != 0, "signal must be nonzero");

        _feedback[tokenId].push(Feedback({
            signal: signal,
            metadataURI: metadataURI,
            at: uint64(block.timestamp),
            reporter: msg.sender
        }));
        reputation[tokenId] += int256(signal);

        emit FeedbackSubmitted(tokenId, msg.sender, signal, metadataURI);
    }

    function feedbackCount(uint256 tokenId) external view returns (uint256) {
        return _feedback[tokenId].length;
    }

    function feedbackAt(uint256 tokenId, uint256 idx) external view returns (Feedback memory) {
        return _feedback[tokenId][idx];
    }

    // --- validation ---

    /// @notice A designated validator (e.g. KeeperHub, a watchdog-committee DAO)
    ///         records whether an operation was correct. The operation ID is
    ///         meant to be the hash of (policyId, attestation hash, rescue tx).
    function recordValidation(uint256 tokenId, bytes32 validatorOpId, bool approved) external {
        _requireOwned(tokenId);
        validated[tokenId][validatorOpId] = approved;
        emit ValidationRecorded(tokenId, validatorOpId, approved);
        // Hook for future reputation impact:
        // if (!approved) reputation[tokenId] -= SLASH_WEIGHT;
    }
}
