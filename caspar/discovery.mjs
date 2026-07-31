/**
 * Live in-space discovery: what tools, apps, creatures and sub-agents does this
 * space contain, fetched from the node **at prompt time**.
 *
 * The Decillion backend already sends a `config.tools` catalog with each prompt
 * (its `DiscoveryService`: the space's member programs, each paired with the
 * creature's `public.decillion` descriptor metadata). This module lets the
 * creature fetch that same set itself, directly over the gateway, so it is not
 * blind when the backend sends a thin catalog and so the model always sees the
 * space's live roster of employable creatures — the user asked for the agent to
 * "see all the tools, agents and creatures in the space by first fetching their
 * list each time it is prompted."
 *
 * It mirrors `DiscoveryService.catalogForSpace` exactly, but from inside the
 * container using the node's unified host functions (see the node's
 * `vm_host_functions.rs`, reachable from a docker creature via the gateway):
 *
 *   1. `readMembers` (aka `listStoreMembers` / `listStoreAccess`) on the space
 *      store → the member creatures/programs (routing ids only — the node's
 *      store listing carries no descriptors);
 *   2. `getCreature` per member → the creature's metadata, whose
 *      `public.decillion` block is the descriptor (usecases, how-to-talk, arg
 *      schema, kind: tool | agent | frontend).
 *
 * Everything here is **best-effort and defensive**: a space id it cannot resolve,
 * a host op the node does not expose, or an unexpected response shape all yield
 * an empty list — never an exception and never a broken prompt. The result is
 * *merged into* `config.tools` (which stays authoritative, because it carries the
 * platform-pinned `defaults` such as the bound `space_id`); discovery only adds
 * creatures the backend did not already send. See `catalog.mergeCatalogs`.
 */

/** Resolve the space (Caspar store) id for this task, or "" when there is none. */
export function resolveSpaceId(task) {
  const direct = task?.spaceId || task?.storeId || task?.space_id || task?.store_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // The backend's session id is `space:<spaceId>:<agentId|orbit>`.
  const session = task?.sessionId || task?.session_id;
  if (typeof session === "string") {
    const m = session.match(/^space:([^:]+):/);
    if (m) return m[1];
  }
  return "";
}

/** First array found under any of `keys` on `obj` (host responses vary in shape). */
function firstArray(obj, keys) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object") return [];
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  // A nested single wrapper (`{ result: { members: [...] } }`).
  for (const k of ["result", "data", "obj", "value"]) {
    if (obj[k] && typeof obj[k] === "object") {
      const nested = firstArray(obj[k], keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/** Normalise one store-member record into `{ creatureId, programId, entityId }`. */
function memberRouting(entry) {
  if (!entry || typeof entry !== "object") return null;
  const creatureId = pick(entry, ["creatureId", "creature_id", "userId", "user_id", "id"]);
  const programId = pick(entry, ["programId", "program_id", "pid"]);
  const entityId = pick(entry, ["entityId", "entity_id"]);
  if (!creatureId && !programId) return null;
  return { creatureId, programId, entityId };
}

/**
 * Pull a `public.decillion` (or `decillion`) descriptor out of whatever shape a
 * `getCreature` response takes — the record may nest metadata under `obj`,
 * `meta`, `metadata`, `public`, or be the descriptor object itself.
 */
export function extractDescriptor(resp) {
  if (!resp || typeof resp !== "object") return undefined;
  const roots = [resp, resp.obj, resp.meta, resp.metadata, resp.result, resp.data, resp.creature, resp.record].filter(
    (r) => r && typeof r === "object",
  );
  for (const root of roots) {
    const d = root?.public?.decillion || root?.decillion || (root?.kind && Array.isArray(root?.usecases) ? root : undefined);
    if (d && typeof d === "object" && d.kind) return d;
  }
  return undefined;
}

/** Build the human/LLM description from a descriptor (usecases + how-to-talk). */
function describeDescriptor(d) {
  const uses = Array.isArray(d.usecases) && d.usecases.length ? `Use when: ${d.usecases.join("; ")}.` : "";
  const how = d.howToTalk ? ` How to talk to it: ${d.howToTalk}` : "";
  return `${uses}${how}`.trim() || String(d.name || "creature");
}

/**
 * A `config.tools`-shaped catalog entry from a descriptor + routing ids, matching
 * `descriptor.toCatalogEntry` in the backend so `catalog.buildToolDefinitions`
 * consumes it identically. No platform `defaults` are known on-chain (those are
 * backend-injected), so a discovered entry never *replaces* a backend one that
 * carries them — it only fills a gap.
 */
export function entryFromDescriptor(d, routing) {
  const kind = d.kind === "agent" || d.kind === "frontend" ? d.kind : "tool";
  const argSchema = d.argSchema || (kind === "agent" ? { prompt: { type: "string", description: "the request for this sub-agent" } } : {});
  const entityId = routing.entityId || (kind === "agent" ? "agent" : "main");
  return {
    name: String(d.name || routing.programId || routing.creatureId || "creature"),
    kind,
    category: d.category || (kind === "agent" ? "agent" : "general"),
    description: describeDescriptor(d),
    arg_schema: argSchema,
    ...(Array.isArray(d.requiredArgs) ? { required: d.requiredArgs } : {}),
    ...(d.function ? { function: d.function } : {}),
    requires_network: !!d.requiresNetwork,
    risk: d.risk || "low",
    // Routing ids in the snake_case shape catalog.mjs + toolInvoker.mjs read.
    tool_id: routing.programId || routing.creatureId,
    program_id: routing.programId,
    creature_id: routing.creatureId,
    entity_id: entityId,
    discovered: true,
  };
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Fetch the space's employable creatures from the node, as catalog entries.
 *
 * @param bridge  connected `CasparBridgeClient` (null → returns []).
 * @param task    the decoded task (for the space id).
 * @param opts    `{ timeoutMs, maxMembers, log }`.
 * @returns catalog entries (possibly empty). Never throws.
 */
export async function discoverSpaceCatalog(bridge, task, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  if (!bridge || typeof bridge.call !== "function") return [];
  const spaceId = resolveSpaceId(task);
  if (!spaceId) return [];

  const timeoutMs = num(opts.timeoutMs, num(process.env.CLAUDE_CREATURE_DISCOVER_TIMEOUT_MS, 8000));
  const maxMembers = num(opts.maxMembers, num(process.env.CLAUDE_CREATURE_DISCOVER_MAX, 50));

  // 1) Members of the space store. Op + store-id field names vary by node build;
  //    try the known aliases and pass every id spelling — the node ignores extras.
  let members = [];
  const idInput = { storeId: spaceId, id: spaceId, store: spaceId, storeID: spaceId };
  for (const op of ["readMembers", "listStoreMembers", "listStoreAccess", "listAccess"]) {
    try {
      const resp = await bridge.call(op, idInput, { timeoutMs });
      const list = firstArray(resp, ["members", "list", "access", "creatures", "results", "items", "entries"])
        .map(memberRouting)
        .filter(Boolean);
      if (list.length) {
        members = list;
        break;
      }
      // An explicit ok:false means the op exists but rejected — stop guessing ops.
      if (resp && typeof resp === "object" && resp.ok === false && !/unknown|unsupported|not.*found/i.test(String(resp.error || ""))) {
        break;
      }
    } catch {
      /* try the next alias */
    }
  }
  if (!members.length) {
    log({ space: spaceId, members: 0 });
    return [];
  }

  // De-dup members by creature+program, cap the count.
  const seen = new Set();
  const unique = [];
  for (const m of members) {
    const key = `${m.creatureId}|${m.programId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
    if (unique.length >= maxMembers) break;
  }

  // 2) Descriptor per member (parallel, each bounded by the same timeout).
  const settled = await Promise.all(
    unique.map(async (m) => {
      if (!m.creatureId) return null;
      try {
        const resp = await bridge.call("getCreature", { userId: m.creatureId, creatureId: m.creatureId }, { timeoutMs });
        const descriptor = extractDescriptor(resp);
        if (!descriptor) return null; // no decillion descriptor → not an employable creature
        return entryFromDescriptor(descriptor, m);
      } catch {
        return null;
      }
    }),
  );

  const entries = settled.filter(Boolean);
  log({ space: spaceId, members: unique.length, discovered: entries.length });
  return entries;
}
