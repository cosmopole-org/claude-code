/**
 * Trajectory mapping: Claude Code's `stream-json` messages → Decillion steps.
 *
 * A run is a multi-step loop, and the product streams it live: every thought,
 * every tool call, every observation and the final answer are pushed to the
 * prompting user as they happen (see `runtime.mjs`). The client renders each step
 * from two fields only — a coarse `channel` and a one-line `message` — so this
 * module's job is to turn each SDK message into that shape:
 *
 *   channel ∈ { status, plan, thought, action, observation, final, trace }
 *
 * The event shape (`seq`, `event_id`, `ts_utc`, `kind`, `message`, `data`) is the
 * one the Decillion backend already buffers and the Expo client already renders,
 * so nothing downstream changes when this creature replaces the davinci agent.
 */

import crypto from "node:crypto";

/** One-line summaries are for humans; keep signal payloads small. */
const MAX_MESSAGE_CHARS = Number(process.env.CLAUDE_CREATURE_STEP_MESSAGE_CHARS || 600);
const MAX_DATA_CHARS = Number(process.env.CLAUDE_CREATURE_STEP_DATA_CHARS || 2000);

/** Tools whose use is really the agent planning, not acting. */
const PLAN_TOOLS = new Set(["TodoWrite", "ExitPlanMode", "TaskCreate", "TaskUpdate"]);

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?<=(?:api[_-]?key|token|secret|password|authorization)["'\s:=]{1,6})[A-Za-z0-9_\-.]{16,}/gi,
];

/** Redact anything that looks like a credential before it leaves the container. */
export function maskSecrets(value) {
  if (typeof value === "string") {
    let out = value;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "***");
    return out;
  }
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecrets(v);
    return out;
  }
  return value;
}

function clip(text, limit = MAX_MESSAGE_CHARS) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function clipJson(value, limit = MAX_DATA_CHARS) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** A short, human-readable description of a tool call. */
function describeToolUse(name, input) {
  const args = input && typeof input === "object" ? input : {};
  if (name === "Bash" && args.command) return `Bash: ${clip(args.command, 200)}`;
  if (name === "TodoWrite" && Array.isArray(args.todos)) {
    const active = args.todos.find((t) => t && t.status === "in_progress");
    return `Plan (${args.todos.length} steps)${active ? ` — now: ${clip(active.content || active.activeForm, 120)}` : ""}`;
  }
  for (const key of ["file_path", "path", "pattern", "query", "url", "prompt", "description", "command", "code"]) {
    if (typeof args[key] === "string" && args[key].trim()) return `${name}: ${clip(args[key], 200)}`;
  }
  const keys = Object.keys(args);
  return keys.length ? `${name}(${keys.slice(0, 4).join(", ")})` : name;
}

/** Flatten a tool result's content blocks into text. */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          if (typeof block.text === "string") return block.text;
          if (block.type === "image") return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return clipJson(content) ?? "";
  return "";
}

export class TrajectoryMapper {
  constructor({ traceAll = false } = {}) {
    this.seq = 0;
    this.traceAll = traceAll;
    /** The plan the agent last wrote with TodoWrite, surfaced in the result. */
    this.todos = [];
    this.toolNamesById = new Map();
    this.toolCallCount = 0;
  }

  _event(kind, message, data, channel) {
    this.seq += 1;
    return {
      seq: this.seq,
      event_id: crypto.randomBytes(6).toString("hex"),
      ts_utc: new Date().toISOString(),
      kind,
      message: maskSecrets(clip(message)),
      data: data === undefined ? {} : maskSecrets(data),
      channel,
    };
  }

  /** Map one SDK message onto zero or more trajectory events. */
  map(message) {
    if (!message || typeof message !== "object") return [];
    switch (message.type) {
      case "system":
        return this._system(message);
      case "assistant":
        return this._assistant(message);
      case "user":
        return this._user(message);
      case "result":
        return this._result(message);
      case "rate_limit_event":
        return [this._event("status", "Rate limit status changed", { rate_limit_info: message.rate_limit_info }, "status")];
      case "stream_event":
      case "active_goal":
      case "streamlined_text":
      case "streamlined_tool_use_summary":
        return this.traceAll ? [this._event(`claude/${message.type}`, message.type, {}, "trace")] : [];
      default:
        return this.traceAll ? [this._event(`claude/${message.type}`, String(message.type), clipJson(message), "trace")] : [];
    }
  }

  _system(message) {
    if (message.subtype !== "init") {
      return this.traceAll ? [this._event(`claude/system.${message.subtype}`, String(message.subtype), {}, "trace")] : [];
    }
    const mcp = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
    const summary =
      `Session started (model ${message.model || "default"}, ${Array.isArray(message.tools) ? message.tools.length : 0} built-in tools` +
      (mcp.length ? `, creatures: ${mcp.map((s) => `${s.name}:${s.status}`).join(", ")}` : "") +
      ")";
    return [
      this._event(
        "run_start",
        summary,
        {
          model: message.model,
          permissionMode: message.permissionMode,
          apiKeySource: message.apiKeySource,
          version: message.claude_code_version,
          cwd: message.cwd,
          mcp_servers: mcp,
          session_id: message.session_id,
        },
        "status",
      ),
    ];
  }

  _assistant(message) {
    const events = [];
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
    if (message.is_api_error_message || message.error) {
      const text = blocks.find((b) => b?.type === "text")?.text || String(message.error || "api error");
      return [this._event("error", text, { error: message.error }, "observation")];
    }
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" && block.thinking) {
        events.push(this._event("reason", block.thinking, {}, "thought"));
      } else if (block.type === "text" && block.text?.trim()) {
        events.push(this._event("reason", block.text, {}, "thought"));
      } else if (block.type === "tool_use") {
        this.toolCallCount += 1;
        const name = String(block.name || "tool");
        if (block.id) this.toolNamesById.set(block.id, name);
        if (name === "TodoWrite" && Array.isArray(block.input?.todos)) this.todos = block.input.todos;
        events.push(
          this._event(
            "decision",
            describeToolUse(name, block.input),
            { tool: name, input: clipJson(block.input) },
            PLAN_TOOLS.has(name) ? "plan" : "action",
          ),
        );
      }
    }
    return events;
  }

  _user(message) {
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
    const events = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
      const tool = this.toolNamesById.get(block.tool_use_id) || "tool";
      const text = toolResultText(block.content);
      events.push(
        this._event(
          block.is_error ? "guardrail_block" : "tool_result",
          `${tool} → ${text ? clip(text, 300) : block.is_error ? "failed" : "ok"}`,
          { tool, is_error: Boolean(block.is_error), output: clipJson(text) },
          "observation",
        ),
      );
    }
    return events;
  }

  _result(message) {
    const ok = message.subtype === "success" && !message.is_error;
    return [
      this._event(
        ok ? "final_answer" : "error",
        ok ? clip(message.result || "") || "done" : `run failed: ${message.subtype}${message.errors?.length ? ` — ${clip(message.errors.join("; "), 200)}` : ""}`,
        {
          subtype: message.subtype,
          num_turns: message.num_turns,
          duration_ms: message.duration_ms,
          total_cost_usd: message.total_cost_usd,
        },
        "final",
      ),
    ];
  }
}
