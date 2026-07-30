#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI, for the checks.
 *
 * It behaves like `claude --print --output-format stream-json`: it reads the
 * prompt from stdin, then writes a scripted sequence of stream-json messages.
 * The scenario file (`CLAUDE_FAKE_SCENARIO`) decides what it emits, so a check
 * can drive a normal run, an error result, a hang (to exercise the wall-clock
 * kill) or a run that actually calls the `caspar` MCP server.
 *
 * The invocation itself is recorded to `CLAUDE_FAKE_RECORD` (argv, cwd, prompt,
 * selected env), which is how the checks assert that the platform's per-prompt
 * inputs — the skill, the model override, the MCP config — reach the CLI.
 */

import fs from "node:fs";

const scenarioPath = process.env.CLAUDE_FAKE_SCENARIO || "";
const recordPath = process.env.CLAUDE_FAKE_RECORD || "";
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, "utf-8")) : { messages: [] };

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const prompt = await readStdin();

if (recordPath) {
  fs.writeFileSync(
    recordPath,
    JSON.stringify(
      {
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        prompt,
        appendSystemPrompt: arg("--append-system-prompt"),
        mcpConfig: arg("--mcp-config"),
        model: arg("--model"),
        permissionMode: arg("--permission-mode"),
        uid: typeof process.getuid === "function" ? process.getuid() : null,
        env: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
          CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
          CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
        },
      },
      null,
      2,
    ),
  );
}

// A run that never finishes: the runtime's wall-clock ceiling must end it.
if (scenario.hang) {
  emit({ type: "system", subtype: "init", session_id: "fake-session", model: "fake-model", tools: [], mcp_servers: [] });
  // A timer (not a never-settling promise) keeps the event loop alive, so this
  // process really does hang until the runtime kills it.
  setInterval(() => {}, 1000);
  await new Promise((resolve) => setTimeout(resolve, 3_600_000));
}

// A CLI that prints a non-JSON line to stdout (a banner, a version/update notice,
// an early error) before/without any stream-json — the runner keeps it as
// `stdoutTail`, and a "no result" reply must surface it.
if (typeof scenario.stdoutNoise === "string" && scenario.stdoutNoise) {
  process.stdout.write(`${scenario.stdoutNoise}\n`);
}

const messages = scenario.messages || [];
for (let i = 0; i < messages.length; i++) {
  const message = messages[i];
  if (message.__sleepMs) {
    await new Promise((resolve) => setTimeout(resolve, message.__sleepMs));
    continue;
  }
  // `noFinalNewline` drops the trailing newline on the LAST message, mimicking a
  // CLI whose terminal `result` line is truncated at exit — the bridge must still
  // parse it (flush-on-close) instead of losing the run's answer.
  if (scenario.noFinalNewline && i === messages.length - 1) {
    process.stdout.write(JSON.stringify(message));
  } else {
    emit(message);
  }
}

process.exit(scenario.exitCode ?? 0);
