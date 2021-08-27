import { HardhatUserConfig } from "hardhat/types"
import '@nomiclabs/hardhat-waffle'

import 'hardhat-typechain'
import "solidity-coverage"

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.6",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
            evmVersion: "berlin",
        }
    },
    typechain: {
        outDir: './typechain',
        target: 'ethers-v5',
    }
}
export default config