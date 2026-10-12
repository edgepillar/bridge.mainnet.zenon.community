# Testing

Install the committed dependency graph with `npm ci`. Use a supported Node release from `package.json`; CI targets Node 22, 24 and 26. Local qualification and hosted results are separate.

```sh
npm run lint
npm run typecheck
npm run test:coverage
npm audit --audit-level=low
npm run build
CHROME_PATH=<pinned-headless-shell> npm run test:browser
```

## Deterministic source checks

`tests/unit` covers recorded ABI/signature vectors, exact fees/amounts, recipient/referral eligibility, complete bounded history, schema/RPC failure handling, retired node/account responses, fail-closed route/health authority, journal persistence and original-outcome recovery, EVM receipt identity, compiler-cache inputs and retry-safe lab publications. Fixtures contain public test accounts; no wallet or production write is used.

Coverage thresholds apply to the selected safety modules listed in `vite.config.ts`, not the whole application. State ownership, orchestration and browser focus have additional targeted tests. A percentage is not a security proof.

## Offline browser qualification

`tests/browser` mounts the actual Vue components and uses isolated providers. Outbound network requests are refused; the disconnected-wallet fallback is served by a loopback fixture. It checks all five views at 320/375/768/1024/1440 pixels in light/dark themes with connected/disconnected wallets, modal keyboard/focus behavior, reduced motion, strict amount/recipient checks, late original results, queued economic changes, reverted receipts, same-origin redirects and real cross-tab Web Locks.

Liquidity cases cover unavailable/substituted pools, reverted approvals, LP completion postconditions, zero/halted/unavailable programs, source changes before a queued stake, complete paginated stake history, expiry cancellation and submitted-only collection. These fixtures do not establish DEX contract behavior, real LP minting, stake economics or a production reward cycle. Results and screenshots are written to ignored `.browser-results`.

## Isolated protocol and page checks

Follow the [pinned lab setup](../e2e/README.md), require successful readiness, then run:

```sh
npm run test:e2e
```

The suites run sequentially because administrator/orchestrator/user fixture sends share one account. They exercise wrap, two delayed EVM redeems, unwrap/referral, Zenon redemption and exact balances, then the actual page with its node/contract reads and injected wallet adapters. The lab asserts loopback endpoints and chain IDs before writes. No mainnet funds are used.

Protocol delay tests disable interval mining and control EVM blocks explicitly; UI receipt waits restore interval mining. Zenon publication acknowledges a momentum with depth three and waits until a receive source is included before signing. Unknown publications retain the exact signed block and stop replacements. Preserve a failed run before creating a fresh isolated chain.

The one-key orchestrator does not exercise distributed TSS. Native and Docker evidence are separate; a native pass cannot qualify Docker. Real wallet/platform tests, a full pool-to-LP-to-stake lifecycle, independent review, hosted CI and deployment/operator acceptance remain [external gates](QUALIFICATION.md).
