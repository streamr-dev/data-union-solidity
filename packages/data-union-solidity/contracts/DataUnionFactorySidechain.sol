// SPDX-License-Identifier: MIT

pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./CloneLib.sol";
import "./IAMB.sol";
import "./ITokenMediator.sol";
// TODO: switch to "@openzeppelin/contracts/access/Ownable.sol";
import "./Ownable.sol";

contract DataUnionFactorySidechain is Ownable {
    event SidechainDUCreated(address indexed mainnet, address indexed sidenet, address indexed owner, address template);
    event UpdateNewDUInitialEth(uint amount);
    event UpdateNewDUOwnerInitialEth(uint amount);
    event UpdateDefaultNewMemberInitialEth(uint amount);
    event DUInitialEthSent(uint amountWei);
    event OwnerInitialEthSent(uint amountWei);

    address public dataUnionSidechainTemplate;

    // when sidechain DU is created, the factory sends a bit of sETH to the DU and the owner
    uint public newDUInitialEth;
    uint public newDUOwnerInitialEth;
    uint public defaultNewMemberEth;

    constructor(address _dataUnionSidechainTemplate) Ownable(msg.sender) {
        dataUnionSidechainTemplate = _dataUnionSidechainTemplate;
    }

    // contract is payable so it can receive and hold the new member eth stipends
    receive() external payable {}

    function setNewDUInitialEth(uint val) public onlyOwner {
        if(val == newDUInitialEth) return;
        newDUInitialEth = val;
        emit UpdateNewDUInitialEth(val);
    }

    function setNewDUOwnerInitialEth(uint val) public onlyOwner {
        if(val == newDUOwnerInitialEth) return;
        newDUOwnerInitialEth = val;
        emit UpdateNewDUOwnerInitialEth(val);
    }

    function setNewMemberInitialEth(uint val) public onlyOwner {
        if(val == defaultNewMemberEth) return;
        defaultNewMemberEth = val;
        emit UpdateDefaultNewMemberInitialEth(val);
    }


    function sidechainAddress(address mainnetAddress)
        public view
        returns (address proxy)
    {
        return CloneLib.predictCloneAddressCreate2(dataUnionSidechainTemplate, address(this), bytes32(uint256(uint160(mainnetAddress))));
    }

    function amb(address _mediator) public view returns (IAMB) {
        return IAMB(ITokenMediator(_mediator).bridgeContract());
    }


    /**
     * @dev This function is called over the bridge by the DataUnionMainnet.initialize function
     * @dev Hence must be called by the AMB. Use MockAMB for testing.
     * @dev CREATE2 salt = mainnet_address.
     */
    function deployNewDUSidechain(
        address token,
        address mediator,
        address payable owner,
        address[] memory agents,
        uint256 initialAdminFeeFraction,
        uint256 initialDataUnionFeeFraction,
        address initialDataUnionBeneficiary
    ) public returns (address) {
        require(msg.sender == address(amb(mediator)), "only_AMB");
        address duMainnet = amb(mediator).messageSender();
        bytes32 salt = bytes32(uint256(uint160(duMainnet)));
        bytes memory data = abi.encodeWithSignature(
            "initialize(address,address,address,address[],address,uint256,uint256,uint256,address)",
            owner,
            token,
            mediator,
            agents,
            duMainnet,
            defaultNewMemberEth,
            initialAdminFeeFraction,
            initialDataUnionFeeFraction,
            initialDataUnionBeneficiary
        );
        address payable du = CloneLib.deployCodeAndInitUsingCreate2(CloneLib.cloneBytecode(dataUnionSidechainTemplate), data, salt);
        emit SidechainDUCreated(duMainnet, du, owner, dataUnionSidechainTemplate);

        // continue whether or not send succeeds
        if (newDUInitialEth != 0 && address(this).balance >= newDUInitialEth) {
            if (du.send(newDUInitialEth)) {
                emit DUInitialEthSent(newDUInitialEth);
            }
        }
        if (newDUOwnerInitialEth != 0 && address(this).balance >= newDUOwnerInitialEth) {
            // solhint-disable-next-line multiple-sends
            if (owner.send(newDUOwnerInitialEth)) {
                emit OwnerInitialEthSent(newDUOwnerInitialEth);
            }
        }
        return du;
    }
}
