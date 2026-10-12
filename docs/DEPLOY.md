# Deploy

## GitHub Pages

`.github/workflows/pages.yml` tests, builds and publishes on every push to
`main`. Pull requests are tested and built, not published.

1. Settings, Pages, Source: **GitHub Actions**.
2. Push to `main`.

`public/CNAME` ships in the build, so the custom domain
`bridge.mainnet.zenon.community` stays attached. To serve the site at
`<user>.github.io/<repo>/` instead, delete `public/CNAME` and set the
repository variable `VITE_BASE` to `/<repo>/`.

## Settings

All are build time. Set them as repository variables (or secrets, where noted)
for Pages, or in `.env.local` for a local build.

| Name | Default | |
|---|---|---|
| `VITE_NETWORK` | `mainnet` | `devnet` points at the e2e harness |
| `VITE_ZNN_NODE` | `wss://my.hc1node.com:35998,wss://node.zenonhub.io:35998` | Comma-separated; the first that answers is used until Syrius offers its own |
| `VITE_EVM_RPCS` | publicnode for chains 1 and 56 | JSON `{"1":"https://…"}`, for reads with no wallet connected |
| `VITE_PLASMA_BOT_URL` | zenonhub's fuse endpoint | See below |
| `VITE_PLASMA_BOT_TOKEN` (secret) | none | See below |
| `VITE_BASE` | `/` | Base path |

The original default node, `wss://syrius-mainnet.zenon.community`, answers 404
since 2026 and is not in the list.

## Plasma bot

When a Zenon recipient has no plasma, the Bridge view offers to get some from
zenonhub's plasma bot:

```
POST https://zenonhub.io/api/utilities/plasma-bot/fuse
Authorization: Bearer <token with the plasma-bot ability>
{"address": "z1…"}
```

The endpoint allows any origin, but it needs a token, and **a token built into
a static page is public**: anyone can read it from the bundle and spend the
bot's QSR. So:

- With no token (the default), the button opens zenonhub's own form.
- The better setup is a small proxy that holds the token and rate-limits by
  address, with `VITE_PLASMA_BOT_URL` pointing at it and no token in the build.
  A Cloudflare Worker of twenty lines is enough: accept `{address}`, check it
  is a z1 address, forward with the token.
- `VITE_PLASMA_BOT_TOKEN` works, for a token you are willing to publish.

## What is not deployed

No server, no analytics, no remote scripts. Everything the page needs is in
`dist/`; the workflow fails the build if `dist/` references a CDN.
