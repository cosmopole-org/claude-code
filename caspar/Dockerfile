# Claude Code Caspar creature image.
#
# Built and run by a Caspar node as a gVisor-sandboxed `docker` creature: the node
# builds this context, starts one container, and the container's only route to the
# outside world is the docker-host bridge gateway (see caspar/bridge.mjs).
#
# The agent is **this repository's own Claude Code source**, compiled here — not
# the published npm package. `caspar/build/buildCli.mjs` bundles `src/` into a
# single self-contained `dist/cli.mjs`; see that file for how it deals with the
# parts this source snapshot is missing. Deploy with CLAUDE_CODE_CLI_SOURCE=npm to
# install the published CLI instead (a fallback, not the default).
#
# The ECR mirror of the official node image avoids Docker Hub anonymous-pull rate
# limits during node-side builds (the same reason the davinci creature uses it).

# ── Stage 1: build the agent from this repo's source ─────────────────────────
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS builder

WORKDIR /build

# >>> caspar-ca <<<
# (the deployer substitutes the host CA bundle here when it has one — an
# intercepting egress proxy would otherwise break every dependency download)

# node-pty (a declared dependency) compiles a native addon during install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# The repo's source, shipped by the deployer (src/, caspar/, package.json, …).
ADD bundle.tar.gz /build

ARG CLAUDE_CODE_CLI_SOURCE=source
ARG CLAUDE_CREATURE_CLI_VERSION
RUN sh caspar/build/imageBuild.sh

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# git: the agent works in a real repo-shaped workspace.
# ripgrep: the CLI's Grep tool.
# ca-certificates: outbound TLS (the Anthropic API, and the node's egress gateway).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# >>> caspar-ca <<<

# The signaling bridge, and the CLI built from this repo's source.
COPY --from=builder /build/caspar /app/caspar
COPY --from=builder /build/dist /app/dist

# Fallback path only: with CLAUDE_CODE_CLI_SOURCE=npm nothing was built above, so
# install the published CLI. The runtime resolves `CLAUDE_CODE_BIN` first and falls
# back to `claude` on PATH when that file does not exist, so both modes work with
# one entrypoint.
ARG CLAUDE_CODE_CLI_SOURCE=source
ARG CLAUDE_CODE_VERSION=latest
RUN if [ "$CLAUDE_CODE_CLI_SOURCE" = "npm" ]; then \
      npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      && npm cache clean --force; \
    fi

# The node uploads runtime inputs to /app/input before starting the container; the
# directory must exist for the upload (and the container start) to succeed. /data is
# the VM's persistent mount — session workspaces live there so a conversation's
# files survive a container restart.
RUN mkdir -p /app/input /data/workspaces \
    && useradd --create-home --shell /bin/bash claude \
    && chown -R claude:claude /app /data

# Claude Code refuses to bypass permission prompts as root, and an autonomous agent
# has no human to approve them — so the creature runs unprivileged.
USER claude
ENV HOME=/home/claude \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_BIN=/app/dist/cli.mjs \
    CLAUDE_CREATURE_INPUT_DIR=/app/input \
    CLAUDE_CREATURE_WORKSPACE_ROOT=/data/workspaces \
    CLAUDE_CREATURE_CONFIG_DIR=/data/claude-config \
    CLAUDE_CREATURE_PERMISSION_MODE=bypassPermissions

# Serve prompts over the signaling API (the gateway path). With no gateway env
# injected, the same entrypoint answers one task from /app/input and exits — the
# offline self-test.
CMD ["node", "/app/caspar/runtime.mjs"]
