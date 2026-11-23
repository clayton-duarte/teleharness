# Teleharness

Teleharness is an early-stage Telegram client and backend for a durable coding
agent. The first target is one owner, one private chat, and one isolated
repository.

This initial slice validates and authorizes Telegram text updates with Zod and
serves a local Hono health endpoint. It does **not** connect to a bot, execute
commands, or run an agent yet.

## Development

Use Node.js 24 and the [pnpm](https://pnpm.io/installation) version pinned in
`package.json`:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run fmt
pnpm run lint
pnpm run tsc
pnpm start
```

`GET http://127.0.0.1:3000/healthz` checks the HTTP process. CI runs Vitest,
Oxfmt, Oxlint, and TypeScript on pull requests and on `main`.

## Next milestones

1. Implement outbound Telegram polling with a durable inbox and update deduplication.
2. Add a pinned Pi Durable adapter and verify resume against a disposable fixture.
3. Add a bounded reply outbox and verify `/status` and `/stop` through restarts.
4. Enable coding tools only after verifying workspace isolation and credential separation.
