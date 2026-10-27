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

The suite establishes the idempotent committed loopback bridge fixture itself
before starting its read-only browser checks. It can therefore run first or
after either other E2E file. Vitest orders uncached files by size and cached
files by failure/duration; no filename or previous suite may supply this setup
implicitly. Fixture writes retain the chain-322/Anvil-31337 identity guard.

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

A failed target run on the tested merge `b8af7c02` observed a replaced network
service after successful five-node readiness; the browser's empty WebSocket
error still fails the suite. The reason for that replacement remains unknown.
The report now passively inspects at most 64 KiB of the owned browser's stderr
after launch and before teardown. It retains only a fixed count of the pinned
Chromium [network-service recreation message](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/browser/network_service_instance_impl.cc#L652),
byte/truncation facts and the owned main browser's exit state. Raw lines,
identifiers and paths are never included. Missing or incomplete capture stays
explicit; a zero counter does not prove the service never exited. The message
itself does not distinguish a crash from termination or establish its cause.
Reporting snapshots precede the fixture's intentional browser shutdown.

When a browser socket error occurs, a single pre-teardown snapshot also records
deltas of the pinned Chromium utility-process crash, kill and disconnected-alive
counters. The baseline is taken before navigation; there is no idle polling.
The [pinned process-type enum](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/public/common/process_type.h#L18)
and [termination histogram sites](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/browser/browser_child_process_host_impl.cc#L468)
define the categories. An actual owned-browser SIGKILL calibration increased only
the utility-kill counter while replacing the network service. It calibrates the
metric, not the natural Linux failure. These counters cover **all utility
processes** and do not alone identify a network-service termination or its cause.
Unknown browser revisions, schemas, deadlines and non-monotone samples remain
unavailable. Identifiers, paths, arbitrary histogram names and raw query errors
are excluded. Unexpected socket/console errors remain fatal.

The pinned Linux implementation can send `SIGKILL` itself when querying a
[disconnected child's known-dead status](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/base/process/kill_posix.cc#L82).
A killed-counter delta therefore does not prove an external actor or OOM.
The `info` native CI case calibrates a separate owned kernel signal observer
using one deliberate `SIGTERM` to its own disposable Python child. It then
observes each compiled/probe browser's initial network-service threads in a fresh,
recipient-filtered tracefs instance. Only fixed signal, sender-role and
generation-result categories enter the report. No raw trace, process/thread ID,
command, executable or path is uploaded. Buffer loss, bounds, identity or
permission failures remain explicit. The observer stops before intentional
browser teardown and removes only its own tracing instance. It neither signals
the natural browser nor changes its sandbox or RPC policy. Signal generation
is positive evidence; it does not establish why an earlier IPC pipe closed.

Actual-Go transport probes reuse the already accepted compiled fixture origin
`http://127.0.0.1:5195` after that fixture closes. A random web port is not in
the native lab's existing Origin allowlist and can be refused before an RPC
reply. That setup error is distinct from a validated socket dropping while
the network service is replaced. The allowlist is never widened for a probe.

Native stack reports can distinguish fixed downloader wait sites only for the
exact reviewed Go commit and built downloader file SHA-256. The EOF handoff and the hash reply/timeout select are
separate categories, as are the first-worker and remaining-worker joins.
Unknown source pins or source locations have no inferred wait-site category.
Only those fixed categories are emitted; raw paths, offsets and arguments stay
private. A matching stack shape alone is not a causal reproduction.

A known pre-publication validation rejection archives the matching signed fixture
under `e2e/.state/rejected/` and releases its pending slot. The startup cache error
must name that block's exact acknowledged momentum. Network/timeouts, malformed
responses, internal and unclassified RPC errors keep `publication.json` and its
original hash. There is no automatic resend, replacement signature or cleanup of
old lab state.

The genesis generator backs every declared QSR fusion while preserving total supply; index 1 has 10,000 ZNN and 70,000 spendable QSR plus its fused QSR. Setup deploys/configures the lab bridge/token, and the suites exercise wrap, delayed two-step EVM redemption, unwrap/referral, Zenon redemption and UI behavior. See [qualification boundaries](../docs/QUALIFICATION.md) and [release gates](../docs/DEPLOY.md).

## Downloader phase isolation

A failed synchronization could leave an EOF flag in the downloader's shared
`processCh`. The next block-fetch worker could consume that old flag before new
hashes arrived and exit successfully. The new hash worker then queued two hashes
and blocked sending its EOF to a full channel with no block worker left. The
outer sync joined the blocked worker indefinitely. This is independent of a
particular height: the actual package regression freezes at height 5, while a
natural Linux CI producer froze at height 2.

The pinned package passed its nine existing tests. A control using two complete
actual synchronizations, the real queue/peer/delivery functions and descending
protocol hash replies reproduced height 5, two pending hashes and active sync.
It did not seed `processCh` directly. Resetting that channel for each new sync
made all ten package tests and ten repeated controlled interleavings pass. The
[natural failure on the unpatched source](https://github.com/edgepillar/bridge.mainnet.zenon.community/actions/runs/40545587535/attempts/1)
independently captured `HASH_COMPLETION_HANDOFF` and
`SYNC_JOIN_AFTER_FIRST_SUCCESS`, with no block-fetch worker. Its exact Go source
and downloader-file hash matched the control. The older RPC-5 run lacks this
stack evidence; no exact retrospective attribution is claimed for that run.

Both native and Docker lab builds now apply only this two-line synchronization
patch to the exported Go source. `downloader-phase-reset.mjs` refuses any source
or result whose SHA-256 differs from the qualified preimage/result. The Go base
commit/tree remain pinned and its checkout is never edited. Build manifests
record the original/patched identities, actual downloader hash and all overlay
hashes. The runtime is therefore explicitly a patched lab build. Consensus rules,
genesis, peer requirements and convergence/timeout assertions are unchanged.
This does not install a fix on an operating bridge or accept a production node
upgrade; those remain operator/owner decisions.

The native `error-b` CI job also qualifies the package control before starting
its fresh chains. It exports the exact unmodified Git archive, passes the nine
baseline tests, requires the original height-5 regression to fail, then applies
the exact patch and requires ten package tests plus ten repeated controls to
pass with zero skips. Go stays offline using the module cache already populated
by the pinned native build. Only fixed outcomes, counters, source/runtime pins
and stream SHA-256/byte/completeness facts enter `downloader-control-report.json`.
Raw command output and stack data stay outside uploaded artifacts. A failure
remains fatal. Current-source Linux/native/Docker evidence is required separately
from the completed Darwin package control and any earlier successful cold case.
## Browser utility-exit investigation

The `browser-transport` CI job uses the same pinned sandboxed Chromium for 48
fresh browser starts. It varies complete messages, empty final continuations,
separately scheduled final continuations and request interception. Complete
messages are serialized on the synthetic loopback server. Each start must receive
all 13 valid JSON replies and keep its socket open during the observation window.
Socket or console errors, unexpected service replacement and incomplete controls
fail the job. It sends no injected signals and uses no wallet or chain.

The report binds source/tree/file/lock/runtime identities and retains fixed
utility-termination, stderr and inherited cgroup-memory facts. Raw lines,
identifiers, profiles and paths are excluded. The cgroup counters cover the whole
process's cgroup hierarchy; utility counters cover all utilities. Neither alone identifies a
particular process or establishes why it exited. Current compiled native/Docker
checks also capture memory facts after a transport error, before browser teardown.

This bounded experiment investigates the preserved natural network-service
replacement. A passing probe or injected calibration does not establish its cause
or dispose of historical failures. The browser pin, fatal transport assertions,
sandbox and five-node readiness requirements are unchanged.

Each native/Docker job also runs 12 fresh browsers before its owned lab stops.
These use the actual qualified Go RPC codec: one validated chain-322 frontier
response releases twelve concurrent `ledger.getMomentumsByPage(0, 30)` reads.
This reproduces the application's staged startup pattern instead of substituting
a Node WebSocket writer. Source/build/runtime identities must match the current
lab manifests. Only bounded ledger reads are sent; no wallet, subscription,
signature, transfer or chain write is involved. The separate sanitized report
does not establish an unobserved historical cause or production acceptance.
