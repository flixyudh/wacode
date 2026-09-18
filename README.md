# WhatsApp MCP + Opencode Bridge

Standalone TypeScript daemon (DESIGN.md v2): WhatsApp as MCP tools
(`send_message`, `get_messages`, `mark_read`) for any MCP client, plus an
auto-forward bridge from a sender whitelist to a running `opencode` agent.

Implements DESIGN v2 end-to-end: authenticated localhost MCP, whitelist-scoped
auto-read, per-JID sessions with TTL/compaction/`/reset`, Baileys dedupe +
type router + backoff reconnect, rate limiting, chunking, typing presence,
`/healthz`, structured logging, graceful shutdown, zod config, tests, Docker.

## Quick start

```bash
cd whatsapp-opencode-bridge
cp .env.example .env
# edit .env: WHATSAPP_WHITELIST, MCP_TOKEN (≥16 chars), WHATSAPP_PHONE_NUMBER …
pnpm install
pnpm run build

# 1) start opencode server with the least-privilege agent
opencode serve --port 4096 --hostname 127.0.0.1
# agents ship in `.opencode/agents/` and are auto-discovered from cwd:
# - `whatsapp-bridge` (default, safe): no bash, no write, read-only + web
# - `yolo` (trusted local use only): full access, auto-approve everything

# 2) start the bridge (first run prints a pairing code)
pnpm start
# phone: WhatsApp > Linked devices > Link with phone number > enter code
```

Dev mode: `WHATSAPP_LOGIN_MODE=qr pnpm run dev` (QR in terminal; dev only —
containers can't scan QR, use pairing there).

## Config

See `.env.example`. All env is zod-validated at boot — the daemon fails fast
on missing/invalid config instead of at first request.

| Var | Default | Notes |
|---|---|---|
| `WHATSAPP_WHITELIST` | — | comma-separated numbers, e.g. `62812…,62898…` |
| | | **LID note:** WhatsApp increasingly addresses DMs by opaque LID (`xxx@lid`) instead of phone numbers. Mapping resolves in order: explicit `WHATSAPP_LID_MAP=lid:pn,lid:pn` (also seeded into Baileys v7's own store), persistent learned cache (from `lid-mapping.update`, history sync, address-book syncs), then raw LID whitelist entries. If a whitelisted sender logs `non-whitelisted`, the `candidates` in that line show the exact values to pin. |
| `WHATSAPP_LOGIN_MODE` | `pairing` | `pairing` (headless/Docker) or `qr` (interactive dev) |
| `WHATSAPP_PHONE_NUMBER` | — | required in pairing mode (digits, country code, no `+`) |
| `WHATSAPP_SHARED_SECRET` | — | optional extra gate: inbound must contain this keyword to forward |
| `MCP_BIND` / `MCP_PORT` / `MCP_TOKEN` | `127.0.0.1` / `8787` / required | bearer auth on every tool call; refuses to start without token |
| `AUTO_READ_SCOPE` | `whitelist` | `whitelist` (default) or `all` |
| `SESSION_TTL_HOURS` | `6` | idle TTL per sender JID |
| `SESSION_COMPACT_AFTER` | `40` | summarize-and-restart after N messages |
| `RATE_LIMIT_PER_SENDER_SECONDS` | `5` | 1 opencode call per window per sender |
| `OPENCODE_HOST/PORT/AGENT` | `127.0.0.1`/`4096`/`whatsapp-bridge` | dedicated least-privilege agent, never default |
| `OPENCODE_PASSWORD` | — | set if `opencode serve` uses `OPENCODE_SERVER_PASSWORD` |
| `DATA_DIR`/`DB_PATH`/`AUTH_DIR` | `./data*` | **back up `data/auth_info/`** — losing it forces re-pair |

## Agents

| Agent | File | Use |
|---|---|---|
| `whatsapp-bridge` | `.opencode/agents/whatsapp-bridge.md` | Bridge default. Least-privilege: `edit`/`bash`/`task` denied. Every inbound message is treated as untrusted input. |
| `yolo` | `.opencode/agents/yolo.md` | Trusted local operator only. Full access (`allow` all, incl. `external_directory` + `doom_loop`). Never point the WhatsApp bridge at it — untrusted chat + shell/write = RCE. |

```bash
opencode --agent yolo                 # TUI with the yolo agent
opencode run --agent yolo --auto "…"  # non-interactive + auto-approve
OPENCODE_AGENT=yolo pnpm start        # bridge via yolo (trusted senders only!)
```

## Yolo mode (auto-approve)

Upstream ([anomalyco/opencode#8463](https://github.com/anomalyco/opencode/issues/8463))
asked for `--dangerously-skip-permissions`; that PR was closed unmerged.
Current opencode (≥1.17, verified on 1.18.9) ships it as `--auto`:

```bash
opencode --auto                       # TUI, muted `auto` indicator in prompt
opencode run --auto "Refactor this"   # non-interactive
# TUI runtime toggle: Ctrl+P → Enable/Disable auto-approve permissions
```

Explicit `deny` rules still win — `--auto` only auto-approves what would
otherwise `ask`. `opencode serve` has no `--auto` flag, so headless uses
config instead (see Production below).

## How it works

Inbound `messages.upsert` (`type === "notify"` only; history sync ignored):
`fromMe` skip → dedupe (`seen_messages` + LRU) → group ignore (1:1 only) →
type router → `/reset` → whitelist → shared-secret → rate limit → auto-read →
`composing` presence → opencode (`whatsapp-bridge` agent, untrusted-input
prefix) → chunked reply (≤4096) → session touch → compaction check.

Type router: `conversation`/`extendedTextMessage` → text; image/video/document
**with caption** → caption forwarded (media logged, not processed in v2);
reaction/protocol/poll/sticker/audio/contact/location/view-once → logged, not
forwarded. Ephemeral wrappers unwrapped one level.

Sessions: one opencode session per whitelisted sender JID, persisted to
SQLite so restarts keep context inside the TTL. `/reset` (exact first line)
ends the session immediately and replies `Session reset ✅`.

## MCP

- Endpoint: `POST http://127.0.0.1:8787/mcp` (Streamable HTTP, stateless).
- Auth: `Authorization: Bearer $MCP_TOKEN` on every call, else 401.
- Tools: `send_message {to, text}`, `get_messages {jid?, limit?}`,
  `mark_read {jid, ids?}`.
- Binds localhost by default. Remote access is opt-in via reverse tunnel only,
  e.g. `ssh -R 8787:127.0.0.1:8787 user@host` — never expose the port directly.

Verify with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP, URL http://127.0.0.1:8787/mcp
# header: Authorization: Bearer <MCP_TOKEN>
# expect: 3 tools listed; get_messages returns seeded/real messages
```

`pnpm test` includes the same check headless
(`tests/mcp-integration.test.ts`: 401 without token, list+call with token).

## Health

`GET /healthz` (no auth, localhost): `{ status, socket, lastInboundAt,
opencodeReachable, uptime_s, version }` — 200 when socket open, 503 when
degraded. Docker `HEALTHCHECK` hits it.

## Backup & recovery

- Required backup: `data/auth_info/` (+ `data/bridge.db` for history/sessions).
- Startup fails loudly if `auth_info` exists but is unreadable/corrupt —
  restore from backup or delete deliberately to re-pair (never a silent fresh QR).
- `DisconnectReason.loggedOut` (401): daemon stops retrying — delete
  `data/auth_info` and re-pair.

## Pairing code fails?

1. **Number format** (most common): `WHATSAPP_PHONE_NUMBER` must be
   international digits with country code — no `+`, no spaces, no trunk `0`.
   Indonesian `0812…` → `62812…`. The daemon validates this at boot.
2. **Stale auth for another number**: if you change the number, delete
   `data/auth_info/` first — Baileys pins the first number, the daemon now
   errors loudly instead of failing cryptically.
3. **Code expired**: codes live ~60s. Enter at
   WhatsApp > Settings > Linked devices > Link a device >
   **Link with phone number** (not the QR scanner), then restart the daemon
   for a fresh code if it lapses.
4. **No route to WhatsApp**: the daemon waits for the transport plus a 4s
   handshake settle before requesting (requesting mid-handshake flips Baileys
   onto the login path with unpaired creds and the server kills it) and
   retries across reconnects — if it still times out, check firewall/DNS.
5. **`401 rejected pre-pairing login` warnings are expected** until you
   approve the code on the phone — keep the daemon running, don't delete
   `data/auth_info`. A `fatal … Logged out` only applies to established
   sessions.
6. Still stuck? `LOG_LEVEL=debug pnpm start` and look for
   `requestPairingCode failed` / `transport unsettled` / `connected to WA`.

## Production

One image holds both processes: the bridge plus the latest `opencode`
binary (multi-stage build). The entrypoint starts `opencode serve`, waits
for its health, then boots the bridge; if either exits, the container
stops so the restart policy kicks in.

```bash
# Publish (maintainer): tags flixyudh/project:wacode on Docker Hub
docker build -t flixyudh/project:wacode .
docker push flixyudh/project:wacode   # after `docker login`

# Run (everyone): pulls the published tag, see compose.yml for all env
MCP_TOKEN=$(openssl rand -hex 32) \
WHATSAPP_WHITELIST=6281234567890 \
WHATSAPP_PHONE_NUMBER=6281234567890 \
ANTHROPIC_API_KEY=... \
docker compose up -d
docker compose logs -f   # first boot prints the pairing code / QR
```

Required env inside the container: everything in `.env.example`
(`WHATSAPP_*`, `MCP_TOKEN`, `OPENCODE_*` — host/port default to the
in-container `opencode serve`), **plus model auth (pick one)**:
- a provider key (`-e ANTHROPIC_API_KEY=…`, `OPENAI_API_KEY`, …), or
- OpenCode Zen free models: `opencode auth login` once on the host, then
  mount `-v ~/.local/share/opencode/auth.json:/root/.local/share/opencode/auth.json:ro`
  (make sure a Zen model is your default, e.g. `opencode/gpt-5.1-codex`).
If you set `OPENCODE_SERVER_PASSWORD` for serve, set the same value in
`OPENCODE_PASSWORD` so the bridge can authenticate.
The least-privilege `whatsapp-bridge` agent ships in the image
(`.opencode/agents/`); `UNHEALTHY` before pairing is expected.

**Yolo mode (serve):** `opencode serve` has no `--auto` flag — the image enables the
equivalent instead (`OPENCODE_YOLO=true` by default → global
`"permission": "allow"`, written to `/app/opencode.json` unless you mount
your own). Headless needs this: approval prompts can't be answered over the
SDK, so any `ask` would stall the bridge. Explicit agent `deny` rules still
win, so `whatsapp-bridge` stays no-bash/no-write — but the `yolo` agent (also
shipped in `.opencode/agents/`) and any *other* agent on this serve would run
fully unconstrained, which is why the serve port stays container-internal.
Set `OPENCODE_YOLO=false` to disable. Never set `OPENCODE_AGENT=yolo` unless
every whitelisted sender is fully trusted.

**Agent instructions (AGENTS.md):** serve runs with cwd `/app`, so mount a
file there — no rebuild needed:
```yaml
volumes:
  - ./AGENTS.md:/app/AGENTS.md:ro
```
It's loaded into every session automatically; existing sessions pick it up
on `/reset`, compaction restart, or TTL expiry. Keep it short and
WhatsApp-shaped (reply language, tone, what the agent may refuse) — tool
access stays governed by the agent profile, not this file.

- Logs: JSON via pino, `correlationId` per inbound message end-to-end.
- Shutdown: `SIGTERM` stops both processes; bridge closes the Baileys
  socket and checkpoints SQLite.
- Tests: `pnpm test` (whitelist, router, chunker, dedupe/store,
  rate-limiter/sessions, MCP integration).

## Out of scope (v2)

Group chats (stored, not forwarded), media transcription (caption only),
multi-instance (single daemon, single Baileys session).
