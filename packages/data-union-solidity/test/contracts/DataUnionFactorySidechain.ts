import { expect, use } from 'chai'
import { waffle } from 'hardhat'
import { Contract, utils, BigNumber } from 'ethers'
const { parseEther } = utils

import DataUnionFactorySidechainJson from "../../artifacts/contracts/DataUnionFactorySidechain.sol/DataUnionFactorySidechain.json"
import DataUnionSidechainJson from "../../artifacts/contracts/DataUnionSidechain.sol/DataUnionSidechain.json"
import MockTokenMediatorJson from "../../artifacts/contracts/MockTokenMediator.sol/MockTokenMediator.json"
import TestTokenJson from "../../artifacts/contracts/TestToken.sol/TestToken.json"
import MockAMBJson from "../../artifacts/contracts/MockAMB.sol/MockAMB.json"

import { DataUnionSidechain, DataUnionFactorySidechain, TestToken, MockAMB, MockTokenMediator } from '../../typechain'

import Debug from "debug"
const log = Debug("Streamr:du:test:BinanceAdapter")

use(waffle.solidity)
const { deployContract, provider } = waffle

type EthereumAddress = string

describe("DataUnionFactorySidechain", (): void => {
    const accounts = provider.getWallets()

    const creator = accounts[0]
    const agents = accounts.slice(1, 3)
    const members = accounts.slice(3, 6)
    const others = accounts.slice(6)

    const m = members.map(member => member.address)
    const a = agents.map(agent => agent.address)
    const o = others.map(outsider => outsider.address)

    let factory: DataUnionFactorySidechain
    let testToken: TestToken
    let mockAMB: MockAMB
    let mockTokenMediator: MockTokenMediator

    before(async () => {
        testToken = await deployContract(creator, TestTokenJson, ["name", "symbol"]) as TestToken
        mockAMB = await deployContract(creator, MockAMBJson, []) as MockAMB
        mockTokenMediator = await deployContract(creator, MockTokenMediatorJson, [testToken.address, mockAMB.address]) as MockTokenMediator
        const dataUnionSidechainTemplate = await deployContract(creator, DataUnionSidechainJson, [])
        factory = await deployContract(creator, DataUnionFactorySidechainJson, [dataUnionSidechainTemplate.address]) as DataUnionFactorySidechain
    })

    it("sidechain ETH flow", async () => {
        const ownerEth = parseEther("0.01")
        const newDUEth = parseEther("1")
        const newMemberEth = parseEther("0.1")

        const factoryOutsider = factory.connect(others[0])
        await expect(factoryOutsider.setNewDUInitialEth(newMemberEth)).to.be.reverted
        await expect(factoryOutsider.setNewDUOwnerInitialEth(newMemberEth)).to.be.reverted
        await expect(factoryOutsider.setNewMemberInitialEth(newMemberEth)).to.be.reverted
        await expect(factory.setNewDUInitialEth(newDUEth)).to.emit(factory, "UpdateNewDUInitialEth")
        await expect(factory.setNewDUOwnerInitialEth(ownerEth)).to.emit(factory, "UpdateNewDUOwnerInitialEth")
        await expect(factory.setNewMemberInitialEth(newMemberEth)).to.emit(factory, "UpdateDefaultNewMemberInitialEth")

        await others[0].sendTransaction({
            to: factory.address,
            value: parseEther("2"),
        })

        const creatorBalanceBefore = await provider.getBalance(creator.address)

        //  function deployNewDUSidechain(
        //     address token,
        //     address mediator,
        //     address payable owner,
        //     address[] memory agents,
        //     uint256 initialAdminFeeFraction,
        //     uint256 initialDataUnionFeeFraction,
        //     address initialDataUnionBeneficiary
        //  )
        const args : [EthereumAddress, EthereumAddress, EthereumAddress, EthereumAddress[], BigNumber, BigNumber, EthereumAddress] = [
            testToken.address,
            mockTokenMediator.address,
            creator.address,
            agents.map(a => a.address),
            parseEther("0.1"),
            parseEther("0.1"),
            others[0].address
        ]
        log('deployNewDUSidechain args: %o', args)

        // this should fail because deployNewDUSidechain must be called by AMB
        await expect(factoryOutsider.deployNewDUSidechain(...args)).to.be.reverted

        const deployMessage = await factory.interface.encodeFunctionData("deployNewDUSidechain", args)
        log('deploy: %o', deployMessage)
        // MockAMB "message passing" happens instantly, so no need to wait
        const tx = await mockAMB.requireToPassMessage(factory.address, deployMessage, "2000000", { gasLimit: "3000000" })
        const tr = await tx.wait()
        log('Receipt: %o', tr)

        // since creator was msg.sender of mockAMB.requireToPassMessage, it's assumed to be the "mainnet DU", too,
        //   because the real setting is that mainnetDU.initialize calls the AMB
        const newDuAddress = await factory.sidechainAddress(creator.address)
        log('%s code: %s', newDuAddress, await provider.getCode(newDuAddress))
        expect(await provider.getCode(newDuAddress)).not.equal("0x")

        const newDuCreator = new Contract(newDuAddress, DataUnionSidechainJson.abi, creator)
        const newDuAgent = new Contract(newDuAddress, DataUnionSidechainJson.abi, agents[0])
        const newDuOutsider = new Contract(newDuAddress, DataUnionSidechainJson.abi, others[0])
        const newDuBalance = await provider.getBalance(newDuAddress)
        log('newdu_address: %s, balance %s', newDuAddress, newDuBalance)

        // TODO: move asserts to the end

        // check created DU Eth
        expect(newDuBalance).to.equal(newDUEth)

        // check owner eth increased (can't assert exact change because creator also pays gas fees)
        const creatorBalanceChange = (await provider.getBalance(creator.address)).sub(creatorBalanceBefore)
        expect(creatorBalanceChange).not.equal(0)

        // 1st added member should have been given newMemberEth
        const balanceBefore1 = await provider.getBalance(members[0].address)
        await expect(newDuAgent.addMembers(m)).to.emit(newDuAgent, "MemberJoined")
        const balanceChange1 = (await provider.getBalance(members[0].address)).sub(balanceBefore1)
        expect(balanceChange1).to.equal(newMemberEth)

        // change the setting from within DU. check member Eth
        const newMemberEth2 = parseEther("0.2")
        await expect(newDuOutsider.setNewMemberEth(newMemberEth2)).to.be.reverted
        await expect(newDuCreator.setNewMemberEth(newMemberEth2)).to.emit(newDuCreator, "UpdateNewMemberEth")

        // 2nd added member should have been given newMemberEth
        const balanceBefore2 = await provider.getBalance(others[0].address)
        await expect(newDuAgent.addMembers(o.slice(0, 1))).to.emit(newDuAgent, "MemberJoined")
        const balanceChange2 = (await provider.getBalance(others[0].address)).sub(balanceBefore2)
        expect(balanceChange2).to.equal(newMemberEth2)
    })
})