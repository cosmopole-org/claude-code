#!/bin/sh
# Build the agent inside the creature image.
#
# Run by caspar/Dockerfile's builder stage, from the repo root. Three modes:
#
#   source (default) — install dependencies and compile THIS repository's Claude
#                      Code source into a single self-contained dist/cli.mjs, then
#                      prove the bundle actually loads. A broken bundle fails the
#                      image build, where the node's build log shows it, instead of
#                      failing on the first prompt an agent receives.
#   prebuilt         — do NOT compile; a dist/cli.mjs built earlier (in CI, from
#                      this same source) is already in the build context. Just
#                      prove it loads. This is the lightweight deploy path: the
#                      heavy build happened once in the workflow, so the node-side
#                      build touches neither the npm registry nor a compiler.
#   npm              — build nothing; the runtime stage installs the published CLI
#                      instead (a fallback for when the source snapshot cannot be
#                      built at all).
#
# Env: CLAUDE_CODE_CLI_SOURCE=source|prebuilt|npm, CLAUDE_CREATURE_CLI_VERSION=<semver>
set -eu

MODE="${CLAUDE_CODE_CLI_SOURCE:-source}"

if [ "$MODE" = "npm" ]; then
  echo "[caspar] CLAUDE_CODE_CLI_SOURCE=npm — skipping the source build"
  mkdir -p dist
  exit 0
fi

if [ "$MODE" = "prebuilt" ]; then
  echo "[caspar] CLAUDE_CODE_CLI_SOURCE=prebuilt — using the CLI bundle shipped in the build context"
  if [ ! -f dist/cli.mjs ]; then
    echo "[caspar] ERROR: prebuilt mode, but dist/cli.mjs is not in the build context." >&2
    echo "[caspar]        Ship it with the context (scripts/package-creature.sh) or use CLAUDE_CODE_CLI_SOURCE=source." >&2
    exit 1
  fi
  echo "[caspar] verifying the prebuilt bundle runs"
  node dist/cli.mjs --version
  echo "[caspar] using prebuilt agent: $(node dist/cli.mjs --version)"
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
