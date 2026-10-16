# Single-image build: whatsapp-bridge (node) + opencode binary.
#
#   docker build -t flixyudh/project:wacode .
#   docker push flixyudh/project:wacode   # after `docker login`
#
# Or via compose (pulls the published tag): see compose.yml.
# Remote MCP access stays opt-in: bind 127.0.0.1 on the host and tunnel
# (ssh -L), never publish 8787 publicly — the token is the only auth.

# ---- Stage 1: build the bridge (pinned deps via pnpm lockfile) ----
FROM node:22-bookworm-slim AS bridge-build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --no-optional
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# ---- Stage 2: fetch a PINNED opencode binary (linux) ----
FROM debian:bookworm-slim AS opencode
# Pin the version: an unpinned `curl ... | bash` install silently moved the
# image from 1.18.30 to 1.19.2 on rebuild, which broke startup. Bump
# deliberately (and re-test) when upgrading.
ARG OPENCODE_VERSION=1.18.30
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
# Official installer, pinned to a version (installs to ~/.opencode/bin/opencode).
# The installer only ships OpenCode 1 ("--version 1.x").
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" \
  && mv /root/.opencode/bin/opencode /usr/local/bin/opencode \
  && opencode --version

# ---- Stage 3: final runtime (bridge + opencode, supervised) ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# better-sqlite3 ships prebuilds for debian/node22 — no build tools needed.
RUN pnpm install --frozen-lockfile --prod --no-optional && pnpm store prune
COPY --from=bridge-build /app/dist ./dist
COPY --from=opencode /usr/local/bin/opencode /usr/local/bin/opencode
COPY .env.example ./.env.example
# Default agent instructions (/app/AGENTS.md). A consumer can override them by
# mounting their own ./AGENTS.md over /app/AGENTS.md — writable, so the agent
# can edit the host file (see compose.yml).
COPY docker/AGENTS.md /app/AGENTS.md
# Least-privilege whatsapp-bridge agent, auto-discovered by `opencode serve`
# from the project dir (/app).
COPY .opencode ./.opencode
COPY docker/entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod +x /usr/local/bin/bridge-entrypoint && opencode --version
# Auth + sqlite — back this up (DESIGN §6). Second volume keeps opencode's
# own sessions/projects across restarts (mount at run time, see header).
VOLUME ["/app/data"]
EXPOSE 8787 4096
# 503 pre-pairing is expected (not ready until QR/pairing approved).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8787)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["bridge-entrypoint"]
