# Architecture

A static Vue 3 app. Everything it shows comes from two places: a Zenon node
(JSON-RPC over WebSocket) and the EVM chains (through the user's wallet, or a
public RPC when there is none).

```mermaid
flowchart LR
  views[Views] --> state[State]
  state --> core[Core]
  state --> znn[znn client]
  state --> evm[evm clients]
  state --> wallets[Wallet adapters]
  znn --> node[Zenon node]
  evm --> rpc[EVM RPC]
  wallets --> syrius[Syrius]
  wallets --> injected[EIP-6963 wallets]
```

- **core/** is pure: no network, no Vue. Fees, status mapping, referral codes,
  orchestrator health, the plasma bot call. This is what the unit tests cover
  most.
- **state/** holds one reactive store per concern and refreshes on the
  momentum beat (`node.tick`), so a page never polls on its own timer.
- **views/** read state and call wallets. No view talks to a node directly.

## Reads

| Data | From | Refresh |
|---|---|---|
| Momentum height and rate | `ledger.subscribe('momentums')`, timestamp read per momentum | live |
| Bridge switches, networks, pairs | `embedded.bridge.*` | 90 s |
| EVM side of each pair | `tokensInfo`, ERC-20 `symbol`/`decimals` on each bridge | 90 s |
| Orchestrator health | unsigned wraps, last 300 bridge blocks, pillar list | 2 min |
| Activity | requests by recipient, EVM `redeemsInfo` | 30 s while pending |

Networks and pairs are never hardcoded: a pair added on chain appears without a
release. `src/config.ts` holds only what the chain cannot say: explorers,
fallback RPCs, default nodes, the Uniswap pool.

## Which node

The page reads from the default node (`wss://my.hc1node.com:35998` on mainnet,
with one fallback). The node Syrius reports is used only when the user turns on
"Use Syrius node" in the Syrius menu and confirms the network that node says it
is on. That node decides what the page shows, so the user is told which network
it is before anything is read from it: chain 1 is Mainnet, 3 is Testnet, any
other identifier is a devnet.

```mermaid
sequenceDiagram
  participant U as User
  participant P as Page
  participant S as Syrius
  participant W as Wallet node
  participant D as Default node

  P->>D: frontier momentum, first default that answers
  P->>S: connect
  S-->>P: address, chain id, node host
  U->>P: Use Syrius node
  alt embedded, or remote ws from https
    Note over P: keep the default, show why
  else usable
    P->>W: frontier momentum
    alt answers within 5 s
      W-->>P: chain identifier
      P-->>U: network name and chain id
      alt confirmed
        Note over P: every read moves to W, choice remembered
      else cancelled
        Note over P: keep the default
      end
    else no answer
      Note over P: keep the default, show why
    end
  end
```

The choice is stored with the chain identifier it was confirmed for. It is
restored on a later visit only while Syrius still names that node and the node
is still on that chain; otherwise the page goes back to the default and says so.

## Any chain

Nothing is tied to chain 1. On whichever chain the node is on, the page reads
the embedded bridge contract for its networks, EVM bridge addresses, token
pairs, fees and delays, and builds account blocks with that chain's identifier.
What the chain cannot say is skipped off the build's own chain: explorer links,
the plasma bot and the Uniswap pool. An EVM chain the build has no RPC for is
read through the connected EVM wallet once it is on that chain. Transfers
remembered in the browser carry their Zenon chain identifier and show only on
that chain.

## Orchestrator status

There is no public orchestrator monitor any more (status.bridge.zenon.community
is gone), and the orchestrators' own health endpoints are private. The status
is derived from the chain:

- Orchestrators send `UpdateWrapRequest` and `UnwrapToken` from their pillar's
  producer address, rotating by request id. The bridge contract's receive
  blocks show who sent each one and when. Mapping producers to pillars gives
  "seen signing".
- `getAllUnsignedWrapTokenRequests` lists wraps without a signature. One past
  finality for six hours means the ceremony is not happening.

The verdict, in order: halted, key generation, stalled (6 h), delayed (1 h),
online (a signature in the last 24 h), idle. Halted, key generation and
stalled show the red banner on every page and put a "Send anyway" checkbox
in front of the Bridge button. Thresholds are in `src/core/orchestrators.ts`.

## Writes

Every write is signed by the user's wallet.

| Action | Wallet | Call |
|---|---|---|
| Wrap | Syrius | send to the bridge contract, `WrapToken(class, chainId, to)` |
| Redeem a wrap | EVM | `redeem(to, token, amount - fee, id, sig)` twice, `redeemDelay` blocks apart |
| Unwrap | EVM | `approve` if short, then `unwrap(token, amount, "z1…[&z1referrer]")` |
| Redeem an unwrap | Syrius | `Redeem(txHash, logIndex)` |
| Stake LP | Syrius | send to the liquidity contract, `LiquidityStake(seconds)` |
| Revoke, collect | Syrius | `CancelLiquidityStake(id)`, `CollectReward()` |
| Add liquidity | EVM | `approve`, `addLiquidityETH` on the Uniswap V2 router |
| Swap | EVM | `approve` if short, then the transaction LI.FI quoted, to its router |

A redeem simulates first, so bridge.sol's revert reason ("not redeemable yet",
"nonce already redeemed") is shown instead of a failed transaction.

## Swaps

An EVM asset can go to another EVM asset, on the same chain or on the other
one, without the bridge: ETH to wZNN, wZNN on Ethereum to BNB, and so on. The
assets are each chain's coin and the bridge's own tokens there, less pool
shares. `src/core/swap.ts` asks a router for one transaction and the wallet
sends it. Three routers, each answering a browser with no key:

| Swap | Router | Why |
|---|---|---|
| One chain | KyberSwap's aggregator | Takes no fee. For wZNN it returns exactly what the Uniswap V2 pool pays |
| Two chains | Across | Relayers fill in seconds, and it paid the most on every pair tried |
| Either, as a fallback | LI.FI | Reaches the most tokens, and takes 0.25% for it. Asked only when the first has no route |

Measured on 2026-10-13, amount received, against LI.FI alone (the first
version of this feature):

| Pair | LI.FI | Now | Gain |
|---|---|---|---|
| 0.1 ETH to wZNN, Ethereum | 1564.857 wZNN | 1568.755 wZNN, KyberSwap | 0.25% |
| 1000 wZNN to ETH, Ethereum | 0.062577 ETH | 0.062733 ETH, KyberSwap | 0.25% |
| 0.1 ETH to BNB | 0.332674 BNB | 0.335430 BNB, Across | 0.83% |
| 0.3 BNB to ETH | 0.089149 ETH | 0.089303 ETH, Across | 0.17% |
| 1000 wZNN, Ethereum, to BNB | 0.208523 BNB | 0.210411 BNB, Across | 0.91% |

Also tried and set aside: Relay (0.1% better than LI.FI on one chain, 11% worse
on wZNN across two), Symbiosis and deBridge (within 0.03% of Relay on ETH to
BNB, and deBridge adds a fixed 0.001 ETH), 1inch (its API needs a key and
refuses browsers), and a direct Uniswap router call (one pool on one chain;
KyberSwap gives the same price and covers the other tokens).

```mermaid
sequenceDiagram
  participant P as Page
  participant R as Router API
  participant L as LI.FI API
  participant W as EVM wallet
  participant S as Source chain
  participant D as Destination chain

  P->>R: quote (assets, amount, sender, recipient)
  alt has a route
    R-->>P: amount out, minimum, time, transaction
  else no route, or unreachable
    P->>L: quote
    L-->>P: amount out, minimum, time, transaction
  end
  Note over P: refused unless the transaction and the approval name that router's contract
  opt token source, allowance short
    P->>W: approve the router for the amount
    W->>S: approve
  end
  Note over P: a quote past its expiry is asked for again first
  P->>W: send the quoted transaction
  W->>S: swap, or deposit for the relayer
  alt same chain
    S-->>P: receipt, funds at the recipient
  else two chains
    loop every 6 s, up to 10 min
      P->>R: status (tx hash)
      R-->>P: pending, filled or refunded
    end
    D-->>P: funds at the recipient
  end
```

Router API is KyberSwap on one chain and Across on two. Each router's contract
is one address on both chains, held in `src/config.ts`. A quote is refused
unless its transaction and its approval name the contract of the router that
answered, and its value is the amount entered for a coin and zero for a token.
A quote refused that way is shown; it is not replaced by another router's.
Approvals are for the amount, not unlimited.

What changes on the page for a swap: Syrius is not asked for, the bridge's
terms are not asked for, the time shown is the quote's (seconds, not the
bridge's half hour), the recipient is an EVM address and can still be a custom
one, the bridge-down block does not apply, and the details list the route, the
minimum received and the fee in dollars.

Limits. The quote is asked for when an input settles, not on a timer: the
routers are unkeyed and rate limited (LI.FI allows 75 quotes per two hours).
An Across quote is good for about half a minute, so it is usually asked for
again on send; a worse one is shown before anything is signed. KyberSwap
refuses a few well-known addresses, anvil's first account among them, and such
a sender falls back to LI.FI. A swap is not a bridge request, so Activity does
not list it: it is followed with toasts in the tab that sent it, and a reload
loses that.

## Prices

Both amounts carry a dollar estimate, and the details list each token's price.
`fetchPrice` in `src/core/swap.ts` reads LI.FI's token list (`/token`, 100
lookups a minute unkeyed), kept for five minutes per token. A Zenon token is
priced by the EVM token the bridge pairs it with: ZNN by wZNN. A token LI.FI
does not list shows no estimate. Nothing is quoted, limited or sent by these
numbers.

## Design

Zenon design tokens transcribed into `src/style.css` (Tailwind 4, CSS-first),
self-hosted Space Grotesk and JetBrains Mono, Lucide icons. Rules from
`webdesign-lab/RULES.md`: amounts and ids mono and tabular, status as icon plus
word, the plasma gradient once per view on the main action, light and dark, one
700 px breakpoint, 44 px hit areas, nothing from a CDN, and motion that always
runs.

The shape is the owner's brief of 2026-10-12, after stargate.finance, and it
is written down as `webdesign-lab/RULES.md` section 11, "The transfer shape",
so that a refactor of this app or a new app of the same kind keeps it. In
short:

- Glass cards (24 px radius, 88% surface, 10 px blur) over a seeded canvas
  starfield that the pointer lights; controls 14 px, buttons full pills.
- One 440 px column: a From card and a To card with a round reverse button on
  the seam, the amount mono at 30 px, a dollar estimate under each.
- Every token icon carries its chain's badge. A picker row is one asset on one
  chain; each side has its own picker, with no filters, and a valid default
  pair is always selected.
- One main button that says what is missing, then the action. Cost and steps
  in a collapsed Details list. Rare controls behind Advanced and the wallet
  menu.
- Every error goes through `src/core/errors.ts` before it is shown: a few
  plain words, "Declined in wallet" for any refusal.

## Decisions

| Decision | Why |
|---|---|
| No znn-ts-sdk | It pulls ethers 5 and Node polyfills; the noble-based primitives from the ptlc lab are a few hundred lines |
| WebSocket to the node | Public nodes speak it, it carries the subscription, and it needs no CORS preflight |
| Hash routes | Pages has no SPA fallback |
| Large integers parsed as strings | go-zenon sends some amounts as bare JSON numbers past 2^53 (`parseJsonSafe`) |
| Referral suffix is the decoded address | The orchestrator parses it as an address; the original sent the mangled code on a first visit |
| `affiliate.html` follows only http(s) | The original followed any `originURL`, including `javascript:` |
