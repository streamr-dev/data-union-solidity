// SPDX-License-Identifier: MIT

pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IERC677.sol";
// TODO: switch to "@openzeppelin/contracts/access/Ownable.sol";
import "./Ownable.sol";
import "./IERC20Receiver.sol";
import "./IERC677Receiver.sol";

contract DataUnionSidechain is Ownable, IERC20Receiver, IERC677Receiver {

    // Used to describe both members and join part agents
    enum ActiveStatus {NONE, ACTIVE, INACTIVE}

    // Members
    event MemberJoined(address indexed member);
    event MemberParted(address indexed member);
    event JoinPartAgentAdded(address indexed agent);
    event JoinPartAgentRemoved(address indexed agent);
    event NewMemberEthSent(uint amountWei);

    // Revenue handling: earnings = revenue - admin fee - du fee
    event RevenueReceived(uint256 amount);
    event FeesCharged(uint256 adminFee, uint256 dataUnionFee);
    event NewEarnings(uint256 earningsPerMember, uint256 activeMemberCount);

    // Withdrawals
    event EarningsWithdrawn(address indexed member, uint256 amount);

    // In-contract transfers
    event TransferWithinContract(address indexed from, address indexed to, uint amount);
    event TransferToAddressInContract(address indexed from, address indexed to, uint amount);

    // Variable properties change events
    event UpdateNewMemberEth(uint value);
    event FeesSet(uint256 adminFee, uint256 dataUnionFee);
    event DataUnionBeneficiaryChanged(address current, address old);

    struct MemberInfo {
        ActiveStatus status;
        uint256 earningsBeforeLastJoin;
        uint256 lmeAtJoin;
        uint256 withdrawnEarnings;
    }

    // Constant properties (only set in initialize)
    IERC677 public token;
    address public tokenMediator;
    address public dataUnionMainnet;

    // Variable properties
    uint256 public newMemberEth;
    uint256 public adminFeeFraction;
    uint256 public dataUnionFeeFraction;
    address public dataUnionBeneficiary;

    // Useful stats
    uint256 public totalRevenue;
    uint256 public totalEarnings;
    uint256 public totalAdminFees;
    uint256 public totalDataUnionFees;
    uint256 public totalWithdrawn;
    uint256 public activeMemberCount;
    uint256 public inactiveMemberCount;
    uint256 public lifetimeMemberEarnings;
    uint256 public joinPartAgentCount;

    mapping(address => MemberInfo) public memberData;
    mapping(address => ActiveStatus) public joinPartAgents;

    modifier onlyJoinPartAgent() {
        require(joinPartAgents[msg.sender] == ActiveStatus.ACTIVE, "error_onlyJoinPartAgent");
        _;
    }

    // owner will be set by initialize()
    constructor() Ownable(address(0)) {}

    receive() external payable {}

    function initialize(
        address initialOwner,
        address tokenAddress,
        address tokenMediatorAddress,
        address[] memory initialJoinPartAgents,
        address mainnetDataUnionAddress,
        uint256 defaultNewMemberEth,
        uint256 initialAdminFeeFraction,
        uint256 initialDataUnionFeeFraction,
        address initialDataUnionBeneficiary
    ) public {
        require(!isInitialized(), "error_alreadyInitialized");
        owner = msg.sender; // set real owner at the end. During initialize, addJoinPartAgents can be called by owner only
        token = IERC677(tokenAddress);
        addJoinPartAgents(initialJoinPartAgents);
        tokenMediator = tokenMediatorAddress;
        dataUnionMainnet = mainnetDataUnionAddress;
        setFees(initialAdminFeeFraction, initialDataUnionFeeFraction);
        setDataUnionBeneficiary(initialDataUnionBeneficiary);
        setNewMemberEth(defaultNewMemberEth);
        owner = initialOwner;
    }

    function isInitialized() public view returns (bool){
        return address(token) != address(0);
    }

    /**
     * Atomic getter to get all Data Union state variables in one call
     * This alleviates the fact that JSON RPC batch requests aren't available in ethers.js
     */
    function getStats() public view returns (uint256[9] memory) {
        uint256 cleanedInactiveMemberCount = inactiveMemberCount;
        if (memberData[owner].status == ActiveStatus.INACTIVE) { cleanedInactiveMemberCount -= 1; }
        if (memberData[dataUnionBeneficiary].status == ActiveStatus.INACTIVE) { cleanedInactiveMemberCount -= 1; }
        return [
            totalRevenue,
            totalEarnings,
            totalAdminFees,
            totalDataUnionFees,
            totalWithdrawn,
            activeMemberCount,
            cleanedInactiveMemberCount,
            lifetimeMemberEarnings,
            joinPartAgentCount
        ];
    }

    /**
     * Admin and DU fees as a fraction of revenue,
     *   using fixed-point decimal in the same way as ether: 50% === 0.5 ether === "500000000000000000"
     * @param newAdminFee fee that goes to the DU owner
     * @param newDataUnionFee fee that goes to the DU beneficiary
     */
    function setFees(uint256 newAdminFee, uint256 newDataUnionFee) public onlyOwner {
        require((newAdminFee + newDataUnionFee) <= 1 ether, "error_Fees");
        adminFeeFraction = newAdminFee;
        dataUnionFeeFraction = newDataUnionFee;
        emit FeesSet(adminFeeFraction, dataUnionFeeFraction);
    }

    function setDataUnionBeneficiary(address _dataUnionBeneficiary) public onlyOwner {
        require(_dataUnionBeneficiary != address(0), "invalid_address");
        dataUnionBeneficiary = _dataUnionBeneficiary;
        emit DataUnionBeneficiaryChanged(dataUnionBeneficiary, _dataUnionBeneficiary);
    }

    function setNewMemberEth(uint val) public onlyOwner {
        if (val == newMemberEth) { return; }
        newMemberEth = val;
        emit UpdateNewMemberEth(val);
    }

    //------------------------------------------------------------
    // REVENUE HANDLING FUNCTIONS
    //------------------------------------------------------------

    /**
     * Process unaccounted tokens that have been sent previously
     * Called by AMB (see DataUnionMainnet:sendTokensToBridge)
     */
    function refreshRevenue() public returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 newTokens = balance - totalWithdrawable(); // solidity 0.8: a - b errors if b > a
        if (newTokens == 0 || activeMemberCount == 0) { return 0; }
        totalRevenue += newTokens;
        emit RevenueReceived(newTokens);

        // fractions are expressed as multiples of 10^18 just like tokens, so must divide away the extra 10^18 factor
        // overflow in multiplication is not an issue: 256bits ~= 10^77
        uint256 adminFee = (newTokens * adminFeeFraction) / (1 ether);
        uint256 duFee = (newTokens * dataUnionFeeFraction) / (1 ether);
        uint256 newEarnings = newTokens - adminFee - duFee;

        _increaseBalance(owner, adminFee);
        _increaseBalance(dataUnionBeneficiary, duFee);
        totalAdminFees += adminFee;
        totalDataUnionFees += duFee;
        emit FeesCharged(adminFee, duFee);

        uint256 earningsPerMember = newEarnings / activeMemberCount;
        lifetimeMemberEarnings = lifetimeMemberEarnings + earningsPerMember;
        totalEarnings = totalEarnings + newEarnings;
        emit NewEarnings(earningsPerMember, activeMemberCount);

        assert (token.balanceOf(address(this)) == totalWithdrawable()); // calling this function immediately again should just return 0 and do nothing
        return newEarnings;
    }

    /**
     * ERC677 callback function, see https://github.com/ethereum/EIPs/issues/677
     * Receives the tokens arriving through bridge
     * Only the token contract is authorized to call this function
     */
    function onTokenTransfer(address, uint256, bytes calldata) override external {
        require(msg.sender == address(token), "error_onlyTokenContract");
        refreshRevenue();
    }

    /**
     * Tokenbridge callback function
     */
    function onTokenBridged(address, uint256, bytes memory) override public {
        refreshRevenue();
    }

    //------------------------------------------------------------
    // MEMBER MANAGEMENT / VIEW FUNCTIONS
    //------------------------------------------------------------

    function getEarnings(address member) public view returns (uint256) {
        MemberInfo storage info = memberData[member];
        require(info.status != ActiveStatus.NONE, "error_notMember");
        return
            info.earningsBeforeLastJoin +
            (
                info.status == ActiveStatus.ACTIVE
                    ? lifetimeMemberEarnings - info.lmeAtJoin
                    : 0
            );
    }

    function getWithdrawn(address member) public view returns (uint256) {
        MemberInfo storage info = memberData[member];
        require(info.status != ActiveStatus.NONE, "error_notMember");
        return info.withdrawnEarnings;
    }

    function getWithdrawableEarnings(address member) public view returns (uint256) {
        return getEarnings(member) - getWithdrawn(member);
    }

    // this includes the fees paid to admins and the DU beneficiary
    function totalWithdrawable() public view returns (uint256) {
        return totalRevenue - totalWithdrawn;
    }

    function addJoinPartAgents(address[] memory agents) public onlyOwner {
        for (uint256 i = 0; i < agents.length; i++) {
            addJoinPartAgent(agents[i]);
        }
    }

    function addJoinPartAgent(address agent) public onlyOwner {
        require(joinPartAgents[agent] != ActiveStatus.ACTIVE, "error_alreadyActiveAgent");
        joinPartAgents[agent] = ActiveStatus.ACTIVE;
        emit JoinPartAgentAdded(agent);
        joinPartAgentCount = ++joinPartAgentCount;
    }

    function removeJoinPartAgent(address agent) public onlyOwner {
        require(joinPartAgents[agent] == ActiveStatus.ACTIVE, "error_notActiveAgent");
        joinPartAgents[agent] = ActiveStatus.INACTIVE;
        emit JoinPartAgentRemoved(agent);
        joinPartAgentCount = --joinPartAgentCount;
    }

    function addMember(address payable member) public onlyJoinPartAgent {
        MemberInfo storage info = memberData[member];
        require(info.status != ActiveStatus.ACTIVE, "error_alreadyMember");
        if(info.status == ActiveStatus.INACTIVE){
            inactiveMemberCount = --inactiveMemberCount;
        }
        bool sendEth = info.status == ActiveStatus.NONE && newMemberEth != 0 && address(this).balance >= newMemberEth;
        info.status = ActiveStatus.ACTIVE;
        info.lmeAtJoin = lifetimeMemberEarnings;
        activeMemberCount = ++activeMemberCount;
        emit MemberJoined(member);

        // give new members ETH. continue even if transfer fails
        if (sendEth) {
            if (member.send(newMemberEth)) {
                emit NewMemberEthSent(newMemberEth);
            }
        }
    }

    function partMember(address member) public {
        require(msg.sender == member || joinPartAgents[msg.sender] == ActiveStatus.ACTIVE, "error_notPermitted");
        MemberInfo storage info = memberData[member];
        require(info.status == ActiveStatus.ACTIVE, "error_notActiveMember");
        info.earningsBeforeLastJoin = getEarnings(member);
        info.status = ActiveStatus.INACTIVE;
        activeMemberCount = --activeMemberCount;
        inactiveMemberCount = ++inactiveMemberCount;
        emit MemberParted(member);
    }

    function addMembers(address payable[] memory members) public onlyJoinPartAgent {
        for (uint256 i = 0; i < members.length; i++) {
            addMember(members[i]);
        }
    }

    //access checked in partMember
    function partMembers(address[] memory members) public {
        for (uint256 i = 0; i < members.length; i++) {
            partMember(members[i]);
        }
    }

    //------------------------------------------------------------
    // IN-CONTRACT TRANSFER FUNCTIONS
    //------------------------------------------------------------

    /**
     * Transfer tokens from outside contract, add to a recipient's in-contract balance
     */
    function transferToMemberInContract(address recipient, uint amount) public {
        // this is done first, so that in case token implementation calls the onTokenTransfer in its transferFrom (which by ERC677 it should NOT),
        //   transferred tokens will still not count as earnings (distributed to all) but a simple earnings increase to this particular member
        _increaseBalance(recipient, amount);
        totalEarnings = totalEarnings + amount;
        emit TransferToAddressInContract(msg.sender, recipient,  amount);

        uint balanceBefore = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), amount), "error_transfer");
        uint balanceAfter = token.balanceOf(address(this));
        require((balanceAfter - balanceBefore) >= amount, "error_transfer");
    }

    /**
     * Transfer tokens from sender's in-contract balance to recipient's in-contract balance
     * This is done by "withdrawing" sender's earnings and crediting them to recipient's unwithdrawn earnings,
     *   so withdrawnEarnings never decreases for anyone (within this function)
     * @param recipient whose withdrawable earnings will increase
     * @param amount how much withdrawable earnings is transferred
     */
    function transferWithinContract(address recipient, uint amount) public {
        require(getWithdrawableEarnings(msg.sender) >= amount, "error_insufficientBalance");    // reverts with "error_notMember" msg.sender not member
        MemberInfo storage info = memberData[msg.sender];
        info.withdrawnEarnings = info.withdrawnEarnings + amount;
        _increaseBalance(recipient, amount);
        emit TransferWithinContract(msg.sender, recipient, amount);
    }

    /**
     * Hack to add to single member's balance without affecting lmeAtJoin
     */
    function _increaseBalance(address member, uint amount) internal {
        MemberInfo storage info = memberData[member];
        info.earningsBeforeLastJoin = info.earningsBeforeLastJoin + amount;

        // allow seeing and withdrawing earnings
        if (info.status == ActiveStatus.NONE) {
            info.status = ActiveStatus.INACTIVE;
            inactiveMemberCount = ++inactiveMemberCount;
        }
    }

    //------------------------------------------------------------
    // WITHDRAW FUNCTIONS
    //------------------------------------------------------------

    function withdrawMembers(address[] memory members, bool sendToMainnet)
        public
        returns (uint256)
    {
        uint256 withdrawn = 0;
        for (uint256 i = 0; i < members.length; i++) {
            withdrawn = withdrawn + (withdrawAll(members[i], sendToMainnet));
        }
        return withdrawn;
    }

    function withdrawAll(address member, bool sendToMainnet)
        public
        returns (uint256)
    {
        return withdraw(member, getWithdrawableEarnings(member), sendToMainnet);
    }

    function withdraw(address member, uint amount, bool sendToMainnet)
        public
        returns (uint256)
    {
        require(msg.sender == member || msg.sender == owner, "error_notPermitted");
        return _withdraw(member, member, amount, sendToMainnet);
    }

    function withdrawAllTo(address to, bool sendToMainnet)
        public
        returns (uint256)
    {
        return withdrawTo(to, getWithdrawableEarnings(msg.sender), sendToMainnet);
    }

    function withdrawTo(address to, uint amount, bool sendToMainnet)
        public
        returns (uint256)
    {
        return _withdraw(msg.sender, to, amount, sendToMainnet);
    }

    /**
     * Check signature from a member authorizing withdrawing its earnings to another account.
     * Throws if the signature is badly formatted or doesn't match the given signer and amount.
     * Signature has parts the act as replay protection:
     * 1) `address(this)`: signature can't be used for other contracts;
     * 2) `withdrawn[signer]`: signature only works once (for unspecified amount), and can be "cancelled" by sending a withdraw tx.
     * Generated in Javascript with: `web3.eth.accounts.sign(recipientAddress + amount.toString(16, 64) + contractAddress.slice(2) + withdrawnTokens.toString(16, 64), signerPrivateKey)`,
     * or for unlimited amount: `web3.eth.accounts.sign(recipientAddress + "0".repeat(64) + contractAddress.slice(2) + withdrawnTokens.toString(16, 64), signerPrivateKey)`.
     * @param signer whose earnings are being withdrawn
     * @param recipient of the tokens
     * @param amount how much is authorized for withdraw, or zero for unlimited (withdrawAll)
     * @param signature byte array from `web3.eth.accounts.sign`
     * @return isValid true iff signer of the authorization (member whose earnings are going to be withdrawn) matches the signature
     */
    function signatureIsValid(
        address signer,
        address recipient,
        uint amount,
        bytes memory signature
    )
        public view
        returns (bool isValid)
    {
        require(signature.length == 65, "error_badSignatureLength");

        bytes32 r; bytes32 s; uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "error_badSignatureVersion");

        // When changing the message, remember to double-check that message length is correct!
        bytes32 messageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n104", recipient, amount, address(this), getWithdrawn(signer)));
        address calculatedSigner = ecrecover(messageHash, v, r, s);

        return calculatedSigner == signer;
    }

    /**
     * Do an "unlimited donate withdraw" on behalf of someone else, to an address they've specified.
     * Sponsored withdraw is paid by admin, but target account could be whatever the member specifies.
     * The signature gives a "blank cheque" for admin to withdraw all tokens to `recipient` in the future,
     *   and it's valid until next withdraw (and so can be nullified by withdrawing any amount).
     * A new signature needs to be obtained for each subsequent future withdraw.
     * @param fromSigner whose earnings are being withdrawn
     * @param to the address the tokens will be sent to (instead of `msg.sender`)
     * @param sendToMainnet if the tokens should be sent to mainnet or only withdrawn into sidechain address
     * @param signature from the member, see `signatureIsValid` how signature generated for unlimited amount
     */
    function withdrawAllToSigned(
        address fromSigner,
        address to,
        bool sendToMainnet,
        bytes memory signature
    )
        public
        returns (uint withdrawn)
    {
        require(signatureIsValid(fromSigner, to, 0, signature), "error_badSignature");
        return _withdraw(fromSigner, to, getWithdrawableEarnings(fromSigner), sendToMainnet);
    }

    /**
     * Do a "donate withdraw" on behalf of someone else, to an address they've specified.
     * Sponsored withdraw is paid by admin, but target account could be whatever the member specifies.
     * The signature is valid only for given amount of tokens that may be different from maximum withdrawable tokens.
     * @param fromSigner whose earnings are being withdrawn
     * @param to the address the tokens will be sent to (instead of `msg.sender`)
     * @param amount of tokens to withdraw
     * @param sendToMainnet if the tokens should be sent to mainnet or only withdrawn into sidechain address
     * @param signature from the member, see `signatureIsValid` how signature generated for unlimited amount
     */
    function withdrawToSigned(
        address fromSigner,
        address to,
        uint amount,
        bool sendToMainnet,
        bytes memory signature
    )
        public
        returns (uint withdrawn)
    {
        require(signatureIsValid(fromSigner, to, amount, signature), "error_badSignature");
        return _withdraw(fromSigner, to, amount, sendToMainnet);
    }

    /**
     * Internal function common to all withdraw methods.
     * Does NOT check proper access, so all callers must do that first.
     */
    function _withdraw(address from, address to, uint amount, bool sendToMainnet)
        internal
        returns (uint256)
    {
        if (amount == 0) { return 0; }
        require(amount <= getWithdrawableEarnings(from), "error_insufficientBalance");
        MemberInfo storage info = memberData[from];
        info.withdrawnEarnings += amount;
        totalWithdrawn += amount;

        if (sendToMainnet) {
            // tokenMediator sends tokens over the bridge it's assigned to
            require(token.transferAndCall(tokenMediator, amount, abi.encodePacked(to)), "error_transfer");
        } else {
            // transferAndCall also enables transfers over another token bridge
            //   in this case to=another bridge's tokenMediator, and from=recipient on the other chain
            // this follows the tokenMediator API: data will contain the recipient address, which is the same as sender but on the other chain
            // in case transferAndCall recipient is not a tokenMediator, the data can be ignored (it contains the DU member's address)
            require(token.transferAndCall(to, amount, abi.encodePacked(from)), "error_transfer");
        }
        emit EarningsWithdrawn(from, amount);
        return amount;
    }

}
