// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {WatchdogQuorum}    from "../src/WatchdogQuorum.sol";
import {Agent911PolicyNFT} from "../src/Agent911PolicyNFT.sol";
import {Agent911Vault}    from "../src/Agent911Vault.sol";
import {MockERC20}        from "../src/mocks/MockERC20.sol";

/// @dev forge script script/Deploy.s.sol \
///        --rpc-url zerog_testnet --broadcast --private-key $PRIVATE_KEY
///
/// Writes a deployment record to stdout; consumers snapshot it to
/// deployments/0g-testnet.json (or wherever they track it). Also
/// deploys a MockERC20 so the demo has something to rescue on testnet.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console2.log("Deployer:", deployer);
        console2.log("ChainId :", block.chainid);

        vm.startBroadcast(pk);

        Agent911PolicyNFT nft    = new Agent911PolicyNFT();
        WatchdogQuorum    quorum = new WatchdogQuorum(nft);
        Agent911Vault     vault  = new Agent911Vault(quorum, nft);
        MockERC20         usdc   = new MockERC20("USD Coin (mock)", "mUSDC", 6);

        // Mint 1M mUSDC to the deployer so they can seed the vault for demos
        usdc.mint(deployer, 1_000_000 * 1e6);

        vm.stopBroadcast();

        console2.log("WatchdogQuorum   :", address(quorum));
        console2.log("Agent911PolicyNFT:", address(nft));
        console2.log("Agent911Vault    :", address(vault));
        console2.log("MockERC20 (mUSDC):", address(usdc));
    }
}
