// SPDX-License-Identifier: MIT

pragma solidity 0.8.6;

library BytesLib {
    // from https://github.com/GNSPS/solidity-bytes-utils/blob/6458fb2780a3092bc756e737f246be1de6d3d362/contracts/BytesLib.sol#L297
    function toAddress(bytes memory _bytes) internal pure returns (address) {
        require(_bytes.length >= 20, "toAddress_outOfBounds");
        address tempAddress;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            tempAddress := div(mload(add(_bytes, 0x20)), 0x1000000000000000000000000)
        }
        return tempAddress;
    }
}