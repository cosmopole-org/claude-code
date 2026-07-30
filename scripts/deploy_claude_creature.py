#!/usr/bin/env python3
"""Deploy Claude Code onto a running Caspar node as a `docker` creature entity.

The creature is the signaling bridge in `caspar/` plus the Claude Code CLI: the
node builds the image, starts one long-lived container, and the container serves
every prompt the Decillion backend signals it (see `caspar/README.md`).

What this script does, in order:

  1. log in to the node as the deploy operator (the SAME account that owns the
     program being reused — a program can only be redeployed by its owner);
  2. gzip-tar this repo's source (`src/`, `caspar/`, the manifests) as the docker
     build context — the agent is COMPILED FROM THIS SOURCE inside the image;
  3. compose the Dockerfile: `caspar/Dockerfile` + the host CA bundle + the
     baked env (the Anthropic credentials, never written to disk here) + a
     context-digest LABEL;
  4. deploy the entity — onto an EXISTING program id when one is given, so
     already-deployed agent proxies keep pointing at a valid backbone;
  5. wait for the node to finish building the image (by watching for the digest
     LABEL, so a fully-cached rebuild does not burn the whole timeout);
  6. `runEntity` with `forceRestart`, so the new image actually runs.

Environment
-----------
Connection (plaintext TCP, matching the local `casparctl` node):
    CASPAR_NODE_HOST        node host                     (default 127.0.0.1)
    CASPAR_NODE_PORT        node TCP port                 (default 8074)
    CASPAR_CA_BUNDLE        host CA bundle baked into the image for egress TLS
                            (default /etc/ssl/certs/ca-certificates.crt)
    CASPAR_DEPLOY_USER      deploy operator account       (default davinci_admin)

Program / entity:
    CLAUDE_REUSE_PROGRAM_ID  redeploy onto this existing program (no new creature)
    CLAUDE_ENTITY_ID         entity id                    (default davinci)
    CLAUDE_STOP_PROGRAM_ID   stop mode: stop this program's entity and exit
    DAVINCI_* equivalents are accepted for every one of the three above, so this
    script is a drop-in for the davinci deploy entrypoint the Decillion CI calls.

Claude Code backbone (baked into the image; read from this environment only):
    ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
    CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX,
    ANTHROPIC_MODEL, CLAUDE_CREATURE_MODEL

Agent build:
    CLAUDE_CODE_CLI_SOURCE      source (default: compile this repo's src/) | npm
    CLAUDE_CREATURE_CLI_VERSION version the source-built CLI reports (default 2.0.0-caspar)
    CLAUDE_CODE_VERSION         published CLI version pin, npm mode only

VM:
    CLAUDE_RUN_ENTITY       1 to start the VM after deploy (default), 0 to skip
    CLAUDE_VM_RAM_MB        default 2048     CLAUDE_VM_DISK_GB   default 8
    CLAUDE_VM_CPUS          default 2        CLAUDE_VM_MAX_SECONDS default unlimited
    CLAUDE_FORCE_RESTART    default 1
    CLAUDE_REBUILD_TIMEOUT  image build wait, seconds (default 900)

Output (stdout, machine-readable — the CI greps these):
    DAVINCI_PROGRAM_ID=<id>     CLAUDE_PROGRAM_ID=<id>
    DAVINCI_ENTITY_ID=<id>      CLAUDE_ENTITY_ID=<id>
    DAVINCI_VM_ID=<vmId>        CLAUDE_VM_ID=<vmId>
"""

from __future__ import annotations

import io
import os
import sys
import tarfile
from pathlib import Path
from typing import Dict, Tuple

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from caspar_deploy_common import (  # noqa: E402
    DEPLOY_USER,
    NODE_HOST,
    NODE_PORT,
    VM_MAX_UNLIMITED,
    apply_ca,
    b64_bytes,
    bad,
    bake_snippet,
    docker_image_context,
    docker_image_id,
    env_any,
    info,
    ok,
    stamp_context,
    truthy,
    vm_label,
    vm_max_seconds,
    wait_for_image,
    warn,
)
from caspar_signaling import CasparSignalingClient  # noqa: E402

ENTITY_ID = env_any("CLAUDE_ENTITY_ID", "DAVINCI_ENTITY_ID", default="davinci")

# The backbone credentials + runtime knobs to bake into the image. Read from this
# host's environment only — never written to the repo, never sent in a signal.
BAKE_ENV_NAMES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CREATURE_MODEL",
    "CLAUDE_CREATURE_PERMISSION_MODE",
    "CLAUDE_CREATURE_MAX_WALL_SECONDS",
    "CLAUDE_CREATURE_TOOL_TIMEOUT",
    "CLAUDE_CREATURE_TASK_WAIT",
    "CLAUDE_CREATURE_TRACE_ALL",
    "CLAUDE_CREATURE_STREAM_STEPS",
    "CLAUDE_CREATURE_HISTORY_TURNS",
    "CLAUDE_CREATURE_BARE",
    "CLAUDE_CREATURE_USER",
)

# Cloud-provider credentials are only relevant when the operator actually selected
# that backbone. Baking whatever AWS/GCP variables happen to be exported on a CI
# host into an agent image would ship credentials nobody asked to ship.
BEDROCK_ENV_NAMES = ("AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE")
VERTEX_ENV_NAMES = ("CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS")
# A deploy host's proxy is usually a *loopback* proxy, which inside the creature's
# network namespace points at nothing — so proxying is opt-in, never inherited.
PROXY_ENV_NAMES = ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy")


def bake_env() -> Dict[str, str]:
    """The Claude Code credentials/knobs to bake into the creature image."""
    names = list(BAKE_ENV_NAMES)
    if truthy(os.environ.get("CLAUDE_CODE_USE_BEDROCK", "")):
        names += list(BEDROCK_ENV_NAMES)
    if truthy(os.environ.get("CLAUDE_CODE_USE_VERTEX", "")):
        names += list(VERTEX_ENV_NAMES)
    if truthy(os.environ.get("CLAUDE_BAKE_PROXY", "")):
        names += list(PROXY_ENV_NAMES)
    env = {name: os.environ[name].strip() for name in names if os.environ.get(name, "").strip()}
    for name in PROXY_ENV_NAMES:
        value = env.get(name, "")
        if value and ("127.0.0.1" in value or "localhost" in value):
            warn(f"{name} points at loopback ({value}) — inside the creature that address is not the proxy; "
                 "unset CLAUDE_BAKE_PROXY or give the proxy an address reachable from the docker network")
    return env


# Directories/files of this repo that go into the image build context. `src/` is
# there because the creature's agent is compiled FROM THIS SOURCE inside the image
# (see caspar/Dockerfile); node_modules, the web app and the docs are not needed to
# build the CLI, so they stay out of a payload that travels over a signal.
CONTEXT_TREES = ("src", "caspar")
CONTEXT_FILES = ("package.json", "package-lock.json", "bun.lock", "tsconfig.json", "biome.json", "agent.md")
CONTEXT_EXCLUDE_SUFFIXES = (".map", ".log")
CONTEXT_EXCLUDE_DIRS = {"__pycache__", "node_modules", ".git"}


def _tar_filter(entry: tarfile.TarInfo):
    parts = set(entry.name.split("/"))
    if parts & CONTEXT_EXCLUDE_DIRS:
        return None
    if entry.name.endswith(CONTEXT_EXCLUDE_SUFFIXES):
        return None
    # Deterministic metadata: the context digest must not change just because a
    # file was checked out at a different time or by a different user.
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = "root"
    entry.mtime = 0
    return entry


def bundle_tar_gz() -> bytes:
    """Gzip a tar of the build context (the repo source + the signaling bridge).

    Gzipped because it travels inside a deploy signal: ~34 MB of source becomes
    ~9 MB, comfortably under the node's frame limit. `ADD bundle.tar.gz` unpacks it
    in the image.
    """
    buf = io.BytesIO()
    # mtime=0 keeps the gzip header (and therefore the context digest) stable.
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
        tar.gzip_mtime = 0  # type: ignore[attr-defined]  (documented no-op on old pythons)
        for tree in CONTEXT_TREES:
            root = REPO / tree
            if not root.exists():
                continue
            for path in sorted(p for p in root.rglob("*") if p.is_file()):
                tar.add(path, arcname=str(path.relative_to(REPO)), filter=_tar_filter)
        for name in CONTEXT_FILES:
            path = REPO / name
            if path.exists():
                tar.add(path, arcname=name, filter=_tar_filter)
        # A CLI bundle already built on this host is shipped too, so the image can
        # use it directly instead of rebuilding (and so an operator can deploy a
        # locally-patched CLI).
        bundle = REPO / "dist" / "cli.mjs"
        if bundle.exists() and truthy(os.environ.get("CLAUDE_SHIP_LOCAL_BUNDLE", "0")):
            info(f"shipping the locally built CLI bundle ({bundle.stat().st_size // 1024} KiB)")
            tar.add(bundle, arcname="dist/cli.mjs", filter=_tar_filter)
    return buf.getvalue()


def compose_dockerfile(files: Dict[str, str]) -> Tuple[bytes, str]:
    """The image's Dockerfile: repo file + build mode + CA + baked env + label."""
    dockerfile = (REPO / "caspar" / "Dockerfile").read_bytes()

    # Where the agent comes from. `source` (default) compiles this repo's Claude
    # Code source inside the image; `npm` installs the published CLI instead.
    cli_source = env_any("CLAUDE_CODE_CLI_SOURCE", default="source").lower()
    if cli_source not in ("source", "npm"):
        warn(f"unknown CLAUDE_CODE_CLI_SOURCE={cli_source!r} — falling back to 'source'")
        cli_source = "source"
    info(f"agent build mode: {cli_source}"
         + (" (compiling src/ inside the image)" if cli_source == "source" else " (installing the published CLI)"))
    dockerfile = dockerfile.replace(b"ARG CLAUDE_CODE_CLI_SOURCE=source",
                                    f"ARG CLAUDE_CODE_CLI_SOURCE={cli_source}".encode())

    version = env_any("CLAUDE_CODE_VERSION", default="")
    if version and cli_source == "npm":
        info(f"pinning the published CLI to {version}")
        dockerfile = dockerfile.replace(b"ARG CLAUDE_CODE_VERSION=latest",
                                        f"ARG CLAUDE_CODE_VERSION={version}".encode())
    cli_version = env_any("CLAUDE_CREATURE_CLI_VERSION", default="")
    if cli_version and cli_source == "source":
        info(f"the source-built CLI will report version {cli_version}")
        dockerfile = dockerfile.replace(b"ARG CLAUDE_CREATURE_CLI_VERSION",
                                        f"ARG CLAUDE_CREATURE_CLI_VERSION={cli_version}".encode())

    dockerfile = apply_ca(dockerfile, files)
    baked = bake_env()
    if baked:
        # Report the names only — a key must never reach a log.
        info(f"baking backbone credentials/knobs into the image: {', '.join(sorted(baked))}")
    else:
        info("no default backbone credentials baked into the image. This is fine when every agent "
             "brings its own LLM provider + key (config.llm: openai/gemini/xai/openrouter) — those "
             "runs go through the creature's built-in translation proxy and never need an Anthropic "
             "key. Only agents with NO per-agent LLM override need a default backbone here "
             "(ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, or bedrock/vertex).")
    dockerfile = dockerfile + b"\n" + bake_snippet(baked).encode()
    return stamp_context(dockerfile, files)


def deploy(client: CasparSignalingClient, *, program_id: str, entity_id: str) -> Dict[str, str]:
    """Deploy (or redeploy) the creature entity; returns the ids it landed on."""
    creature_id = ""
    prev_image_id = ""
    if program_id:
        info(f"redeploying the claude-code entity onto existing program {program_id} (entity {entity_id}) — no new creature")
        # Capture the image id BEFORE the rebuild so the wait can detect a change.
        prev_image_id = docker_image_id(program_id, entity_id)
    else:
        suffix = os.urandom(4).hex()
        creature_id = client.create_machine_creature(f"m-claude-code-{suffix}")
        program_id = client.create_program(creature_id, "/claude-code", "docker", "claude code agent")
        info(f"created machine creature {creature_id} and program {program_id}")

    context = bundle_tar_gz()
    info(f"build context: {len(context) / 1048576:.1f} MiB gzipped ({len(context) * 4 // 3 // 1048576} MiB as base64 in the deploy signal)")
    files: Dict[str, str] = {"bundle.tar.gz": b64_bytes(context)}
    dockerfile, digest = compose_dockerfile(files)
    already_current = bool(prev_image_id) and docker_image_context(program_id, entity_id) == digest

    client.deploy(program_id, entity_id, "docker", b64_bytes(dockerfile), files_b64=files)
    if already_current:
        ok("image already built from this exact context — no rebuild to wait for")
    else:
        timeout = int(env_any("CLAUDE_REBUILD_TIMEOUT", "DAVINCI_REBUILD_TIMEOUT", default="900"))
        wait_for_image(program_id, entity_id, timeout=timeout, prev_image_id=prev_image_id, expect_context=digest)
    ok(f"claude-code creature deployed: program={program_id} entity={entity_id}")
    return {"creature_id": creature_id, "program_id": program_id, "entity_id": entity_id}


def main() -> int:
    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT}")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=180).connect()
    client.login(DEPLOY_USER)
    ok(f"logged in as {DEPLOY_USER} (user_id={client.user_id})")

    # Stop mode: bring a running entity down gracefully, then exit. The Decillion
    # CI uses this before restarting the node, so the VM is not yanked with it.
    stop_pid = env_any("CLAUDE_STOP_PROGRAM_ID", "DAVINCI_STOP_PROGRAM_ID")
    if stop_pid:
        info(f"stopping entity {ENTITY_ID} on program {stop_pid} (graceful pre-shutdown)")
        try:
            client.stop_entity(stop_pid, ENTITY_ID)
            ok(f"stopEntity requested for {stop_pid}/{ENTITY_ID}")
            print(f"DAVINCI_STOPPED={stop_pid}", flush=True)
            print(f"CLAUDE_STOPPED={stop_pid}", flush=True)
        except Exception as exc:  # noqa: BLE001 — the entity may not be running
            warn(f"stopEntity failed ({exc}); the entity may not be running")
        client.close()
        return 0

    reuse_pid = env_any("CLAUDE_REUSE_PROGRAM_ID", "DAVINCI_REUSE_PROGRAM_ID")
    try:
        deployed = deploy(client, program_id=reuse_pid, entity_id=ENTITY_ID)
    except Exception as exc:  # noqa: BLE001
        bad(f"deploy failed: {exc}")
        client.close()
        return 1

    # Machine-readable markers. Both spellings are printed so this script is a
    # drop-in for the davinci deploy entrypoint the Decillion CI greps.
    for prefix in ("DAVINCI", "CLAUDE"):
        print(f"{prefix}_PROGRAM_ID=" + deployed["program_id"], flush=True)
        print(f"{prefix}_ENTITY_ID=" + deployed["entity_id"], flush=True)

    if truthy(env_any("CLAUDE_RUN_ENTITY", "DAVINCI_RUN_ENTITY", default="1")):
        ram = int(env_any("CLAUDE_VM_RAM_MB", "DAVINCI_VM_RAM_MB", default="2048"))
        disk = int(env_any("CLAUDE_VM_DISK_GB", "DAVINCI_VM_DISK_GB", default="8"))
        cpus = int(env_any("CLAUDE_VM_CPUS", "DAVINCI_VM_CPUS", default="2"))
        max_seconds = vm_max_seconds("CLAUDE_VM_MAX_SECONDS", "DAVINCI_VM_MAX_SECONDS")
        label = vm_label(max_seconds)
        # forceRestart is essential after a (re)deploy: without it the node's
        # idempotent run_vm resumes the OLD container (old code) instead of
        # creating a fresh one from the just-built image.
        force_restart = truthy(env_any("CLAUDE_FORCE_RESTART", "DAVINCI_FORCE_RESTART", default="1"))
        info(f"starting the creature as a standalone VM entity (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={label} forceRestart={force_restart})")
        try:
            vm_id = client.run_entity(deployed["program_id"], deployed["entity_id"], ram_mb=ram, disk_gb=disk,
                                      cpu_cores=cpus, max_exec_seconds=max_seconds, force_restart=force_restart)
            if vm_id:
                ok(f"claude-code VM entity running: {vm_id}")
                print("DAVINCI_VM_ID=" + vm_id, flush=True)
                print("CLAUDE_VM_ID=" + vm_id, flush=True)
                if truthy(env_any("CLAUDE_WAIT_READY", default="1")):
                    found, _logs = client.wait_for_vm_log(vm_id, "CLAUDE_READY", timeout=int(env_any("CLAUDE_READY_TIMEOUT", default="180")), poll=3)
                    if found:
                        ok("creature is connected to the gateway and serving prompts (CLAUDE_READY)")
                    else:
                        warn("no CLAUDE_READY in the VM logs yet — the container may still be starting; "
                             "check `/machines/readVmLogs` for this vmId")
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the program is deployed and the backend can still spawn it per prompt")
    else:
        info("CLAUDE_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
