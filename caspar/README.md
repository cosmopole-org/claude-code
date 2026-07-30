# Claude Code as a Caspar creature

This directory turns Claude Code into a **Caspar `docker` creature program entity**
— an autonomous agent the [Decillion](https://github.com/DecillionAI/decillionai-server)
platform can prompt over Caspar's signaling API. It speaks the exact wire contract
the davinci agent creature speaks, so it is a drop-in replacement for Decillion's
agent backbone:

* **no change to Caspar** — the node's docker-host bridge gateway, proxy entities
  and signal envelopes are used as they are;
* **no change to Decillion** — the backend still signals an agent proxy, still
  receives `davinci/step` / `davinci/result`, still bills the same `usage`.

The agent is **this repository's own Claude Code source**, compiled inside the
creature image — not the published npm package.

---

## How a prompt flows

```
Expo app ──▶ Nest /api/agents/:id/prompt
                │  signal (pvp)
                ▼
        agent proxy entity  ──relays, attaching the agent's skill──▶  THIS creature
                ▲                                                        │
                │  davinci/result (terminal, closes the correlation)     │
                └────────────────────────────────────────────────────────┘
                   davinci/step … (streamed to the prompting user)

   inside the creature:   runtime.mjs ──▶ claude --print --output-format stream-json
                                │                     │
                                │        the space's creatures, as MCP tools
                                ▼                     ▼
                          bridge.mjs  ──signalUser──▶ tool creature (sandbox, …)
```

A creature container has **one** channel to the outside world: a TCP connection to
the node's docker-host bridge gateway. Everything — receiving prompts, streaming
progress, employing sibling creatures — rides that connection.

### The contract

| Direction | Key | Packet |
|---|---|---|
| in | `creatures/signal` | `{prompt\|objective, skill, history, self, roster, groupChat, sessionId, spaceId, streamTo, correlationId, replyTo, attachments, config:{tools, llm, max_wall_seconds}}` |
| out (per step) | `creatures/signal` | `{kind:"davinci/step", correlationId, seq, channel, event, stream:true, final:false}` |
| out (terminal) | `creatures/signal` | `{kind:"davinci/result", correlationId, result, stream:false, final:true}` |
| out (tool call) | `creatures/signal` | `{kind:"invoke", entityId, correlationId, reply_to, tool_id, function, payload}` |
| in (tool reply) | `creatures/signal` | `{kind:"tools/result", correlationId, result}` |

`channel` is one of `status · plan · thought · action · observation · final · trace`
— what the Expo client renders as the live trajectory. The `result` carries
`answer`, `usage.promptTokens` / `usage.completionTokens` (what the platform bills),
`durationMs`, and a non-array `plan`.

Steps go to `streamTo` (the prompting user's own creature) when the backend names
one, so the proxy correlation carries exactly one message — the terminal result.
With no `streamTo` they ride the proxy as non-terminal chunks (`stream: true`),
which the node relays while keeping the correlation open.

---

## Files

| File | Role |
|---|---|
| `runtime.mjs` | The entrypoint. Connects to the gateway, then serves every prompt signal for as long as the VM lives. Also runs one task from `/app/input` when there is no gateway (offline self-test). |
| `bridge.mjs` | The docker-host bridge gateway client: chunked framing, HELLO/WELCOME, host calls (`signalUser`, `dbOp`, `httpRequest`), pushed signals. |
| `taskSignal.mjs` | Peels the StoresSend / `payload` / proxy envelopes into a task; derives the conversation thread key. |
| `prompt.mjs` | Composes what Claude Code is given: the agent's skill as persona, the group-chat preamble and roster, the thread's history with `[From → To]` annotations. |
| `catalog.mjs` | Turns the space's `config.tools` into MCP tool definitions; applies the platform's pinned `defaults` after the model's arguments. |
| `toolInvoker.mjs` | Employs a tool creature over the gateway and awaits its correlated `tools/result`. |
| `toolSocket.mjs` / `mcpStdioServer.mjs` | The `caspar` MCP server Claude Code talks to, and its unix-socket link back to this process (which owns the single gateway connection). |
| `claudeRunner.mjs` | Runs the CLI headless: flags, per-agent LLM override, privilege drop, wall-clock kill. |
| `events.mjs` | Maps `stream-json` messages onto the platform's step channels; masks credentials. |
| `result.mjs` | Builds the terminal reply (answer, billable usage, plan, budget). |
| `attachments.mjs` | Materialises prompt attachments into the session workspace. |
| `build/` | Compiles the CLI from `src/` (see below). |
| `Dockerfile` | The creature image. |
| `tests/` | Checks — see *Testing*. |

Session state: each conversation thread (`space:<spaceId>:<agentId>`) gets its own
workspace under `/data/workspaces/…`, on the VM's persistent mount, so a project's
files survive container restarts.

---

## Building the agent from this repo's source

`scripts/build-bundle.ts` (the repo's own build) **fails on this source snapshot**:
~200 modules it imports are not in the tree (ANT-only or unpublished features —
`proactive/`, `daemon/`, `WorkflowTool/`, `contextCollapse/`, bundled skill
markdown, …), plus ~40 dependencies the tree imports without declaring in
`package.json`.

`build/buildCli.mjs` is that same build, made to complete:

* **missing dependencies are installed** (`build/extra-deps.json`,
  `build/installDeps.mjs`) — including ones a headless agent genuinely needs
  (`jsonc-parser`, `env-paths`, `shell-quote`, `turndown`, `https-proxy-agent`, …).
  They are installed *unsaved*: `package.json` is never modified;
* **missing modules become stubs** whose exports are inert where a feature is only
  described (an empty table) and **throw with the module's name** where it is
  actually used, so a missing capability is never silently wrong. Text assets
  (`SKILL.md`) stub to empty content, which every bundled-skill loader tolerates;
* **four unpublished Anthropic packages** (`color-diff-napi`, `audio-capture-napi`,
  `modifiers-napi`, `@anthropic-ai/foundry-sdk`) and `@ant/*` are stubbed by name —
  any *other* missing dependency is still a hard error;
* two source-level gaps are patched at load time (never on disk): a missing
  `isReplBridgeActive` export, and a `-d2e` short flag that the pinned `commander`
  rejects outright;
* the bundle is stamped with a semver-valid version (`2.0.0-caspar` by default) —
  the API refuses to serve a client reporting `0.0.0-leaked`.

Every stub is reported at build time and written to `dist/stubbed-modules.json`.

```bash
npm install                      # or: bun install
node caspar/build/installDeps.mjs
node caspar/build/buildCli.mjs   # → dist/cli.mjs   (--minify for the image build)
node dist/cli.mjs --version      # 2.0.0-caspar (Claude Code)
```

The creature image does exactly this (`build/imageBuild.sh`) and fails the build if
the bundle cannot report its version. `CLAUDE_CODE_CLI_SOURCE=npm` at deploy time
installs the published CLI instead — a fallback, not the default.

---

## Deploying

```bash
# on the Caspar node's host, with the node running
ANTHROPIC_API_KEY=sk-ant-…  python3 scripts/deploy_claude_creature.py
```

It logs in as the deploy operator, gzip-tars this repo's source as the build
context (~9 MB), composes the Dockerfile (host CA bundle + the backbone credentials
baked in, never written to disk), deploys the entity, waits for the node to build
the image, and starts it with `runEntity --forceRestart`. It prints:

```
DAVINCI_PROGRAM_ID=<id>   CLAUDE_PROGRAM_ID=<id>
DAVINCI_ENTITY_ID=davinci CLAUDE_ENTITY_ID=davinci
DAVINCI_VM_ID=<vmId>      CLAUDE_VM_ID=<vmId>
```

Key knobs (all documented in the script's header):

| Env | Meaning |
|---|---|
| `CLAUDE_REUSE_PROGRAM_ID` | Redeploy onto an existing program id — **use this**, so already-deployed agent proxies keep pointing at a valid backbone |
| `CLAUDE_ENTITY_ID` | Entity id, default `davinci` (existing proxies target that entity) |
| `CASPAR_DEPLOY_USER` | Deploy operator, default `davinci_admin` — must own the program being reused |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL` | The backbone, baked into the image |
| `CLAUDE_CODE_CLI_SOURCE` | `source` (default) or `npm` |
| `CLAUDE_VM_RAM_MB` / `_DISK_GB` / `_CPUS` / `_MAX_SECONDS` | VM resources (defaults 2048 MB / 8 GB / 2 cpu / unlimited) |

### Replacing davinci in Decillion, with zero Decillion changes

`decillionai-server/scripts/ci-deploy.sh` deploys the agent backbone by running
`$DAVINCI_DIR/scripts/deploy_davinci_agent.py` and grepping `DAVINCI_PROGRAM_ID`
out of its output. This repo provides that entrypoint (`scripts/deploy_davinci_agent.py`,
a thin alias), honours the same environment contract
(`DAVINCI_REUSE_PROGRAM_ID`, `DAVINCI_ENTITY_ID`, `DAVINCI_STOP_PROGRAM_ID`,
`CASPAR_NODE_HOST/PORT`, `CASPAR_CA_BUNDLE`) and prints the same markers. So:

```bash
DAVINCI_REPO=https://github.com/cosmopole-org/claude-code \
DAVINCI_DIR=/path/to/claude-code \
bash scripts/ci-deploy.sh
```

The deployer records the program id in `.caspar-deploy.json` under
`davinci.agent`, which is what `CasparService.davinciAgent()` reads and what every
new agent proxy targets. Reusing the recorded program id keeps existing agents
working — a redeploy that minted a new id would strand every deployed proxy.

Runtime knobs (baked at deploy time or set on the entity):

| Env | Default | Meaning |
|---|---|---|
| `CLAUDE_CREATURE_MODEL` | CLI default | Model for every run (a per-agent `config.llm` override wins) |
| `CLAUDE_CREATURE_MAX_WALL_SECONDS` | `900` | Hard ceiling per prompt (a task's `config.max_wall_seconds` wins) |
| `CLAUDE_CREATURE_PERMISSION_MODE` | `bypassPermissions` | Autonomous agent; degrades to `acceptEdits` if it cannot drop root |
| `CLAUDE_CREATURE_TOOL_TIMEOUT` | `240` | Seconds to wait for a tool creature (cold spawns are slow) |
| `CLAUDE_CREATURE_STREAM_STEPS` | `1` | Stream the trajectory |
| `CLAUDE_CREATURE_TRACE_ALL` | `0` | Also emit unmapped CLI events on the `trace` channel |
| `CLAUDE_CREATURE_HISTORY_TURNS` | `30` | Prior turns rendered into the prompt |
| `CLAUDE_CREATURE_BARE` | `0` | `--bare` (skip hooks/plugins/CLAUDE.md discovery — cheaper prompts, but auth is then strictly `ANTHROPIC_API_KEY`) |
| `CLAUDE_CREATURE_SERVE_FOREVER` | `1` | Keep serving prompts instead of exiting after one |
| `CLAUDE_CREATURE_USER` | `claude` | Unprivileged user for the CLI; empty means "do not drop privileges" |

---

## Testing

```bash
node caspar/tests/checks.mjs          # 19 checks, no node/container/LLM needed
node caspar/tests/live-cli.mjs        # against a REAL Claude Code CLI (needs credentials)
node caspar/tests/container-check.mjs # against the built image (needs docker)
```

`checks.mjs` drives the real modules against a fake gateway that speaks the real
wire protocol and a fake CLI that speaks real `stream-json`. It asserts the
invariants the platform depends on: the handshake and chunked framing, prompt
decoding (skill, history, roster, correlation), the skill and history reaching the
CLI, one step per trajectory event on the right channel, exactly one terminal
result through the proxy, billable usage, platform-pinned tool arguments winning
over the model's, that a prompt arriving mid-run is queued rather than dropped, and
that a failed run / a timed-out run / a crashed CLI all still reply.

`container-check.mjs` runs the image the way the node does — gateway env only — and
asserts a proxy-relayed prompt comes back streamed and answered.
