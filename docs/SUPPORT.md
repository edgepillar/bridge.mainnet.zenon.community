# Support

## Works

| | |
|---|---|
| Syrius | Extension 0.3.0 and later, 0.1.x in a browser that still runs MV2, and the phone app 0.3.6 and later through `syrius://` links ([SYRIUS](SYRIUS.md)): account, chain and node checked; one prompt at a time; the cooldown after a decline waited out |
| Nodes | The build's default, the node Syrius reports, or any node the user adds (`wss://`, or `ws://` to this machine); its network confirmed before anything is read |
| EVM wallets | Any wallet announcing itself by EIP-6963, or `window.ethereum`; account and chain followed |
| Bridge routes | Every pair the embedded bridge lists whose EVM side reads back: chain, key, decimals and halt flag |
| Swaps | Router quotes from KyberSwap, Across and LI.FI on Ethereum and BNB Chain, with router and spender addresses checked |
| Liquidity | The configured wZNN pool, the LP bridge and the stake contract |
| Recovery | Unconfirmed sends kept and checked by hash, see [RECOVERY](RECOVERY.md) |

The page needs HTTPS, a browser with ES modules, BigInt, WebSocket and Web
Locks, and storage it can write. Without exclusive locks or storage it will
not sign. Do not clear saved history to get around that.

## Doesn't work, or isn't proven

- **WalletConnect.** It needs a project id and a remote relay.
- **Real wallet versions.** Every Syrius release was driven on the lab
  ([SYRIUS](SYRIUS.md)); the phone app only as its web build, not on a device.
  0.1.x cannot approve in Firefox (the wallet's limit). EVM wallets are mocked;
  WebKit, hardware wallets and smart wallets have not been qualified.
- **Swap delivery.** A confirmed swap proves the source transaction. The
  router's calldata and the result on the receiving chain are trusted, not
  checked.
- **Other networks.** A node switch reads that network's bridge, but sends
  still need a verified matching EVM route. Explorers, the plasma bot and the
  liquidity settings belong to the build's chain only.
- **Contract recipients.** An EVM contract address is a valid recipient; that
  does not mean the contract can use what it receives. Zenon recipients and
  referrers must be user addresses.

## Where to ask

Open an issue on the repository for anything that holds no private data.
Browser exports hold addresses, amounts and node details: do not post them.
Security problems go through [SECURITY](../SECURITY.md). A recovery contact,
supported wallet versions and a release owner have not been named yet.
