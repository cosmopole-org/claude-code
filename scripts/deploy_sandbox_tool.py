#!/usr/bin/env python3
"""Deploy the per-space sandbox tool creature onto a running Caspar node.

Every Decillion space owns one cloud sandbox — the machine its agents work on —
and one docker creature owns them all: Nest signals it to create a sandbox when a
space is created and to destroy it when the space is deleted, and publishes it into
the space so every agent there discovers it as a tool. The binding is the sandbox's
*name*, derived from the space id, so no party has to store a mapping.

The creature (`caspar/tools/vercel_sandbox`) and the shared tool runtime
(`caspar/tools/_runtime`) live in this repository because this repository is the
platform's agent backbone: deploying agents and deploying the machine they work on
should not need two checkouts.

The Vercel credentials are read from this process's environment and **baked into
the creature image**, so they never travel in a signal payload an agent's prompt
could influence, and are never written to the repo.

Environment
-----------
    CASPAR_NODE_HOST / CASPAR_NODE_PORT / CASPAR_CA_BUNDLE / CASPAR_DEPLOY_USER

    SANDBOX_REUSE_PROGRAM_ID  redeploy onto this existing program id instead of
                              minting a new creature — what CI passes on every run
                              after the first, so the ids Nest recorded stay valid
    SANDBOX_TOOL_ENTITY_ID    entity id (default vercel_sandbox)
    SANDBOX_RUN_ENTITY        1 (default) to start it serving after the deploy
    SANDBOX_VM_RAM_MB / _DISK_GB / _CPUS / _MAX_SECONDS   VM resources
    SANDBOX_REBUILD_TIMEOUT   image build wait, seconds (default 480)

    VERCEL_TOKEN (or VERCEL_API_TOKEN / VERCEL_ACCESS_TOKEN), VERCEL_TEAM_ID,
    VERCEL_PROJECT_ID, VERCEL_API_BASE, VERCEL_SANDBOX_*  → baked into the image

Output (stdout, machine-readable — the CI greps these):
    SANDBOX_TOOL_PROGRAM_ID=<id>
    SANDBOX_TOOL_CREATURE_ID=<id>     (empty on a redeploy onto an existing program)
    SANDBOX_TOOL_ENTITY_ID=vercel_sandbox
    SANDBOX_TOOL_VM_ID=<vmId>         (when the standalone runEntity start succeeds)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from caspar_deploy_common import (  # noqa: E402
    DEPLOY_USER,
    NODE_HOST,
    NODE_PORT,
    apply_ca,
    b64_bytes,
    b64_file,
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

TOOL_ID = "vercel_sandbox"
TOOLS_DIR = REPO / "caspar" / "tools"

# Every name the tool reads. All three token spellings are here on purpose: the
# tool accepts any of them, so baking only VERCEL_TOKEN would let an operator who
# set VERCEL_API_TOKEN deploy a creature that looks fine and refuses every call.
SANDBOX_ENV_NAMES = (
    "VERCEL_TOKEN", "VERCEL_API_TOKEN", "VERCEL_ACCESS_TOKEN",
    "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_API_BASE",
    "VERCEL_SANDBOX_RUNTIME", "VERCEL_SANDBOX_TIMEOUT_MS", "VERCEL_SANDBOX_VCPUS",
    "VERCEL_SANDBOX_PREFIX", "VERCEL_SANDBOX_MAX_OUTPUT", "VERCEL_SANDBOX_MAX_READ_BYTES",
    "VERCEL_SANDBOX_EXEC_TIMEOUT_MS", "VERCEL_SANDBOX_HTTP_TIMEOUT",
    "VERCEL_SANDBOX_SESSION_TTL",
)


def bake_env() -> Dict[str, str]:
    """The Vercel credentials + tuning to bake into the creature image."""
    import os

    return {name: os.environ[name].strip() for name in SANDBOX_ENV_NAMES if os.environ.get(name, "").strip()}


def build_context() -> Dict[str, str]:
    """The tool's docker build context: the shared runtime + this tool's code."""
    runtime = TOOLS_DIR / "_runtime"
    tool_dir = TOOLS_DIR / TOOL_ID
    files = {
        "tool_runtime.py": b64_file(runtime / "tool_runtime.py"),
        # The docker-host bridge client, the tool's only route to the node's host
        # functions (HTTP for the Vercel API) and to signalling its result back.
        "caspar_bridge.py": b64_file(runtime / "caspar_bridge.py"),
        "tool.py": b64_file(tool_dir / "tool.py"),
        "requirements.txt": b64_file(tool_dir / "requirements.txt"),
        "point.metadata.json": b64_file(tool_dir / "point.metadata.json"),
    }
    return files


def descriptor() -> Dict[str, object]:
    """The tool's own metadata — deployed with it so the node/Nest can read it."""
    try:
        return json.loads((TOOLS_DIR / TOOL_ID / "point.metadata.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def compose_dockerfile(files: Dict[str, str]):
    dockerfile = (TOOLS_DIR / TOOL_ID / "Dockerfile").read_bytes()
    dockerfile = apply_ca(dockerfile, files)
    baked = bake_env()
    if any(baked.get(k) for k in ("VERCEL_TOKEN", "VERCEL_API_TOKEN", "VERCEL_ACCESS_TOKEN")):
        info(f"baking Vercel credentials into the image (scope={baked.get('VERCEL_TEAM_ID') or 'personal account'})")
    else:
        warn("no VERCEL_TOKEN in the environment — the creature will deploy but every call will fail "
             "until the token is baked in")
    dockerfile = dockerfile + b"\n" + bake_snippet(baked).encode()
    return stamp_context(dockerfile, files)


def main() -> int:
    entity_id = env_any("SANDBOX_TOOL_ENTITY_ID", default=TOOL_ID)
    reuse_pid = env_any("SANDBOX_REUSE_PROGRAM_ID", "SANDBOX_TOOL_PROGRAM_ID")

    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT}")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=180).connect()
    client.login(DEPLOY_USER)
    ok(f"logged in as {DEPLOY_USER} (user_id={client.user_id})")

    import os

    creature_id = ""
    prev_image_id = ""
    reminted = False
    program_id = reuse_pid

    # Ownership drift: a redeploy onto a program the deploy operator does not own
    # is blocked by the node (`/programs/deploy` → "access to vm denied"). This
    # happens when the recorded id is a leftover from a previous node era / a
    # different admin. Detect it up front rather than failing on the deploy call.
    if program_id:
        owner = client.program_owner(program_id)
        mine = client.user_id
        if owner is None:
            warn(f"recorded sandbox program {program_id} does not exist on the node — deploying a fresh one")
            program_id = ""
            reminted = True
        elif owner and owner != mine:
            if truthy(env_any("SANDBOX_REMINT_ON_DRIFT", default="0")):
                warn(f"recorded sandbox program {program_id} is owned by {owner}, not the deploy operator ({mine}); "
                     "re-minting a fresh operator-owned sandbox. Spaces re-adopt their Vercel sandbox by name, so no "
                     "sandbox data is lost — but existing spaces keep pointing at the old creature until re-provisioned "
                     "(POST /api/spaces/:id/sandbox).")
                program_id = ""
                reminted = True
            else:
                warn(f"recorded sandbox program {program_id} is owned by another account ({owner}), not the deploy "
                     f"operator ({mine}). The node blocks redeploy onto a program you do not own, so this is SKIPPED — "
                     "the existing sandbox creature keeps running and serving spaces (its image is functionally "
                     "unchanged). Set SANDBOX_REMINT_ON_DRIFT=1 to mint a fresh operator-owned sandbox instead.")
                # Report the existing ids unchanged so the manifest is preserved.
                print("SANDBOX_TOOL_PROGRAM_ID=" + program_id, flush=True)
                print("SANDBOX_TOOL_ENTITY_ID=" + entity_id, flush=True)
                print("SANDBOX_SKIPPED=1", flush=True)
                client.close()
                return 0

    if program_id:
        info(f"redeploying the {TOOL_ID} entity onto existing program {program_id} — no new creature")
        prev_image_id = docker_image_id(program_id, entity_id)
    else:
        suffix = os.urandom(4).hex()
        creature_id = client.create_machine_creature(f"m-tool-{TOOL_ID}-{suffix}")
        program_id = client.create_program(creature_id, f"/tools/{TOOL_ID}", "docker", f"tool {TOOL_ID}")
        info(f"created machine creature {creature_id} and program {program_id}")

    files = build_context()
    dockerfile, digest = compose_dockerfile(files)
    already_current = bool(prev_image_id) and docker_image_context(program_id, entity_id) == digest

    try:
        client.deploy(program_id, entity_id, "docker", b64_bytes(dockerfile), files_b64=files,
                      metadata={"decillion": descriptor()})
    except Exception as exc:  # noqa: BLE001
        bad(f"deploy failed: {exc}")
        client.close()
        return 1

    if already_current:
        ok("image already built from this exact context — no rebuild to wait for")
    else:
        wait_for_image(program_id, entity_id, timeout=int(env_any("SANDBOX_REBUILD_TIMEOUT", default="480")),
                       prev_image_id=prev_image_id, expect_context=digest)
    ok(f"{TOOL_ID} creature deployed: program={program_id} entity={entity_id}")

    print("SANDBOX_TOOL_PROGRAM_ID=" + program_id, flush=True)
    print("SANDBOX_TOOL_CREATURE_ID=" + creature_id, flush=True)
    print("SANDBOX_TOOL_ENTITY_ID=" + entity_id, flush=True)
    # Signal a deliberate drift recovery so the CI accepts the new id instead of
    # treating a changed sandbox program id as an orphaning bug.
    if reminted:
        print("SANDBOX_REMINTED=1", flush=True)

    # Start it as a long-lived serving creature: the tool runtime stays in its serve
    # loop and answers every signal over the gateway, so Nest's create/delete calls
    # and the agents' exec calls hit a warm container instead of cold-spawning one.
    if truthy(env_any("SANDBOX_RUN_ENTITY", default="1")):
        ram = int(env_any("SANDBOX_VM_RAM_MB", default="512"))
        disk = int(env_any("SANDBOX_VM_DISK_GB", default="2"))
        cpus = int(env_any("SANDBOX_VM_CPUS", default="1"))
        max_seconds = vm_max_seconds("SANDBOX_VM_MAX_SECONDS")
        info(f"starting {TOOL_ID} as a standalone serving VM (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={vm_label(max_seconds)})")
        try:
            # forceRestart: this always follows a (re)deploy, so the old container
            # must be replaced or the node resumes the pre-rebuild image.
            vm_id = client.run_entity(program_id, entity_id, ram_mb=ram, disk_gb=disk, cpu_cores=cpus,
                                      max_exec_seconds=max_seconds, force_restart=True)
            if vm_id:
                ok(f"{TOOL_ID} VM entity running: {vm_id}")
                print("SANDBOX_TOOL_VM_ID=" + vm_id, flush=True)
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the node will cold-spawn the tool per signal")
    else:
        info("SANDBOX_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
