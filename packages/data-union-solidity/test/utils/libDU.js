const {
    Contract,
    Wallet,
    ContractFactory,
} = require("ethers")

const log = require("debug")("Streamr:du:libDU")
const until = require("./await-until")

const DataUnionMainnet = require("../../artifacts/contracts/DataUnionMainnet.sol/DataUnionMainnet.json")
const DataUnionSidechain = require("../../artifacts/contracts/DataUnionSidechain.sol/DataUnionSidechain.json")
const DataUnionFactorySidechain = require("../../artifacts/contracts/DataUnionFactorySidechain.sol/DataUnionFactorySidechain.json")
const DataUnionFactoryMainnet = require("../../artifacts/contracts/DataUnionFactoryMainnet.sol/DataUnionFactoryMainnet.json")

let templateSidechain

/**
 * Deploy template DataUnion contract as well as factory to sidechain
 * @param wallet {Wallet} sidechain wallet that is used in deployment
 * @returns {Promise<Contract>} DataUnionFactorySidechain contract
 */
async function deployDataUnionFactorySidechain(wallet) {
    log(`Deploying template DU sidechain contract from ${wallet.address}`)
    const templateDeployer = new ContractFactory(DataUnionSidechain.abi, DataUnionSidechain.bytecode, wallet)
    const templateTx = await templateDeployer.deploy({ gasLimit: 6000000 })
    templateSidechain = await templateTx.deployed()
    log(`Side-chain template DU: ${templateSidechain.address}`)

    // constructor(address _token_mediator, address _data_union_sidechain_template)
    log(`Deploying sidechain DU factory contract from ${wallet.address}`)
    const factoryDeployer = new ContractFactory(DataUnionFactorySidechain.abi, DataUnionFactorySidechain.bytecode, wallet)
    const factoryTx = await factoryDeployer.deploy(
        templateSidechain.address,
        { gasLimit: 6000000 }
    )
    log(`Side-chain DU factory: ${factoryTx.address}`)
    return factoryTx.deployed()
}

function getTemplateSidechain() {
    if (!templateSidechain) {
        throw new Error("deployDataUnionFactorySidechain must be called (and awaited) first")
    }
    return templateSidechain
}

async function deployDataUnionFactoryMainnet(wallet, sidechainTemplateAddress, sidechainFactoryAddress) {
    log(`Deploying template DU mainnet contract from ${wallet.address}`)
    const templateDeployer = new ContractFactory(
        DataUnionMainnet.abi,
        DataUnionMainnet.bytecode,
        wallet
    )
    const templateTx = await templateDeployer.deploy({ gasLimit: 6000000 })
    const templateDU = await templateTx.deployed()
    log(`Mainnet template DU: ${templateDU.address}`)

    // constructor(address _token_mediator, address _data_union_mainnet_template, address _data_union_sidechain_template, address _data_union_sidechain_factory, uint256 _sidechain_maxgas)
    log(`Deploying DU mainnet factory contract from ${wallet.address}`)
    const factoryDeployer = new ContractFactory(
        DataUnionFactoryMainnet.abi,
        DataUnionFactoryMainnet.bytecode,
        wallet
    )
    const dummyAddress = "0x0000000000000000000000000000000000001337"
    const factoryTx = await factoryDeployer.deploy(
        templateDU.address,
        sidechainTemplateAddress,
        sidechainFactoryAddress,
        dummyAddress,
        dummyAddress,
        dummyAddress,
        dummyAddress,
        2000000,
        { gasLimit: 6000000 }
    )
    log(`Mainnet DU factory: ${factoryTx.address}`)
    return factoryTx.deployed()
}

/**
 * Tell DataUnionFactoryMainnet to create a new DataUnionMainnet,
 *   which then triggers through AMB the DataUnionFactorySidechain to create a new DataUnionSidechain.
 * DU admin will be the mainnet wallet used for transaction, the wallet that dataUnionFactoryMainnet Contract object was created with
 * If DU already is deployed, just return it instead
 * @param {string} duname unique identifier for the DU
 * @param {Contract} dataUnionFactoryMainnet created with `new Contract(factoryAddress, adminWallet)`
 * @param {Provider} sidechainProvider for watching when the deployment has be registered in sidechain
 * @param {number} bridgeTimeoutMs time that it takes for bridge to cause sidechain community to be deployed
 * @returns {Contract} DataUnionMainnet contract
 */
async function deployDataUnion(duname, adminFee, tokenMainnet, mediatorMainnet, tokenSidechain, mediatorSidechain, dataUnionFactoryMainnet, sidechainProvider, bridgeTimeoutMs) {
    const adminWallet = new Wallet(dataUnionFactoryMainnet.signer.privateKey, dataUnionFactoryMainnet.provider)
    const duMainnetAddress = await dataUnionFactoryMainnet.mainnetAddress(adminWallet.address, duname)
    const duSidechainAddress = await dataUnionFactoryMainnet.sidechainAddress(duMainnetAddress)
    log(`Requested deploy of DU ${duname}, mainnet ${duMainnetAddress}, sidechain ${duSidechainAddress}`)
    if (await adminWallet.provider.getCode(duMainnetAddress) !== "0x") {
        log(`DU ${duname} already exists, skipping deployment`)
    } else {
        // function deployNewDataUnionUsingToken(
        //     address tokenMainnet,
        //     address tokenMediatorMainnet,
        //     address tokenSidechain,
        //     address tokenMediatorSidechain,
        //     address owner,
        //     uint256 adminFeeFraction,
        //     uint256 duFeeFraction,
        //     address duBeneficiary,
        //     address[] memory agents,
        //     string memory name
        // )
        const args = [
            tokenMainnet,
            mediatorMainnet,
            tokenSidechain,
            mediatorSidechain,
            adminWallet.address,
            adminFee,
            "0",
            adminWallet.address,
            [adminWallet.address],
            duname
        ]
        // log("dataUnionFactoryMainnet.deployNewDataUnion args: %o", args)
        const tx = await dataUnionFactoryMainnet.deployNewDataUnionUsingToken(
            ...args,
            { gasLimit: 6000000 }
        )
        // log(`tx ${JSON.stringify(tx)}`)
        // const tr =
        await tx.wait()
        // log(`deploy tx receipt ${JSON.stringify(tr)}`)
        log(`Waiting for bridge to process deployment and sidechain DU appearing at ${duSidechainAddress}`)
        await until(async () => await sidechainProvider.getCode(duSidechainAddress) !== "0x", bridgeTimeoutMs)
    }

    return new Contract(
        duMainnetAddress,
        DataUnionMainnet.abi,
        adminWallet
    )
}

/**
 * Returns [homeDU, foreignDU] contracts for a given mainnet_address
 * @param {string} mainnet_address
 */
async function getContracts(mainnet_address, wallet_mainnet, wallet_sidechain) {
    const foreignDU = new Contract(mainnet_address, DataUnionMainnet.abi, wallet_mainnet)
    let sidechain_address = await foreignDU.sidechainAddress()
    const homeDU = new Contract(sidechain_address, DataUnionSidechain.abi, wallet_sidechain)
    return [homeDU, foreignDU]
}

module.exports = {
    deployDataUnionFactorySidechain,
    deployDataUnionFactoryMainnet,
    getTemplateSidechain,
    deployDataUnion,
    getContracts,
}
