/**
 * The in-creature LLM proxy: an Anthropic Messages API endpoint that fronts an
 * OpenAI-compatible provider.
 *
 * When an agent names a non-Anthropic provider (OpenAI, Gemini, xAI, OpenRouter),
 * the runtime starts one of these on localhost and points the Claude Code CLI at it
 * with `ANTHROPIC_BASE_URL`. The CLI then talks its native Anthropic protocol to the
 * proxy, which translates each request to OpenAI Chat Completions, calls the real
 * provider with the agent's own key, and translates the answer (streaming SSE
 * included) back — so the agent loop, tool calls and all, runs unchanged on any of
 * the four providers.
 *
 * The provider key lives only in this process (passed at construction, from the
 * agent's `config.llm`), never in the CLI's environment. The CLI is given a dummy
 * Anthropic key just to satisfy its own auth check; the proxy ignores it.
 *
 * Endpoints (the only ones the CLI calls against `ANTHROPIC_BASE_URL`):
 *   POST /v1/messages                — generate (streaming or not)
 *   POST /v1/messages/count_tokens   — a token estimate for context management
 */

import http from "node:http";

import { OpenAIToAnthropicStream, estimateTokens, toAnthropicResponse, toOpenAIRequest } from "./anthropicOpenAI.mjs";

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function anthropicError(res, status, type, message) {
  sendJson(res, status, { type: "error", error: { type, message } });
}

/** Split an SSE text buffer into complete `data:` payloads; returns [payloads, rest]. */
function drainSse(buffer) {
  const payloads = [];
  let rest = buffer;
  let index;
  while ((index = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, index).replace(/\r$/, "");
    rest = rest.slice(index + 1);
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) payloads.push(trimmed.slice(5).trim());
  }
  return [payloads, rest];
}

export class LlmProxy {
  /**
   * @param provider resolved provider `{ id, baseUrl, headers, maxTokensField }`
   * @param apiKey   the agent's provider key
   * @param opts.fetchImpl override for tests
   * @param opts.onError optional `(err) => void` for diagnostics
   */
  constructor(provider, apiKey, { fetchImpl = globalThis.fetch, onError } = {}) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.onError = onError;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.port = 0;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    return this;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  _upstreamHeaders() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...(this.provider.headers || {}),
    };
  }

  async _handle(req, res) {
    try {
      const url = (req.url || "").split("?")[0];
      if (req.method !== "POST") return anthropicError(res, 404, "not_found_error", `no route for ${req.method} ${url}`);
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return anthropicError(res, 400, "invalid_request_error", "request body is not valid JSON");
      }
      if (url.endsWith("/count_tokens")) {
        return sendJson(res, 200, { input_tokens: estimateTokens(body) });
      }
      if (url.endsWith("/v1/messages") || url.endsWith("/messages")) {
        return body.stream ? this._stream(body, res) : this._complete(body, res);
      }
      return anthropicError(res, 404, "not_found_error", `no route for ${url}`);
    } catch (err) {
      this.onError?.(err);
      if (!res.headersSent) anthropicError(res, 500, "api_error", String(err?.message || err));
      else res.end();
    }
  }

  async _complete(body, res) {
    const openaiReq = toOpenAIRequest(body, { model: body.model, maxTokensField: this.provider.maxTokensField });
    openaiReq.stream = false;
    let upstream;
    try {
      upstream = await this.fetch(`${this.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this._upstreamHeaders(),
        body: JSON.stringify(openaiReq),
      });
    } catch (err) {
      return anthropicError(res, 502, "api_error", `provider ${this.provider.id} unreachable: ${err?.message || err}`);
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      return anthropicError(res, upstream.status, "api_error", `provider ${this.provider.id} error ${upstream.status}: ${text.slice(0, 500)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return anthropicError(res, 502, "api_error", `provider ${this.provider.id} returned non-JSON`);
    }
    return sendJson(res, 200, toAnthropicResponse(parsed, { model: body.model }));
  }

  async _stream(body, res) {
    const openaiReq = toOpenAIRequest(body, { model: body.model, maxTokensField: this.provider.maxTokensField });
    openaiReq.stream = true;
    let upstream;
    try {
      upstream = await this.fetch(`${this.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this._upstreamHeaders(),
        body: JSON.stringify(openaiReq),
      });
    } catch (err) {
      return anthropicError(res, 502, "api_error", `provider ${this.provider.id} unreachable: ${err?.message || err}`);
    }
    if (!upstream.ok || !upstream.body) {
      const text = upstream.body ? await upstream.text() : "";
      return anthropicError(res, upstream.status || 502, "api_error", `provider ${this.provider.id} error ${upstream.status}: ${text.slice(0, 500)}`);
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const translator = new OpenAIToAnthropicStream({ model: body.model, inputTokensEstimate: estimateTokens(body) });
    // `fetch` yields Uint8Array chunks; decode them as UTF-8 (a naive String()
    // would produce comma-joined byte values, not text).
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    try {
      for await (const chunk of upstream.body) {
        buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : decoder.decode(chunk, { stream: true });
        const [payloads, rest] = drainSse(buffer);
        buffer = rest;
        for (const payload of payloads) {
          if (payload === "[DONE]") {
            done = true;
            continue;
          }
          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          const events = translator.handleChunk(json);
          if (events) res.write(events);
        }
      }
      res.write(translator.end());
    } catch (err) {
      this.onError?.(err);
      // Mid-stream failure: close the block sequence so the CLI's parser settles,
      // then surface the error as a final event.
      if (!done) {
        try {
          res.write(translator.end());
        } catch {
          /* ignore */
        }
      }
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: String(err?.message || err) } })}\n\n`);
    } finally {
      res.end();
    }
  }
}

/** Start a proxy for a resolved provider + key. Returns the running proxy. */
export async function startLlmProxy(provider, apiKey, opts = {}) {
  return new LlmProxy(provider, apiKey, opts).start();
}
