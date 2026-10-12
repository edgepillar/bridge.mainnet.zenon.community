# End-to-end tests

The bridge on a private devnet: go-zenon with the bridge contract usable,
HyperCore's `bridge.sol` on anvil, and a test orchestrator between them.

```sh
npm run lab:up       # Docker: five znnd nodes and anvil
npm run test:e2e
npm run lab:down
```

What it is, what it changes in go-zenon and why, and what each test covers:
[../docs/TESTING.md](../docs/TESTING.md).

| Path | |
|---|---|
| `lab/` | `lab.sh`, the compose file, the genesis changes, the file added to znnd |
| `contracts/` | `Bridge.sol` (HyperCore, vendored unchanged) and `TestToken.sol` |
| `lib/` | lab endpoints and keys, signing, message builders, solc |
| `setup.ts` | deploys and configures both ends, idempotent |
| `orchestrator.ts` | the one-key orchestrator |
| `*.e2e.test.ts` | the suites |

Every key in here is public: go-zenon's devnet mnemonic, anvil's default
accounts, a fixed test TSS key. They are worth nothing outside the lab.
