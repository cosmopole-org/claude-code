/**
 * Translation between the Anthropic Messages API (what Claude Code speaks) and the
 * OpenAI Chat Completions API (what OpenAI, Gemini, xAI and OpenRouter speak).
 *
 * This is the whole reason an agent can name a non-Anthropic provider: the CLI
 * emits Anthropic-shaped requests, the proxy translates them to OpenAI shape,
 * calls the provider, and translates the answer — including the streaming SSE —
 * back to Anthropic shape so the CLI's agent loop (tool calls and all) works
 * unchanged.
 *
 * Pure and dependency-free so the mapping is unit-testable without a provider:
 *   • `toOpenAIRequest`   — Anthropic request body → OpenAI request body
 *   • `toAnthropicResponse` — OpenAI (non-streaming) response → Anthropic response
 *   • `OpenAIToAnthropicStream` — an OpenAI SSE stream → Anthropic SSE events
 *   • `estimateTokens`    — a rough token count for `/v1/messages/count_tokens`
 */

import crypto from "node:crypto";

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

/** Flatten Anthropic's `system` (string or block array) to one string. */
function systemText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b === "object" ? b.text || "" : String(b || "")))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** An Anthropic tool_result's content → an OpenAI tool message's string content. */
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
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return content == null ? "" : String(content);
}

function mapToolChoice(choice) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return undefined;
}

/**
 * Anthropic request body → OpenAI request body.
 *
 * `model` is passed through (the CLI already set it to the provider's model id via
 * `--model`). `maxTokensField` lets a provider that rejects `max_tokens` use
 * `max_completion_tokens` instead.
 */
export function toOpenAIRequest(a, { model, maxTokensField = "max_tokens" } = {}) {
  const messages = [];
  const sys = systemText(a.system);
  if (sys.trim()) messages.push({ role: "system", content: sys });

  for (const m of Array.isArray(a.messages) ? a.messages : []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") textParts.push(block.text || "");
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || genId("call"),
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
        // thinking / redacted_thinking blocks have no OpenAI equivalent — dropped.
      }
      const msg = { role: "assistant" };
      const text = textParts.join("");
      msg.content = text || null;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // user message: tool_result blocks become their own `tool` messages (OpenAI
    // requires them to follow the assistant tool_calls, which the ordering here
    // preserves), and the rest becomes one user message.
    const parts = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") {
        messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block.content) });
      } else if (block.type === "text") {
        parts.push({ type: "text", text: block.text || "" });
      } else if (block.type === "image" && block.source) {
        const src = block.source;
        const url = src.type === "base64" ? `data:${src.media_type};base64,${src.data}` : src.url || "";
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
    }
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((p) => p.text).join("\n") : parts });
    }
  }

  const out = { model, messages, stream: Boolean(a.stream) };
  const maxTokens = Number(a.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out[maxTokensField] = maxTokens;
  if (a.temperature != null) out.temperature = a.temperature;
  if (a.top_p != null) out.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) out.stop = a.stop_sequences;
  if (Array.isArray(a.tools) && a.tools.length) {
    out.tools = a.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || { type: "object", properties: {} },
        },
      }));
    const choice = mapToolChoice(a.tool_choice);
    if (choice) out.tool_choice = choice;
  }
  if (a.stream) out.stream_options = { include_usage: true };
  return out;
}

const FINISH_TO_STOP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

function mapFinish(reason) {
  return FINISH_TO_STOP[reason] || "end_turn";
}

/** OpenAI (non-streaming) response → Anthropic response body. */
export function toAnthropicResponse(o, { model } = {}) {
  const choice = (Array.isArray(o.choices) && o.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = { _raw: tc.function?.arguments || "" };
    }
    content.push({ type: "tool_use", id: tc.id || genId("toolu"), name: tc.function?.name || "tool", input });
  }
  return {
    id: o.id || genId("msg"),
    type: "message",
    role: "assistant",
    model: model || o.model,
    content,
    stop_reason: mapFinish(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(o.usage?.prompt_tokens || 0),
      output_tokens: Number(o.usage?.completion_tokens || 0),
    },
  };
}

/**
 * Streaming translator: OpenAI SSE chunks in, Anthropic SSE events out.
 *
 * Anthropic's stream is a sequence of typed events — `message_start`, then per
 * content block `content_block_start` / `content_block_delta` / `content_block_stop`,
 * then `message_delta` (stop reason + output tokens) and `message_stop`. Only one
 * block is open at a time, so text and each tool call are opened lazily and closed
 * before the next begins. OpenAI reports usage only in a final chunk, so
 * `message_start` carries an input **estimate** (the exact prompt-token count is
 * not known until the end); `output_tokens` in the closing `message_delta` is exact.
 */
export class OpenAIToAnthropicStream {
  constructor({ model, inputTokensEstimate = 0 } = {}) {
    this.model = model;
    this.messageId = genId("msg");
    this.inputTokens = inputTokensEstimate;
    this.outputTokens = 0;
    this.blockIndex = -1;
    this.open = null; // "text" | "tool" | null
    this.toolIndexMap = new Map(); // OpenAI tool-call index → our block index
    this.finish = "stop";
    this.started = false;
  }

  static _event(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  begin() {
    this.started = true;
    return OpenAIToAnthropicStream._event("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  _closeOpen(out) {
    if (this.open) {
      out.push(OpenAIToAnthropicStream._event("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
      this.open = null;
    }
  }

  _openText(out) {
    this._closeOpen(out);
    this.blockIndex += 1;
    out.push(
      OpenAIToAnthropicStream._event("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "text", text: "" },
      }),
    );
    this.open = "text";
  }

  _openTool(out, id, name) {
    this._closeOpen(out);
    this.blockIndex += 1;
    out.push(
      OpenAIToAnthropicStream._event("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "tool_use", id: id || genId("toolu"), name: name || "tool", input: {} },
      }),
    );
    this.open = "tool";
  }

  /** Feed one parsed OpenAI SSE chunk; returns the Anthropic SSE string(s) to send. */
  handleChunk(json) {
    const out = [];
    if (!this.started) out.push(this.begin());
    if (json && json.usage) {
      if (Number.isFinite(json.usage.prompt_tokens)) this.inputTokens = json.usage.prompt_tokens;
      if (Number.isFinite(json.usage.completion_tokens)) this.outputTokens = json.usage.completion_tokens;
    }
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    if (choice) {
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content.length) {
        if (this.open !== "text") this._openText(out);
        out.push(
          OpenAIToAnthropicStream._event("content_block_delta", {
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const oaIndex = Number(tc.index ?? 0);
        if (!this.toolIndexMap.has(oaIndex)) {
          this._openTool(out, tc.id, tc.function?.name);
          this.toolIndexMap.set(oaIndex, this.blockIndex);
        }
        const args = tc.function?.arguments;
        if (typeof args === "string" && args.length) {
          out.push(
            OpenAIToAnthropicStream._event("content_block_delta", {
              type: "content_block_delta",
              index: this.blockIndex,
              delta: { type: "input_json_delta", partial_json: args },
            }),
          );
        }
      }
      if (choice.finish_reason) this.finish = choice.finish_reason;
    }
    return out.join("");
  }

  /** Close the stream: final block, message_delta (stop + output tokens), message_stop. */
  end() {
    const out = [];
    if (!this.started) out.push(this.begin());
    this._closeOpen(out);
    out.push(
      OpenAIToAnthropicStream._event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapFinish(this.finish), stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      }),
    );
    out.push(OpenAIToAnthropicStream._event("message_stop", { type: "message_stop" }));
    return out.join("");
  }
}

/** A rough token estimate (~4 chars/token) for `/v1/messages/count_tokens`. */
export function estimateTokens(a) {
  let chars = systemText(a.system).length;
  for (const m of Array.isArray(a.messages) ? a.messages : []) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string") chars += block.text.length;
        else if (block.type === "tool_use") chars += JSON.stringify(block.input ?? {}).length + (block.name || "").length;
        else if (block.type === "tool_result") chars += toolResultText(block.content).length;
      }
    }
  }
  for (const t of Array.isArray(a.tools) ? a.tools : []) {
    chars += (t.name || "").length + (t.description || "").length + JSON.stringify(t.input_schema || {}).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}
