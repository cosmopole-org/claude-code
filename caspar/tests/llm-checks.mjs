#!/usr/bin/env node
/**
 * Checks for the multi-provider LLM support (OpenAI / Gemini / xAI / OpenRouter).
 *
 * The translator is exercised as pure functions, and the proxy is exercised
 * end-to-end against a fake OpenAI-compatible server: an Anthropic-shaped request
 * (with tools) is translated, sent, and the streamed answer translated back — the
 * exact path a run on a non-Anthropic provider takes. `applyLlmOverride` is checked
 * for routing each provider (proxy vs native vs gateway) and for keeping the
 * agent's key out of the CLI environment.
 *
 * Run: node caspar/tests/llm-checks.mjs
 */

import assert from "node:assert/strict";

import { OpenAIToAnthropicStream, estimateTokens, toAnthropicResponse, toOpenAIRequest } from "../llm/anthropicOpenAI.mjs";
import { applyLlmOverride } from "../claudeRunner.mjs";
import { LlmProxy } from "../llm/llmProxy.mjs";
import { resolveProvider } from "../llm/providers.mjs";
import { FakeOpenAI } from "./fakeOpenAI.mjs";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`${GREEN}✓${NC} ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`${RED}✗${NC} ${name}\n  ${String(err?.stack || err).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

/** Collect an SSE string into an ordered list of {event, data}. */
function parseAnthropicSse(sse) {
  const events = [];
  for (const block of sse.split("\n\n")) {
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
  }
  return events;
}

// ── provider resolution + routing ───────────────────────────────────────────

await check("every named provider resolves (with aliases)", () => {
  assert.equal(resolveProvider("openai").id, "openai");
  assert.equal(resolveProvider("gpt").id, "openai");
  assert.equal(resolveProvider("grok").id, "xai");
  assert.equal(resolveProvider("x.ai").id, "xai");
  assert.equal(resolveProvider("google").id, "gemini");
  assert.equal(resolveProvider("open_router").id, "openrouter");
  assert.equal(resolveProvider("anthropic").native, true);
  assert.equal(resolveProvider("madeup"), null);
  // The agent's base_url overrides the provider default.
  assert.equal(resolveProvider("openai", { baseUrlOverride: "https://gw/v1" }).baseUrl, "https://gw/v1");
  // An operator can repoint a provider by env.
  assert.equal(resolveProvider("xai", { env: { CLAUDE_CREATURE_LLM_BASE_XAI: "https://x/v1" } }).baseUrl, "https://x/v1");
});

await check("each provider routes to the built-in proxy, keeping the key out of the CLI env", () => {
  for (const provider of ["openai", "gemini", "xai", "openrouter"]) {
    const env = { ANTHROPIC_API_KEY: "sk-platform", CLAUDE_CODE_OAUTH_TOKEN: "oauth-platform" };
    const res = applyLlmOverride(env, { provider, models: ["some-model"], api_key: "agent-secret-key" });
    assert.ok(res.proxy, `${provider} should route to the proxy`);
    assert.equal(res.proxy.provider.id, provider);
    assert.equal(res.proxy.apiKey, "agent-secret-key");
    assert.equal(res.model, "some-model");
    // The real key must never be in the child env; the placeholder is set instead.
    assert.equal(env.ANTHROPIC_API_KEY, "sk-caspar-local-proxy");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.notEqual(env.ANTHROPIC_API_KEY, "agent-secret-key");
  }
});

await check("anthropic stays native; bedrock/vertex stay 3P; a keyless provider falls back", () => {
  const native = {};
  const a = applyLlmOverride(native, { provider: "anthropic", models: ["claude-opus-5"], api_key: "sk-agent" });
  assert.equal(a.proxy, undefined);
  assert.equal(native.ANTHROPIC_API_KEY, "sk-agent");

  const bedrock = {};
  assert.equal(applyLlmOverride(bedrock, { provider: "bedrock" }).proxy, undefined);
  assert.equal(bedrock.CLAUDE_CODE_USE_BEDROCK, "1");

  // A known provider with no key can't authenticate: fall back and say so.
  const keyless = { ANTHROPIC_API_KEY: "sk-platform" };
  const res = applyLlmOverride(keyless, { provider: "openai", models: ["gpt-4o"] });
  assert.equal(res.proxy, undefined);
  assert.match(res.warning, /no api_key/);
  assert.equal(keyless.ANTHROPIC_API_KEY, "sk-platform", "the platform key is untouched on fallback");
});

// ── request translation (Anthropic → OpenAI) ─────────────────────────────────

await check("a request with system, tools, a prior tool call and a tool result translates", () => {
  const anthropic = {
    model: "gpt-4o",
    max_tokens: 1024,
    system: [{ type: "text", text: "You are Aria." }],
    tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    tool_choice: { type: "auto" },
    messages: [
      { role: "user", content: "list the files" },
      { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }] },
    ],
    stream: true,
  };
  const o = toOpenAIRequest(anthropic, { model: "gpt-4o", maxTokensField: "max_completion_tokens" });
  assert.equal(o.model, "gpt-4o");
  assert.equal(o.max_completion_tokens, 1024);
  assert.equal(o.messages[0].role, "system");
  assert.equal(o.messages[0].content, "You are Aria.");
  assert.equal(o.messages[1].content, "list the files");
  // The assistant tool call becomes an OpenAI tool_calls message.
  const assistant = o.messages[2];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls[0].function.name, "Bash");
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).command, "ls");
  // The tool result becomes a `tool` message keyed by the call id.
  const toolMsg = o.messages[3];
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "toolu_1");
  assert.match(toolMsg.content, /a\.txt/);
  // Tools + choice mapped.
  assert.equal(o.tools[0].function.name, "Bash");
  assert.equal(o.tool_choice, "auto");
  assert.deepEqual(o.stream_options, { include_usage: true });
});

await check("a non-streaming OpenAI response with a tool call becomes Anthropic content", () => {
  const anthropic = toAnthropicResponse(
    {
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "sure", tool_calls: [{ id: "call_9", function: { name: "Read", arguments: '{"path":"x"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    },
    { model: "gpt-4o" },
  );
  assert.equal(anthropic.type, "message");
  assert.equal(anthropic.content[0].type, "text");
  assert.equal(anthropic.content[0].text, "sure");
  assert.equal(anthropic.content[1].type, "tool_use");
  assert.equal(anthropic.content[1].name, "Read");
  assert.deepEqual(anthropic.content[1].input, { path: "x" });
  assert.equal(anthropic.stop_reason, "tool_use");
  assert.equal(anthropic.usage.input_tokens, 30);
  assert.equal(anthropic.usage.output_tokens, 12);
});

// ── streaming translation (OpenAI SSE → Anthropic SSE) ───────────────────────

await check("a streamed text+tool answer becomes a well-formed Anthropic event sequence", () => {
  const t = new OpenAIToAnthropicStream({ model: "gpt-4o", inputTokensEstimate: 5 });
  let sse = "";
  sse += t.handleChunk({ choices: [{ delta: { role: "assistant" } }] });
  sse += t.handleChunk({ choices: [{ delta: { content: "Hel" } }] });
  sse += t.handleChunk({ choices: [{ delta: { content: "lo" } }] });
  sse += t.handleChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "" } }] } }] });
  sse += t.handleChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] });
  sse += t.handleChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  sse += t.handleChunk({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } });
  sse += t.end();

  const events = parseAnthropicSse(sse);
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, [
    "message_start",
    "content_block_start", // text
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "content_block_start", // tool_use
    "content_block_delta", // input_json_delta
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[0].data.message.usage.input_tokens, 5);
  assert.equal(events[1].data.content_block.type, "text");
  assert.equal(events[2].data.delta.text, "Hel");
  assert.equal(events[5].data.content_block.type, "tool_use");
  assert.equal(events[5].data.content_block.name, "Bash");
  assert.equal(events[6].data.delta.type, "input_json_delta");
  assert.equal(events[6].data.delta.partial_json, '{"command":"ls"}');
  assert.equal(events[8].data.delta.stop_reason, "tool_use");
  assert.equal(events[8].data.usage.output_tokens, 9);
});

await check("count_tokens returns a positive estimate", () => {
  const n = estimateTokens({ system: "hello there", messages: [{ role: "user", content: "count me" }] });
  assert.ok(n > 0);
});

// ── the proxy, end to end against a fake OpenAI-compatible provider ──────────

await check("the proxy answers a non-streaming Anthropic request via the provider", async () => {
  const provider = await new FakeOpenAI({ turns: [{ text: "hello from the provider", finish: "stop", usage: { prompt_tokens: 21, completion_tokens: 4 } }] }).start();
  const resolved = resolveProvider("openai", { baseUrlOverride: provider.baseUrl });
  const proxy = await new LlmProxy(resolved, "agent-key").start();
  try {
    const r = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-caspar-local-proxy" },
      body: JSON.stringify({ model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.type, "message");
    assert.equal(body.content[0].text, "hello from the provider");
    assert.equal(body.usage.input_tokens, 21);
    // The provider got a proper OpenAI request carrying the agent's key.
    assert.equal(provider.requests[0].body.model, "gpt-4o");
    assert.equal(provider.requests[0].headers.authorization, "Bearer agent-key");
  } finally {
    await proxy.stop();
    await provider.stop();
  }
});

await check("the proxy streams a tool-using answer back in Anthropic SSE", async () => {
  const provider = await new FakeOpenAI({
    turns: [{ toolCalls: [{ id: "call_1", name: "Bash", arguments: { command: "ls" } }], finish: "tool_calls", usage: { prompt_tokens: 33, completion_tokens: 5 } }],
  }).start();
  const resolved = resolveProvider("xai", { baseUrlOverride: provider.baseUrl });
  const proxy = await new LlmProxy(resolved, "grok-key").start();
  try {
    const r = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-2",
        max_tokens: 100,
        stream: true,
        tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
        messages: [{ role: "user", content: "list files" }],
      }),
    });
    assert.equal(r.status, 200);
    const sse = await r.text();
    const events = parseAnthropicSse(sse);
    const start = events.find((e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use");
    assert.ok(start, "a tool_use block should be streamed");
    assert.equal(start.data.content_block.name, "Bash");
    const jsonDelta = events.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
    assert.deepEqual(JSON.parse(jsonDelta), { command: "ls" });
    const messageDelta = events.find((e) => e.event === "message_delta");
    assert.equal(messageDelta.data.delta.stop_reason, "tool_use");
    assert.equal(messageDelta.data.usage.output_tokens, 5);
  } finally {
    await proxy.stop();
    await provider.stop();
  }
});

await check("a provider error is surfaced as an Anthropic error, not a crash", async () => {
  // Point the proxy at a dead address so the upstream fetch fails.
  const resolved = resolveProvider("openrouter", { baseUrlOverride: "http://127.0.0.1:1/v1" });
  const proxy = await new LlmProxy(resolved, "k").start();
  try {
    const r = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await r.json();
    assert.equal(body.type, "error");
    assert.match(body.error.message, /unreachable|error/);
  } finally {
    await proxy.stop();
  }
});

console.log(`\n${failures.length ? RED : GREEN}${passed} passed, ${failures.length} failed${NC}`);
process.exit(failures.length ? 1 : 0);
