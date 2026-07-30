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
 * Translate the platform's per-agent LLM override (`config.llm`:
 * `{provider, models, api_key}`) into child env + model selection.
 *
 * Anthropic (the native backbone) and Anthropic-compatible gateways are honoured;
 * a provider this CLI cannot speak is reported back rather than silently ignored,
 * so an operator can see why an agent is answering on the image default.
 */
export function applyLlmOverride(env, llm) {
  if (!llm || typeof llm !== "object") return { model: undefined, warning: undefined };
  const provider = String(llm.provider || "").trim().toLowerCase();
  const model = (Array.isArray(llm.models) && llm.models.find((m) => typeof m === "string" && m.trim())) || (typeof llm.model === "string" ? llm.model : undefined);
  const apiKey = typeof llm.api_key === "string" && llm.api_key.trim() ? llm.api_key.trim() : typeof llm.apiKey === "string" ? llm.apiKey.trim() : "";
  const baseUrl = typeof llm.base_url === "string" ? llm.base_url.trim() : typeof llm.baseUrl === "string" ? llm.baseUrl.trim() : "";

  let warning;
  if (!provider || provider === "anthropic" || provider === "claude" || provider === "claude-code") {
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
      delete env.ANTHROPIC_AUTH_TOKEN; // an explicit key must win over a baked token
    }
  } else if (provider === "bedrock") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
  } else if (provider === "vertex") {
    env.CLAUDE_CODE_USE_VERTEX = "1";
  } else if (baseUrl) {
    // An Anthropic-compatible gateway (LiteLLM, a router, …).
    env.ANTHROPIC_BASE_URL = baseUrl;
    if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  } else {
    warning = `LLM provider "${provider}" is not an Anthropic-compatible backbone for Claude Code; using the image default`;
  }
  if (baseUrl && !env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = baseUrl;
  return { model: model && model.trim() ? model.trim() : undefined, warning };
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
  const { model, warning } = applyLlmOverride(childEnv, llm);
  Object.assign(childEnv, extra);
  return { env: childEnv, model, warning };
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

  const configDir = (env.CLAUDE_CREATURE_CONFIG_DIR || "").trim() || undefined;
  const { env: childEnv, model: llmModel, warning } = buildChildEnv({
    env,
    llm,
    configDir,
    home: drop ? drop.home : undefined,
  });
  if (warning) warnings.push(warning);

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
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Non-JSON noise on stdout (a warning from a wrapper, say) — keep a tail
        // for diagnostics, never fail the run over it.
        stdoutTail = `${stdoutTail}${line}\n`.slice(-2000);
        continue;
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
  if (outcome instanceof Error) {
    return { result: null, messages, exitCode: null, timedOut, stderr: `${outcome.message}\n${stderr}`, argv: [command, ...args], warnings, stdoutTail };
  }
  return { result, messages, exitCode: outcome, timedOut, stderr, argv: [command, ...args], warnings, stdoutTail };
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
