# github — the space's git + GitHub client creature

A Davinci tool creature (Caspar `docker` entity) that gives a Decillion **space a
full GitHub client**: a human member connects a GitHub account, then everyone the
member allows — people **and** the space's agents — can browse organizations and
repositories and drive git and GitHub (clone, branch, commit, push, pull, merge,
open/merge pull requests, manage issues).

```
Victor "GitHub" mini-app ──host.call──▶ Nest ──signal(as the user)──▶ github creature ──▶ GitHub
     (the space desktop)                (space_id pinned)                  │  git + REST API
space agents ──Davinci bridge──▶ signal(exec) ─────────────────────────────┘
```

One creature serves **every** space; the binding is per-space state (the OAuth
token one member connected), keyed by the space id, so nothing is deployed per
space and any space that adds the tool from its tool-management page gets it.

## Connecting (OAuth device flow)

The connect button uses GitHub's **Device Authorization flow**, which needs no
redirect URL, no callback server and no Victor hooks:

1. `oauth_start` → the creature asks GitHub for a device code and returns a
   `user_code` + `verification_uri`.
2. The front-end opens `https://github.com/login/device` in a browser tab (via
   the host's `host:openUrl` capability) and shows the code.
3. The user enters the code and grants the requested **account + organization**
   access.
4. The front-end polls `oauth_poll`; the creature exchanges the device code for a
   token, stores it, and the UI flips to the dashboard.

The member who started the flow **owns** the connection.

## Sharing

A per-space **shared** toggle (owner-only, `set_shared`) decides who may *use* the
connection:

- **private** (default) — only the member who connected it. Every other caller,
  human or agent, is refused with a clear message.
- **shared** — everyone in the space, including the agents, may drive it.

`status` is always readable (so the UI can show "connected as …"); only *using*
the connection is gated. Only the owner can flip sharing or disconnect.

## Actions

| function | what it does |
|---|---|
| `status` | connection state, account, sharing, and whether the caller may use/manage it |
| `oauth_start` / `oauth_poll` | device-flow connect (front-end) |
| `set_shared` / `disconnect` | owner-only settings |
| `orgs` | the connected user + the orgs they granted |
| `repos` | repositories (optionally scoped to an `org`) |
| `repo` / `branches` / `commits` | repository detail, branches, commits |
| `pulls` / `get_pull` / `create_pull` / `merge_pull` / `update_pull` | pull requests |
| `issues` / `create_issue` | issues |
| `clone` | clone a repo into the space (idempotent) |
| `pull` / `push` / `fetch` | sync a clone with origin |
| `commit` | stage + commit (`message`, optional `files`) |
| `checkout` / `branch` / `merge` | branch + merge in the clone |
| `git_status` / `git_log` | clone state |
| `read_file` / `write_file` / `list_dir` / `list_cloned` | files in the clone |

Every action requires `space_id`, pinned by Nest for front-end calls and by the
space membership for agents — a caller can never name another space.

Git authenticates with the token injected per-invocation via `http.extraheader`,
so the token is **never** written into a repo's stored remote or config, and it
is scrubbed from any git output echoed back.

## The front-end (the space desktop)

The tool has **two parts on one program**: this docker back-end (entity
`github`) and a downloadable Victor mini-app **front-end** (entity `frontend`,
`frontend/dashboard.js`). The front-end is an Elpian-based JS app that runs in the
Decillion client's Victor host — the space "desktop" — not on the node.
`deploy_github_tool.py` deploys it as a `downloadable` `javascript` entity right
after the back-end, so any space with the tool gets its UI for free.

It reaches this back-end over the client's **host bridge**: it calls
`hostCall("<function>", args, cb)`, the client signs the matching Caspar signal
with the **human user's** identity (pinning `space_id`) and returns the reply. To
open the GitHub authorization page it calls the client capability
`hostCall("host:openUrl", { url })`, handled by the client rather than the
back-end (see `new-decillion` `VictorDesktop`).

## Configuration

Credentials are read from the **container environment only** — never from the
signal payload, so a prompt-injected agent cannot swap the OAuth app.

| env | meaning |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | the GitHub OAuth App / GitHub App client id (device flow **must** be enabled on it) |
| `GITHUB_OAUTH_CLIENT_SECRET` | optional — device-flow public apps omit it |
| `GITHUB_OAUTH_SCOPES` | default `repo,read:org,workflow,read:user` |
| `GITHUB_API_BASE` | default `https://api.github.com` (set for GitHub Enterprise) |
| `GITHUB_WEB_BASE` | default `https://github.com` |
| `GITHUB_MAX_OUTPUT` | chars of git/API output returned (60000) |
| `GITHUB_GIT_TIMEOUT_S` | per-git-command timeout (600) |

State survives the container in the node's key/value store (over the docker-host
bridge); a node whose `dbOp` is unavailable falls back to a JSON file under
`GITHUB_WORKSPACE` (`/workspace`), so the tool always works and is durable when
the store is present.

Deploy it with `scripts/deploy_github_tool.py`, which bakes those values into the
creature image and prints the ids Nest needs. `ci-deploy.sh` runs it whenever a
`GITHUB_OAUTH_CLIENT_ID` is configured, and the deployer records it in the
manifest under `davinci.tools["github"]` so it appears on the space tool-manager.
