#!/usr/bin/env node
/**
 * Install the dependencies this source tree imports but `package.json` omits
 * (`caspar/build/extra-deps.json`), so the CLI can be built from `src/`.
 *
 * They are installed **unsaved** — `package.json` and the lockfile are left
 * exactly as they are, because they are not this project's declared dependencies;
 * they are what this *snapshot* happens to need. One consequence drives the shape
 * of this script: an unsaved npm install prunes anything previously installed
 * unsaved, so every extra has to go in a single command. Hence one list, one run.
 *
 * Run this AFTER the base install (`bun install` / `npm install`), never before.
 *
 * Usage: node caspar/build/installDeps.mjs [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "caspar/build/extra-deps.json"), "utf-8"));

const packages = Object.entries(manifest)
  .filter(([group]) => group !== "//" && group !== "stub")
  .flatMap(([, list]) => list);

if (!packages.length) {
  console.log("no extra dependencies to install");
  process.exit(0);
}

const args = [
  "install",
  "--no-save",
  "--no-fund",
  "--no-audit",
  // The tree pins versions that some of these packages disagree with in their
  // peer ranges; the published CLI ships them together regardless, so peer
  // resolution must not decide the build.
  "--legacy-peer-deps",
  ...packages,
];

console.log(`installing ${packages.length} unsaved dependencies (${manifest.stub?.length || 0} unpublished ones are stubbed at build time)`);
if (process.argv.includes("--dry-run")) {
  console.log(`npm ${args.join(" ")}`);
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, args, { cwd: ROOT, stdio: "inherit" });
process.exit(result.status ?? 1);
