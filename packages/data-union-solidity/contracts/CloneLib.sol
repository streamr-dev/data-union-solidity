// SPDX-License-Identifier: MIT

pragma solidity 0.8.6;
//solhint-disable avoid-low-level-calls
//solhint-disable no-inline-assembly

/** NOTE: DO NOT MODIFY. This has been audited and test was removed in truffle -> waffle transition */
library CloneLib {
    /**
     * Returns bytecode of a new contract that clones template
     * Adapted from https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-sdk/master/packages/lib/contracts/upgradeability/ProxyFactory.sol
     * Which in turn adapted it from https://github.com/optionality/clone-factory/blob/32782f82dfc5a00d103a7e61a17a5dedbd1e8e9d/contracts/CloneFactory.sol
     */
    function cloneBytecode(address template) internal pure returns (bytes memory code) {
        bytes20 targetBytes = bytes20(template);
        assembly {
            code := mload(0x40)
            mstore(0x40, add(code, 0x57)) // code length is 0x37 plus 0x20 for bytes length field. update free memory pointer
            mstore(code, 0x37) // store length in first 32 bytes

            // store clone source address after first 32 bytes
            mstore(add(code, 0x20), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(code, 0x34), targetBytes)
            mstore(add(code, 0x48), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
        }
    }

    /**
     * Predict the CREATE2 address.
     * See https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1014.md for calculation details
     */
    function predictCloneAddressCreate2(
        address template,
        address deployer,
        bytes32 salt
    ) internal pure returns (address proxy) {
        bytes32 codehash = keccak256(cloneBytecode(template));
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            deployer,
            salt,
            codehash
        )))));
    }

    /**
     * Deploy given bytecode using CREATE2, address can be known in advance, get it from predictCloneAddressCreate2
     * Optional 2-step deployment first runs the constructor, then supplies an initialization function call.
     * @param code EVM bytecode that would be used in a contract deploy transaction (to=null)
     * @param initData if non-zero, send an initialization function call in the same tx with given tx input data (e.g. encoded Solidity function call)
     */
    function deployCodeAndInitUsingCreate2(
        bytes memory code,
        bytes memory initData,
        bytes32 salt
    ) internal returns (address payable proxy) {
        uint256 len = code.length;
        assembly {
            proxy := create2(0, add(code, 0x20), len, salt)
        }
        require(proxy != address(0), "error_alreadyCreated");
        if (initData.length != 0) {
            (bool success, ) = proxy.call(initData);
            require(success, "error_initialization");
        }
    }

    /**
     * Deploy given bytecode using old-style CREATE, address is hash(sender, nonce)
     * Optional 2-step deployment first runs the constructor, then supplies an initialization function call.
     * @param code EVM bytecode that would be used in a contract deploy transaction (to=null)
     * @param initData if non-zero, send an initialization function call in the same tx with given tx input data (e.g. encoded Solidity function call)
     */
    function deployCodeAndInitUsingCreate(
        bytes memory code,
        bytes memory initData
    ) internal returns (address payable proxy) {
        uint256 len = code.length;
        assembly {
            proxy := create(0, add(code, 0x20), len)
        }
        require(proxy != address(0), "error_create");
        if (initData.length != 0) {
            (bool success, ) = proxy.call(initData);
            require(success, "error_initialization");
        }
    }
}
