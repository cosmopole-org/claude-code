#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# package-creature.sh — pre-build the Claude Code creature binaries
# ─────────────────────────────────────────────────────────────
# Builds the CLI **from this repository's own source** (never the published npm
# package) and assembles a portable, self-contained bundle that a later deploy
# can drop into a Docker image with zero compilation.
#
# What it produces (under $OUT_DIR, default ./out):
#
#   bundle.tar.gz                 the deploy payload / docker build context:
#                                   dist/cli.mjs
#                                   dist/stubbed-modules.json
#                                   caspar/**            (the signaling bridge)
#   cli.mjs                       the raw built CLI, for direct `node cli.mjs`
#   stubbed-modules.json          the list of snapshot-absent modules (audit)
#   manifest.json                 version, git sha, sizes, build time
#
# `bundle.tar.gz` unpacks to `dist/` + `caspar/` at its root, which is exactly
# what `caspar/Dockerfile.prebuilt` expects (`ADD bundle.tar.gz /app`). The same
# tarball is what `deploy_claude_creature.py` ships to a Caspar node in prebuilt
# mode — so the heavy build happens here, once, in CI, and the deploy is a copy.
#
# Usage:
#   scripts/package-creature.sh                 # build + package into ./out
#   OUT_DIR=/tmp/creature scripts/package-creature.sh
#   CLAUDE_CREATURE_CLI_VERSION=2.1.0-caspar scripts/package-creature.sh
#   SKIP_BUILD=1 scripts/package-creature.sh    # reuse an existing dist/cli.mjs
#
# Env:
#   OUT_DIR                       output directory            (default ./out)
#   CLAUDE_CREATURE_CLI_VERSION   version the built CLI reports (default 2.0.0-caspar)
#   SKIP_BUILD                    1 to skip install+compile and package dist/ as-is
#   PKG_MANAGER                   bun | npm                   (default: bun if present)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${OUT_DIR:-$ROOT/out}"
PKG_MANAGER="${PKG_MANAGER:-}"

log() { printf '\033[36m[package]\033[0m %s\n' "$*"; }

if [ -z "$PKG_MANAGER" ]; then
  if command -v bun >/dev/null 2>&1; then PKG_MANAGER=bun; else PKG_MANAGER=npm; fi
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "installing declared dependencies with $PKG_MANAGER"
  if [ "$PKG_MANAGER" = "bun" ]; then
    bun install --frozen-lockfile 2>/dev/null || bun install
  else
    npm ci --no-fund --no-audit --loglevel=error 2>/dev/null || npm install --no-fund --no-audit --loglevel=error
  fi

  log "installing the dependencies this snapshot imports but does not declare"
  node caspar/build/installDeps.mjs

  log "building the CLI from src/ (minified)"
  node caspar/build/buildCli.mjs --minify
else
  log "SKIP_BUILD=1 — packaging the existing dist/cli.mjs"
fi

if [ ! -f dist/cli.mjs ]; then
  echo "[package] ERROR: dist/cli.mjs not found — the source build did not produce a bundle" >&2
  exit 1
fi

log "verifying the bundle runs"
BUILT_VERSION="$(node dist/cli.mjs --version 2>&1 | head -1)"
log "built CLI reports: $BUILT_VERSION"

# ── Assemble the portable bundle ─────────────────────────────
mkdir -p "$OUT_DIR"

# The tar arcnames are repo-relative (dist/…, caspar/…) so `ADD bundle.tar.gz /app`
# lands them at /app/dist and /app/caspar — the layout Dockerfile.prebuilt copies
# from. caspar/tests is shipped too (it is tiny) so the offline self-test image is
# self-contained; node_modules and __pycache__ never travel.
BUNDLE_MEMBERS=(dist/cli.mjs caspar)
[ -f dist/stubbed-modules.json ] && BUNDLE_MEMBERS+=(dist/stubbed-modules.json)

log "writing $OUT_DIR/bundle.tar.gz"
tar --exclude='__pycache__' --exclude='*.pyc' --exclude='node_modules' \
    -czf "$OUT_DIR/bundle.tar.gz" "${BUNDLE_MEMBERS[@]}"

cp dist/cli.mjs "$OUT_DIR/cli.mjs"
[ -f dist/stubbed-modules.json ] && cp dist/stubbed-modules.json "$OUT_DIR/stubbed-modules.json"

# ── Manifest ─────────────────────────────────────────────────
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
CLI_BYTES="$(wc -c < dist/cli.mjs | tr -d ' ')"
BUNDLE_BYTES="$(wc -c < "$OUT_DIR/bundle.tar.gz" | tr -d ' ')"
STUBBED_COUNT=0
[ -f dist/stubbed-modules.json ] && STUBBED_COUNT="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("dist/stubbed-modules.json","utf8")).length))' 2>/dev/null || echo 0)"

cat > "$OUT_DIR/manifest.json" <<JSON
{
  "cliVersion": $(printf '%s' "$BUILT_VERSION" | sed 's/"/\\"/g' | awk '{printf "\"%s\"", $0}'),
  "gitSha": "$GIT_SHA",
  "gitRef": "$GIT_REF",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "src/ (this repository) — not the published npm package",
  "cliBytes": $CLI_BYTES,
  "bundleBytes": $BUNDLE_BYTES,
  "stubbedModules": $STUBBED_COUNT
}
JSON

log "done — artifacts in $OUT_DIR:"
ls -lh "$OUT_DIR"
