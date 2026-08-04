"""github tool creature — a full git + GitHub client bound to a Decillion space.

Deployed as its own Caspar ``docker`` creature (like every other Davinci tool)
and driven purely through the Caspar signalling API. Two kinds of caller reach
it, both over the same contract:

* the tool's **front-end** (the Victor "GitHub" mini-app), relayed by Nest and
  **signed as the human user** with ``space_id`` pinned — the connect/OAuth flow
  and the whole repository dashboard;
* the space's **agents**, through Davinci's bridge executor, so an agent can
  clone, branch, commit, push and open/merge pull requests exactly like a human.

State that must survive the container is kept in the node's key/value store
(reached over the docker-host bridge, :mod:`caspar_bridge`), with a local-file
fallback so the tool still works on a node whose ``dbOp`` is unavailable. It is
**keyed by space** so one creature serves every space without a per-space
deployment:

    github/conn/<space_id>     JSON  {owner_user_id, login, shared, scopes, ...}
    github/token/<space_id>    the user's GitHub OAuth access token (secret)
    github/pending/<space_id>  in-flight device-flow handshake

The **binding between a Decillion space and a GitHub account is the OAuth token**
one member connected, so the token is what every call is authorised against. A
per-space *shared* toggle decides whether the rest of the space (people **and**
agents) may drive the connection, or only the member who connected it.

OAuth uses GitHub's **Device Authorization flow**, which needs no redirect URL,
no callback server and no Victor hooks: the front-end asks the back-end to start
the flow, opens ``https://github.com/login/device`` in a browser tab, the user
enters the shown code and grants the requested account + organization access,
and the back-end polls GitHub until the token is issued and stores it.

The OAuth **app credentials** come from the container environment only — never
from a signal payload a prompt could influence:

    GITHUB_OAUTH_CLIENT_ID       required to start the device flow
    GITHUB_OAUTH_CLIENT_SECRET   optional (device-flow public apps omit it)
    GITHUB_OAUTH_SCOPES          default "repo,read:org,workflow,read:user"
    GITHUB_API_BASE              default https://api.github.com
    GITHUB_WEB_BASE              default https://github.com
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

API_BASE = os.environ.get("GITHUB_API_BASE", "https://api.github.com").rstrip("/")
WEB_BASE = os.environ.get("GITHUB_WEB_BASE", "https://github.com").rstrip("/")
DEFAULT_SCOPES = os.environ.get("GITHUB_OAUTH_SCOPES", "repo,read:org,workflow,read:user")

HTTP_TIMEOUT = float(os.environ.get("GITHUB_HTTP_TIMEOUT", "45"))
# Command output / API bodies are fed back into an LLM context and a mobile UI —
# cap them hard so a huge diff or file listing can never blow either up.
MAX_OUTPUT_CHARS = int(os.environ.get("GITHUB_MAX_OUTPUT", "60000"))
MAX_READ_BYTES = int(os.environ.get("GITHUB_MAX_READ_BYTES", "1000000"))
GIT_TIMEOUT = int(os.environ.get("GITHUB_GIT_TIMEOUT_S", "600"))
API_PAGE_CAP = int(os.environ.get("GITHUB_API_PAGE_CAP", "300"))

# Where cloned repositories (and the local state fallback) live inside the
# container. Persists while the serving creature is warm; a cold restart simply
# re-clones, and the token comes back from the node DB.
WORKSPACE = os.environ.get("GITHUB_WORKSPACE", "/workspace")
STATE_DIR = os.path.join(WORKSPACE, ".state")

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class GithubError(RuntimeError):
    """A tool operation failed; carries an HTTP-ish status for the reply."""

    def __init__(self, message: str, *, status: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# Persistence — node DB (durable) with a local-file fallback
# --------------------------------------------------------------------------- #
#
# The tool runtime connects the docker-host bridge and hands it to us via
# ``set_bridge`` so persistence can use the node's key/value store, which
# survives a container restart. When no bridge is present (offline / a node
# whose dbOp is unavailable) we fall back to a JSON file under the workspace, and
# we always mirror to that file so reads are cheap and a warm container is
# self-consistent either way.

_BRIDGE = None  # set by set_bridge()


def set_bridge(bridge) -> None:
    global _BRIDGE
    _BRIDGE = bridge


def _file_path(key: str) -> str:
    return os.path.join(STATE_DIR, _UNSAFE.sub("_", key) + ".json")


def _file_get(key: str) -> Optional[str]:
    try:
        with open(_file_path(key), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def _file_put(key: str, val: str) -> None:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = _file_path(key) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(val)
        os.replace(tmp, _file_path(key))
    except OSError:
        pass


def _file_del(key: str) -> None:
    try:
        os.remove(_file_path(key))
    except OSError:
        pass


def _bridge_get(key: str) -> Optional[str]:
    if _BRIDGE is None:
        return None
    try:
        res = _BRIDGE.db_get(key)
    except Exception:  # noqa: BLE001 — a flaky bridge falls back to the file
        return None
    if not isinstance(res, dict):
        return None
    if res.get("found") is False:
        return None
    val = res.get("val")
    if val is None:
        val = res.get("value")
    if val is None:
        return None
    if res.get("encoding") == "base64" or res.get("b64"):
        try:
            return base64.b64decode(val).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return None
    return str(val)


def _store_get(key: str) -> Optional[str]:
    val = _bridge_get(key)
    if val is not None:
        # Keep the local mirror warm so a later bridge hiccup still reads.
        _file_put(key, val)
        return val
    return _file_get(key)


def _store_put(key: str, val: str) -> None:
    if _BRIDGE is not None:
        try:
            _BRIDGE.db_put(key, val)
        except Exception:  # noqa: BLE001
            pass
    _file_put(key, val)


def _store_del(key: str) -> None:
    if _BRIDGE is not None:
        try:
            _BRIDGE.db_del(key)
        except Exception:  # noqa: BLE001
            pass
    _file_del(key)


def _json_get(key: str) -> Optional[Dict[str, Any]]:
    raw = _store_get(key)
    if not raw:
        return None
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else None
    except (TypeError, ValueError):
        return None


def _json_put(key: str, obj: Dict[str, Any]) -> None:
    _store_put(key, json.dumps(obj))


# --------------------------------------------------------------------------- #
# HTTP: GitHub REST + OAuth (direct egress, like the sandbox tool)
# --------------------------------------------------------------------------- #

def _client_id() -> str:
    val = os.environ.get("GITHUB_OAUTH_CLIENT_ID", "").strip()
    if not val:
        raise GithubError(
            "no GitHub OAuth app configured — set GITHUB_OAUTH_CLIENT_ID on the github "
            "creature image (see scripts/deploy_github_tool.py)")
    return val


def _api(method: str, path: str, token: str, *, body: Any = None,
         params: Optional[Dict[str, Any]] = None) -> Any:
    """Call the GitHub REST API with the space's token and return parsed JSON."""
    url = path if path.startswith("http") else f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "decillion-github-tool",
    }
    try:
        resp = requests.request(method, url, headers=headers, json=body,
                                params={k: v for k, v in (params or {}).items() if v not in (None, "")},
                                timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise GithubError(f"GitHub API unreachable: {exc}", status=502)
    parsed = _parse(resp)
    if resp.status_code == 401:
        raise GithubError("GitHub rejected the stored token (401) — reconnect the tool",
                          status=401, body=parsed)
    if resp.status_code == 403 and isinstance(parsed, dict) and "rate limit" in str(parsed.get("message", "")).lower():
        raise GithubError("GitHub API rate limit reached — try again shortly", status=403, body=parsed)
    if resp.status_code >= 300:
        msg = parsed.get("message") if isinstance(parsed, dict) else parsed
        raise GithubError(f"GitHub API {method} {path} failed ({resp.status_code}): {msg}",
                          status=resp.status_code, body=parsed)
    return parsed


def _parse(resp: requests.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return (resp.text or "")[:2000]


def _form_post(url: str, fields: Dict[str, str]) -> Tuple[int, Any]:
    headers = {"Accept": "application/json", "User-Agent": "decillion-github-tool"}
    try:
        resp = requests.post(url, data=fields, headers=headers, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise GithubError(f"GitHub unreachable: {exc}", status=502)
    return resp.status_code, _parse(resp)


# --------------------------------------------------------------------------- #
# Identity & access control (the shared toggle)
# --------------------------------------------------------------------------- #

def _space_id(payload: Dict[str, Any]) -> str:
    for key in ("space_id", "spaceId", "store_id", "storeId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    raise GithubError("space_id is required — this tool is bound to a Decillion space")


def _caller(payload: Dict[str, Any]) -> str:
    """The user id on whose behalf this call is made, as far as the tool can tell.

    Nest signs a front-end call as the human user and passes ``reply_to``; an
    agent turn carries the space/agent identity. Either way it is only *one* half
    of the access decision — the other half is the stored owner + shared flag."""
    for key in ("reply_to", "replyTo", "caller_id", "callerId", "user_id", "userId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _conn(space_id: str) -> Optional[Dict[str, Any]]:
    return _json_get(f"github/conn/{space_id}")


def _token_for(space_id: str) -> str:
    token = _store_get(f"github/token/{space_id}")
    if not token:
        raise GithubError("this space is not connected to GitHub yet — connect the tool first",
                          status=409)
    return token


def _require_use(space_id: str, payload: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Authorise a data/action call and return (token, connection).

    Enforces the *shared* toggle: when a connection is not shared, only the
    member who connected it (matched by user id) may drive it. A call whose
    caller identity cannot be established is allowed only for a shared
    connection — never for a private one."""
    conn = _conn(space_id)
    if not conn:
        raise GithubError("this space is not connected to GitHub yet — connect the tool first",
                          status=409)
    if not conn.get("shared", False):
        caller = _caller(payload)
        owner = str(conn.get("owner_user_id") or "")
        if not caller or caller != owner:
            raise GithubError(
                "this GitHub connection is private to the member who connected it; ask them to "
                "enable sharing in the tool settings to let the rest of the space use it",
                status=403)
    return _token_for(space_id), conn


def _assert_owner(space_id: str, payload: Dict[str, Any], conn: Dict[str, Any], what: str) -> None:
    caller = _caller(payload)
    if caller and caller != str(conn.get("owner_user_id") or ""):
        raise GithubError(f"only the member who connected GitHub can {what}", status=403)


# --------------------------------------------------------------------------- #
# OAuth device flow
# --------------------------------------------------------------------------- #

def _oauth_start(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Begin the device flow and hand the front-end the code + verification URL."""
    client_id = _client_id()
    scopes = str(payload.get("scopes") or DEFAULT_SCOPES)
    status, parsed = _form_post(f"{WEB_BASE}/login/device/code",
                                {"client_id": client_id, "scope": scopes.replace(",", " ")})
    if status >= 300 or not isinstance(parsed, dict) or not parsed.get("device_code"):
        raise GithubError(f"could not start GitHub device authorization ({status}): {parsed}",
                          status=status or 502)
    pending = {
        "device_code": parsed["device_code"],
        "interval": int(parsed.get("interval") or 5),
        "expires_at": time.time() + int(parsed.get("expires_in") or 900),
        "started_by": _caller(payload),
        "scopes": scopes,
    }
    _json_put(f"github/pending/{space_id}", pending)
    return {
        "ok": True, "action": "oauth_start", "space_id": space_id,
        "user_code": parsed.get("user_code"),
        "verification_uri": parsed.get("verification_uri") or f"{WEB_BASE}/login/device",
        "verification_uri_complete": parsed.get("verification_uri_complete"),
        "interval": pending["interval"],
        "expires_in": int(parsed.get("expires_in") or 900),
    }


def _oauth_poll(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Poll GitHub for the device-flow result; store the token on success.

    The Elpian front-end has no timer to pace polling, so when it passes
    ``wait: true`` we **long-poll** server-side: poll once, and while GitHub says
    "authorization_pending" sleep the interval and poll again, up to a wall
    budget kept comfortably under the host-call timeout. The front-end simply
    re-invokes whenever we return ``status == "pending"``, so the loop is paced
    with no guest-side clock."""
    if not payload.get("wait"):
        return _oauth_poll_once(space_id, payload)
    budget = time.time() + float(payload.get("wait_seconds") or 25)
    interval = 5.0
    while True:
        res = _oauth_poll_once(space_id, payload)
        if res.get("status") != "pending":
            return res
        if res.get("slow_down"):
            interval += 5.0
        if time.time() + interval >= budget:
            return res
        time.sleep(interval)


def _oauth_poll_once(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """One device-flow poll against GitHub; store the token on success."""
    pending = _json_get(f"github/pending/{space_id}")
    if not pending or not pending.get("device_code"):
        raise GithubError("no GitHub authorization is in progress — start over", status=409)
    if time.time() > float(pending.get("expires_at") or 0):
        _store_del(f"github/pending/{space_id}")
        raise GithubError("the authorization code expired — start over", status=410)

    fields = {
        "client_id": _client_id(),
        "device_code": pending["device_code"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    }
    secret = os.environ.get("GITHUB_OAUTH_CLIENT_SECRET", "").strip()
    if secret:
        fields["client_secret"] = secret
    status, parsed = _form_post(f"{WEB_BASE}/login/oauth/access_token", fields)
    if not isinstance(parsed, dict):
        raise GithubError(f"unexpected token response from GitHub ({status})", status=status or 502)

    if parsed.get("error"):
        err = str(parsed.get("error"))
        if err in ("authorization_pending", "slow_down"):
            return {"ok": True, "action": "oauth_poll", "space_id": space_id,
                    "status": "pending", "connected": False, "slow_down": err == "slow_down"}
        if err in ("expired_token", "access_denied"):
            _store_del(f"github/pending/{space_id}")
        raise GithubError(f"GitHub authorization failed: {parsed.get('error_description') or err}",
                          status=400)

    token = parsed.get("access_token")
    if not token:
        return {"ok": True, "action": "oauth_poll", "space_id": space_id,
                "status": "pending", "connected": False}

    # Success: resolve who authorized, persist the token + connection, drop the
    # handshake. The member who *started* the flow owns the connection.
    login, name = "", ""
    try:
        me = _api("GET", "/user", token)
        login, name = str(me.get("login") or ""), str(me.get("name") or "")
    except GithubError:
        pass
    conn = {
        "owner_user_id": pending.get("started_by") or _caller(payload),
        "login": login, "name": name,
        "shared": bool((_conn(space_id) or {}).get("shared", False)),
        "scopes": str(parsed.get("scope") or pending.get("scopes") or DEFAULT_SCOPES),
        "connected_at": int(time.time()),
    }
    _store_put(f"github/token/{space_id}", str(token))
    _json_put(f"github/conn/{space_id}", conn)
    _store_del(f"github/pending/{space_id}")
    return {"ok": True, "action": "oauth_poll", "space_id": space_id, "status": "connected",
            "connected": True, "login": login, "name": name, "shared": conn["shared"],
            "scopes": conn["scopes"]}


def _status(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Report the connection state + settings. Read-only, never gated: everyone
    may *see* whether the tool is connected; only *using* it is gated."""
    conn = _conn(space_id)
    if not conn:
        return {"ok": True, "action": "status", "space_id": space_id, "connected": False}
    caller = _caller(payload)
    is_owner = bool(caller) and caller == str(conn.get("owner_user_id") or "")
    return {
        "ok": True, "action": "status", "space_id": space_id, "connected": True,
        "login": conn.get("login"), "name": conn.get("name"),
        "shared": bool(conn.get("shared", False)),
        "scopes": conn.get("scopes"), "connected_at": conn.get("connected_at"),
        "is_owner": is_owner, "can_manage": is_owner,
        "can_use": bool(conn.get("shared", False)) or is_owner,
    }


def _disconnect(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    conn = _conn(space_id)
    if conn:
        _assert_owner(space_id, payload, conn, "disconnect it")
    _store_del(f"github/token/{space_id}")
    _store_del(f"github/conn/{space_id}")
    _store_del(f"github/pending/{space_id}")
    return {"ok": True, "action": "disconnect", "space_id": space_id, "connected": False}


def _set_shared(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Flip the shared toggle. Owner-only — it changes who else may drive the
    connection, so a non-owner must never be able to open it up (or lock it)."""
    conn = _conn(space_id)
    if not conn:
        raise GithubError("connect the tool before changing its settings", status=409)
    _assert_owner(space_id, payload, conn, "change its sharing")
    shared = payload.get("shared")
    if isinstance(shared, str):
        shared = shared.strip().lower() in ("1", "true", "yes", "on")
    conn["shared"] = bool(shared)
    _json_put(f"github/conn/{space_id}", conn)
    return {"ok": True, "action": "set_shared", "space_id": space_id, "shared": conn["shared"]}


# --------------------------------------------------------------------------- #
# GitHub API actions (read + write)
# --------------------------------------------------------------------------- #

def _paginate(token: str, path: str, params: Optional[Dict[str, Any]] = None,
              *, cap: int = API_PAGE_CAP) -> List[Any]:
    out: List[Any] = []
    page = 1
    while len(out) < cap:
        rows = _api("GET", path, token, params={**(params or {}), "per_page": 100, "page": page})
        if not isinstance(rows, list) or not rows:
            break
        out.extend(rows)
        if len(rows) < 100:
            break
        page += 1
    return out[:cap]


def _repo_row(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "full_name": r.get("full_name"), "name": r.get("name"),
        "owner": (r.get("owner") or {}).get("login"), "private": r.get("private"),
        "default_branch": r.get("default_branch"), "description": r.get("description"),
        "language": r.get("language"), "stars": r.get("stargazers_count"),
        "open_issues": r.get("open_issues_count"), "fork": r.get("fork"),
        "archived": r.get("archived"), "pushed_at": r.get("pushed_at"),
        "permissions": r.get("permissions"), "clone_url": r.get("clone_url"),
    }


def _a_orgs(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    orgs = _paginate(token, "/user/orgs")
    me = _api("GET", "/user", token)
    return {"ok": True, "action": "orgs", "space_id": space_id,
            "user": {"login": me.get("login"), "name": me.get("name"), "avatar_url": me.get("avatar_url")},
            "orgs": [{"login": o.get("login"), "description": o.get("description"),
                      "avatar_url": o.get("avatar_url")} for o in orgs if isinstance(o, dict)]}


def _a_repos(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    org = str(payload.get("org") or "").strip()
    if org:
        rows = _paginate(token, f"/orgs/{_slug(org)}/repos", {"sort": "pushed"})
    else:
        rows = _paginate(token, "/user/repos",
                         {"sort": "pushed", "affiliation": "owner,collaborator,organization_member"})
    return {"ok": True, "action": "repos", "space_id": space_id, "org": org or None,
            "repos": [_repo_row(r) for r in rows if isinstance(r, dict)]}


def _a_repo(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    return {"ok": True, "action": "repo", "space_id": space_id,
            "repo": _repo_row(_api("GET", f"/repos/{full}", token))}


def _a_branches(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    rows = _paginate(token, f"/repos/{full}/branches")
    return {"ok": True, "action": "branches", "space_id": space_id, "repo": full,
            "branches": [{"name": b.get("name"), "protected": b.get("protected"),
                          "sha": (b.get("commit") or {}).get("sha")} for b in rows if isinstance(b, dict)]}


def _a_commits(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    params: Dict[str, Any] = {"per_page": int(payload.get("limit") or 30)}
    if payload.get("branch") or payload.get("sha"):
        params["sha"] = payload.get("branch") or payload.get("sha")
    if payload.get("path"):
        params["path"] = payload["path"]
    rows = _api("GET", f"/repos/{full}/commits", token, params=params)
    out = []
    for c in rows if isinstance(rows, list) else []:
        commit = c.get("commit") or {}
        author = commit.get("author") or {}
        out.append({"sha": c.get("sha"), "message": commit.get("message"),
                    "author": author.get("name"), "date": author.get("date"),
                    "login": (c.get("author") or {}).get("login")})
    return {"ok": True, "action": "commits", "space_id": space_id, "repo": full, "commits": out}


def _pull_row(p: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "number": p.get("number"), "title": p.get("title"), "state": p.get("state"),
        "draft": p.get("draft"), "user": (p.get("user") or {}).get("login"),
        "head": (p.get("head") or {}).get("ref"), "base": (p.get("base") or {}).get("ref"),
        "merged": p.get("merged"), "mergeable": p.get("mergeable"),
        "mergeable_state": p.get("mergeable_state"), "html_url": p.get("html_url"),
        "created_at": p.get("created_at"), "updated_at": p.get("updated_at"),
        "body": _clip(p.get("body") or "", 4000),
    }


def _a_pulls(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    state = str(payload.get("state") or "open")
    rows = _paginate(token, f"/repos/{full}/pulls", {"state": state, "sort": "updated", "direction": "desc"})
    return {"ok": True, "action": "pulls", "space_id": space_id, "repo": full, "state": state,
            "pulls": [_pull_row(p) for p in rows if isinstance(p, dict)]}


def _a_get_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    number = _number(payload)
    return {"ok": True, "action": "get_pull", "space_id": space_id, "repo": full,
            "pull": _pull_row(_api("GET", f"/repos/{full}/pulls/{number}", token))}


def _a_create_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    head, base, title = (str(payload.get("head") or "").strip(),
                         str(payload.get("base") or "").strip(),
                         str(payload.get("title") or "").strip())
    if not head or not base or not title:
        raise GithubError("create_pull needs `title`, `head` and `base`")
    body: Dict[str, Any] = {"title": title, "head": head, "base": base}
    if payload.get("body"):
        body["body"] = str(payload["body"])
    if payload.get("draft") is not None:
        body["draft"] = bool(payload["draft"])
    return {"ok": True, "action": "create_pull", "space_id": space_id, "repo": full,
            "pull": _pull_row(_api("POST", f"/repos/{full}/pulls", token, body=body))}


def _a_merge_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    number = _number(payload)
    body: Dict[str, Any] = {}
    method = str(payload.get("merge_method") or payload.get("method") or "merge").lower()
    if method in ("merge", "squash", "rebase"):
        body["merge_method"] = method
    for key in ("commit_title", "commit_message"):
        if payload.get(key):
            body[key] = str(payload[key])
    res = _api("PUT", f"/repos/{full}/pulls/{number}/merge", token, body=body)
    return {"ok": bool(res.get("merged")), "action": "merge_pull", "space_id": space_id,
            "repo": full, "number": number, "merged": res.get("merged"),
            "sha": res.get("sha"), "message": res.get("message")}


def _a_update_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    number = _number(payload)
    body: Dict[str, Any] = {}
    for key in ("title", "body", "state", "base"):
        if payload.get(key) is not None:
            body[key] = str(payload[key])
    if not body:
        raise GithubError("update_pull needs at least one of title, body, state, base")
    return {"ok": True, "action": "update_pull", "space_id": space_id, "repo": full,
            "pull": _pull_row(_api("PATCH", f"/repos/{full}/pulls/{number}", token, body=body))}


def _a_issues(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    state = str(payload.get("state") or "open")
    rows = _paginate(token, f"/repos/{full}/issues", {"state": state, "sort": "updated", "direction": "desc"})
    out = []
    for i in rows if isinstance(rows, list) else []:
        if not isinstance(i, dict) or i.get("pull_request"):
            continue  # the issues endpoint also returns PRs; drop them
        out.append({"number": i.get("number"), "title": i.get("title"), "state": i.get("state"),
                    "user": (i.get("user") or {}).get("login"), "comments": i.get("comments"),
                    "html_url": i.get("html_url"),
                    "labels": [l.get("name") for l in (i.get("labels") or []) if isinstance(l, dict)]})
    return {"ok": True, "action": "issues", "space_id": space_id, "repo": full, "state": state, "issues": out}


def _a_create_issue(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    title = str(payload.get("title") or "").strip()
    if not title:
        raise GithubError("create_issue needs a `title`")
    body: Dict[str, Any] = {"title": title}
    if payload.get("body"):
        body["body"] = str(payload["body"])
    if isinstance(payload.get("labels"), list):
        body["labels"] = [str(l) for l in payload["labels"]]
    i = _api("POST", f"/repos/{full}/issues", token, body=body)
    return {"ok": True, "action": "create_issue", "space_id": space_id, "repo": full,
            "number": i.get("number"), "html_url": i.get("html_url")}


# --------------------------------------------------------------------------- #
# Git operations on a per-space workspace
# --------------------------------------------------------------------------- #

def _full_name(payload: Dict[str, Any]) -> str:
    """The ``owner/repo`` slug, from an explicit field or owner+repo pair."""
    full = str(payload.get("repo") or payload.get("full_name") or "").strip()
    if "/" in full:
        owner, name = full.split("/", 1)
        return f"{_slug(owner)}/{_slug(name)}"
    owner = str(payload.get("owner") or payload.get("org") or "").strip()
    name = str(payload.get("name") or full).strip()
    if not owner or not name:
        raise GithubError("a repository is required as `repo` = \"owner/name\" (or owner + name)")
    return f"{_slug(owner)}/{_slug(name)}"


def _slug(s: str) -> str:
    """A GitHub owner/repo/branch component with path + shell metacharacters
    stripped, so a forged value can never escape a filesystem path or an argv."""
    cleaned = _UNSAFE.sub("", str(s).strip())
    if not cleaned:
        raise GithubError(f"invalid name component: {s!r}")
    return cleaned


def _number(payload: Dict[str, Any]) -> int:
    for key in ("number", "pull_number", "issue_number", "pr"):
        val = payload.get(key)
        if val not in (None, ""):
            try:
                return int(val)
            except (TypeError, ValueError):
                raise GithubError(f"{key} must be a number")
    raise GithubError("a pull request / issue number is required")


def _space_dir(space_id: str) -> str:
    return os.path.join(WORKSPACE, _UNSAFE.sub("-", space_id).strip("-") or "space")


def _repo_dir(space_id: str, full: str) -> str:
    return os.path.join(_space_dir(space_id), full.replace("/", "__"))


def _auth_header(token: str) -> str:
    """The ``http.extraheader`` value that authenticates git without ever writing
    the token into the repo's stored remote URL or config."""
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return f"AUTHORIZATION: basic {basic}"


def _git(space_id: str, full: str, token: str, args: List[str], *,
         cwd: Optional[str] = None, timeout: Optional[int] = None) -> Dict[str, Any]:
    """Run one git command with the token injected per-invocation.

    The token rides in ``-c http.extraheader`` (never in the URL or on disk) and
    a fixed identity is pinned so commits an agent makes are attributable."""
    directory = cwd or _repo_dir(space_id, full)
    base = [
        "git",
        "-c", f"http.{WEB_BASE}/.extraheader={_auth_header(token)}",
        "-c", "credential.helper=",
        "-c", "user.name=Decillion GitHub Tool",
        "-c", "user.email=github-tool@decillion.local",
        "-c", "safe.directory=*",
    ]
    try:
        proc = subprocess.run(base + args, cwd=directory if os.path.isdir(directory) else None,
                              capture_output=True, text=True, timeout=timeout or GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise GithubError(f"git {' '.join(args[:2])} timed out after {timeout or GIT_TIMEOUT}s", status=504)
    except FileNotFoundError:
        raise GithubError("git is not installed in the creature image", status=500)
    out = _clip(proc.stdout or "")
    # Never echo the Authorization header back if git logged the argv.
    err = _clip((proc.stderr or "").replace(_auth_header(token), "AUTHORIZATION: basic ***"))
    return {"exit_code": proc.returncode, "stdout": out, "stderr": err}


def _a_clone(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    directory = _repo_dir(space_id, full)
    os.makedirs(_space_dir(space_id), exist_ok=True)
    url = f"{WEB_BASE}/{full}.git"
    if os.path.isdir(os.path.join(directory, ".git")):
        res = _git(space_id, full, token, ["fetch", "--all", "--prune"])
        cloned = False
    else:
        args = ["clone"]
        if payload.get("depth"):
            args += ["--depth", str(int(payload["depth"]))]
        if payload.get("branch"):
            args += ["--branch", _slug(payload["branch"])]
        args += [url, directory]
        res = _git(space_id, full, token, args, cwd=_space_dir(space_id))
        cloned = True
    if res["exit_code"] != 0:
        raise GithubError(f"git clone/fetch failed: {res['stderr'] or res['stdout']}", status=502)
    return {"ok": True, "action": "clone", "space_id": space_id, "repo": full,
            "path": directory, "cloned": cloned, "output": res["stderr"] or res["stdout"]}


def _ensure_cloned(space_id: str, full: str) -> str:
    directory = _repo_dir(space_id, full)
    if not os.path.isdir(os.path.join(directory, ".git")):
        raise GithubError(f"{full} is not cloned into this space yet — clone it first", status=409)
    return directory


def _a_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    args = ["pull", "origin"] + ([_slug(payload["branch"])] if payload.get("branch") else [])
    res = _git(space_id, full, token, args)
    return {"ok": res["exit_code"] == 0, "action": "pull", "space_id": space_id, "repo": full,
            "exit_code": res["exit_code"], "stdout": res["stdout"], "stderr": res["stderr"]}


def _a_fetch(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    res = _git(space_id, full, token, ["fetch", "--all", "--prune"])
    return {"ok": res["exit_code"] == 0, "action": "fetch", "space_id": space_id, "repo": full,
            "exit_code": res["exit_code"], "stdout": res["stdout"], "stderr": res["stderr"]}


def _a_commit(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    message = str(payload.get("message") or "").strip()
    if not message:
        raise GithubError("commit needs a `message`")
    add_args = ["add"]
    files = payload.get("files")
    if isinstance(files, list) and files:
        add_args += ["--"] + [str(f) for f in files]
    else:
        add_args.append("-A")
    add = _git(space_id, full, token, add_args)
    if add["exit_code"] != 0:
        raise GithubError(f"git add failed: {add['stderr']}", status=502)
    commit = _git(space_id, full, token, ["commit", "-m", message])
    return {"ok": commit["exit_code"] == 0, "action": "commit", "space_id": space_id, "repo": full,
            "exit_code": commit["exit_code"], "stdout": commit["stdout"], "stderr": commit["stderr"]}


def _a_push(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    if payload.get("branch"):
        args = ["push", "origin", _slug(payload["branch"])]
    elif payload.get("set_upstream"):
        args = ["push", "-u", "origin", "HEAD"]
    else:
        args = ["push", "origin", "HEAD"]
    if payload.get("force"):
        args.insert(1, "--force-with-lease")
    res = _git(space_id, full, token, args)
    if res["exit_code"] != 0:
        raise GithubError(f"git push failed: {res['stderr'] or res['stdout']}", status=502)
    return {"ok": True, "action": "push", "space_id": space_id, "repo": full,
            "stdout": res["stdout"], "stderr": res["stderr"]}


def _a_checkout(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    branch = str(payload.get("branch") or "").strip()
    if not branch:
        raise GithubError("checkout needs a `branch`")
    args = ["checkout"]
    if payload.get("create"):
        args.append("-b")
    args.append(_slug(branch))
    if payload.get("start_point"):
        args.append(_slug(payload["start_point"]))
    res = _git(space_id, full, token, args)
    if res["exit_code"] != 0:
        raise GithubError(f"git checkout failed: {res['stderr'] or res['stdout']}", status=502)
    return {"ok": True, "action": "checkout", "space_id": space_id, "repo": full, "branch": branch,
            "stdout": res["stdout"], "stderr": res["stderr"]}


def _a_merge(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    branch = str(payload.get("branch") or payload.get("from") or "").strip()
    if not branch:
        raise GithubError("merge needs a `branch` to merge in")
    res = _git(space_id, full, token, ["merge", _slug(branch)])
    return {"ok": res["exit_code"] == 0, "action": "merge", "space_id": space_id, "repo": full,
            "exit_code": res["exit_code"], "stdout": res["stdout"], "stderr": res["stderr"]}


def _a_git_status(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    st = _git(space_id, full, token, ["status", "--porcelain=v1", "--branch"])
    branch = _git(space_id, full, token, ["rev-parse", "--abbrev-ref", "HEAD"])
    body_lines = [ln for ln in (st["stdout"] or "").splitlines() if not ln.startswith("##")]
    return {"ok": True, "action": "git_status", "space_id": space_id, "repo": full,
            "branch": (branch["stdout"] or "").strip(),
            "status": st["stdout"], "dirty": bool(body_lines)}


def _a_git_log(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    _ensure_cloned(space_id, full)
    n = int(payload.get("limit") or 20)
    res = _git(space_id, full, token, ["log", f"-{n}", "--pretty=format:%h%x09%an%x09%ad%x09%s", "--date=short"])
    commits = []
    for line in (res["stdout"] or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 4:
            commits.append({"sha": parts[0], "author": parts[1], "date": parts[2], "message": parts[3]})
    return {"ok": True, "action": "git_log", "space_id": space_id, "repo": full, "commits": commits}


def _a_list_cloned(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_use(space_id, payload)
    base = _space_dir(space_id)
    repos: List[Dict[str, Any]] = []
    if os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            directory = os.path.join(base, name)
            if os.path.isdir(os.path.join(directory, ".git")):
                repos.append({"repo": name.replace("__", "/"), "path": directory})
    return {"ok": True, "action": "list_cloned", "space_id": space_id, "repos": repos, "count": len(repos)}


def _safe_join(directory: str, rel: str) -> str:
    target = os.path.realpath(os.path.join(directory, rel))
    if target != os.path.realpath(directory) and not target.startswith(os.path.realpath(directory) + os.sep):
        raise GithubError("path escapes the repository", status=400)
    return target


def _a_read_file(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_use(space_id, payload)
    full = _full_name(payload)
    directory = _ensure_cloned(space_id, full)
    rel = str(payload.get("path") or "").strip()
    if not rel:
        raise GithubError("read_file needs a `path`")
    target = _safe_join(directory, rel)
    if not os.path.isfile(target):
        raise GithubError(f"no such file: {rel}", status=404)
    with open(target, "rb") as fh:
        data = fh.read(MAX_READ_BYTES)
    try:
        return {"ok": True, "action": "read_file", "space_id": space_id, "repo": full, "path": rel,
                "content": _clip(data.decode("utf-8")), "encoding": "text", "bytes": len(data)}
    except UnicodeDecodeError:
        return {"ok": True, "action": "read_file", "space_id": space_id, "repo": full, "path": rel,
                "content": base64.b64encode(data).decode("ascii"), "encoding": "base64", "bytes": len(data)}


def _a_write_file(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_use(space_id, payload)
    full = _full_name(payload)
    directory = _ensure_cloned(space_id, full)
    rel = str(payload.get("path") or "").strip()
    if not rel:
        raise GithubError("write_file needs a `path`")
    target = _safe_join(directory, rel)
    content = payload.get("content", "")
    if str(payload.get("encoding") or "text").lower() == "base64":
        data = base64.b64decode(content or "")
    else:
        data = str(content).encode("utf-8")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as fh:
        fh.write(data)
    return {"ok": True, "action": "write_file", "space_id": space_id, "repo": full, "path": rel,
            "bytes": len(data)}


def _a_list_dir(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Structured listing of a directory inside a cloned repo, for the UI."""
    _require_use(space_id, payload)
    full = _full_name(payload)
    directory = _ensure_cloned(space_id, full)
    rel = str(payload.get("path") or ".").strip() or "."
    target = _safe_join(directory, rel)
    if not os.path.isdir(target):
        raise GithubError("not a directory", status=404)
    entries = []
    for name in os.listdir(target):
        if name == ".git":
            continue
        p = os.path.join(target, name)
        is_dir = os.path.isdir(p)
        entries.append({"name": name, "type": "dir" if is_dir else "file",
                        "size": 0 if is_dir else os.path.getsize(p)})
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    return {"ok": True, "action": "list_dir", "space_id": space_id, "repo": full, "path": rel,
            "entries": entries, "count": len(entries)}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _clip(text: Optional[str], limit: int = MAX_OUTPUT_CHARS) -> str:
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated, {len(text) - limit} more chars]"


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

_ACTIONS = {
    # connection / oauth
    "oauth_start": _oauth_start, "connect": _oauth_start,
    "oauth_poll": _oauth_poll, "poll": _oauth_poll,
    "status": _status, "connection": _status,
    "disconnect": _disconnect, "logout": _disconnect,
    "set_shared": _set_shared, "settings": _set_shared,
    # github api (read)
    "orgs": _a_orgs, "repos": _a_repos, "list_repos": _a_repos, "repo": _a_repo,
    "branches": _a_branches, "commits": _a_commits,
    "pulls": _a_pulls, "list_pulls": _a_pulls, "get_pull": _a_get_pull, "pr": _a_get_pull,
    "issues": _a_issues,
    # github api (write)
    "create_pull": _a_create_pull, "open_pr": _a_create_pull,
    "merge_pull": _a_merge_pull, "merge_pr": _a_merge_pull,
    "update_pull": _a_update_pull, "create_issue": _a_create_issue,
    # git (local per-space workspace)
    "clone": _a_clone, "pull": _a_pull, "git_pull": _a_pull, "fetch": _a_fetch,
    "push": _a_push, "commit": _a_commit,
    "checkout": _a_checkout, "branch": _a_checkout, "merge": _a_merge,
    "git_status": _a_git_status, "status_repo": _a_git_status, "git_log": _a_git_log,
    "list_cloned": _a_list_cloned,
    "read_file": _a_read_file, "write_file": _a_write_file,
    "list_dir": _a_list_dir, "ls": _a_list_dir,
}


def _normalize_action(function_name: str, payload: Dict[str, Any]) -> str:
    for candidate in (payload.get("action"), payload.get("function"), function_name):
        if isinstance(candidate, str) and candidate.strip() and candidate.strip() != "invoke":
            return candidate.strip().lower()
    return "status"


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    handler = _ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": f"unknown action '{action}'", "actions": sorted(set(_ACTIONS))}
    try:
        space_id = _space_id(payload)
        return handler(space_id, payload)
    except GithubError as exc:
        return {"ok": False, "action": action, "error": str(exc), "status": exc.status or None}
    except Exception as exc:  # noqa: BLE001 — never crash the serving loop
        return {"ok": False, "action": action, "error": f"{type(exc).__name__}: {exc}"}
