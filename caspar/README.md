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
| `catalog.mjs` | Turns the space's `config.tools` into MCP tool definitions; applies the platform's pinned `defaults` after the model's arguments; `mergeCatalogs` unions the backend catalog with live discovery. |
| `discovery.mjs` | Fetches the space's employable creatures (tools, apps, sub-agents) straight from the node at prompt time — the **program index** (`getJson` on `Json::StoreProgramIndex::<space>`, where tools/agents are attached), supplemented by `readMembers` + `getCreature` — and builds catalog entries, so the agent sees the space's live roster even when `config.tools` is thin. |
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

## Seeing the space: tools, apps, creatures and other agents

On every prompt the agent is given the space's employable creatures — the project
sandbox, published tools and apps, and the **other agents** — as real, callable
MCP tools, and its system prompt enumerates them so it *plans with* them instead
of only answering from its own knowledge or the generic editor/shell built-ins of
the harness it runs on (asked "what tools do you have?", it answers with the
space's tools, not `Read`/`Write`/`Bash`). Sub-agents are offered for delegation:
the agent can hand a sub-task to another agent by calling it with a prose prompt.

When the space has a **shared cloud sandbox** (the per-space machine Decillion
publishes as a `category: "execution"` tool), the prompt names it as the space's
shared filesystem + shell and tells the agent to collaborate THERE — so teammates
see the same files and command output — rather than in its own private, ephemeral
local working directory. Detection is by the published descriptor, not a hardcoded
program id, so any execution-tool the space carries is framed this way.

And it is not just advice: when a sandbox is present the CLI's **own built-in
shell and filesystem tools are turned off** for the run (`--disallowedTools Bash,
Read, Write, Edit, MultiEdit, NotebookEdit, NotebookRead, Glob, Grep, LS`), so the
agent has no way to do throwaway work on its private container — bash and files
*must* go through the shared sandbox, where the team sees them. It degrades safely:
with no sandbox in the space the built-ins stay on (else the agent could run
nothing). Knobs: `CLAUDE_CREATURE_FORCE_SANDBOX_FS=0` disables the enforcement,
`CLAUDE_CREATURE_DISALLOWED_TOOLS` overrides the denied list.

**Which space is authoritative.** The space a run is scoped to is decided by the
**store the signal came from**, not by a client-supplied field. The backend signals
an agent *within* its space store, the node stamps that store onto the signal
envelope (`store.id`) and the proxy relay carries it through untouched, so
`decodeTaskSignal` (`taskSignal.mjs`, `spaceIdFromEnvelope`) reads it and sets the
task's `spaceId` from it — overriding any `spaceId` a caller embedded in the payload.
This is what discovery (`resolveSpaceId`) and the thread/session key scope to, so an
agent can neither be handed the wrong space nor reach another space's creatures by
naming a different id. A signal with no store on its envelope falls back to whatever
the payload provided (and then the `session:<spaceId>:…` shape).

Two sources feed that catalog, unioned by `mergeCatalogs`:

1. **`config.tools`** — the catalog the backend's `DiscoveryService` sends with the
   prompt (a space's member programs paired with their `public.decillion`
   descriptors). It is **authoritative**: it carries the platform-pinned `defaults`
   (e.g. the bound `space_id`) that keep a shared tool working on *this* space.
2. **Live discovery** (`discovery.mjs`) — the creature also fetches the space's
   roster itself, over the gateway, using the node's own host functions. It reads
   the **program index** (`getJson` on `Json::StoreProgramIndex::<space>`) first —
   where a space's tools and sub-agents are actually attached (a platform tool like
   the sandbox is a *program*, never a store member, so a members-only scan missed
   them entirely) — then supplements with `readMembers` + `getCreature`. This
   mirrors `DiscoveryService` but from inside the container, so the agent sees the
   space's live roster even when the backend sends a thin `config.tools`. It is
   **best-effort**: an unresolved space id, a host op the node does not expose, or
   an unexpected shape all yield nothing rather than an error, and a discovered
   entry only *adds* a creature the backend did not send — it never displaces a
   backend entry or its pinned binding.

Knobs (env): `CLAUDE_CREATURE_DISCOVER_TOOLS` (default on), `_DISCOVER_TIMEOUT_MS`
(default 8000), `_DISCOVER_MAX` (default 50 members). `node caspar/tests/discovery-checks.mjs`
drives the fetch, merge and prompt end to end against the real gateway wire.

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

### Pre-building the binaries in CI (the lightweight deploy path)

Compiling `src/` inside the image is the slow part of a deploy. You can do it
**once, in CI**, and then deploy a copy — no compiler, no npm registry on the node:

* **`scripts/package-creature.sh`** runs the build above and packages the result
  into `out/bundle.tar.gz` — `dist/cli.mjs` plus the `caspar/` bridge, laid out so
  it is a ready-to-use Docker build context — alongside the raw `cli.mjs` and a
  `manifest.json` (version, git sha, sizes).
* **`.github/workflows/build-claude-binaries.yml`** does this on every push (and on
  `v*` tags / manual dispatch) and publishes the bundle three ways: a workflow
  **artifact**, a **GitHub Release** (on a tag), and a **prebuilt image** pushed to
  `ghcr.io/<owner>/claude-code-creature`.
* **`caspar/Dockerfile.prebuilt`** is the lightweight image: it `ADD`s the prebuilt
  `bundle.tar.gz` and runs it — the whole build is a copy plus a `--version`
  smoke-test, no `bun install`, no esbuild.
* **`CLAUDE_CODE_CLI_SOURCE=prebuilt`** wires this into the normal deployer (below):
  it ships only `dist/cli.mjs` + `caspar/` and builds `Dockerfile.prebuilt`, so the
  node-side build recompiles nothing. Build (or download) the bundle into `dist/`
  first — the deployer refuses prebuilt mode without it.

So the two deploy shapes are: **pull the GHCR image** and run it as the creature,
or **`CLAUDE_CODE_CLI_SOURCE=prebuilt python3 scripts/deploy_claude_creature.py`**
after dropping the CI-built `dist/cli.mjs` in place.

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
| `CASPAR_DEPLOY_IDENTITY_FILE` | Where the durable deploy-operator identity is persisted (default: next to `CASPAR_MANIFEST`). The backbone **and** every tool authenticate as this one account (`caspar_deploy_common.resolve_operator`), so a redeploy always owns the program being reused and never mints a new one. |
| `CASPAR_OPERATOR_ID` + `CASPAR_OPERATOR_PRIVATE_KEY` | Inject the operator identity explicitly (highest precedence) — lets the Nest deployer and these scripts share one account verbatim |
| `CASPAR_DEPLOY_USER` | Username used for the **first** login only, when no identity is persisted yet (default `davinci_admin`); after that the persisted identity is reused |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL` | The backbone, baked into the image |
| `CLAUDE_CODE_CLI_SOURCE` | `source` (default, compile `src/`), `prebuilt` (copy a CI-built `dist/cli.mjs`, no compile), or `npm` |
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

## LLM providers (per agent)

Decillion stores an optional `{provider, model, apiKey}` per agent and sends it as
`config.llm` with every prompt — the same block davinci consumed. Every part is
honoured:

| Provider (`llm_provider`) | How it's served | `llm_model` example |
|---|---|---|
| `anthropic` (or unset) | The Anthropic API directly | `claude-opus-5` |
| `openai` | Built-in Anthropic↔OpenAI **translation proxy** | `gpt-4o` |
| `gemini` (`google`) | Translation proxy (Gemini's OpenAI-compatible endpoint) | `gemini-2.5-pro` |
| `xai` (`grok`) | Translation proxy | `grok-2-latest` |
| `openrouter` | Translation proxy | `anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, … |
| `bedrock` / `vertex` | 3P backbone (the image's cloud creds) | provider model id |

Claude Code speaks the **Anthropic Messages API**, so `anthropic` is native. The
four OpenAI-compatible providers are served through a tiny proxy the creature
starts on localhost for the run (`caspar/llm/`): the CLI talks Anthropic to the
proxy, the proxy translates each request — tools, tool results, images, streaming
SSE — to OpenAI Chat Completions, calls the provider **with the agent's own key**,
and translates the answer back. So an agent works on any of these from just
`provider` + `model` + `api_key`, with nothing for the operator to configure.

- **The agent's key takes over the run.** When `config.llm` carries an `api_key`,
  every credential the image baked in is removed for that run — the agent's
  provider is billed, never the platform's. The real key lives only in the proxy
  process; the CLI is given a placeholder Anthropic key.
- **The agent's key never leaves the creature.** It goes only to the provider the
  agent named (agents cannot set the provider host beyond an optional `base_url`).
- **Base URL overrides.** An agent may set `llm.base_url` (e.g. an Azure/OpenAI
  gateway); an operator may repoint a provider with `CLAUDE_CREATURE_LLM_BASE_<PROVIDER>`.
- **Unknown provider.** With no `api_key` (nothing to auth with) or an unrecognised
  provider and no gateway, the run falls back to the image's default backbone and
  says so in the reply's `warnings` — never a silent wrong answer.
- **Usage/billing.** `completion_tokens` from the provider is exact;
  `prompt_tokens` for a streamed run is a proxy estimate (providers report input
  tokens only at the end of a stream), so Decillion's per-prompt billing stays
  close.

`node caspar/tests/llm-checks.mjs` checks the translator + proxy end-to-end against
a fake OpenAI server; `node caspar/tests/live-provider.mjs` runs the **real** CLI
through the proxy on a fake provider, proving an agentic tool-using turn completes
on a non-Anthropic backbone.

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
