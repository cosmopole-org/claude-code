#!/usr/bin/env node
/**
 * Checks for the Caspar signaling bridge.
 *
 * These drive the REAL modules against a fake node gateway (which speaks the real
 * wire protocol) and a fake Claude Code CLI (which speaks real `stream-json`), so
 * every invariant the Decillion platform depends on is asserted end to end
 * without a node, a container or an LLM:
 *
 *   • the handshake adopts the node-assigned identity; large messages chunk and
 *     reassemble correctly;
 *   • a proxy-relayed prompt is decoded — skill, history, roster, correlation —
 *     and non-task signals are ignored;
 *   • the agent's skill, the group-chat context and the thread's history all
 *     reach the CLI, and the per-agent LLM override reaches its environment;
 *   • every step is streamed as `davinci/step` on the right channel, and exactly
 *     one terminal `davinci/result` is sent, through the proxy;
 *   • the result carries the answer, billable token usage and a non-array plan;
 *   • the space's creatures are employable over MCP, with platform-pinned
 *     arguments winning over the model's, and a tool added to a space appears on
 *     the next prompt (the catalog is per-prompt, not baked in);
 *   • a prompt delivered while another is being served is queued, not dropped;
 *   • a failed run, a run that never finishes, and a crashed CLI all still reply.
 *
 * Run: node caspar/tests/checks.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bridgeFromEnv } from "../bridge.mjs";
import { buildToolDefinitions, mergeArgs } from "../catalog.mjs";
import { applyLlmOverride, buildChildEnv } from "../claudeRunner.mjs";
import { TrajectoryMapper } from "../events.mjs";
import { buildSystemPrompt, buildUserPrompt } from "../prompt.mjs";
import { normalizeUsage } from "../result.mjs";
import { decodeTaskSignal, sessionSlug, taskObjective, threadSessionId } from "../taskSignal.mjs";
import { ToolInvoker } from "../toolInvoker.mjs";
import { ToolSocketServer } from "../toolSocket.mjs";
import { FakeGateway } from "./fakeGateway.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FAKE_CLI = path.join(HERE, "fakeClaude.mjs");
const MCP_SERVER = path.join(HERE, "..", "mcpStdioServer.mjs");

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

let passed = 0;
const failures = [];
const cleanups = [];

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

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A prompt exactly as the Decillion backend + node proxy deliver it. */
function proxyDelivery({ prompt = "What is the status of the deploy?", skill = "You are Tina, the release manager.", tools = [], history = [], correlationId = "corr-1", streamTo = "9@global", replyTo = "8@global", extra = {} } = {}) {
  const inner = {
    prompt,
    objective: prompt,
    streamTo,
    history,
    groupChat: true,
    self: { id: "res-tina", name: "Tina", handle: "tina" },
    roster: [
      { id: "res-tina", name: "Tina", handle: "tina", kind: "agent" },
      { id: "res-bob", name: "Bob", handle: "bob", kind: "agent" },
      { id: "u-1", name: "Shayan", handle: "shayan", kind: "user" },
    ],
    sessionId: "space:space-1:res-tina",
    spaceId: "space-1",
    config: { tools },
    ...extra,
    // stamped by the node's proxy entity on the way through
    skill,
    correlationId,
    replyTo,
    proxyProgramId: replyTo,
    proxyEntityId: "agent",
  };
  return { key: "creatures/signal", data: { user: { id: replyTo }, action: "single", entityId: "davinci", correlationId, data: JSON.stringify(inner) } };
}

function scenarioFile(scenario) {
  const dir = tempDir("caspar-scenario-");
  const file = path.join(dir, "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario));
  return { file, record: path.join(dir, "record.json") };
}

/** stream-json messages for a normal run: think → plan → act → observe → answer. */
function successScenario(answer = "The deploy is green.") {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5", cwd: "/w", tools: ["Bash", "Read"], mcp_servers: [{ name: "caspar", status: "connected" }], permissionMode: "bypassPermissions", apiKeySource: "ANTHROPIC_API_KEY", claude_code_version: "9.9.9" },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "They want the deploy status." }] }, session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "check CI", status: "in_progress" }, { content: "report", status: "pending" }] } }] }, session_id: "sess-1" },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "todos updated" }] }, session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "git log -1" } }] }, session_id: "sess-1" },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "abc123 fix the thing" }] }, session_id: "sess-1" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: answer,
        duration_ms: 1234,
        duration_api_ms: 1000,
        num_turns: 3,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 },
        modelUsage: { "claude-opus-5": { inputTokens: 100 } },
        permission_denials: [],
        session_id: "sess-1",
      },
    ],
  };
}

// ── unit-level checks ────────────────────────────────────────────────────────

await check("a proxy-relayed prompt decodes into a task with its envelope intact", () => {
  const { key, data } = proxyDelivery();
  const decoded = decodeTaskSignal(key, data);
  assert.ok(decoded, "the delivery should decode as a task");
  assert.equal(decoded.correlationId, "corr-1");
  assert.equal(decoded.replyTo, "8@global");
  assert.equal(decoded.streamTo, "9@global");
  assert.equal(taskObjective(decoded.task), "What is the status of the deploy?");
  assert.equal(decoded.task.skill, "You are Tina, the release manager.");
  assert.equal(threadSessionId(decoded.task), "space:space-1:res-tina");
  assert.equal(sessionSlug("space:space-1:res-tina"), "space-space-1-res-tina");
});

await check("a payload-string envelope (the CLI convention) unwraps, keeping proxy keys", () => {
  const inner = { payload: JSON.stringify({ objective: "ship it", config: { tools: [] } }), skill: "persona", correlationId: "c9", replyTo: "8@global" };
  const decoded = decodeTaskSignal("creatures/signal", { data: JSON.stringify(inner) });
  assert.equal(taskObjective(decoded.task), "ship it");
  assert.equal(decoded.task.skill, "persona");
  assert.equal(decoded.correlationId, "c9");
});

await check("signals that are not prompts are ignored", () => {
  assert.equal(decodeTaskSignal("creatures/signal", { data: JSON.stringify({ kind: "tools/result", correlationId: "x", result: {} }) }), null);
  assert.equal(decodeTaskSignal("creatures/signal", { data: JSON.stringify({ kind: "davinci/step", correlationId: "x" }) }), null);
  assert.equal(decodeTaskSignal("other/key", { data: "{}" }), null);
  assert.equal(decodeTaskSignal("creatures/signal", { data: "not json" }), null);
});

await check("the system prompt carries the persona and the group-chat protocol", () => {
  const { task } = decodeTaskSignal(...Object.values(proxyDelivery()));
  const system = buildSystemPrompt(task);
  assert.match(system, /YOUR PERSONA/);
  assert.match(system, /Tina, the release manager/);
  assert.match(system, /GROUP CHAT/);
  assert.match(system, /@handle is @tina/);
  assert.match(system, /Bob — @bob \(agent\)/);
  assert.match(system, /Shayan — @shayan \(person\)/);
  // The agent must never be listed among the other participants.
  assert.equal(/• Tina/.test(system), false, "the agent should not be in its own roster");
});

await check("history reaches the prompt with [From → To] annotations", () => {
  const history = [
    { role: "user", content: "hey team", from: "Shayan", to: [] },
    { role: "assistant", content: "on it", from: "Bob", to: [{ name: "Shayan" }] },
    { role: "user", content: "@tina what's the status?", from: "Shayan", to: [{ name: "Tina" }], directedToMe: true },
  ];
  const { task } = decodeTaskSignal(...Object.values(proxyDelivery({ history })));
  const prompt = buildUserPrompt(task, { objective: "what's the status?", attachments: [], workspace: "/w" });
  assert.match(prompt, /CONVERSATION SO FAR/);
  assert.match(prompt, /\[Shayan → everyone\] hey team/);
  assert.match(prompt, /\[Bob → Shayan\] on it/);
  assert.match(prompt, /\(directed at you\)/);
  assert.match(prompt, /CURRENT MESSAGE TO ANSWER ===\nwhat's the status\?/);
});

await check("the tool catalog becomes MCP tools with pinned platform defaults", () => {
  const catalog = [
    {
      name: "project sandbox",
      tool_id: "31@global",
      program_id: "31@global",
      entity_id: "vercel_sandbox",
      creature_id: "30@global",
      category: "sandbox",
      description: "the project's cloud machine",
      arg_schema: { command: { type: "string", description: "shell command" }, path: { type: "string" }, space_id: { type: "string" } },
      required: ["command"],
      function: "exec",
      defaults: { space_id: "space-1" },
      risk: "high",
    },
    { name: "no-target tool", tool_id: "", arg_schema: {} },
  ];
  const { tools, byName } = buildToolDefinitions(catalog);
  assert.equal(tools.length, 1, "an unroutable creature must never be offered to the agent");
  assert.equal(tools[0].name, "project_sandbox");
  assert.deepEqual(tools[0].inputSchema.required, ["command"]);
  assert.match(tools[0].description, /pins space_id/);
  // The platform's binding wins over anything the model says.
  const merged = mergeArgs(byName.get("project_sandbox"), { command: "ls", space_id: "space-999", nothing: null });
  assert.deepEqual(merged, { command: "ls", space_id: "space-1" });
});

await check("token usage maps to what the platform bills", () => {
  const usage = normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 10, output_tokens: 40 });
  assert.equal(usage.promptTokens, 1010);
  assert.equal(usage.completionTokens, 40);
  assert.equal(usage.totalTokens, 1050);
});

await check("an agent's own API key takes over the run from the image's credentials", () => {
  // The image is deployed with the platform's own credentials baked in; an agent
  // that carries its own must not silently run (and bill) on the platform's.
  const imageEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-platform-key",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-platform-token",
    ANTHROPIC_AUTH_TOKEN: "platform-bearer",
  };
  const own = buildChildEnv({ env: imageEnv, llm: { provider: "anthropic", models: ["claude-opus-5"], api_key: "sk-agent-key" } });
  assert.equal(own.env.ANTHROPIC_API_KEY, "sk-agent-key");
  assert.equal(own.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the image's OAuth token must not outrank the agent's key");
  assert.equal(own.env.ANTHROPIC_AUTH_TOKEN, undefined, "the image's bearer token must not outrank the agent's key");
  assert.equal(own.model, "claude-opus-5");
  assert.equal(own.credential, "agent:ANTHROPIC_API_KEY");

  // An agent with no override keeps the image's backbone untouched.
  const inherited = buildChildEnv({ env: imageEnv });
  assert.equal(inherited.env.ANTHROPIC_API_KEY, "sk-platform-key");
  assert.equal(inherited.env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-platform-token");
  assert.equal(inherited.model, undefined);
});

await check("a per-agent LLM override lands in the child environment", () => {
  const anthropic = buildChildEnv({ env: { PATH: "/usr/bin", CLAUDE_CODE_SESSION_ID: "leaked" }, llm: { provider: "anthropic", models: ["claude-opus-5"], api_key: "sk-test-key" } });
  assert.equal(anthropic.env.ANTHROPIC_API_KEY, "sk-test-key");
  assert.equal(anthropic.model, "claude-opus-5");
  assert.equal(anthropic.env.CLAUDE_CODE_SESSION_ID, undefined, "the parent's session id must not leak into the child");
  assert.equal(anthropic.env.CLAUDE_CODE_ENTRYPOINT, "caspar-creature");
  assert.equal(anthropic.proxy, undefined, "the native provider needs no translation proxy");

  // openai/gemini/xai/openrouter routing (through the built-in translation proxy)
  // and an unknown provider's gateway fallback are covered in llm-checks.mjs. Here
  // just confirm a known non-native provider selects the proxy, not the env.
  const openai = buildChildEnv({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-platform" }, llm: { provider: "openai", models: ["gpt-4o"], api_key: "agent-key" } });
  assert.ok(openai.proxy, "a non-native provider routes to the proxy");
  assert.equal(openai.proxy.provider.id, "openai");
  assert.equal(openai.env.ANTHROPIC_API_KEY, "sk-caspar-local-proxy", "the agent's real key stays out of the child env");
});

await check("trajectory events land on the channels the client renders", () => {
  const mapper = new TrajectoryMapper();
  const channels = [];
  for (const message of successScenario().messages) {
    for (const event of mapper.map(message)) channels.push([event.channel, event.kind]);
  }
  assert.deepEqual(channels, [
    ["status", "run_start"],
    ["thought", "reason"],
    ["plan", "decision"],
    ["observation", "tool_result"],
    ["action", "decision"],
    ["observation", "tool_result"],
    ["final", "final_answer"],
  ]);
  assert.equal(mapper.toolCallCount, 2);
  assert.equal(mapper.todos.length, 2);
});

await check("credentials are masked out of streamed steps", () => {
  const mapper = new TrajectoryMapper();
  const [event] = mapper.map({ type: "assistant", message: { content: [{ type: "text", text: "using sk-ant-abcdefghijklmnopqrstuv now" }] } });
  assert.equal(/sk-ant-abcdefghijklmnopqrstuv/.test(event.message), false);
  assert.match(event.message, /\*\*\*/);
});

// ── gateway-level checks ─────────────────────────────────────────────────────

await check("the handshake adopts the node-assigned identity and large messages chunk", async () => {
  const gateway = await new FakeGateway({ identity: { machineId: "77@global", programId: "77@global", vmId: "vm-77" } }).listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  try {
    assert.equal(bridge.machineId, "77@global");
    assert.equal(bridge.vmId, "vm-77");
    assert.equal(bridge.sessionId, 42);
    const pong = await bridge.ping();
    assert.equal(pong.ok, true);
    // A payload larger than one 64 KiB chunk must arrive whole.
    const big = "x".repeat(200_000);
    await bridge.signalUser("creatures/signal", "1@global", { kind: "davinci/step", blob: big });
    const [signal] = gateway.signals();
    assert.equal(signal.packet.blob.length, big.length);
  } finally {
    bridge.close();
    await gateway.close();
  }
});

await check("the space's creatures are employable over MCP, and pinned args win", async () => {
  // The node answers a tool signal the way a live tool creature does.
  const invoked = [];
  const gateway = await new FakeGateway({
    onCall: (op, input, gw) => {
      if (op !== "signalUser") return { ok: true };
      const packet = JSON.parse(input.packet);
      if (packet.kind !== "invoke") return { ok: true };
      invoked.push({ target: input.userId, packet });
      setTimeout(() => {
        gw.pushSignal("creatures/signal", {
          data: JSON.stringify({ kind: "tools/result", correlationId: packet.correlationId, result: { ok: true, stdout: "hello from the sandbox" } }),
        });
      }, 10);
      return { ok: true };
    },
  }).listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  const { tools, byName } = buildToolDefinitions([
    {
      name: "project sandbox",
      tool_id: "31@global",
      program_id: "31@global",
      entity_id: "vercel_sandbox",
      arg_schema: { command: { type: "string" }, space_id: { type: "string" } },
      required: ["command"],
      function: "exec",
      defaults: { space_id: "space-1" },
    },
  ]);
  const invoker = new ToolInvoker(bridge, byName, bridge.machineId);
  const socketPath = path.join(tempDir("caspar-sock-"), "tools.sock");
  const server = await new ToolSocketServer(socketPath, { list: () => tools, call: (name, args) => invoker.invoke(name, args) }).start();

  // Speak MCP to the server the way Claude Code does.
  const child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, CASPAR_TOOL_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = responses.get(message.id);
      if (waiter) {
        responses.delete(message.id);
        waiter(message);
      }
    }
  });
  const rpc = (id, method, params) =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "caspar");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await rpc(2, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((t) => t.name), ["project_sandbox"]);

    const called = await rpc(3, "tools/call", { name: "project_sandbox", arguments: { command: "echo hi", space_id: "space-999" } });
    assert.ok(!called.result.isError, "a successful employment is not an error");
    const payload = JSON.parse(called.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.response.stdout, "hello from the sandbox");

    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].target, "31@global");
    assert.equal(invoked[0].packet.entityId, "vercel_sandbox", "entityId is required for the node to cold-spawn the tool");
    assert.equal(invoked[0].packet.function, "exec");
    assert.equal(invoked[0].packet.reply_to, bridge.machineId);
    assert.equal(invoked[0].packet.payload.space_id, "space-1", "the platform's space binding must win over the model's argument");

    const unknown = await rpc(4, "tools/call", { name: "nope", arguments: {} });
    assert.equal(unknown.result.isError, true);
  } finally {
    child.kill();
    invoker.dispose();
    await server.stop();
    bridge.close();
    await gateway.close();
  }
});

await check("prompts that arrive while one is being served are queued, not dropped", async () => {
  const gateway = await new FakeGateway().listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  const { createDeliveryQueue } = await import("../runtime.mjs");
  const queue = createDeliveryQueue(bridge, 3000);
  try {
    // Two prompts back-to-back, as two agents in one space produce — plus one
    // signal that is not a prompt at all.
    const first = proxyDelivery({ prompt: "first", correlationId: "c1" });
    const second = proxyDelivery({ prompt: "second", correlationId: "c2" });
    gateway.pushSignal(first.key, first.data);
    gateway.pushSignal("creatures/signal", { data: JSON.stringify({ kind: "tools/result", correlationId: "x" }) });
    gateway.pushSignal(second.key, second.data);

    const a = await queue.next();
    const b = await queue.next();
    assert.equal(taskObjective(a.task), "first");
    assert.equal(taskObjective(b.task), "second", "the second prompt must survive being delivered mid-run");
    assert.equal(a.correlationId, "c1");
    assert.equal(b.correlationId, "c2");
    // Nothing else is pending, so the queue idles out rather than inventing work.
    assert.equal(await queue.next(), null);
  } finally {
    queue.dispose();
    bridge.close();
    await gateway.close();
  }
});

// ── end-to-end serve checks ─────────────────────────────────────────────────

/**
 * Serve one prompt with the fake CLI standing in for Claude Code, and return
 * everything the node saw plus what the CLI was invoked with.
 */
async function serveWithFakeCli({ scenario, delivery, envOverrides = {}, catalogTools = [] } = {}) {
  const { file, record } = scenarioFile(scenario);
  const workspaceRoot = tempDir("caspar-ws-");
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAUDE_CODE_BIN: FAKE_CLI,
    CLAUDE_FAKE_SCENARIO: file,
    CLAUDE_FAKE_RECORD: record,
    CLAUDE_CREATURE_WORKSPACE_ROOT: workspaceRoot,
    CLAUDE_CREATURE_CONFIG_DIR: path.join(workspaceRoot, "config"),
    CLAUDE_CREATURE_MAX_WALL_SECONDS: "30",
    // The checks run the CLI as whoever runs them; privilege dropping has its own
    // check and would otherwise hide the run behind file permissions.
    CLAUDE_CREATURE_USER: "",
    ...envOverrides,
  });
  const gateway = await new FakeGateway().listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  // Imported lazily so each serve picks up the env above.
  const { serveOnce } = await import("../runtime.mjs");
  try {
    const d = delivery ?? proxyDelivery({ tools: catalogTools });
    const decoded = decodeTaskSignal(d.key, d.data);
    const result = await serveOnce(bridge, decoded);
    return {
      result,
      signals: gateway.signals(),
      invocation: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf-8")) : null,
      workspaceRoot,
    };
  } finally {
    bridge.close();
    await gateway.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

await check("a served prompt streams its trajectory and replies exactly once", async () => {
  const { result, signals, invocation } = await serveWithFakeCli({ scenario: successScenario("The deploy is green.") });

  const steps = signals.filter((s) => s.packet.kind === "davinci/step");
  const finals = signals.filter((s) => s.packet.kind === "davinci/result");

  assert.equal(finals.length, 1, "exactly one terminal result");
  assert.equal(finals[0].userId, "8@global", "the terminal result goes back through the proxy (replyTo)");
  assert.equal(finals[0].packet.final, true);
  assert.equal(finals[0].packet.stream, false);
  assert.equal(finals[0].packet.correlationId, "corr-1");

  assert.ok(steps.length >= 6, `expected the whole trajectory to stream, saw ${steps.length}`);
  assert.ok(
    steps.every((s) => s.userId === "9@global"),
    "steps go straight to the prompting user's creature (streamTo), so the proxy correlation carries only the result",
  );
  assert.ok(steps.every((s) => s.packet.stream === true && s.packet.final === false));
  assert.deepEqual(steps.map((s) => s.packet.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(steps.map((s) => s.packet.channel), ["status", "thought", "plan", "observation", "action", "observation", "final"]);
  assert.equal(steps[1].packet.event.message, "They want the deploy status.");

  // The reply the backend bills and the client renders.
  assert.equal(result.success, true);
  assert.equal(result.answer, "The deploy is green.");
  assert.equal(result.usage.promptTokens, 1010);
  assert.equal(result.usage.completionTokens, 40);
  assert.equal(result.durationMs, 1234);
  assert.equal(result.model, "claude-opus-5");
  assert.equal(result.engine, "claude-code");
  assert.equal(Array.isArray(result.plan), false, "plan must not be an array — an array is the backend's employ-plan signal");
  assert.deepEqual(result.plan.progress, { done: 0, total: 2 });
  assert.equal("result" in result, false, "a `result` key would be mistaken for the answer by the backend");
  assert.deepEqual(finals[0].packet.result, result);

  // What the CLI was actually asked to do.
  assert.ok(invocation, "the CLI should have been invoked");
  assert.ok(invocation.argv.includes("--print"));
  assert.ok(invocation.argv.includes("stream-json"));
  assert.ok(invocation.argv.includes("--verbose"));
  assert.match(invocation.appendSystemPrompt, /Tina, the release manager/);
  assert.match(invocation.prompt, /CURRENT MESSAGE TO ANSWER/);
  assert.equal(invocation.env.CLAUDE_CODE_ENTRYPOINT, "caspar-creature");
  assert.equal(invocation.mcpConfig, undefined, "no MCP server is wired when the space has no creatures");
});

await check("a space's creatures are wired into the run as an MCP server", async () => {
  const { invocation } = await serveWithFakeCli({
    scenario: successScenario(),
    catalogTools: [{ name: "project sandbox", tool_id: "31@global", program_id: "31@global", entity_id: "vercel_sandbox", arg_schema: { command: { type: "string" } }, required: ["command"], function: "exec", defaults: { space_id: "space-1" } }],
  });
  assert.ok(invocation.mcpConfig, "the catalog should produce an --mcp-config");
  const config = JSON.parse(invocation.mcpConfig);
  assert.equal(config.mcpServers.caspar.type, "stdio");
  assert.match(config.mcpServers.caspar.args[0], /mcpStdioServer\.mjs$/);
  assert.ok(config.mcpServers.caspar.env.CASPAR_TOOL_SOCKET);
  assert.ok(invocation.argv.includes("--strict-mcp-config"));
});

await check("tools added to a space appear on the next prompt (dynamic catalog)", async () => {
  // The backend sends config.tools fresh with EVERY prompt (DiscoveryService
  // rebuilds it from the space's current programs), and the runtime rebuilds its
  // MCP tool server per prompt from that catalog. So a tool attached to a space
  // later is available on the very next prompt — no redeploy, no per-agent wiring.
  // Prove it by listing tools over the REAL MCP server for two successive catalogs.
  const listToolsFor = async (catalog) => {
    const { tools } = buildToolDefinitions(catalog);
    const socketPath = path.join(tempDir("caspar-dyn-"), "tools.sock");
    const server = await new ToolSocketServer(socketPath, { list: () => tools, call: async () => ({ ok: true }) }).start();
    const child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, CASPAR_TOOL_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map();
    let buffer = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        const w = responses.get(m.id);
        if (w) {
          responses.delete(m.id);
          w(m);
        }
      }
    });
    const rpc = (id, method, params) =>
      new Promise((resolve) => {
        responses.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    try {
      await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } });
      const listed = await rpc(2, "tools/list", {});
      return listed.result.tools.map((t) => t.name).sort();
    } finally {
      child.kill();
      await server.stop();
    }
  };

  const webSearch = { name: "web search", tool_id: "40@global", program_id: "40@global", entity_id: "web_search", arg_schema: { query: { type: "string" } }, required: ["query"] };
  const sandbox = { name: "project sandbox", tool_id: "31@global", program_id: "31@global", entity_id: "vercel_sandbox", arg_schema: { command: { type: "string" } }, required: ["command"], function: "exec", defaults: { space_id: "space-1" } };

  const before = await listToolsFor([webSearch]);
  const after = await listToolsFor([webSearch, sandbox]);
  assert.deepEqual(before, ["web_search"], "the first prompt sees only the tool the space had then");
  assert.deepEqual(after, ["project_sandbox", "web_search"], "a tool added to the space appears on the next prompt");
});

await check("a failed run still answers, with the reason", async () => {
  const { result, signals } = await serveWithFakeCli({
    scenario: {
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m", tools: [], mcp_servers: [] },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: ["the model refused"], duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 0 }, modelUsage: {}, permission_denials: [], session_id: "s" },
      ],
    },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /error_during_execution/);
  assert.match(result.answer, /could not complete this request/);
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1, "a failure is still a reply");
});

await check("a CLI that produces no result still answers", async () => {
  const { result, signals } = await serveWithFakeCli({ scenario: { messages: [], exitCode: 3 } });
  assert.equal(result.success, false);
  assert.match(result.error, /no result/);
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1);
});

await check("a clean exit whose terminal result line never arrives recovers the assistant's answer", async () => {
  // The CLI exits 0 having spoken, but no `type:"result"` line reaches the bridge
  // (the exact shape of the 'produced no result (exit code 0)' failure). Because
  // the run actually answered, the reply is that answer — not a failure.
  const { result, signals } = await serveWithFakeCli({
    scenario: {
      exitCode: 0,
      messages: [
        { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5", tools: [], mcp_servers: [] },
        { type: "assistant", message: { content: [{ type: "text", text: "Hi! How can I help you today?" }] }, session_id: "sess-1" },
      ],
    },
  });
  assert.equal(result.success, true, "a run that spoke but lost its result line is not a failure");
  assert.equal(result.answer, "Hi! How can I help you today?");
  assert.ok(Array.isArray(result.warnings) && result.warnings.some((w) => /terminal result line/.test(w)), "the recovery is surfaced as a warning");
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1);
});

await check("a result line emitted without a trailing newline is still parsed (flush on close)", async () => {
  // The terminal `result` arrives unterminated (process truncated at exit). The
  // bridge must flush its buffer on close and read it, not drop the whole run.
  const { result } = await serveWithFakeCli({ scenario: { ...successScenario("The deploy is green."), noFinalNewline: true } });
  assert.equal(result.success, true, "the unterminated result line must still be captured");
  assert.equal(result.answer, "The deploy is green.");
});

await check("a run that never finishes is ended by its wall-clock budget", async () => {
  const { result, signals } = await serveWithFakeCli({ scenario: { hang: true }, envOverrides: { CLAUDE_CREATURE_MAX_WALL_SECONDS: "2" } });
  assert.equal(result.success, false);
  assert.equal(result.budget.timed_out, true);
  assert.match(result.error, /wall-clock budget/);
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1);
});

await check("with no streamTo, steps ride the proxy as non-terminal chunks", async () => {
  const { signals } = await serveWithFakeCli({
    scenario: successScenario(),
    delivery: proxyDelivery({ streamTo: "" }),
  });
  const steps = signals.filter((s) => s.packet.kind === "davinci/step");
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s.userId === "8@global"), "steps fall back to the proxy reply path");
  assert.ok(steps.every((s) => s.packet.stream === true && s.packet.final === false), "the node keeps the correlation open only for chunks marked non-terminal");
});

for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch {
    /* best effort */
  }
}

console.log(`\n${failures.length ? RED : GREEN}${passed} passed, ${failures.length} failed${NC}`);
process.exit(failures.length ? 1 : 0);
