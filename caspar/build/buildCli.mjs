#!/usr/bin/env node
/**
 * Build the CLI **from this repository's own source**, for the creature image.
 *
 * `scripts/build-bundle.ts` is the repo's build, and on this source snapshot it
 * fails: ~200 modules that the tree imports are not present in it (ANT-only and
 * not-yet-published features — `proactive/`, `daemon/`, `WorkflowTool/`,
 * `contextCollapse/`, …). Those are all reachable only behind feature gates the
 * external build turns off, but esbuild still has to resolve every import it
 * sees, so the whole bundle fails on them.
 *
 * This build is the repo's build plus one plugin: an import that resolves to
 * nothing becomes a **stub module** whose every export is a function that throws
 * if it is ever actually called. So:
 *
 *   • code paths that never run in a headless agent (the interactive daemon, the
 *     proactive/bridge UI, ANT-only tools) link and get tree-shaken or sit unused;
 *   • if one ever *is* reached, it fails loudly with the name of the module the
 *     snapshot is missing, instead of silently misbehaving.
 *
 * Every stub is reported, so the list is visible at build time and in the deploy
 * log rather than hidden. The result is `dist/cli.mjs`, which the creature runs
 * as its agent (`CLAUDE_CODE_BIN`).
 *
 * Usage: node caspar/build/buildCli.mjs [--minify] [--out <file>] [--strict]
 *   --strict  fail instead of stubbing (i.e. the repo's own build, unmodified)
 */

import { existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

const argv = process.argv.slice(2);
const minify = argv.includes("--minify");
const strict = argv.includes("--strict");
const outArgIndex = argv.indexOf("--out");
const outFile = outArgIndex >= 0 ? path.resolve(argv[outArgIndex + 1]) : path.join(ROOT, "dist", "cli.mjs");

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.error(
    "esbuild is not installed. Run `bun install` (or `npm install`) in the repo first — " +
      "the creature image build does this for you.",
  );
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));

/**
 * The version the built CLI reports.
 *
 * `package.json` says `0.0.0-leaked`, and the API refuses to serve a client below
 * its minimum supported version — a run dies with "needs an update" before it ever
 * reaches the model. So the creature build stamps a semver-valid version of its
 * own (overridable), which is also honest: this is a build of this source tree,
 * not a published release.
 */
const versionArgIndex = argv.indexOf("--cli-version");
const version =
  (versionArgIndex >= 0 ? argv[versionArgIndex + 1] : "") ||
  process.env.CLAUDE_CREATURE_CLI_VERSION ||
  (/^\d+\.\d+\.\d+/.test(pkg.version || "") && !String(pkg.version).startsWith("0.") ? pkg.version : "2.0.0-caspar");

/** The codebase imports `src/foo/bar.js`; map those onto the real TS sources. */
function resolveSourcePath(basePath) {
  if (existsSync(basePath) && !basePath.endsWith(".js") && !basePath.endsWith(".jsx")) return basePath;
  const withoutExt = basePath.replace(/\.(js|jsx)$/, "");
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".json"]) {
    if (existsSync(withoutExt + ext)) return withoutExt + ext;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    if (existsSync(path.join(withoutExt, `index${ext}`))) return path.join(withoutExt, `index${ext}`);
  }
  if (existsSync(basePath)) return basePath;
  return null;
}

const srcResolver = {
  name: "src-resolver",
  setup(build) {
    build.onResolve({ filter: /^src\// }, (args) => {
      const resolved = resolveSourcePath(path.resolve(ROOT, args.path));
      return resolved ? { path: resolved } : undefined;
    });
  },
};

const STUB_NAMESPACE = "caspar-stub";
const stubbed = new Set();

/**
 * Bare packages that are Anthropic-internal and unpublished, so no install can
 * satisfy them (`caspar/build/extra-deps.json` → `stub`). They are named
 * explicitly on purpose: any *other* missing dependency is a real error this build
 * must not paper over, because it would be a capability the agent silently lost.
 */
const STUBBED_PACKAGES = new Set(JSON.parse(readFileSync(path.join(ROOT, "caspar/build/extra-deps.json"), "utf-8")).stub || []);

/**
 * `@ant/*` are Anthropic-internal packages, reachable only behind
 * `USER_TYPE === 'ant'` — which this build defines as `"external"`. The repo's own
 * build lists them as *external*, which leaves a live `import` in the output that
 * node then fails to resolve at startup; a creature has nothing to resolve them
 * from, so they are stubbed instead.
 */
const STUBBED_PACKAGE_PATTERNS = [/^@ant\//];

function isStubbedPackage(specifier) {
  return STUBBED_PACKAGES.has(specifier) || STUBBED_PACKAGE_PATTERNS.some((re) => re.test(specifier));
}

/**
 * The names an importer asks a missing module for.
 *
 * A stub has to *export those exact names*, or the bundle links against
 * `undefined` and dies during module initialisation (e.g. `BROWSER_TOOLS.map(…)`
 * evaluated at import time). esbuild does not tell a plugin which bindings an
 * import needs, so we read them out of the importing file — every form the
 * codebase uses: named, default, namespace, and re-exports.
 */
function importedNames(importerPath, specifier) {
  const names = new Set();
  let source;
  try {
    source = readFileSync(importerPath, "utf-8");
  } catch {
    return names;
  }
  const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Find each `from '<specifier>'` and take the clause by scanning BACK to the
  // nearest `import`/`export` keyword. Scanning forward from the keyword instead
  // would let one statement's clause pair with a later statement's `from`, which
  // silently attributes the wrong names to the stub.
  const fromClause = new RegExp(String.raw`from\s*['"]${quoted}['"]`, "g");
  for (const match of source.matchAll(fromClause)) {
    const head = source.slice(0, match.index);
    const keyword = Math.max(head.lastIndexOf("import"), head.lastIndexOf("export"));
    if (keyword < 0) continue;
    const clause = head.slice(keyword).replace(/^(?:import|export)\b/, "");
    if (/^\s*(?:type\s)?\s*\*\s*(?:as\s+\w+\s*)?$/.test(clause)) {
      names.add("*"); // namespace import / `export * from` — needs a live object
      continue;
    }
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name) names.add(name);
      }
    }
    const bare = clause.replace(/\{[\s\S]*?\}/, "").replace(/^\s*type\s+/, "").split(",")[0].trim();
    if (bare && /^[A-Za-z_$][\w$]*$/.test(bare)) names.add("default");
  }
  return names;
}

/** Valid, non-reserved identifiers can be exported by name; the rest cannot. */
const RESERVED = new Set(["default", "class", "function", "const", "let", "var", "new", "delete", "in", "of", "this", "null", "true", "false", "import", "export"]);

/**
 * Text and data assets the tree imports (`import SKILL_MD from './x/SKILL.md'`)
 * are *values*, not APIs: the bundled-skill loaders parse them and every one of
 * them already tolerates an empty document (each falls back to a built-in
 * description). So a missing asset stubs to empty content — which keeps startup
 * working — while a missing *module* stubs to something that throws when used.
 */
const TEXT_ASSET = /\.(md|mdx|markdown|txt|html|svg|css)$/i;
const DATA_ASSET = /\.json$/i;

function assetStubContents(missing, names, empty) {
  const exportable = [...names].filter((n) => n !== "*" && n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n) && !RESERVED.has(n));
  return [
    `// [caspar] ${missing} is absent from this source snapshot; stubbed as empty content.`,
    ...exportable.map((name) => `export const ${name} = ${empty};`),
    `export default ${empty};`,
  ].join("\n");
}

function stubContents(missing, names) {
  if (TEXT_ASSET.test(missing)) return assetStubContents(missing, names, '""');
  if (DATA_ASSET.test(missing)) return assetStubContents(missing, names, "{}");
  const exportable = [...names].filter((n) => n !== "*" && n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n) && !RESERVED.has(n));
  return `
const MISSING = ${JSON.stringify(missing)};
function explain(label) {
  return "[caspar] " + MISSING + " is not present in this source snapshot (reached via: " + label +
    "). This feature is not available in the creature build.";
}
/**
 * A stub value that is inert where a feature is merely *described* — an empty
 * collection, a falsy flag — and throws where it is actually *used*. That split
 * matters: module initialisation routinely maps over exported tables (which must
 * not crash the CLI at startup), while calling a stubbed function means the run
 * genuinely depends on a missing feature and must say so.
 */
function stub(label) {
  const target = function () {
    throw new Error(explain(label));
  };
  return new Proxy(target, {
    get(t, prop) {
      switch (prop) {
        case "length": return 0;
        case "name": return label;
        case "__esModule": return true;
        case "then": return undefined; // never look like a promise
        case "map": case "filter": case "flatMap": case "slice": case "concat": case "flat": case "sort": case "reverse": case "keys": case "values": case "entries": return () => [];
        case "forEach": return () => undefined;
        case "find": case "at": case "pop": case "shift": case "get": return () => undefined;
        case "has": case "includes": case "some": case "startsWith": case "endsWith": case "test": return () => false;
        case "every": return () => true;
        case "join": return () => "";
        case "size": return 0;
        case "toString": case "toJSON": case "valueOf": case "inspect": return () => "[stub " + label + "]";
        case Symbol.iterator: return function* () {};
        case Symbol.asyncIterator: return async function* () {};
        case Symbol.toPrimitive: return () => "[stub " + label + "]";
        default:
          if (typeof prop === "symbol") return undefined;
          if (prop in t) return t[prop];
          return stub(label + "." + String(prop));
      }
    },
    apply() {
      throw new Error(explain(label + "()"));
    },
    construct() {
      throw new Error(explain("new " + label));
    },
  });
}
${exportable.map((name) => `export const ${name} = stub(${JSON.stringify(name)});`).join("\n")}
export default stub("default");
`;
}

/**
 * Anything relative or `src/`-rooted that does not exist on disk becomes a stub,
 * as do the unpublished packages above. The stub's identity includes the names its
 * importer needs, so two importers of the same missing module each link against a
 * stub that exports what they ask for.
 */
const stubMissing = {
  name: "stub-missing-modules",
  setup(build) {
    /**
     * `written` is the specifier as it appears in the importer's source (that is
     * what the import statement can be found by); `label` is the resolved,
     * repo-relative name a human reads in an error or in the stub report.
     */
    const resolveStub = (written, label, importer) => {
      const names = importer ? importedNames(importer, written) : new Set();
      const list = [...names].sort();
      stubbed.add(label);
      return { path: `${label} ${list.join(",")}`, namespace: STUB_NAMESPACE };
    };
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!isStubbedPackage(args.path)) return undefined;
      return resolveStub(args.path, args.path, args.importer);
    });
    build.onResolve({ filter: /^(\.\.?\/|src\/)/ }, (args) => {
      const base = args.path.startsWith("src/") ? path.resolve(ROOT, args.path) : path.resolve(args.resolveDir, args.path);
      if (resolveSourcePath(base)) return undefined; // exists — normal resolution
      return resolveStub(args.path, path.relative(ROOT, base), args.importer);
    });
    build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, (args) => {
      const [missing, joined = ""] = args.path.split(" ");
      const names = new Set(joined ? joined.split(",") : []);
      return { contents: stubContents(missing, names), loader: "js", resolveDir: ROOT };
    });
  },
};

/**
 * Per-file adjustments applied at load time — the source tree itself is never
 * edited. Each one is a gap in this snapshot, not a behaviour change, and each
 * must be a faithful answer for a headless agent rather than a silent no-op:
 *
 *   • `isReplBridgeActive` (missing export) gates the inbound REPL-bridge
 *     (remote-control) path. A creature is driven by Caspar signals, never by that
 *     bridge, so it is false — exactly what the callers treat as "not connected".
 *   • `-d2e` (invalid short flag) would abort argument parsing entirely.
 */
const SOURCE_SHIMS = {
  "src/bootstrap/state.ts": {
    append: `
export function isReplBridgeActive() {
  // caspar creature build: no inbound REPL bridge exists in this deployment.
  return false;
}
`,
  },
  "src/main.tsx": {
    // The CLI declares a `-d2e` short flag, which the `commander` version this
    // repo pins (13.1.0) rejects outright — the process dies before parsing any
    // argument. Declaring it as a long flag keeps the option (`--d2e`) and lets
    // the CLI start; nothing the creature passes uses it.
    replace: [[/'-d2e, --debug-to-stderr'/g, "'--d2e, --debug-to-stderr'"]],
  },
};

const shimmed = new Set();

const sourceShims = {
  name: "source-shims",
  setup(build) {
    const targets = Object.keys(SOURCE_SHIMS).map((rel) => path.join(ROOT, rel));
    build.onLoad({ filter: /\.tsx?$/ }, (args) => {
      const index = targets.indexOf(args.path);
      if (index < 0) return undefined;
      const rel = Object.keys(SOURCE_SHIMS)[index];
      const shim = SOURCE_SHIMS[rel];
      let contents = readFileSync(args.path, "utf-8");
      for (const [pattern, replacement] of shim.replace || []) contents = contents.replace(pattern, replacement);
      if (shim.append) contents += shim.append;
      shimmed.add(rel);
      return { contents, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
    });
  },
};

const options = {
  entryPoints: [path.join(ROOT, "src/entrypoints/cli.tsx")],
  bundle: true,
  platform: "node",
  target: ["node20", "es2022"],
  format: "esm",
  outfile: outFile,
  splitting: false,
  plugins: strict ? [srcResolver] : [srcResolver, sourceShims, stubMissing],
  tsconfig: path.join(ROOT, "tsconfig.json"),
  alias: { "bun:bundle": path.join(ROOT, "src/shims/bun-bundle.ts") },
  external: [
    "fs", "path", "os", "crypto", "child_process", "http", "https",
    "net", "tls", "url", "util", "stream", "events", "buffer",
    "querystring", "readline", "zlib", "assert", "tty", "worker_threads",
    "perf_hooks", "async_hooks", "dns", "dgram", "cluster",
    "string_decoder", "module", "vm", "constants", "domain",
    "console", "process", "v8", "inspector",
    "node:*",
    "fsevents", "sharp", "image-processor-napi",
    // Not external here, unlike the repo's own build: a creature ships one
    // self-contained file with no node_modules to resolve anything from, so
    // @anthropic-ai/sandbox-runtime and @anthropic-ai/claude-agent-sdk are bundled
    // in and @ant/* is stubbed (see STUBBED_PACKAGE_PATTERNS).
  ],
  jsx: "automatic",
  sourcemap: false,
  minify,
  treeShaking: true,
  define: {
    "MACRO.VERSION": JSON.stringify(version),
    "MACRO.PACKAGE_URL": JSON.stringify("@anthropic-ai/claude-code"),
    "MACRO.ISSUES_EXPLAINER": JSON.stringify("report issues at https://github.com/anthropics/claude-code/issues"),
    "process.env.USER_TYPE": '"external"',
    "process.env.NODE_ENV": minify ? '"production"' : '"development"',
  },
  // ESM output plus bundled CommonJS dependencies (node-fetch inside the Anthropic
  // SDK's shims, among others) means `require()` calls survive into the bundle,
  // where esbuild's fallback shim throws "Dynamic require of X is not supported".
  // Giving the module a real `require` — plus the `__filename`/`__dirname` a CJS
  // dependency may read — makes those calls work instead. esbuild's own shim
  // prefers this `require` when it exists.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __casparCreateRequire } from "node:module";',
      'import { fileURLToPath as __casparFileURLToPath } from "node:url";',
      'import { dirname as __casparDirname } from "node:path";',
      "const require = __casparCreateRequire(import.meta.url);",
      "const __filename = __casparFileURLToPath(import.meta.url);",
      "const __dirname = __casparDirname(__filename);",
    ].join("\n"),
  },
  resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
  logLevel: "warning",
  metafile: true,
  // node-pty's prebuilt addon is loaded at runtime; keep the require dynamic
  // rather than trying to bundle a .node binary.
  // Text assets are imported as strings by the skill/prompt modules.
  loader: { ".node": "file", ".md": "text", ".mdx": "text", ".markdown": "text", ".txt": "text" },
};

mkdirSync(path.dirname(outFile), { recursive: true });
const started = Date.now();
const result = await esbuild.build(options).catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
});

if (result.errors?.length) {
  console.error(`build failed with ${result.errors.length} error(s)`);
  process.exit(1);
}

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`built ${path.relative(ROOT, outFile)} — ${(bytes / 1024 / 1024).toFixed(2)} MB in ${Date.now() - started}ms`);
if (shimmed.size) {
  console.log(`patched ${shimmed.size} module(s) for the creature build: ${[...shimmed].join(", ")}`);
}
if (stubbed.size) {
  const list = [...stubbed].sort();
  console.log(`stubbed ${list.length} module(s) absent from this source snapshot (they throw if ever reached):`);
  for (const name of list.slice(0, 12)) console.log(`  • ${name}`);
  if (list.length > 12) console.log(`  … and ${list.length - 12} more (full list: dist/stubbed-modules.json)`);
  writeFileSync(path.join(path.dirname(outFile), "stubbed-modules.json"), JSON.stringify(list, null, 2));
}
try {
  chmodSync(outFile, 0o755);
} catch {
  /* non-fatal */
}
