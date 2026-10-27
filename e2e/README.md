# Isolated bridge qualification

All keys here are committed public fixtures. Never fund them outside the isolated lab. Endpoints must be loopback and the suite refuses writes unless both chain IDs are Zenon 322 and EVM 31337. This is a one-key orchestrator fixture, not distributed TSS or production activation evidence.

## Pinned source

Clone `https://github.com/sol-znn/go-zenon`, check out `616f0a61ebc8562846965822f94976e531e0937c`, and set `GO_ZENON_DIR` to that checkout. Working-tree edits are excluded: the build exports that exact commit and checks its tree against `lab/pins.json`. Review the fork and the explicit devnet bridge overlay; this is not an official-mainnet qualification.

## Native lab

Install Go 1.27.1 and Anvil 1.8.5. Verify the appropriate official archive SHA256 from `lab/pins.json`, set `LAB_GO_BIN` if Go is not on PATH, and set `ANVIL_BIN` to the extracted executable. Install the pinned Chrome for Testing headless shell with the lockfile's `node_modules/.bin/browsers install chrome-headless-shell@155.0.8059.39 --path <tools-directory>` and set `CHROME_PATH` to it.

```sh
npm ci
npm run lab:build:native
npm run lab:native          # foreground supervisor; Ctrl-C stops its children
# In a second terminal:
node e2e/lab/frontier.mjs 60 --wait 120 --native
npm run test:e2e
```

Readiness must succeed before the tests. It checks production and agreement across five nodes. The supervisor binds loopback only, fails when a child exits, and records the source/build, binary, Anvil, genesis and config identities. An existing native chain with different inputs is refused; archive its generated `.build/native` evidence and create a fresh isolated chain. Do not reuse unknown fixture publications with a different lab state. Short reorg failures are retained, not re-signed away.

On a convergence timeout, the failure report additionally records bounded
read-only peer counts, numeric sync state/heights and each node's height-two
momentum hash. Missing or malformed diagnostic data remains unavailable.

Native qualification runs three independent fresh cold-start cases: two with
the original error-only RPC logging and one with RPC info logging. Each case
has its own runner, chain and artifact; every failure stays failed. There is no
warm restart or successful-case substitution. The 600-second, minimum-height,
depth and exact five-node convergence requirements are unchanged.

The `error-b` case keeps the original Go startup without a profiling listener.
Only after an actual readiness refusal and its read-only peer/hash snapshot,
the source-bound supervisor may signal the exact owned node with the lowest
valid frontier for a postmortem. A private per-start challenge, exact source/build/node-role identity,
one-shot request and verified child exit bind the capture. It stops this
already-failed isolated fixture; the original failure remains fatal. This
separates startup profiling from the unprofiled failure being investigated.
The `error-a` and `info` cases retain a loopback-only profiling listener for
comparison on the RPC node. Every case also owns private, one-shot postmortem
controls for all five fixture nodes. A lagging producer uses its own unprofiled
postmortem even when the RPC has a loopback profiler. No case signals a PID
supplied by a request. Equal minimum heights use a fixed producer-first role
order; incomplete or foreign frontier records do not select a node.

After preserving a native readiness failure, the report compares all five
hashes at the lowest observed frontier, in addition to height two. It also
collects a bounded loopback profile or owned-child postmortem from the selected
isolated node and fixed log categories. The public report identifies the selected
fixture role, port and observed height. This prevents a healthy RPC profile from
standing in for a stalled producer. Only public Go function names, wait classes,
counts and numeric heights leave the parser. Raw profiles/logs, goroutine IDs,
pointer arguments, peer data and paths are excluded. Missing ownership or
incomplete diagnostic data stays unavailable. Private control files and raw
stderr are excluded from uploaded evidence. Successful readiness performs
no profile reads, postmortem requests/signals or diagnostic-log reads. These diagnostics do not fix or establish
the historical sync-lag cause by themselves.
Peer identities, addresses, names and raw RPC errors are excluded. These
failure-only reads do not extend the qualification window, restart nodes or
permit fixture writes.

## Docker lab

```sh
npm run lab:up
npm run test:e2e
npm run lab:down
```

Docker pins the Go/runtime/Anvil images by digest. `lab.sh` verifies the built image and overlay identities before reuse. `npm run lab:wipe` explicitly deletes only this lab's generated assets and named volumes. Archive evidence first. The Docker path needs independent qualification on a host with a running Docker daemon; a native pass does not prove Docker passed.

`lab:up` waits for the same readiness barrier as native mode: minimum height 20,
depth three and three consecutive five-node agreements on recent momentum hashes.
The extra node RPC ports 47100-47103 bind only to loopback. Docker build/runtime
image pairing and readiness are recorded in `.build/manifest.json` and
`.build/docker/{run-manifest,readiness-report}.json`. Qualification has a separate
Docker job that starts with no chain assets or fixture publication, then runs all
three E2E files. Its result remains separate from the native job.

The compiled-browser suite requires a fresh WebSocket upgrade and validated
chain-322 frontier for the initial load, four cold starts and a controlled
normal socket disconnect/reconnect. Reconnection must issue a new frontier
read; a new socket cannot inherit the old socket's chain or freshness evidence.
Console errors, unexpected endpoints and CSP violations remain fatal. Bounded
transport reports exclude raw NetLog, headers, cookies and RPC payloads. A
passing reconnect control does not establish the cause of an earlier unexpected
transport failure.

The compiled-browser report also records the browser revision and a bounded
network-service inventory before navigation. Only a WebSocket error triggers
another inventory; there is no idle polling. Reports retain service counts and
whether the observed service set changed, excluding process identifiers,
command lines and raw query errors. Missing, malformed or timed-out evidence
leaves the comparison unknown. An empty browser error has its own fixed category.
A deliberately terminated network utility can produce the same empty error
signature while the browser remains usable, even with NetLog enabled; a missing
NetLog connection graph therefore remains incomplete evidence. A matching
injected signature alone does not establish the cause of a historical failure.

A known pre-publication validation rejection archives the matching signed fixture
under `e2e/.state/rejected/` and releases its pending slot. The startup cache error
must name that block's exact acknowledged momentum. Network/timeouts, malformed
responses, internal and unclassified RPC errors keep `publication.json` and its
original hash. There is no automatic resend, replacement signature or cleanup of
old lab state.

The genesis generator backs every declared QSR fusion while preserving total supply; index 1 has 10,000 ZNN and 70,000 spendable QSR plus its fused QSR. Setup deploys/configures the lab bridge/token, and the suites exercise wrap, delayed two-step EVM redemption, unwrap/referral, Zenon redemption and UI behavior. See [qualification boundaries](../docs/QUALIFICATION.md) and [release gates](../docs/DEPLOY.md).
