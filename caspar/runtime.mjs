#!/usr/bin/env node
/**
 * Caspar docker-creature entrypoint for Claude Code.
 *
 * Deployed as a Caspar `docker` creature and started with `/programs/runEntity`,
 * this process is a **persistent agent server**: it connects to the node's
 * docker-host bridge gateway, announces itself, and then answers every prompt
 * signal that arrives, one at a time, for as long as the VM lives.
 *
 *   Decillion (Nest)  ──signal──▶  agent proxy entity  ──relay──▶  THIS creature
 *          ▲                                                          │
 *          └────── davinci/step … davinci/result ─────────────────────┘
 *
 * The wire contract is exactly the one the davinci agent creature speaks, so this
 * is a drop-in backbone for Decillion agents — no change to Caspar, none to the
 * backend, none to the app:
 *
 *   in   `creatures/signal` → `{prompt|objective, skill, history, self, roster,
 *        groupChat, sessionId, streamTo, correlationId, replyTo,
 *        config:{tools, llm, max_wall_seconds}}`
 *   out  `{kind:"davinci/step",   correlationId, seq, channel, event, stream:true,  final:false}` (per step)
 *   out  `{kind:"davinci/result", correlationId, result, stream:false, final:true}`  (terminal)
 *
 * Steps go to the prompting user's own creature (`streamTo`) when the backend
 * names one — the node fans that push out to all of the user's live sockets, so
 * the client receives the trajectory directly, and the proxy correlation carries
 * exactly one message (the terminal result). With no `streamTo`, steps ride the
 * proxy as non-terminal chunks (`stream: true`), which the node relays and whose
 * correlation it keeps open.
 *
 * Greppable stdout sentinels (captured as VM logs, `/machines/readVmLogs`):
 *   CLAUDE_BOOT / CLAUDE_BRIDGE / CLAUDE_READY / CLAUDE_IDLE
 *   DAVINCI_TRACE  {...}   one per trajectory event  (name kept: the deploy harness greps it)
 *   DAVINCI_RESULT {...}   the final run result      (name kept: same reason)
 */

import fs from "node:fs";
import path from "node:path";

import { bridgeFromEnv } from "./bridge.mjs";
import { materializeAttachments } from "./attachments.mjs";
import { buildToolDefinitions } from "./catalog.mjs";
import { runClaude, runTempDir } from "./claudeRunner.mjs";
import { TrajectoryMapper } from "./events.mjs";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.mjs";
import { buildResult } from "./result.mjs";
import { decodeTaskSignal, sessionSlug, taskObjective, threadSessionId } from "./taskSignal.mjs";
import { ToolInvoker } from "./toolInvoker.mjs";
import { ToolSocketServer } from "./toolSocket.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VERSION = "1.0.0";
/** The MCP server name the space's creatures are exposed under. */
const MCP_SERVER_NAME = "caspar";

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function log(sentinel, payload) {
  process.stdout.write(`${sentinel} ${JSON.stringify(payload)}\n`);
}

/**
 * Where a session's files live. Preferably under the VM's persistent `/data`
 * mount, so a thread's workspace survives a container restart the way a project
 * machine should.
 */
function workspaceRoot() {
  const configured = (process.env.CLAUDE_CREATURE_WORKSPACE_ROOT || "").trim();
  const candidates = [configured, "/data/workspaces", "/app/workspaces"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  const fallback = path.join(process.cwd(), "workspaces");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** The prompt's tool catalog, from `config.tools` (the space's creatures). */
function catalogFromTask(task) {
  const config = task?.config && typeof task.config === "object" ? task.config : {};
  const tools = Array.isArray(config.tools) ? config.tools : [];
  return { config, tools };
}

/**
 * Answer one prompt.
 *
 * Returns the result object that is signalled back. Never throws: a failed run is
 * still a reply, and a creature that dies on a bad prompt stops serving the
 * space.
 */
async function handleTask(bridge, { task, replyTo, correlationId, streamTo }) {
  const started = Date.now();
  const objective = taskObjective(task);
  const sessionId = threadSessionId(task, bridge ? `claude-${bridge.sessionId ?? "vm"}` : "claude-offline");
  const { config, tools } = catalogFromTask(task);
  const workspace = path.join(workspaceRoot(), sessionSlug(sessionId));
  fs.mkdirSync(workspace, { recursive: true });

  const attachments = materializeAttachments(task, workspace);
  if (attachments.length) log("CLAUDE_ATTACHMENTS", { count: attachments.length, items: attachments });

  const mapper = new TrajectoryMapper({ traceAll: envFlag("CLAUDE_CREATURE_TRACE_ALL", false) });
  // Steps ride the channel the backend named; the terminal result always goes
  // back through `replyTo` (the proxy), which is what closes the correlation.
  const stepTarget = streamTo || replyTo;
  const streamSteps = Boolean(bridge && stepTarget && envFlag("CLAUDE_CREATURE_STREAM_STEPS", true));

  const emit = (event) => {
    process.stdout.write(`DAVINCI_TRACE ${JSON.stringify(event)}\n`);
    if (!streamSteps) return;
    // Best-effort: a step that cannot be delivered must never break the run —
    // the authoritative result is still signalled at the end.
    bridge
      .signalUser("creatures/signal", String(stepTarget), {
        kind: "davinci/step",
        stream: true,
        final: false,
        correlationId,
        seq: event.seq,
        channel: event.channel,
        event,
      })
      .catch(() => {});
  };

  // The space's creatures, exposed to Claude Code as MCP tools. Nothing is wired
  // when the space has none: an agent handed tools that do not exist will promise
  // capabilities it cannot deliver.
  const { tools: toolDefs, byName } = buildToolDefinitions(tools);
  let invoker = null;
  let socketServer = null;
  let mcpConfig;
  const tempDir = runTempDir();
  if (bridge && toolDefs.length) {
    invoker = new ToolInvoker(bridge, byName, bridge.machineId || bridge.programId || "");
    const socketPath = path.join(tempDir, "tools.sock");
    socketServer = new ToolSocketServer(socketPath, {
      list: () => toolDefs,
      call: (name, args) => invoker.invoke(name, args),
    });
    try {
      await socketServer.start();
      mcpConfig = {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "stdio",
            command: process.execPath,
            args: [path.join(HERE, "mcpStdioServer.mjs")],
            env: { CASPAR_TOOL_SOCKET: socketPath },
          },
        },
      };
    } catch (err) {
      log("CLAUDE_BOOT", { tool_bridge_error: String(err?.message || err) });
      socketServer = null;
    }
  }

  const systemPrompt = buildSystemPrompt(task);
  const prompt = buildUserPrompt(task, { objective, attachments, workspace });
  const maxWallSeconds = Number(config.max_wall_seconds || process.env.CLAUDE_CREATURE_MAX_WALL_SECONDS || 900);

  log("CLAUDE_BOOT", {
    session: sessionId,
    workspace,
    objective_chars: objective.length,
    history_turns: Array.isArray(task.history) ? task.history.length : 0,
    tools: toolDefs.map((t) => t.name),
    skill: Boolean(task.skill),
    group_chat: Boolean(task.groupChat || task.group_chat),
    roster: Array.isArray(task.roster) ? task.roster.length : 0,
    llm: config.llm ? { provider: config.llm.provider, models: config.llm.models } : undefined,
    stream_to: stepTarget || undefined,
    correlationId: correlationId || undefined,
    max_wall_seconds: maxWallSeconds,
  });

  let run;
  try {
    run = await runClaude({
      prompt,
      systemPrompt,
      cwd: workspace,
      mcpConfig,
      llm: config.llm,
      model: config.model || process.env.CLAUDE_CREATURE_MODEL,
      // The space's creatures are pre-approved: they were attached to this space
      // by the platform, and there is no human here to approve a prompt. Without
      // this an employment is refused outright whenever the permission mode is
      // anything but `bypassPermissions`.
      allowedTools: mcpConfig ? [`mcp__${MCP_SERVER_NAME}`, ...toolDefs.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`)] : undefined,
      maxWallSeconds,
      onMessage: (message) => {
        for (const event of mapper.map(message)) emit(event);
      },
    });
  } catch (err) {
    run = { result: null, messages: [], exitCode: null, timedOut: false, stderr: String(err?.message || err), warnings: [] };
  } finally {
    if (socketServer) await socketServer.stop();
    if (invoker) invoker.dispose();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const initMessage = run.messages.find((m) => m?.type === "system" && m.subtype === "init");
  const messageTypes = run.messages.map((m) => (m?.subtype ? `${m.type}/${m.subtype}` : m?.type)).filter(Boolean);
  // Which backbone actually served this run, and whether it authenticated with the
  // agent's own key or the image's. Never the credential itself.
  if (run.backbone) log("CLAUDE_BACKBONE", { ...run.backbone, model: initMessage?.model, apiKeySource: initMessage?.apiKeySource });
  // A clean exit that produced no terminal result is the hardest failure to see
  // from the reply alone — log everything the CLI left behind so the cause (a
  // credential/model reject that printed to stdout, an early exit before the
  // turn) is greppable in the VM logs, not just inferable.
  if (!run.result && !run.timedOut) {
    log("CLAUDE_NORESULT", { exitCode: run.exitCode, messageTypes, stdoutTail: (run.stdoutTail || "").slice(-800), backbone: run.backbone });
  }
  const result = buildResult(objective, run.result, mapper, {
    durationMs: Date.now() - started,
    timedOut: run.timedOut,
    exitCode: run.exitCode,
    stderr: run.stderr,
    stdoutTail: run.stdoutTail,
    messageTypes,
    sessionId: initMessage?.session_id,
    initMessage,
    warnings: run.warnings,
  });
  if (run.stderr?.trim()) log("CLAUDE_STDERR", { tail: run.stderr.trim().split("\n").slice(-6) });
  process.stdout.write(`DAVINCI_RESULT ${JSON.stringify(result)}\n`);
  return result;
}

/**
 * Answer one delivery and signal the terminal result back through `replyTo` (the
 * proxy entity), which is what closes the correlation the requester is waiting
 * on. A run that throws still produces a reply — silence would leave the user's
 * client spinning until the backend's timeout.
 */
export async function serveOnce(bridge, delivery) {
  let result;
  try {
    result = await handleTask(bridge, delivery);
  } catch (err) {
    log("CLAUDE_BOOT", { run_error: String(err?.stack || err).slice(0, 400) });
    result = {
      objective: taskObjective(delivery.task || {}),
      engine: "claude-code",
      success: false,
      answer: "I could not complete this request.",
      error: String(err?.message || err).slice(0, 400),
    };
    process.stdout.write(`DAVINCI_RESULT ${JSON.stringify(result)}\n`);
  }
  if (bridge && delivery.replyTo) {
    try {
      await bridge.signalUser("creatures/signal", String(delivery.replyTo), {
        kind: "davinci/result",
        correlationId: delivery.correlationId,
        // Terminal message: closes the proxy correlation the streamed steps
        // (when routed through the proxy) kept open.
        final: true,
        stream: false,
        result,
      });
    } catch (err) {
      log("CLAUDE_BOOT", { reply_error: String(err?.message || err).slice(0, 200) });
    }
  }
  return result;
}

/**
 * The queue of prompts waiting to be served.
 *
 * One creature program serves EVERY agent in the platform, so two prompts can
 * arrive close together (two agents in one space, or two users). A listener that is
 * only registered while idle would drop the second one — and a dropped prompt is a
 * client that spins until the backend's timeout. So prompts are captured the moment
 * they arrive and served in order.
 */
export function createDeliveryQueue(bridge, idleWaitMs, onQueued) {
  const queue = [];
  let notify = null;
  const unsubscribe = bridge.onSignal((key, data) => {
    const delivery = decodeTaskSignal(key, data);
    if (!delivery) return;
    queue.push(delivery);
    if (onQueued) onQueued(queue.length, delivery);
    if (notify) notify();
  });

  return {
    get depth() {
      return queue.length;
    },
    /** The next prompt, or `null` after `idleWaitMs` with nothing to serve. */
    next() {
      return new Promise((resolve) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => {
          notify = null;
          resolve(queue.length ? queue.shift() : null);
        }, idleWaitMs);
        notify = () => {
          clearTimeout(timer);
          notify = null;
          resolve(queue.shift());
        };
      });
    },
    dispose() {
      unsubscribe();
      queue.length = 0;
    },
  };
}

/** Offline self-test: read the task from the input dir instead of the gateway. */
function readOfflineTask() {
  const inputDir = process.env.CLAUDE_CREATURE_INPUT_DIR || process.env.DAVINCI_INPUT_DIR || "/app/input";
  const envTask = (process.env.CLAUDE_CREATURE_TASK || process.env.DAVINCI_TASK || "").trim();
  if (envTask) return { objective: envTask, source: "env" };
  const taskFile = path.join(inputDir, "task.json");
  if (fs.existsSync(taskFile)) {
    try {
      const task = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      const configFile = path.join(inputDir, "config.json");
      if (!task.config && fs.existsSync(configFile)) task.config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      return task;
    } catch (err) {
      log("CLAUDE_BOOT", { task_read_error: String(err?.message || err) });
    }
  }
  return { objective: "Introduce yourself and report what you can do.", source: "default" };
}

export async function main() {
  let bridge = null;
  try {
    bridge = await bridgeFromEnv({ timeoutMs: Number(process.env.CLAUDE_CREATURE_CALL_TIMEOUT_MS || 60000) });
  } catch (err) {
    log("CLAUDE_BOOT", { bridge_init_error: String(err?.message || err) });
  }

  if (!bridge) {
    // No gateway: this is a local run (self-test / development). Answer one task
    // from the input dir and exit with its status.
    log("CLAUDE_BOOT", { version: VERSION, mode: "offline", node: process.version });
    const task = readOfflineTask();
    const result = await handleTask(null, { task, replyTo: "", correlationId: "", streamTo: "" });
    return result.success ? 0 : 2;
  }

  log("CLAUDE_BRIDGE", {
    connected: true,
    version: VERSION,
    session: bridge.sessionId,
    vm_id: bridge.vmId || process.env.CASPAR_VM_ID || "",
    machine_id: bridge.machineId,
    program_id: bridge.programId,
    creature_id: bridge.creatureId,
  });

  const serveForever = envFlag("CLAUDE_CREATURE_SERVE_FOREVER", true);
  const idleWaitMs = Number(process.env.CLAUDE_CREATURE_TASK_WAIT || 600) * 1000;
  let served = 0;

  const deliveries = createDeliveryQueue(bridge, idleWaitMs, (depth, delivery) => {
    if (depth > 1) log("CLAUDE_QUEUED", { depth, correlationId: delivery.correlationId });
  });

  try {
    for (;;) {
      log("CLAUDE_READY", { machine_id: bridge.machineId, program_id: bridge.programId, served, queued: deliveries.depth, ts: Date.now() / 1000 });
      const delivery = await deliveries.next();
      if (!delivery) {
        if (serveForever) {
          log("CLAUDE_IDLE", { served, waited_s: idleWaitMs / 1000 });
          continue; // immortal: keep waiting for the next prompt
        }
        process.stdout.write(`DAVINCI_RESULT ${JSON.stringify({ success: false, error: "no task signal received within the wait window" })}\n`);
        return 2;
      }

      // One bad prompt must never kill the server: `serveOnce` always replies.
      const result = await serveOnce(bridge, delivery);
      served += 1;
      if (!serveForever) return result.success ? 0 : 2;
    }
  } finally {
    deliveries.dispose();
    try {
      bridge.close();
    } catch {
      /* already closed */
    }
  }
}

// `import.meta.main` is Bun/Node ≥20.11; the argv check keeps older runtimes working.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      log("CLAUDE_BOOT", { fatal: String(err?.stack || err).slice(0, 600) });
      process.exit(1);
    });
}

export { handleTask };
