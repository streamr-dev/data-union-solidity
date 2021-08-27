// SPDX-License-Identifier: MIT

pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./CloneLib.sol";
import "./IAMB.sol";
import "./ITokenMediator.sol";

interface IDataUnionMainnet {
    function sidechainAddress() external view returns (address proxy);
}

contract DataUnionFactoryMainnet {
    event MainnetDUCreated(address indexed mainnet, address indexed sidechain, address indexed owner, address template);

    address public dataUnionMainnetTemplate;

    address public defaultTokenMainnet;
    address public defaultTokenMediatorMainnet;
    address public defaultTokenSidechain;
    address public defaultTokenMediatorSidechain;

    // needed to calculate address of sidechain contract
    address public dataUnionSidechainTemplate;
    address public dataUnionSidechainFactory;
    uint256 public sidechainMaxGas;

    constructor(
                address _dataUnionMainnetTemplate,
                address _dataUnionSidechainTemplate,
                address _dataUnionSidechainFactory,
                address _defaultTokenMainnet,
                address _defaultTokenMediatorMainnet,
                address _defaultTokenSidechain,
                address _defaultTokenMediatorSidechain,
                uint256 _sidechainMaxGas)
    {
        dataUnionMainnetTemplate = _dataUnionMainnetTemplate;
        dataUnionSidechainTemplate = _dataUnionSidechainTemplate;
        dataUnionSidechainFactory = _dataUnionSidechainFactory;
        defaultTokenMainnet = _defaultTokenMainnet;
        defaultTokenMediatorMainnet = _defaultTokenMediatorMainnet;
        defaultTokenSidechain = _defaultTokenSidechain;
        defaultTokenMediatorSidechain = _defaultTokenMediatorSidechain;
        sidechainMaxGas = _sidechainMaxGas;
    }


    function sidechainAddress(address mainetAddress)
        public view
        returns (address)
    {
        return CloneLib.predictCloneAddressCreate2(
            dataUnionSidechainTemplate,
            dataUnionSidechainFactory,
            bytes32(uint256(uint160(mainetAddress)))
        );
    }
    /*

    */
    function mainnetAddress(address deployer, string memory name)
        public view
        returns (address)
    {
        bytes32 salt = keccak256(abi.encode(bytes(name), deployer));
        return CloneLib.predictCloneAddressCreate2(
            dataUnionMainnetTemplate,
            address(this),
            salt
        );
    }

    function deployNewDataUnion(
        address owner,
        uint256 adminFeeFraction,
        uint256 duFeeFraction,
        address duBeneficiary,
        address[] memory agents,
        string memory name
    )
        public
        returns (address)
    {
        return deployNewDataUnionUsingToken(
            defaultTokenMainnet,
            defaultTokenMediatorMainnet,
            defaultTokenSidechain,
            defaultTokenMediatorSidechain,
            owner,
            adminFeeFraction,
            duFeeFraction,
            duBeneficiary,
            agents,
            name
        );
    }

    function deployNewDataUnionUsingToken(
        address tokenMainnet,
        address tokenMediatorMainnet,
        address tokenSidechain,
        address tokenMediatorSidechain,
        address owner,
        uint256 adminFeeFraction,
        uint256 duFeeFraction,
        address duBeneficiary,
        address[] memory agents,
        string memory name
    )
        public
        returns (address)
    {
        bytes32 salt = keccak256(abi.encode(bytes(name), msg.sender));
        bytes memory data = abi.encodeWithSignature("initialize(address,address,address,address,address,uint256,address,address,uint256,uint256,address,address[])",
            tokenMainnet,
            tokenMediatorMainnet,
            tokenSidechain,
            tokenMediatorSidechain,
            dataUnionSidechainFactory,
            sidechainMaxGas,
            dataUnionSidechainTemplate,
            owner,
            adminFeeFraction,
            duFeeFraction,
            duBeneficiary,
            agents
        );
        address du = CloneLib.deployCodeAndInitUsingCreate2(CloneLib.cloneBytecode(dataUnionMainnetTemplate), data, salt);
        emit MainnetDUCreated(du, sidechainAddress(du), owner, dataUnionMainnetTemplate);
        return du;
    }
}
