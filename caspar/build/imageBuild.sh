#!/bin/sh
# Build the agent inside the creature image.
#
# Run by caspar/Dockerfile's builder stage, from the repo root. Two modes:
#
#   source (default) — install dependencies and compile THIS repository's Claude
#                      Code source into a single self-contained dist/cli.mjs, then
#                      prove the bundle actually loads. A broken bundle fails the
#                      image build, where the node's build log shows it, instead of
#                      failing on the first prompt an agent receives.
#   npm              — build nothing; the runtime stage installs the published CLI
#                      instead (a fallback for when the source snapshot cannot be
#                      built at all).
#
# Env: CLAUDE_CODE_CLI_SOURCE=source|npm, CLAUDE_CREATURE_CLI_VERSION=<semver>
set -eu

MODE="${CLAUDE_CODE_CLI_SOURCE:-source}"

if [ "$MODE" = "npm" ]; then
  echo "[caspar] CLAUDE_CODE_CLI_SOURCE=npm — skipping the source build"
  mkdir -p dist
  exit 0
fi

echo "[caspar] installing declared dependencies"
npm ci --no-fund --no-audit --loglevel=error || npm install --no-fund --no-audit --loglevel=error

echo "[caspar] installing the dependencies this snapshot imports but does not declare"
node caspar/build/installDeps.mjs

echo "[caspar] building the CLI from src/"
node caspar/build/buildCli.mjs --minify

echo "[caspar] verifying the bundle runs"
node dist/cli.mjs --version

echo "[caspar] agent built from source: $(node dist/cli.mjs --version)"
