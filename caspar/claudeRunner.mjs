/**
 * Running Claude Code headless, once per prompt.
 *
 * The agent loop itself is Claude Code's: we drive it in print mode with
 * `--output-format stream-json`, which emits one JSON message per line for every
 * step it takes (thinking, tool calls, tool results, the final result). Those
 * lines are what this creature restreams to the Decillion client, so the product
 * shows a live trajectory instead of a spinner.
 *
 * Everything the platform sends per prompt is applied here:
 *   • the agent's skill → `--append-system-prompt`
 *   • the space's creatures → an MCP server (`--mcp-config`, `--strict-mcp-config`)
 *   • the agent's LLM override (`config.llm`) → provider env + `--model`
 *   • the run's wall-clock budget → a hard kill, so a stuck run still answers
 *
 * Privileges: Claude Code refuses `bypassPermissions` when running as root, and
 * an autonomous creature has no human to approve tool calls — so when the
 * container starts as root we drop to an unprivileged user for the child. If that
 * is impossible we degrade the permission mode instead of failing the run.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startLlmProxy } from "./llm/llmProxy.mjs";
import { proxiedProviderIds, resolveProvider } from "./llm/providers.mjs";

/** Env vars that would leak *this* process's session identity into the child. */
const STRIPPED_ENV = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_ACTION",
  "ANTHROPIC_MODEL_OVERRIDE",
];

/**
 * Locate the Claude Code CLI. A bundle built from this repo wins (that is the
 * code the operator deployed); otherwise the published CLI on PATH is used.
 */
export function resolveCli(env = process.env) {
  const explicit = (env.CLAUDE_CODE_BIN || "").trim();
  const candidates = [explicit, "/app/dist/cli.mjs", "/app/cli.mjs"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) {
      return candidate.endsWith(".mjs") || candidate.endsWith(".js")
        ? { command: process.execPath, prefixArgs: [candidate] }
        : { command: candidate, prefixArgs: [] };
    }
  }
  if (explicit && !explicit.includes("/")) return { command: explicit, prefixArgs: [] };
  return { command: "claude", prefixArgs: [] };
}

/**
 * The unprivileged identity the CLI runs under when this process is root.
 * Returns `null` when we are already unprivileged or no such user exists.
 */
export function dropTarget({ env = process.env, uid = typeof process.getuid === "function" ? process.getuid() : 1 } = {}) {
  if (uid !== 0) return null;
  // An explicitly empty `CLAUDE_CREATURE_USER` means "do not drop privileges";
  // only an *unset* variable falls back to the image's `claude` user.
  const configured = env.CLAUDE_CREATURE_USER;
  const name = (configured === undefined ? "claude" : configured).trim();
  if (!name || name === "root") return null;
  let entry;
  try {
    entry = fs
      .readFileSync("/etc/passwd", "utf-8")
      .split("\n")
      .map((line) => line.split(":"))
      .find((cols) => cols[0] === name);
  } catch {
    return null;
  }
  if (!entry) return null;
  const targetUid = Number(entry[2]);
  const targetGid = Number(entry[3]);
  if (!Number.isFinite(targetUid) || targetUid === 0) return null;
  return { name, uid: targetUid, gid: targetGid, home: entry[5] || `/home/${name}` };
}

/**
 * Every credential the CLI can authenticate with. When an agent brings its own,
 * the others must go: the CLI prefers `ANTHROPIC_AUTH_TOKEN`, then an OAuth token,
 * so leaving the image's baked credential in place would quietly bill the
 * platform's account for a run the agent's own key was supposed to pay for.
 */
const CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"];

/** Providers that are the Anthropic API itself. */
const NATIVE_PROVIDERS = new Set(["", "anthropic", "claude", "claude-code", "claude_code"]);

/** `openrouter` → `CLAUDE_CREATURE_LLM_GATEWAY_OPENROUTER`. */
function gatewayEnvName(provider) {
  return `CLAUDE_CREATURE_LLM_GATEWAY_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** A placeholder Anthropic key set when the run is served through the local proxy. */
const PROXY_PLACEHOLDER_KEY = "sk-caspar-local-proxy";

/**
 * Translate a per-agent LLM override into child env + model selection.
 *
 * Decillion stores an optional `{provider, model, apiKey}` per agent and sends it
 * as `config.llm` = `{provider, models:[model], api_key}` with every prompt — the
 * same block davinci read. All three parts are honoured here:
 *
 *   • `api_key`  → the run authenticates as that key, and every other credential
 *                  the image carries is removed for this run;
 *   • `models[0]`→ `--model` for the run;
 *   • `provider` → routed to the right backbone:
 *       - anthropic (default)      → the Anthropic API directly;
 *       - bedrock / vertex         → the 3P backbone (its own creds);
 *       - openai / gemini / xai /
 *         openrouter               → the creature's built-in Anthropic↔OpenAI
 *                                     translation proxy, so these providers work
 *                                     from just provider+model+api_key;
 *       - anything else with a
 *         configured gateway       → that Anthropic-compatible gateway.
 *
 * A known non-native provider with no `api_key` (nothing to authenticate with), or
 * an unknown provider with no gateway, falls back to the image's default backbone
 * and says so in the VM log and the reply's `warnings` — never failing silently.
 *
 * When the built-in proxy is chosen this returns a `proxy` descriptor; the caller
 * starts the proxy and points `ANTHROPIC_BASE_URL` at it. The agent's real
 * provider key never enters the CLI's environment (the CLI gets a placeholder).
 */
export function applyLlmOverride(env, llm) {
  const none = { model: undefined, warning: undefined, provider: undefined, credential: undefined, proxy: undefined };
  if (!llm || typeof llm !== "object") return none;
  const provider = String(llm.provider || "").trim().toLowerCase();
  const model = (Array.isArray(llm.models) && llm.models.find((m) => typeof m === "string" && m.trim())) || (typeof llm.model === "string" ? llm.model : undefined);
  const apiKey = (typeof llm.api_key === "string" && llm.api_key.trim()) || (typeof llm.apiKey === "string" && llm.apiKey.trim()) || "";
  const baseUrl = (typeof llm.base_url === "string" && llm.base_url.trim()) || (typeof llm.baseUrl === "string" && llm.baseUrl.trim()) || "";
  const modelId = model && model.trim() ? model.trim() : undefined;

  /** Drop every credential the image baked in, so only the agent's own is used. */
  const takeOver = () => {
    for (const key of CREDENTIAL_ENV) delete env[key];
  };

  let warning;
  let credential;
  let proxy;

  const resolved = resolveProvider(provider, { env, baseUrlOverride: baseUrl });
  if (NATIVE_PROVIDERS.has(provider) || (resolved && resolved.native)) {
    if (apiKey) {
      takeOver();
      env.ANTHROPIC_API_KEY = apiKey;
      // An explicit Anthropic key means the direct API, never a 3P backbone the
      // image may have been built for.
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.CLAUDE_CODE_USE_VERTEX;
      credential = "agent:ANTHROPIC_API_KEY";
    }
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  } else if (provider === "bedrock" || provider === "aws") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    delete env.CLAUDE_CODE_USE_VERTEX;
    credential = "image:bedrock";
  } else if (provider === "vertex" || provider === "gcp" || provider === "google-vertex") {
    env.CLAUDE_CODE_USE_VERTEX = "1";
    delete env.CLAUDE_CODE_USE_BEDROCK;
    credential = "image:vertex";
  } else if (resolved) {
    // A known OpenAI-compatible provider: serve it through the built-in proxy.
    if (apiKey) {
      takeOver();
      // The CLI needs *some* Anthropic key to enable API-key auth; the real
      // provider key stays in the proxy process, never in the child env.
      env.ANTHROPIC_API_KEY = PROXY_PLACEHOLDER_KEY;
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.CLAUDE_CODE_USE_VERTEX;
      proxy = { provider: resolved, apiKey, model: modelId };
      credential = `agent:${resolved.id}`;
    } else {
      warning =
        `LLM provider "${resolved.id}" was selected but the agent carries no api_key — ` +
        `this run used the creature's default backbone instead.`;
    }
  } else {
    // Unknown provider: honour an operator-configured Anthropic-compatible gateway.
    const gateway = baseUrl || (env[gatewayEnvName(provider)] || "").trim() || (env.CLAUDE_CREATURE_LLM_GATEWAY || "").trim();
    if (gateway) {
      takeOver();
      env.ANTHROPIC_BASE_URL = gateway;
      if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.CLAUDE_CODE_USE_VERTEX;
      credential = apiKey ? "agent:ANTHROPIC_AUTH_TOKEN" : "gateway";
      warning = `LLM provider "${provider}" is served through the Anthropic-compatible gateway ${gateway}`;
    } else {
      warning =
        `LLM provider "${provider}" is not a supported backbone (${["anthropic", ...proxiedProviderIds(), "bedrock", "vertex"].join(", ")}) ` +
        `and no gateway is configured for it — this run used the creature's default backbone.`;
    }
  }
  return { model: modelId, warning, provider: provider || "anthropic", credential, proxy };
}

/** Build the child environment: inherited, scrubbed, then per-run overrides. */
export function buildChildEnv({ env = process.env, llm, configDir, home, extra = {} } = {}) {
  const childEnv = { ...env };
  for (const key of STRIPPED_ENV) delete childEnv[key];
  childEnv.CLAUDE_CODE_ENTRYPOINT = "caspar-creature";
  // Never let the CLI try to draw a TUI or auto-update inside a creature.
  childEnv.CI = childEnv.CI || "1";
  childEnv.TERM = childEnv.TERM || "dumb";
  childEnv.DISABLE_AUTOUPDATER = "1";
  childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1";
  if (configDir) childEnv.CLAUDE_CONFIG_DIR = configDir;
  if (home) childEnv.HOME = home;
  const { model, warning, provider, credential, proxy } = applyLlmOverride(childEnv, llm);
  Object.assign(childEnv, extra);
  return { env: childEnv, model, warning, provider, credential, proxy };
}

/** How this run will authenticate, for the boot log. Never the credential itself. */
export function credentialSource(env) {
  if (env.CLAUDE_CODE_USE_BEDROCK) return "bedrock";
  if (env.CLAUDE_CODE_USE_VERTEX) return "vertex";
  if (env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  return "none";
}

/**
 * Run one prompt to completion.
 *
 * @param opts.prompt         the user turn (delivered on stdin, so length is unbounded)
 * @param opts.systemPrompt   appended to Claude Code's own system prompt
 * @param opts.cwd            the session workspace
 * @param opts.mcpConfig      `--mcp-config` JSON (omitted when the space has no creatures)
 * @param opts.llm            the agent's LLM override from `config.llm`
 * @param opts.model          explicit model (overridden by `llm.models[0]`)
 * @param opts.maxWallSeconds hard wall-clock ceiling for the run
 * @param opts.onMessage      called with every parsed stream-json message
 * @param opts.onStderr       called with the child's stderr chunks (diagnostics)
 * @returns `{ result, messages, exitCode, timedOut, stderr, argv, warnings }`
 */
/**
 * The CLI's built-in shell + filesystem tools. In a Decillion space the agent must
 * not run commands or touch files on its own private, ephemeral container — that
 * work is invisible to the rest of the team and thrown away when the container
 * recycles. The space's shared cloud sandbox is the real machine, so when the
 * space has one these built-ins are turned OFF (`--disallowedTools`) and the agent
 * is forced to do all shell/filesystem work through the sandbox tool, where its
 * teammates see the same files and output.
 */
export const DEFAULT_BUILTIN_FS_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
  "LS",
];

/**
 * Which built-in tools to deny for this run. Empty unless the space has a shared
 * execution environment (`hasSharedEnv`) — with no sandbox, denying the built-ins
 * would leave the agent unable to run anything at all. `CLAUDE_CREATURE_FORCE_SANDBOX_FS=0`
 * disables the behaviour; `CLAUDE_CREATURE_DISALLOWED_TOOLS` overrides the list.
 */
export function disallowedBuiltinTools({ hasSharedEnv, env = process.env } = {}) {
  const flag = env.CLAUDE_CREATURE_FORCE_SANDBOX_FS;
  const on = flag === undefined || String(flag).trim() === "" ? true : !["0", "false", "no", "off"].includes(String(flag).trim().toLowerCase());
  if (!on || !hasSharedEnv) return [];
  const override = (env.CLAUDE_CREATURE_DISALLOWED_TOOLS || "").trim();
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_BUILTIN_FS_TOOLS];
}

export async function runClaude(opts) {
  const {
    prompt,
    systemPrompt,
    cwd,
    mcpConfig,
    llm,
    model,
    sessionId,
    resumeSessionId,
    maxWallSeconds = Number(process.env.CLAUDE_CREATURE_MAX_WALL_SECONDS || 900),
    permissionMode = (process.env.CLAUDE_CREATURE_PERMISSION_MODE || "bypassPermissions").trim(),
    allowedTools,
    disallowedTools,
    extraArgs = [],
    onMessage,
    onStderr,
    env = process.env,
  } = opts;

  const warnings = [];
  const drop = dropTarget({ env });
  let mode = permissionMode;
  if (!drop && typeof process.getuid === "function" && process.getuid() === 0 && mode === "bypassPermissions") {
    // Claude Code refuses to bypass permissions as root, and an unattended agent
    // cannot answer a permission prompt — `acceptEdits` is the closest mode that
    // still lets the run proceed.
    mode = "acceptEdits";
    warnings.push("running as root with no unprivileged user available: permission mode degraded to acceptEdits");
  }

  const requestedConfigDir = (env.CLAUDE_CREATURE_CONFIG_DIR || "").trim() || undefined;
  const configDir = resolveConfigDir({
    configured: requestedConfigDir,
    home: drop ? drop.home : undefined,
    uid: drop ? drop.uid : undefined,
    gid: drop ? drop.gid : undefined,
  });
  if (requestedConfigDir && configDir !== requestedConfigDir) {
    // The CLI aborts with no output when it cannot write CLAUDE_CONFIG_DIR, so a
    // fallback here is the difference between a real answer and a silent failure.
    warnings.push(`CLAUDE_CONFIG_DIR ${requestedConfigDir} is not writable by the agent user; using ${configDir || "the CLI default"} instead`);
  }
  const { env: childEnv, model: llmModel, warning, provider, credential, proxy } = buildChildEnv({
    env,
    llm,
    configDir,
    home: drop ? drop.home : undefined,
  });
  if (warning) warnings.push(warning);

  // A non-Anthropic provider (openai/gemini/xai/openrouter) is served through the
  // built-in Anthropic↔OpenAI translation proxy: start it and point the CLI at it.
  // The agent's real provider key lives only in the proxy process.
  let llmProxy = null;
  if (proxy) {
    try {
      llmProxy = await startLlmProxy(proxy.provider, proxy.apiKey, {
        onError: (err) => onStderr?.(`[caspar-llm-proxy] ${err?.message || err}\n`),
      });
      childEnv.ANTHROPIC_BASE_URL = llmProxy.baseUrl;
    } catch (err) {
      warnings.push(`could not start the ${proxy.provider.id} translation proxy (${err?.message || err}); used the default backbone`);
      llmProxy = null;
    }
  }

  // What this run will authenticate as — reported so an operator can tell an
  // agent's own key from the image's, without either ever being logged.
  const backbone = {
    provider,
    credential: credential || credentialSource(childEnv),
    auth: credentialSource(childEnv),
    ...(llmProxy ? { proxied: proxy.provider.id, proxyModel: proxy.model } : {}),
  };

  const { command, prefixArgs } = resolveCli(env);
  const args = [...prefixArgs, "--print", "--output-format", "stream-json", "--verbose", "--permission-mode", mode];
  // Minimal mode: no hooks, plugins, LSP or CLAUDE.md auto-discovery. A creature
  // gets its whole persona from the platform, so this is pure prompt-cost saving
  // — but it also restricts auth to ANTHROPIC_API_KEY, so it stays opt-in.
  if (String(env.CLAUDE_CREATURE_BARE || "").trim() === "1") args.push("--bare");
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (mcpConfig) args.push("--mcp-config", typeof mcpConfig === "string" ? mcpConfig : JSON.stringify(mcpConfig), "--strict-mcp-config");
  const chosenModel = llmModel || model;
  if (chosenModel) args.push("--model", chosenModel);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else if (sessionId) args.push("--session-id", sessionId);
  if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools?.length) args.push("--disallowedTools", disallowedTools.join(","));
  args.push(...extraArgs);

  fs.mkdirSync(cwd, { recursive: true });
  if (drop) {
    // Everything the child touches — its workspace (including files this process
    // wrote into it, e.g. attachments) and the CLI's own state directory — must
    // belong to the user it runs as.
    for (const dir of [configDir, drop.home].filter(Boolean)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.chownSync(dir, drop.uid, drop.gid);
      } catch {
        /* best effort: a pre-owned dir is fine */
      }
    }
    chownTree(cwd, drop.uid, drop.gid);
  }

  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    ...(drop ? { uid: drop.uid, gid: drop.gid } : {}),
  });

  const messages = [];
  let result = null;
  let stderr = "";
  let stdoutTail = "";
  let timedOut = false;

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
  }, Math.max(1, maxWallSeconds) * 1000);

  let buffer = "";
  const processLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Non-JSON noise on stdout (a warning from a wrapper, say) — keep a tail
      // for diagnostics, never fail the run over it.
      stdoutTail = `${stdoutTail}${line}\n`.slice(-2000);
      return;
    }
    messages.push(message);
    if (message?.type === "result") result = message;
    if (onMessage) {
      try {
        onMessage(message);
      } catch {
        /* a listener must not break the run */
      }
    }
  };
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      processLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
    if (onStderr) {
      try {
        onStderr(chunk);
      } catch {
        /* ignore */
      }
    }
  });

  const spawnFailure = new Promise((resolve) => child.once("error", (err) => resolve(err)));
  const exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));

  try {
    child.stdin.write(prompt ?? "");
    child.stdin.end();
  } catch {
    /* the child may already be gone; `close` reports it */
  }

  const outcome = await Promise.race([exited, spawnFailure]);
  clearTimeout(killTimer);
  // The child has closed and every stdout chunk has been delivered: flush any
  // final line the CLI emitted WITHOUT a trailing newline. A `type:"result"`
  // that arrives unterminated — a run SIGTERM'd mid-line, or stdout truncated as
  // the process exits — would otherwise sit unparsed in `buffer` and be dropped,
  // turning a run that actually answered into a "produced no result" failure.
  if (buffer.trim()) processLine(buffer);
  buffer = "";
  if (llmProxy) {
    try {
      await llmProxy.stop();
    } catch {
      /* best effort */
    }
  }
  if (outcome instanceof Error) {
    return { result: null, messages, exitCode: null, timedOut, stderr: `${outcome.message}\n${stderr}`, argv: [command, ...args], warnings, stdoutTail, backbone };
  }
  return { result, messages, exitCode: outcome, timedOut, stderr, argv: [command, ...args], warnings, stdoutTail, backbone };
}

/**
 * Hand a directory tree to the unprivileged user the CLI runs as. Bounded and
 * best-effort: a workspace we cannot fully chown is still usable, and a session
 * with thousands of files must not stall the run.
 */
function chownTree(root, uid, gid, budget = 5000) {
  const stack = [root];
  let remaining = budget;
  while (stack.length && remaining-- > 0) {
    const current = stack.pop();
    try {
      fs.chownSync(current, uid, gid);
      const stat = fs.lstatSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
      }
    } catch {
      /* best effort */
    }
  }
}

/** A per-run temporary directory (sockets, MCP config) inside the container. */
export function runTempDir(prefix = "caspar-run-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * The CLI's config/state directory (`CLAUDE_CONFIG_DIR`), guaranteed writable.
 *
 * Claude Code creates and writes this directory at startup (config, session
 * state, locks); if it cannot, the CLI aborts **before emitting any stream-json**
 * — it exits 0 with no output, which the bridge can only report as "the agent
 * produced no result (exit code 0)". The creature's default is `/data/claude-config`,
 * under the VM's persistent mount — which the node commonly mounts **root-owned**,
 * so the unprivileged user the CLI runs as cannot write it. (The workspace has
 * always guarded against this via `workspaceRoot()`; the config dir did not, which
 * is why an OpenAI/Gemini/etc. agent could get a silent empty reply.)
 *
 * So the configured dir is used only when it can actually be created and written;
 * otherwise we fall back to a writable location — the run's HOME, then a temp dir —
 * creating (and, when dropping privileges, chowning) it so the child can use it.
 * Returns `undefined` only if nothing is writable, letting the CLI use its own
 * default.
 */
export function resolveConfigDir({ configured, home, uid, gid } = {}) {
  const base = home || os.homedir() || os.tmpdir();
  const candidates = [configured, path.join(base, ".claude-config"), path.join(os.tmpdir(), "caspar-claude-config")].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (Number.isFinite(uid) && Number.isFinite(gid)) {
        try {
          fs.chownSync(dir, uid, gid);
        } catch {
          /* best effort: a pre-owned dir is fine */
        }
      }
      // Writable by *this* process; when dropping we chowned it to the child above.
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}
