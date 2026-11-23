# Teleharness

Teleharness connects a private Telegram chat to Pi Durable. This proof of
concept runs a text-only agent: **no shell, files, web tools, or repository
access**. It tests conversation routing and restart recovery before adding
coding tools.

## Development

Use Node.js 24 and the [pnpm](https://pnpm.io/installation) version pinned in
`package.json`:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run fmt
pnpm run lint
pnpm run tsc
```

CI runs Vitest, Oxfmt, Oxlint, and TypeScript on pull requests and on `main`.

## Run the PoC

1. Create a dedicated test bot with [@BotFather](https://t.me/BotFather). Use
   only one instance per bot token. If the bot already uses a webhook, remove
   it before starting the poller.
2. Store `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `TELEGRAM_CHAT_ID`,
   `OPENCODE_API_KEY`, and `TELEHARNESS_MODEL` as fields in a **1Password
   item**. Store Telegram IDs as digits only, not a username or topic ID.
   For a direct one-on-one bot chat, `TELEGRAM_USER_ID` and
   `TELEGRAM_CHAT_ID` should be the same. Use
   `opencode/<model>` for OpenCode Zen or `opencode-go/<model>` for OpenCode
   Go; the model must exist in Pi's catalog and be available to your key.
3. Copy [`.env.example`](.env.example) to `.env` and replace the vault and
   item placeholders. `.env` is ignored by Git and should contain only
   `op://` references, never resolved credentials. With the 1Password CLI
   signed in, start the app:

   ```sh
   op run --env-file=.env -- pnpm start
   ```

4. Send `/start` (an alias for `/status`), a text prompt, or `/stop` in the
   authorized private chat.
   `GET http://127.0.0.1:3000/healthz` checks the local HTTP process, not
   Telegram or model connectivity. `/readyz` indicates a recent successful
   Telegram poll; a text prompt is still needed to verify the model.

If you don't know your IDs, stop any poller for this token and pass only the
bot token reference to the pairing command:

```sh
TELEGRAM_BOT_TOKEN='op://<vault>/<item>/TELEGRAM_BOT_TOKEN' \
  op run -- pnpm telegram:pair
```

The helper shows the bot username and asks you to send a one-time message in
its private chat. The helper prints the confirmed IDs in your terminal; the
bot does not reply during pairing. Put both IDs in 1Password. If a previous
launch stored incorrect IDs, start with a new `TELEHARNESS_STATE_DIR` rather
than deleting the old data.

If 1Password does not authorize the launch on macOS, run the command in your
interactive terminal and approve the prompt. See
[1Password CLI app integration](https://www.1password.dev/cli/app-integration)
for terminal permissions and sign-in troubleshooting.

Set `TELEHARNESS_STATE_DIR` to a private local directory (mode `0700`) to
persist state outside the checkout. It defaults to `.teleharness/` in the
current directory. Keep this directory across restarts. It contains prompt
and answer data, so do not sync it or use sensitive inputs in the PoC. The
state is bound to the bot and owner IDs; use a new directory if they change.
`PORT` can change the loopback-only health port.

### Multiple sessions

Enable [private-chat topics](https://core.telegram.org/bots/features#topics-in-private-chats)
in BotFather and allow users to create topics. Each topic has its own Pi
conversation and transcript. Without topics, the normal chat acts as one
session. `/status` and `/stop` affect only the current session.

The PoC keeps up to three runs active, at most one per topic. If a slot is
busy, retry the prompt later. Idle sessions keep their history on disk
without holding an open agent. Groups are not supported.

### What survives a restart

The service uses Telegram [long polling](https://core.telegram.org/bots/api#getupdates),
so it does not need public ingress. It stores each accepted message in SQLite
before confirming its update and resubmits with a stable request ID if the Pi
receipt wasn't recorded. Pi Durable stores per-topic conversations and can
resume unfinished runs. A stored reply can be retried, but a crash after
Telegram accepts a send can produce a duplicate with the same visible run
number. Replies are plain text, capped in length, and retry at most four
times. `/status` reports undelivered replies for that topic.

The first live bot on the homeserver verified both Telegram delivery and
OpenCode model replies. The next capability is editing and testing the
Teleharness code in an isolated checkout, then opening a draft PR for human
review. The runner must not have access to the host, cluster credentials, bot
token, or a GitHub credential that can bypass protected `main`.

## Container deployment

The container runs as UID 1000. Mount persistent storage at `/state` and
set `TELEHARNESS_STATE_DIR` to a writable private directory on that volume.
Both probe endpoints bind to loopback and can be checked from inside the
container. Run only one poller per bot token, including any old process
running outside the cluster.

The [image workflow](.github/workflows/image.yml) publishes a `linux/amd64`
image after a merge to `main`. It tags each published revision by commit SHA
and advances `ghcr.io/clayton-duarte/teleharness:latest` only for the current
`main` tip. The homeserver's Argo CD Image Updater can track that tag and
write back the immutable digest to Git. The workflow summary also records
the digest for verification or rollback.
