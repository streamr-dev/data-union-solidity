// SPDX-License-Identifier: MIT

pragma solidity 0.8.6;

import "./uniswap-v2-periphery/IUniswapV2Router02.sol";
import "./IERC677.sol";
import "./BytesLib.sol";
import "./IERC677Receiver.sol";

contract BinanceAdapter is IERC677Receiver {

    event WithdrawToBinance(address indexed token, address indexed to, uint256 amountDatacoin, uint256 amountOtheroken);
    event SetBinanceRecipient(address indexed member, address indexed recipient);

    struct UserData {
        address binanceAddress;
        uint256 nonce;
    }

    IUniswapV2Router02 public honeyswapRouter;
    address public bscBridge;
    IERC677 public dataCoin;
    address public convertToCoin;
    //optional intermediate token for liquidity path
    address public liquidityToken;
    uint256 public datacoinPassed;
    mapping(address => UserData) public binanceRecipient;

    constructor(address dataCoin_, address honeyswapRouter_, address bscBridge_, address convertToCoin_, address liquidityToken_) {
        dataCoin = IERC677(dataCoin_);
        honeyswapRouter = IUniswapV2Router02(honeyswapRouter_);
        bscBridge = address(bscBridge_);
        convertToCoin = convertToCoin_;
        liquidityToken = liquidityToken_;
    }

    function setBinanceRecipient(address recipient) public {
        _setBinanceRecipient(msg.sender, recipient);
    }

    function setBinanceRecipientFromSig(address from, address recipient, bytes memory sig) public {
        UserData storage userdata = binanceRecipient[from];
        userdata.nonce += 1;
        require(getSigner(recipient, userdata.nonce, sig) == from, "bad_signature");
        _setBinanceRecipient(from, recipient);
    }

    function _setBinanceRecipient(address member, address recipient) internal {
        UserData storage userdata = binanceRecipient[member];
        userdata.binanceAddress = recipient;
        emit SetBinanceRecipient(member, recipient);
    }

    /**
     * @param deadlineTimestamp given to prevent replay attacks
     */
    function _withdrawToBinance(address binanceAddress, uint256 amountDatacoin, address toCoinXDai, uint256 toCoinMinAmount, uint256 deadlineTimestamp) internal {
        IERC677 toCoin;
        // in toCoin:
        uint256 sendToBinanceAmount;
        if (toCoinXDai == address(dataCoin) || toCoinXDai == address(0)) {
            // no conversion neeeded
            toCoin = IERC677(dataCoin);
            sendToBinanceAmount = toCoin.balanceOf(address(this));
            // err if not enough DATA coin balance
            require(sendToBinanceAmount >= amountDatacoin, "insufficient_balance");
        } else {
            require(dataCoin.approve(address(honeyswapRouter), amountDatacoin), "approve_failed");
            address[] memory path = _honeyswapPath(toCoinXDai);
            // this should err if not enough DATA coin balance
            honeyswapRouter.swapExactTokensForTokens(amountDatacoin, toCoinMinAmount, path, address(this), deadlineTimestamp);
            toCoin = IERC677(toCoinXDai);
            sendToBinanceAmount = toCoin.balanceOf(address(this));
        }
        toCoin.transferAndCall(bscBridge, sendToBinanceAmount, abi.encodePacked(binanceAddress));
        emit WithdrawToBinance(address(toCoin), binanceAddress, amountDatacoin, sendToBinanceAmount);
        datacoinPassed = datacoinPassed + amountDatacoin;
    }

    function _honeyswapPath(address toCoinXDai) internal view returns (address[] memory) {
        address[] memory path;
        if (liquidityToken == address(0)) {
            // no intermediate
            path = new address[](2);
            path[0] = address(dataCoin);
            path[1] = toCoinXDai;
        } else {
            // use intermediate liquidity token
            path = new address[](3);
            path[0] = address(dataCoin);
            path[1] = liquidityToken;
            path[2] = toCoinXDai;
        }
        return path;
    }

    /**
     * ERC677 callback
     */
    function onTokenTransfer(address, uint256 amount, bytes calldata data) override external {
        uint256 maxint = uint256(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
        address member = BytesLib.toAddress(data);
        UserData storage userdata = binanceRecipient[member];
        address recipient = userdata.binanceAddress;
        require(recipient != address(0), "recipient_undefined");
        //min output is 1 wei, no deadline
        _withdrawToBinance(userdata.binanceAddress, amount, convertToCoin, 1, maxint);
    }

    function getSigner(address recipient, uint256 nonce, bytes memory signature) public view returns (address) {
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

        bytes32 messageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n72", recipient, nonce, address(this)));
        return ecrecover(messageHash, v, r, s);
    }

}