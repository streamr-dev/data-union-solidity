import { assert, expect, use } from 'chai'
import { waffle } from 'hardhat'
import { BigNumber, Wallet, Contract, Signer, utils, BigNumberish } from 'ethers'

import Debug from "debug"
const log = Debug("Streamr:du:test:DataUnionSidechain")
//const log = console.log  // for debugging?

import DataUnionSidechainJson from "../../artifacts/contracts/DataUnionSidechain.sol/DataUnionSidechain.json"
import MockTokenMediatorJson from "../../artifacts/contracts/MockTokenMediator.sol/MockTokenMediator.json"
import TestTokenJson from "../../artifacts/contracts/TestToken.sol/TestToken.json"
import MockAMBJson from "../../artifacts/contracts/MockAMB.sol/MockAMB.json"

import type { DataUnionSidechain, MockTokenMediator, TestToken, MockAMB } from "../../typechain"

type EthereumAddress = string

use(waffle.solidity)
const { deployContract, provider } = waffle
const { hexZeroPad, parseEther, arrayify } = utils

/**
 * Member can sign off to "donate" all earnings to another address such that someone else
 *   can submit the transaction (and pay for the gas)
 *
 * In Solidity, the message is created by abi.encodePacked(), which represents addresses unpadded as 20bytes.
 * web3.eth.encodeParameters() encodes addresses padded as 32bytes, so it can't be used
 * encodePacked() method from library would be preferable, but this works
 *
 * @param {EthereumAddress} signer who authorizes withdraw
 * @param {EthereumAddress} to who gets the tokens
 * @param {number} amountTokenWei tokens multiplied by 10^18, or zero for unlimited (withdrawAllToSigned)
 * @param {Contract} duContract DataUnionSidechain contract object
 * @param {number} previouslyWithdrawn (optional) amount of token-wei withdrawn at the moment this signature is used
 */
async function getWithdrawSignature(
    signer: Wallet,
    to: Wallet,
    amountTokenWei: BigNumberish,
    duContract: Contract
) {
    const previouslyWithdrawn = await duContract.getWithdrawn(signer.address) as BigNumber
    const message = to.address
        + hexZeroPad(BigNumber.from(amountTokenWei).toHexString(), 32).slice(2)
        + duContract.address.slice(2)
        + hexZeroPad(previouslyWithdrawn.toHexString(), 32).slice(2)
    return signer.signMessage(arrayify(message))
}

describe("DataUnionSidechain", (): void => {
    const accounts = provider.getWallets()
    const creator = accounts[0]
    const duBeneficiary = accounts[1]
    const agents = accounts.slice(2, 4)
    const members = accounts.slice(4, 7)
    const others = accounts.slice(7)

    const m = members.map(member => member.address)
    const a = agents.map(agent => agent.address)
    const o = others.map(outsider => outsider.address)

    let testToken: TestToken
    let dataUnionSidechain: DataUnionSidechain
    let dataUnionSidechainAgent: DataUnionSidechain
    let dataUnionSidechainMember0: DataUnionSidechain
    let mockAMB: MockAMB
    let mockTokenMediator: MockTokenMediator

    before(async () => {
        testToken = await deployContract(creator, TestTokenJson, ["name", "symbol"]) as TestToken
        await testToken.mint(creator.address, parseEther("10000"))

        mockAMB = await deployContract(creator, MockAMBJson, []) as MockAMB
        mockTokenMediator = await deployContract(creator, MockTokenMediatorJson, [testToken.address, mockAMB.address]) as MockTokenMediator

        log("List of relevant addresses:")
        log("  mockTokenMediator: ", mockTokenMediator.address)
        log("  mockAMB: ", mockAMB.address)
        log("  testToken: ", testToken.address)
        log("  creator: ", creator.address)
        log("  agents: %o", a)
        log("  members: %o", m)
        log("  outsider addresses used in tests: %o", others.map(x => x.address))
    })

    beforeEach(async () => {
        const dummyAddress = a[0]

        dataUnionSidechain = await deployContract(creator, DataUnionSidechainJson, []) as DataUnionSidechain
        dataUnionSidechainAgent = dataUnionSidechain.connect(agents[1])
        dataUnionSidechainMember0 = dataUnionSidechain.connect(members[0])

        // function initialize(
        //     address initialOwner,
        //     address tokenAddress,
        //     address tokenMediatorAddress,
        //     address[] memory initialJoinPartAgents,
        //     address mainnetDataUnionAddress,
        //     uint256 defaultNewMemberEth,
        //     uint256 initialAdminFeeFraction,
        //     uint256 initialDataUnionFeeFraction,
        //     address initialDataUnionBeneficiary
        // )
        await dataUnionSidechain.initialize(
            creator.address,
            testToken.address,
            mockTokenMediator.address,
            a,
            dummyAddress,
            "1",
            parseEther("0.1"),
            parseEther("0.1"),
            duBeneficiary.address
        )
        await dataUnionSidechainAgent.addMembers(m)

        log(`DataUnionSidechain initialized at ${dataUnionSidechain.address}`)
    })

    it("addMembers partMembers", async () => {
        const memberCountBeforeBN = await dataUnionSidechain.activeMemberCount()
        expect(memberCountBeforeBN).to.equal(members.length)

        // add all "others" to data union
        await expect(dataUnionSidechain.addMembers(o)).to.be.revertedWith("error_onlyJoinPartAgent")
        await expect(dataUnionSidechainAgent.addMembers(o)).to.emit(dataUnionSidechain, "MemberJoined")
        await expect(dataUnionSidechainAgent.addMembers(o)).to.be.revertedWith("error_alreadyMember")
        const memberCountAfterJoinBN = await dataUnionSidechain.activeMemberCount()
        expect(+memberCountBeforeBN + others.length).to.equal(memberCountAfterJoinBN)
        expect(await dataUnionSidechain.inactiveMemberCount()).to.equal(0)

        // part all "others" from data union
        await expect(dataUnionSidechain.partMembers(o)).to.be.revertedWith("error_notPermitted")
        await expect(dataUnionSidechain.connect(others[0]).partMember(o[0])).to.emit(dataUnionSidechain, "MemberParted")
        await expect(dataUnionSidechainAgent.partMembers(o)).to.be.revertedWith("error_notActiveMember") // even one non-existing makes the whole tx fail
        await expect(dataUnionSidechainAgent.partMembers(o.slice(1))).to.emit(dataUnionSidechain, "MemberParted")
        const memberCountAfterPartBN = await dataUnionSidechain.activeMemberCount()
        expect(memberCountBeforeBN).to.equal(memberCountAfterPartBN)
        expect(await dataUnionSidechain.inactiveMemberCount()).to.equal(others.length)

        //re-add and check that inactiveMemberCount decreased
        await expect(dataUnionSidechainAgent.addMembers(o)).to.emit(dataUnionSidechain, "MemberJoined")
        expect(await dataUnionSidechain.inactiveMemberCount()).to.equal(0)

    })

    it("addJoinPartAgent removeJoinPartAgent", async () => {
        const newAgent = others[0]
        const newMember = others[1]
        const agentCountBeforeBN = await dataUnionSidechain.joinPartAgentCount()
        expect(agentCountBeforeBN).to.equal(agents.length)

        // add new agent
        await expect(dataUnionSidechain.connect(newAgent).addMember(newMember.address)).to.be.revertedWith("error_onlyJoinPartAgent")
        await expect(dataUnionSidechain.addJoinPartAgent(newAgent.address)).to.emit(dataUnionSidechain, "JoinPartAgentAdded")
        await expect(dataUnionSidechain.addJoinPartAgent(newAgent.address)).to.be.revertedWith("error_alreadyActiveAgent")
        const agentCountAfterAddBN = await dataUnionSidechain.joinPartAgentCount()
        expect(agentCountAfterAddBN).to.equal(agents.length + 1)
        await expect(dataUnionSidechainAgent.addMember(newMember.address)).to.emit(dataUnionSidechain, "MemberJoined")
        await expect(dataUnionSidechainAgent.partMember(newMember.address)).to.emit(dataUnionSidechain, "MemberParted")

        // remove the new agent
        await expect(dataUnionSidechain.removeJoinPartAgent(newAgent.address)).to.emit(dataUnionSidechain, "JoinPartAgentRemoved")
        await expect(dataUnionSidechain.removeJoinPartAgent(newAgent.address)).to.be.revertedWith("error_notActiveAgent")
        const agentCountAfterRemoveBN = await dataUnionSidechain.joinPartAgentCount()
        expect(agentCountAfterRemoveBN).to.equal(agents.length)
        await expect(dataUnionSidechain.connect(newAgent).addMember(newMember.address)).to.be.revertedWith("error_onlyJoinPartAgent")
    })

    async function getBalances(addresses: EthereumAddress[]) {
        return Promise.all(addresses.map(a => testToken.balanceOf(a)))
    }
    async function getBalanceIncrements(addresses: EthereumAddress[], originalBalances: BigNumber[]) {
        return Promise.all(addresses.map(async (a, i) => {
            const newBalance = await testToken.balanceOf(a)
            return newBalance.sub(originalBalances[i]).toNumber()
        }))
    }

    it("withdrawMembers: batch withdraw many members", async () => {
        const balances = await getBalances(m)
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()
        await expect(dataUnionSidechain.withdrawMembers(m, false)).to.emit(dataUnionSidechain, "EarningsWithdrawn")
        expect(await getBalanceIncrements(m, balances)).to.deep.equal([ 800, 800, 800 ])
    })

    it("withdrawAll", async () => {
        const balances = await getBalances(m)
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()
        await expect(dataUnionSidechain.connect(others[0]).withdrawAll(m[0], false)).to.be.revertedWith("error_notPermitted")
        await expect(dataUnionSidechainMember0.withdrawAll(m[0], false)).to.emit(dataUnionSidechain, "EarningsWithdrawn")
        await expect(dataUnionSidechain.withdrawAll(m[1], false)).to.emit(dataUnionSidechain, "EarningsWithdrawn")
        await dataUnionSidechain.withdrawAll(m[1], false)    // this should do nothing, also not revert
        expect(await getBalanceIncrements(m, balances)).to.deep.equal([ 800, 800, 0 ])
    })

    it("withdrawAllTo", async () => {
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()

        const before = await testToken.balanceOf(o[0])
        await expect(dataUnionSidechainMember0.withdrawAllTo(o[0], false)).to.emit(dataUnionSidechain, "EarningsWithdrawn")
        const after = await testToken.balanceOf(o[0])

        const diff = after.sub(before)
        expect(diff).to.equal(800)
    })

    it("withdrawToSigned", async () => {
        const recipient = others[2]
        const dataUnionSidechainRecipient = await dataUnionSidechain.connect(recipient)
        const r = recipient.address
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()

        // function signatureIsValid(address signer, address recipient, uint amount, bytes memory signature)
        const signature = await getWithdrawSignature(members[1], recipient, "100", dataUnionSidechain)
        assert(await dataUnionSidechain.signatureIsValid(m[1], r, "100", signature), "Contract says: bad signature")

        await expect(dataUnionSidechainRecipient.withdrawToSigned(m[1], o[1], "100", false, signature)).to.be.revertedWith("error_badSignature")
        await expect(dataUnionSidechainRecipient.withdrawToSigned(m[1], r, "1000", false, signature)).to.be.revertedWith("error_badSignature")
        await expect(dataUnionSidechainRecipient.withdrawToSigned(m[0], r, "100", false, signature)).to.be.revertedWith("error_badSignature")
        await expect(dataUnionSidechainRecipient.withdrawToSigned(m[1], r, "100", false, signature)).to.emit(dataUnionSidechain, "EarningsWithdrawn")

        expect(await testToken.balanceOf(r)).to.equal(100)
    })

    it("withdrawAllToSigned", async () => {
        const recipient = others[3]
        const dataUnionSidechainRecipient = await dataUnionSidechain.connect(recipient)
        const r = recipient.address
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()

        const signature = await getWithdrawSignature(members[1], recipient, "0", dataUnionSidechain)
        // function signatureIsValid(address signer, address recipient, uint amount, bytes memory signature)
        assert(await dataUnionSidechain.signatureIsValid(m[1], r, "0", signature), "Contract says: bad signature")

        await expect(dataUnionSidechainRecipient.withdrawAllToSigned(m[1], o[1], false, signature)).to.be.revertedWith("error_badSignature")
        await expect(dataUnionSidechainRecipient.withdrawAllToSigned(m[0], r, false, signature)).to.be.revertedWith("error_badSignature")
        await expect(dataUnionSidechainRecipient.withdrawAllToSigned(m[1], r, false, signature)).to.emit(dataUnionSidechain, "EarningsWithdrawn")

        expect(await testToken.balanceOf(r)).to.equal(800)
    })

    it("transferToMemberInContract", async () => {
        await testToken.approve(dataUnionSidechain.address, "2000")
        await dataUnionSidechain.transferToMemberInContract(o[0], "1000")
        await dataUnionSidechain.transferToMemberInContract(m[0], "1000")
        expect(await dataUnionSidechain.getWithdrawableEarnings(o[0])).to.equal(1000)
        expect(await dataUnionSidechain.getWithdrawableEarnings(m[0])).to.equal(1000)

        // TestToken blocks transfers with this magic amount
        await expect(dataUnionSidechain.transferToMemberInContract(m[0], "666")).to.be.revertedWith("error_transfer")

        // TestToken sabotages transfers with this magic amount
        await expect(dataUnionSidechain.transferToMemberInContract(m[0], "777")).to.be.revertedWith("error_transfer")
    })

    it("transferWithinContract", async () => {
        assert(await testToken.transfer(dataUnionSidechain.address, "3000"))
        await dataUnionSidechain.refreshRevenue()
        await expect(dataUnionSidechain.connect(others[0]).transferWithinContract(m[1], "100")).to.be.revertedWith("error_notMember")
        // change after sidechain fees / ETH-141: admin receives fees and so becomes an INACTIVE member by _increaseBalance
        // await expect(dataUnionSidechain.transferWithinContract(m[1], "100")).to.be.revertedWith("error_notMember")
        await expect(dataUnionSidechainMember0.transferWithinContract(m[1], "100")).to.emit(dataUnionSidechain, "TransferWithinContract")
        await expect(dataUnionSidechainMember0.transferWithinContract(o[1], "100")).to.emit(dataUnionSidechain, "TransferWithinContract")
        expect(await dataUnionSidechain.getWithdrawableEarnings(m[0])).to.equal(600)
        expect(await dataUnionSidechain.getWithdrawableEarnings(m[1])).to.equal(900)
        expect(await dataUnionSidechain.getWithdrawableEarnings(m[2])).to.equal(800)
        expect(await dataUnionSidechain.getWithdrawableEarnings(o[1])).to.equal(100)
        // those who received some in-contract balance but aren't members should be marked inactive by _increaseBalance
        expect(await dataUnionSidechain.inactiveMemberCount()).to.equal(3)
        expect((await dataUnionSidechain.memberData(o[1])).status).to.equal(2)
        expect((await dataUnionSidechain.memberData(duBeneficiary.address)).status).to.equal(2)
        expect((await dataUnionSidechain.memberData(creator.address)).status).to.equal(2)
    })

    it("getStats", async () => {
        // test send with transferAndCall. refreshRevenue not needed in this case
        await testToken.transferAndCall(dataUnionSidechain.address, "3000", "0x")

        await dataUnionSidechainMember0.withdraw(m[0], "500", true)
        const [
            totalRevenue,
            totalEarnings,
            totalAdminFees,
            totalDataUnionFees,
            totalEarningsWithdrawn,
            activeMemberCount,
            inactiveMemberCount,
            lifetimeMemberEarnings,
            joinPartAgentCount
        ] = await dataUnionSidechain.getStats()
        expect(totalRevenue).to.equal(3000)
        expect(totalEarnings).to.equal(2400)
        expect(totalAdminFees).to.equal(300)
        expect(totalDataUnionFees).to.equal(300)
        expect(totalEarningsWithdrawn).to.equal(500)
        expect(activeMemberCount).to.equal(3)
        expect(inactiveMemberCount).to.equal(0) // creator and duBeneficiary are cleaned out of this number though they show up in the "inactiveMemberCount"
        expect(lifetimeMemberEarnings).to.equal(800)
        expect(joinPartAgentCount).to.equal(2)
    })

    it("getEarnings", async () => {
        await expect(dataUnionSidechain.getEarnings(o[0])).to.be.revertedWith("error_notMember")
        await expect(dataUnionSidechain.getEarnings(a[0])).to.be.revertedWith("error_notMember")
        await expect(dataUnionSidechain.getEarnings(creator.address)).to.be.revertedWith("error_notMember")
        expect(await dataUnionSidechain.getEarnings(m[0])).to.equal(0)

        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()

        expect(await dataUnionSidechain.getEarnings(m[0])).to.equal(800)
        expect(await dataUnionSidechain.getEarnings(creator.address)).to.equal(300)
        expect(await dataUnionSidechain.getEarnings(duBeneficiary.address)).to.equal(300)
    })

    it("distributes earnings correctly", async () => {
        const randomOutsider = others[1]
        const newMember = others[0]

        // send and distribute a batch of revenue to members
        await expect(testToken.transfer(dataUnionSidechain.address, "3000")).to.emit(testToken, "Transfer(address,address,uint256)")
        await expect(dataUnionSidechain.connect(randomOutsider).refreshRevenue()).to.emit(dataUnionSidechain, "RevenueReceived")

        // repeating it should do nothing (also not throw)
        await dataUnionSidechain.connect(randomOutsider).refreshRevenue()

        expect(await dataUnionSidechain.totalEarnings()).to.equal(2400)
        expect(await dataUnionSidechain.totalAdminFees()).to.equal(300)
        expect(await dataUnionSidechain.totalDataUnionFees()).to.equal(300)
        expect(await dataUnionSidechain.getEarnings(m[0])).to.equal(800)
        expect(await dataUnionSidechain.getEarnings(m[1])).to.equal(800)
        expect(await dataUnionSidechain.getEarnings(m[2])).to.equal(800)

        // drop a member, send more tokens, check accounting
        await expect(dataUnionSidechainAgent.partMember(m[0])).to.emit(dataUnionSidechain, "MemberParted")
        expect(await dataUnionSidechain.getEarnings(m[0])).to.equal(800)
        await testToken.transfer(dataUnionSidechain.address, "2000")
        await dataUnionSidechain.connect(randomOutsider).refreshRevenue()
        expect(await dataUnionSidechain.totalEarnings()).to.equal(4000)
        expect(await dataUnionSidechain.totalAdminFees()).to.equal(500)
        expect(await dataUnionSidechain.totalDataUnionFees()).to.equal(500)
        expect(await dataUnionSidechain.getEarnings(m[0])).to.equal(800)
        expect(await dataUnionSidechain.getEarnings(m[1])).to.equal(1600)
        expect(await dataUnionSidechain.getEarnings(m[2])).to.equal(1600)
        await expect(dataUnionSidechainAgent.addMember(m[0])).to.emit(dataUnionSidechain, "MemberJoined")

        // add a member, send tokens, check accounting
        await expect(dataUnionSidechainAgent.addMember(newMember.address)).to.emit(dataUnionSidechain, "MemberJoined")
        await testToken.transfer(dataUnionSidechain.address, "4000")
        await dataUnionSidechain.connect(randomOutsider).refreshRevenue()
        expect(await dataUnionSidechain.totalEarnings()).to.equal(7200)
        expect(await dataUnionSidechain.totalAdminFees()).to.equal(900)
        expect(await dataUnionSidechain.totalDataUnionFees()).to.equal(900)
        expect(await dataUnionSidechain.getEarnings(newMember.address)).to.equal(800)
        expect(await dataUnionSidechain.getEarnings(m[0])).to.equal(1600)
        expect(await dataUnionSidechain.getEarnings(m[1])).to.equal(2400)
        expect(await dataUnionSidechain.getEarnings(m[2])).to.equal(2400)
        await expect(dataUnionSidechainAgent.partMember(newMember.address)).to.emit(dataUnionSidechain, "MemberParted")
    })

    // Of course there is no "withdraw to mainnet" in test.
    // Instead what happens in DataUnionSidechain is a call to TokenMediator
    it("withdraw to mainnet", async () => {
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()
        await expect(dataUnionSidechainMember0.withdraw(m[0], "100", true)).to.emit(dataUnionSidechain, "EarningsWithdrawn")

        // TestToken blocks transfers with this magic amount
        await expect(dataUnionSidechainMember0.withdraw(m[0], "666", true)).to.be.revertedWith("error_transfer")
    })

    it("fails to withdraw more than earnings", async () => {
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()
        await expect(dataUnionSidechainMember0.withdraw(m[0], "4000", false)).to.be.revertedWith("error_insufficientBalance")

        // TestToken blocks transfers with this magic amount
        await expect(dataUnionSidechainMember0.withdraw(m[0], "666", false)).to.be.revertedWith("error_transfer")
    })

    it("fails to initialize twice", async () => {
        const a = agents.map(agent => agent.address)
        const dummyAddress = a[0]
        await expect(dataUnionSidechain.initialize(
            creator.address,
            testToken.address,
            mockTokenMediator.address,
            a,
            dummyAddress,
            "1",
            parseEther("0.1"),
            parseEther("0.1"),
            duBeneficiary.address
        )).to.be.revertedWith("error_alreadyInitialized")
    })

    it("fails for badly formed signatures", async () => {
        const recipient = others[2]
        const r = o[2]
        await testToken.transfer(dataUnionSidechain.address, "3000")
        await dataUnionSidechain.refreshRevenue()

        const signature = await getWithdrawSignature(members[1], recipient, "100", dataUnionSidechain)
        const truncatedSig = signature.slice(0, -10)
        const badVersionSig = signature.slice(0, -2) + "30"

        await expect(dataUnionSidechain.withdrawToSigned(m[1], r, "100", false, truncatedSig)).to.be.revertedWith("error_badSignatureLength")
        await expect(dataUnionSidechain.withdrawToSigned(m[1], r, "100", false, badVersionSig)).to.be.revertedWith("error_badSignatureVersion")
        await expect(dataUnionSidechain.withdrawToSigned(m[1], r, "200", false, signature)).to.be.revertedWith("error_badSignature")

        await expect(dataUnionSidechain.signatureIsValid(m[1], r, "100", truncatedSig)).to.be.revertedWith("error_badSignatureLength")
        await expect(dataUnionSidechain.signatureIsValid(m[1], r, "100", badVersionSig)).to.be.revertedWith("error_badSignatureVersion")
        assert(!await dataUnionSidechain.signatureIsValid(m[1], r, "200", signature), "Bad signature was accepted as valid :(")
    })
})
