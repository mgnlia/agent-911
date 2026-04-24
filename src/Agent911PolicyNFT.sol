// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Agent911PolicyNFT
/// @notice ERC-7857-flavored policy token. Each NFT represents the
///         *rescue contract* for one agent: an encrypted runbook stored
///         off-chain (0G Storage) plus the `safeAddress` funds should
///         land in when the agent dies.
///
/// @dev    ERC-7857 draft calls for `transfer(from, to, id, sealedKey, proof)`
///         which re-encrypts metadata to the new owner. We stub the verified
///         re-encryption path (Day 7 polish) and ship the onchain state
///         needed for a working rescue today: encryptedURI, metadataHash,
///         safeAddress. Transferring the NFT changes who controls rescue.
contract Agent911PolicyNFT is ERC721, Ownable {
    // --- storage ---
    struct Policy {
        string  encryptedURI;   // points to the encrypted runbook on 0G Storage
        bytes32 metadataHash;   // keccak256 of the sealed runbook (binds content-address)
        address safeAddress;    // rescue destination (usually owner's safe multisig)
    }

    mapping(uint256 => Policy) private _policies;
    uint256 private _nextId = 1;

    // --- events ---
    event PolicyMinted(uint256 indexed tokenId, address indexed to, bytes32 metadataHash, address safeAddress);
    event PolicyUpdated(uint256 indexed tokenId, bytes32 newMetadataHash, string newEncryptedURI);
    event SafeAddressChanged(uint256 indexed tokenId, address indexed newSafe);

    // ERC-7857 authorized-usage hook (stub; real enforcement is off-chain until Day 7)
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor, bytes permissions);

    constructor() ERC721("Agent-911 Policy", "A911P") Ownable(msg.sender) {}

    // --- mutations ---

    function mintPolicy(
        address to,
        string calldata encryptedURI,
        bytes32 metadataHash,
        address safeAddress
    ) external returns (uint256 tokenId) {
        require(bytes(encryptedURI).length > 0, "uri required");
        require(metadataHash != bytes32(0), "hash required");
        require(safeAddress != address(0), "safe required");

        tokenId = _nextId++;
        _safeMint(to, tokenId);
        _policies[tokenId] = Policy({
            encryptedURI: encryptedURI,
            metadataHash: metadataHash,
            safeAddress: safeAddress
        });

        emit PolicyMinted(tokenId, to, metadataHash, safeAddress);
    }

    /// @notice Update an existing policy's runbook (owner only). This
    ///         allows agents to rotate strategy/key material without
    ///         re-deploying the vault.
    function updatePolicy(
        uint256 tokenId,
        string calldata newEncryptedURI,
        bytes32 newMetadataHash
    ) external {
        require(ownerOf(tokenId) == msg.sender, "not owner");
        require(bytes(newEncryptedURI).length > 0, "uri required");
        require(newMetadataHash != bytes32(0), "hash required");

        _policies[tokenId].encryptedURI = newEncryptedURI;
        _policies[tokenId].metadataHash = newMetadataHash;
        emit PolicyUpdated(tokenId, newMetadataHash, newEncryptedURI);
    }

    function setSafeAddress(uint256 tokenId, address newSafe) external {
        require(ownerOf(tokenId) == msg.sender, "not owner");
        require(newSafe != address(0), "safe required");
        _policies[tokenId].safeAddress = newSafe;
        emit SafeAddressChanged(tokenId, newSafe);
    }

    /// @notice ERC-7857 authorized-usage stub. Off-chain executors (KeeperHub,
    ///         sealed-inference nodes) read this log to decide what they're
    ///         allowed to do with the encrypted runbook.
    function authorizeUsage(uint256 tokenId, address executor, bytes calldata permissions) external {
        require(ownerOf(tokenId) == msg.sender, "not owner");
        emit UsageAuthorized(tokenId, executor, permissions);
    }

    // --- views ---

    function policy(uint256 tokenId) external view returns (Policy memory) {
        _requireOwned(tokenId);
        return _policies[tokenId];
    }

    function safeAddressOf(uint256 tokenId) external view returns (address) {
        _requireOwned(tokenId);
        return _policies[tokenId].safeAddress;
    }

    function metadataHashOf(uint256 tokenId) external view returns (bytes32) {
        _requireOwned(tokenId);
        return _policies[tokenId].metadataHash;
    }
}
