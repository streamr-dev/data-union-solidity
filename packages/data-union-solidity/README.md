# data-union-solidity

[![Discord Chat](https://img.shields.io/discord/801574432350928907.svg?label=Discord&logo=Discord&colorB=7289da)](https://discord.gg/FVtAph9cvz)

A Data Union (DU) is a collection of "members" that split token revenue sent to a single mainnet contract. This DU implementation uses the following components:

1. A **mainchain** contract where revenue is sent.
2. A **sidechain** contract that records joins and parts of group members, calculates earnings (in constant time), processes withdraw requests.
3. A **bridge** system that connects the mainchain and sidechain. We use the POA TokenBridge https://github.com/poanetwork/tokenbridge in AMB (Arbitrary Message Bridge) mode.

The purpose of the sidechain is to **facilitate cheap join and part operations**. The basic workflow looks like this:

0. Deploy factory contracts if needed. They are pre-baked into supplied docker images. See [Getting Started](#getting-started)
1. create a [DataUnionMainnet](https://github.com/streamr-dev/data-union-solidity/blob/master/contracts/DataUnionMainnet.sol) using [mainnetFactory.deployNewDataUnion()](https://github.com/streamr-dev/data-union-solidity/blob/b703721ad0b4aff0bde297b88293365ea2d37022/contracts/DataUnionFactoryMainnet.sol#L114)
    1. this will automatically create [DataUnionSidechain](https://github.com/streamr-dev/data-union-solidity/blob/master/contracts/DataUnionSidechain.sol) via the bridge. The address of the sidechain contract is [predictable](#note-about-addresses).
2. `addMembers()` on [DataUnionSidechain](https://github.com/streamr-dev/data-union-solidity/blob/master/contracts/DataUnionSidechain.sol)
3. send tokens to DataUnionMainnet and call `sendTokensToBridge()`
    1. this will "send" the tokens across the bridge to the sidechain DataUnionSidechain using the token mediator contracts
4. `withdraw()` members on DataUnionSidechain
    1. this will "send" the tokens across the bridge to mainchain to the members' addresses


# Overview of Components

## Factories

The DataUnionFactoryMainnet and DataUnionFactorySidechain contract produce DataUnionMainnet and DataUnionSidechain instances using a cloned template. There are some nuances to this pattern: When you supply constructor args to the template, the args [configure template's initial state](https://medium.com/@hayeah/diving-into-the-ethereum-vm-part-5-the-smart-contract-creation-process-cb7b6133b855). But clones don't see template's state because they call template code with [DELEGATECALL](https://ethervm.io/#F4). So the template's initial var values are invisible to clones. For this reason, our templates use 0-arg constructors plus an `initialize()` function that sets up up ownership. Both deploy and `initialize()` are performed in the same transaction by the factory, so there is no danger that ownership of the contract is claimed by the wrong party.

#### Note About Addresses
The factory contracts make use of [CREATE2](https://eips.ethereum.org/EIPS/eip-1014), which creates a contract address at predictable address given by:
`keccak256( 0xff ++ factory_address ++ salt ++ keccak256(contract_code))`

DataUnionFactoryMainnet creates DataUnionMainnet using
`salt = keccak256( some_string_name_as_bytes ++ deployer_address)`

Because the DU address is a function of (name, deployer), you cannot use the same name twice with the same deployer address. Use a **different name** each time.

then DataUnionMainnet sends a message over the bridge to DataUnionFactorySidechain to create the sidenet contract. In that case:
`salt = mainnet_address`

So you can always fetch the DataUnionSidechain address deterministically by calling `DataUnionMainnet.sidechainAddress()`.


## Mainchain Contract
DataUnionMainnet handles token passing and admin fees only. DataUnionMainnet does not have membership information because that is managed on the sidechain. Thus the bulk of the accounting is done on DataUnionSidechain.

## Sidechain Contract
DataUnionSidechain records member joins and parts made by "agents". Agents are set at init. They be added by the admin by calling `addJoinPartAgent(address)` or `addJoinPartAgents([address1, address2, ...])` and removed by calling `removeJoinPartAgent(address)`.

#### Accounting for Equal Split in Constant Time

DataUnionSidechain accounts for the earnings of a member, i.e. `SUM(earnings / active members)`, for all the time they were active. We account for this in constant time by recording the monotonically increasing quantity of Lifetime Member Earnings, or LME.

Every time new earnings are added: `new LME = old LME + (new earnings / active members)`

For each active member we store `member address -> LME(join time)`. The earnings of an active member are then `LME(current) - LME(join time)`.


## The Bridge
The bridge has 3 main components:
1. Arbitrary Message Bridge (AMB): smart contracts on main and side chains that pass arbitrary function calls between the chains.
2. ERC677 token mediator: contracts that talk to the AMB in order to facilitate token transfers across the bridge. Mainnet tokens can be transferred to the mainnet mediator contract and "passed" to sidechain by minting [corresponding ERC677 tokens](https://github.com/poanetwork/tokenbridge-contracts/blob/master/contracts/upgradeable_contracts/amb_erc677_to_erc677/BasicStakeTokenMediator.sol). This sidenet ERC677 can be "passed" back to mainnet by transferring to the sidechain mediator, which burns sidechain tokens, triggering mainnet token transfer.
3. Oracles: Each oracle node runs a set of processes in Docker. The oracles attest to transactions submitted to the AMB and pass verified transactions across the bridge in both directions. A production setup includes multiple oracles and a majority of oracle votes is needed to verify a transaction. The rules for oracle voting can be setup in TokenBridge.

[See TokenBridge documentation](https://docs.tokenbridge.net/amb-bridge/about-amb-bridge) for detailed info about the bridge.

# Getting Started
The easiest way to get started running and testing Data Unions is to use the preloaded test images baked into https://github.com/streamr-dev/streamr-docker-dev:

0. `cd streamr-docker-dev`
1. `sudo ifconfig lo:0 10.200.10.1/24` (must link 10.200.10.1 to loopback so containers can communicate)
2. `docker-compose up -d bridge parity-node0 parity-sidechain-node0`

This will use parity images for mainchain and sidechain that are preloaded with the AMB, token mediators, and DU factory contracts. It will also spin up required oracle processes. In the test environment, there is only 1 oracle.

mainchain RPC is localhost:8545

sidechain RPC is localhost:8546

The private key `0x5e98cce00cff5dea6b454889f359a4ec06b9fa6b88e9d69b86de8e1c81887da0` (address `0xa3d1F77ACfF0060F7213D7BF3c7fEC78df847De1`) is used for all contract admin functions and oracle.


Alternatively, you can build this setup from scratch. See https://github.com/streamr-dev/smart-contracts-init for smart contract init, and https://github.com/streamr-dev/streamr-docker-dev for oracle init.

# Code Samples

Use [libDU](https://github.com/streamr-dev/data-union-solidity/blob/DU-12-move-adminfee-mainnet/test/utils/libDU.js) to deploy DU components:
  - `deployDataUnionFactorySidechain`
  - `deployDataUnionFactoryMainnet`
  - `getTemplateSidechain`
  - `deployDataUnion`
  - `getContracts(mainet_address)`

To deploy factories:
1. `deployDataUnionFactorySidechain`
2. `deployDataUnionFactoryMainnet`, passing deployDataUnionFactorySidechain.address and template from `getTemplateSidechain()`

To deploy DU:
`deployDataUnion`, passing deployDataUnionFactoryMainnet.address

Interact with DataUnionMainnet and DataUnionSidechain contracts using Solidity calls once they are deployed.

See the [end-to-end test](https://github.com/streamr-dev/data-union-solidity/blob/master/test/e2e/usingPlainEthers.js) that shows how to use all major features from factory creation to withdrawal. The test runs against the docker setup described above.
