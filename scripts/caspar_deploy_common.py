"""Shared helpers for deploying creatures onto a Caspar node.

Used by both deploy entrypoints in this repo:

* ``deploy_claude_creature.py`` — the agent backbone (this repo's Claude Code
  source, compiled into a docker creature);
* ``deploy_sandbox_tool.py``    — the per-space sandbox tool creature.

What lives here is everything that is the same for any docker creature: build
contexts and their digests, the CA bundle and credential baking, the "has the node
finished building this image?" wait, and the VM resource knobs.
"""

from __future__ import annotations

import base64
import hashlib
import os
import subprocess
import time
from pathlib import Path
from typing import Dict, Optional, Tuple

GREEN, RED, YELLOW, CYAN, NC = "\033[0;32m", "\033[0;31m", "\033[0;33m", "\033[0;36m", "\033[0m"


def info(m: str) -> None:
    print(f"{CYAN}[deploy]{NC} {m}", flush=True)


def ok(m: str) -> None:
    print(f"{GREEN}[ ok ]{NC} {m}", flush=True)


def warn(m: str) -> None:
    print(f"{YELLOW}[warn]{NC} {m}", flush=True)


def bad(m: str) -> None:
    print(f"{RED}[fail]{NC} {m}", flush=True)


def env_any(*names: str, default: str = "") -> str:
    """First non-empty value among ``names``, else ``default``."""
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def truthy(value: str) -> bool:
    return str(value).strip().lower() not in ("", "0", "false", "no", "off")


NODE_HOST = env_any("CASPAR_NODE_HOST", default="127.0.0.1")
NODE_PORT = int(env_any("CASPAR_NODE_PORT", default="8074"))
# The platform's deploy operator. Redeploying onto a program id the Decillion
# manifest already records requires logging in as the account that owns it, which
# is why the historical account name is the default and not a new one.
DEPLOY_USER = env_any("CASPAR_DEPLOY_USER", "CLAUDE_ADMIN_USER", "DAVINCI_ADMIN_USER", default="davinci_admin")
CA_BUNDLE_PATH = env_any("CASPAR_CA_BUNDLE", default="/etc/ssl/certs/ca-certificates.crt")

# The node has no true "unlimited" exec cap (`runEntity` clamps <= 0 to 60 and
# always spawns a reaper), so "unlimited" is a very large but i64-safe value.
VM_MAX_UNLIMITED = 10_000_000_000

# Label stamped into every creature image, carrying a digest of the build context
# it was built from. It is what lets a redeploy tell "the node already built this"
# from "the node has not finished building yet".
CONTEXT_LABEL = "org.decillion.build-context"

# Substituted into a Dockerfile at every `CA_MARKER` — once per build stage — so the
# egress-gateway CA is trusted both while the image installs dependencies and while
# the creature makes API calls. A host with a TLS-intercepting proxy fails every
# dependency download without it. Appended at the end for a Dockerfile with no
# marker (single-stage tool images).
CA_MARKER = "# >>> caspar-ca <<<"
CA_SNIPPET = (
    "COPY ca-certificates.crt /etc/ssl/certs/caspar-ca.crt\n"
    "ENV SSL_CERT_FILE=/etc/ssl/certs/caspar-ca.crt "
    "REQUESTS_CA_BUNDLE=/etc/ssl/certs/caspar-ca.crt "
    "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/caspar-ca.crt"
)


def b64_bytes(data: bytes) -> str:
    return base64.b64encode(data).decode()


def b64_file(path: Path) -> str:
    return b64_bytes(path.read_bytes())


def ca_bundle_bytes() -> Optional[bytes]:
    """The host CA bundle (including any egress-gateway CA), or ``None``."""
    try:
        data = Path(CA_BUNDLE_PATH).read_bytes()
        return data if data.strip() else None
    except OSError:
        return None


def apply_ca(dockerfile: bytes, files: Dict[str, str]) -> bytes:
    """Ship the host CA bundle into the context and trust it in every stage."""
    ca = ca_bundle_bytes()
    if ca is None:
        warn("no host CA bundle found — the image will trust only its own roots")
        return dockerfile
    files["ca-certificates.crt"] = b64_bytes(ca)
    if CA_MARKER.encode() in dockerfile:
        return dockerfile.replace(CA_MARKER.encode(), CA_SNIPPET.encode())
    return dockerfile + b"\n" + CA_SNIPPET.encode() + b"\n"


def bake_snippet(env: Dict[str, str]) -> str:
    """A Dockerfile ``ENV`` line baking key=value pairs into the image.

    Credentials are baked into the image rather than sent in a signal, so nothing
    an agent's prompt can influence ever carries them.
    """
    parts = []
    for key, value in env.items():
        if value == "":
            continue
        escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
        parts.append(f'{key}="{escaped}"')
    return ("ENV " + " ".join(parts) + "\n") if parts else ""


def context_digest(dockerfile: bytes, files_b64: Dict[str, str]) -> str:
    """sha256 over the whole build context (Dockerfile + every shipped file)."""
    h = hashlib.sha256()
    h.update(dockerfile)
    for name in sorted(files_b64 or {}):
        h.update(name.encode())
        h.update(files_b64[name].encode())
    return h.hexdigest()


def stamp_context(dockerfile: bytes, files_b64: Dict[str, str]) -> Tuple[bytes, str]:
    """Append the context LABEL to a Dockerfile. Returns (dockerfile, digest)."""
    digest = context_digest(dockerfile, files_b64)
    return dockerfile + f'\nLABEL {CONTEXT_LABEL}="{digest}"\n'.encode(), digest


def image_tag(program_id: str, entity_id: str) -> str:
    return f"{program_id.replace('@', '_')}/{entity_id}"


def docker_image_id(program_id: str, entity_id: str) -> str:
    """Current image id for a program/entity tag, or "" (also when docker is unreachable)."""
    try:
        out = subprocess.run(["docker", "images", "--no-trunc", "--format", "{{.ID}}", image_tag(program_id, entity_id)],
                             capture_output=True, text=True, timeout=15)
        lines = [line.strip() for line in out.stdout.splitlines() if line.strip()]
        return lines[0] if lines else ""
    except Exception:  # noqa: BLE001 — the deployer does not always share the node's docker socket
        return ""


def docker_image_context(program_id: str, entity_id: str) -> str:
    """The context digest baked into the current image, or "" when absent."""
    try:
        out = subprocess.run(
            ["docker", "inspect", "--format", '{{index .Config.Labels "' + CONTEXT_LABEL + '"}}',
             image_tag(program_id, entity_id)],
            capture_output=True, text=True, timeout=15)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


def wait_for_image(program_id: str, entity_id: str, *, timeout: int,
                   prev_image_id: str = "", expect_context: str = "") -> bool:
    """Wait until the node has (re)built the entity's image.

    The node builds asynchronously and only re-tags on success, so on a redeploy the
    old tag is present the whole time — waiting for the context digest to appear is
    what makes this both correct and terminating (an unchanged context is already
    satisfied, so a no-op rebuild returns at once).
    """
    tag = image_tag(program_id, entity_id)
    deadline = time.time() + timeout
    info(f"waiting for the node to build image {tag} (≤{timeout}s)…")
    while time.time() < deadline:
        if expect_context and docker_image_context(program_id, entity_id) == expect_context:
            ok(f"image built from the deployed context: {tag}")
            return True
        current = docker_image_id(program_id, entity_id)
        if prev_image_id and current and current != prev_image_id:
            ok(f"image rebuilt: {tag} -> {current[:19]}")
            return True
        if not prev_image_id and not expect_context and current:
            ok(f"image present: {tag}")
            return True
        time.sleep(3)
    warn(f"image {tag} did not appear/change within {timeout}s — proceeding with the current image; "
         "check the node's build logs if the entity misbehaves (a host that cannot query docker "
         "always reports empty here, which must not fail an otherwise fine deploy)")
    return True


def vm_max_seconds(*names: str, default: str = "unlimited") -> int:
    """Resolve a VM exec cap from the environment; "unlimited" → the i64-safe max."""
    raw = env_any(*names, default=default).lower()
    if raw in ("0", "-1", "none", "inf", "infinite", "unlimited", "immortal", "forever"):
        return VM_MAX_UNLIMITED
    try:
        value = int(raw)
    except ValueError:
        return VM_MAX_UNLIMITED
    return VM_MAX_UNLIMITED if value <= 0 else value


def vm_label(max_seconds: int) -> str:
    return "unlimited (~317y)" if max_seconds == VM_MAX_UNLIMITED else f"{max_seconds}s"
