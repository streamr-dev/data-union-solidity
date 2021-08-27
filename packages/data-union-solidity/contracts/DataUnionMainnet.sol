// SPDX-License-Identifier: MIT

pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
 // TODO: switch to "@openzeppelin/contracts/access/Ownable.sol";
import "./Ownable.sol";
import "./PurchaseListener.sol";
import "./CloneLib.sol";
import "./IAMB.sol";
import "./ITokenMediator.sol";
import "./IERC677Receiver.sol";

contract DataUnionMainnet is Ownable, PurchaseListener, IERC677Receiver {

    event RevenueReceived(uint256 amount);

    // NOTE: any variables set below will NOT be visible in clones from CloneLib / factories
    //       clones must set variables in initialize()

    ERC20 public tokenMainnet;
    ERC20 public tokenSidechain;
    ITokenMediator public tokenMediatorMainnet;
    ITokenMediator public tokenMediatorSidechain;
    address public sidechainDUFactory;
    uint256 public sidechainMaxGas;

    address public sidechainDUTemplate; // needed to compute sidechain address

    // only passed to the sidechain, hence not made public
    uint256 initialAdminFeeFraction;
    uint256 initialDataUnionFeeFraction;
    address initialDataUnionBeneficiary;

    function version() public pure returns (uint256) { return 2; }

    uint256 public tokensSentToBridge;

    constructor() Ownable(address(0)) {}

    function initialize(
        address _tokenMainnet,
        address _mediatorMainnet,
        address _tokenSidechain,
        address _mediatorSidechain,
        address _sidechainDUFactory,
        uint256 _sidechainMaxGas,
        address _sidechainDUTemplate,
        address _owner,
        uint256 _adminFeeFraction,
        uint256 _dataUnionFeeFraction,
        address _dataUnionBeneficiary,
        address[] memory agents
    )  public {
        require(!isInitialized(), "init_once");

        //during setup, msg.sender is admin
        owner = msg.sender;

        tokenMainnet = ERC20(_tokenMainnet);
        tokenMediatorMainnet = ITokenMediator(_mediatorMainnet);
        tokenSidechain = ERC20(_tokenSidechain);
        tokenMediatorSidechain = ITokenMediator(_mediatorSidechain);
        sidechainDUFactory = _sidechainDUFactory;
        sidechainMaxGas = _sidechainMaxGas;
        sidechainDUTemplate = _sidechainDUTemplate;

        initialAdminFeeFraction = _adminFeeFraction;
        initialDataUnionFeeFraction = _dataUnionFeeFraction;
        initialDataUnionBeneficiary = _dataUnionBeneficiary;

        //transfer to real admin
        owner = _owner;
        deployNewDUSidechain(agents);
    }

    function isInitialized() public view returns (bool) {
        return address(tokenMainnet) != address(0);
    }

    function amb() public view returns (IAMB) {
        return IAMB(tokenMediatorMainnet.bridgeContract());
    }

    function deployNewDUSidechain(address[] memory agents) public {
        bytes memory data = abi.encodeWithSignature(
            "deployNewDUSidechain(address,address,address,address[],uint256,uint256,address)",
            address(tokenSidechain),
            address(tokenMediatorSidechain),
            owner,
            agents,
            initialAdminFeeFraction,
            initialDataUnionFeeFraction,
            initialDataUnionBeneficiary
        );
        amb().requireToPassMessage(sidechainDUFactory, data, sidechainMaxGas);
    }

    function sidechainAddress() public view returns (address) {
        return CloneLib.predictCloneAddressCreate2(sidechainDUTemplate, sidechainDUFactory, bytes32(uint256(uint160(address(this)))));
    }

    /**
     * ERC677 callback function, see https://github.com/ethereum/EIPs/issues/677
     * Sends the tokens arriving through a transferAndCall to the sidechain (ignore arguments/calldata)
     * Only the token contract is authorized to call this function
     */
    function onTokenTransfer(address, uint256, bytes calldata) override external {
        require(msg.sender == address(tokenMainnet), "error_onlyTokenContract");
        sendTokensToBridge();
    }

    //function onPurchase(bytes32 productId, address subscriber, uint256 endTimestamp, uint256 priceDatacoin, uint256 feeDatacoin)
    function onPurchase(bytes32, address, uint256, uint256, uint256) external override returns (bool) {
        sendTokensToBridge();
        return true;
    }

    function sendTokensToBridge() public returns (uint256) {
        uint256 newTokens = tokenMainnet.balanceOf(address(this));
        if (newTokens == 0) { return 0; }

        emit RevenueReceived(newTokens);

        // transfer memberEarnings
        require(tokenMainnet.approve(address(tokenMediatorMainnet), newTokens), "approve_failed");

        // must send some non-zero data to trigger the callback function
        tokenMediatorMainnet.relayTokensAndCall(address(tokenMainnet), sidechainAddress(), newTokens, abi.encodePacked("DU2"));

        // check that memberEarnings were sent
        require(tokenMainnet.balanceOf(address(this)) == 0, "not_transferred");
        tokensSentToBridge += newTokens;

        return newTokens;
    }
}
