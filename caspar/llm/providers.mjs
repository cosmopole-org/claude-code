/**
 * The LLM providers a Decillion agent can name, and how to reach each.
 *
 * Decillion stores an optional `{provider, model, apiKey}` per agent and sends it
 * as `config.llm` with every prompt — exactly what davinci consumed. Claude Code
 * speaks the **Anthropic Messages API**; `anthropic` is therefore native (no
 * translation). The other four providers expose an **OpenAI-compatible Chat
 * Completions API**, so the creature reaches them through its built-in
 * Anthropic↔OpenAI translation proxy (`llmProxy.mjs`) — the agent just supplies
 * the provider, a model id, and a key.
 *
 * Base URLs are the providers' OpenAI-compatible endpoints; `/chat/completions`
 * is appended by the proxy. An agent may override the base with `llm.base_url`
 * (e.g. an Azure/OpenAI-compatible gateway), and an operator may override any
 * provider's base with `CLAUDE_CREATURE_LLM_BASE_<PROVIDER>`.
 */

/** provider id → config. `aliases` fold common spellings onto one entry. */
export const PROVIDERS = {
  anthropic: { native: true, aliases: ["claude", "claude-code", "claude_code"] },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    aliases: ["oai", "gpt", "chatgpt"],
    // The newest OpenAI models reject `max_tokens` and want `max_completion_tokens`.
    maxTokensField: "max_completion_tokens",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    aliases: ["open_router", "openrouter.ai", "or"],
    headers: { "X-Title": "Decillion Agent", "HTTP-Referer": "https://decillionai.com" },
  },
  gemini: {
    // Google's OpenAI-compatible surface. Accepts `Authorization: Bearer <key>`.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    aliases: ["google", "google-gemini", "googleai", "vertex-gemini"],
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    aliases: ["grok", "x-ai", "x.ai"],
  },
};

const ALIAS_TO_ID = (() => {
  const map = new Map();
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    map.set(id, id);
    for (const alias of cfg.aliases || []) map.set(alias, id);
  }
  return map;
})();

/** Canonical provider id for any accepted spelling, or `null` when unknown. */
export function resolveProviderId(name) {
  const key = String(name || "").trim().toLowerCase();
  return ALIAS_TO_ID.get(key) || null;
}

/**
 * Resolve everything the proxy needs to call a provider for one agent:
 * `{ id, native, baseUrl, headers, maxTokensField }`, or `null` when the provider
 * is unknown. `env` supplies per-provider base overrides; `baseUrlOverride` is the
 * agent's own `llm.base_url`.
 */
export function resolveProvider(name, { env = process.env, baseUrlOverride = "" } = {}) {
  const id = resolveProviderId(name);
  if (!id) return null;
  const cfg = PROVIDERS[id];
  if (cfg.native) return { id, native: true };
  const envBase = (env[`CLAUDE_CREATURE_LLM_BASE_${id.toUpperCase()}`] || "").trim();
  const baseUrl = (baseUrlOverride || envBase || cfg.baseUrl || "").replace(/\/+$/, "");
  return {
    id,
    native: false,
    baseUrl,
    headers: cfg.headers || {},
    maxTokensField: cfg.maxTokensField || "max_tokens",
  };
}

/** The set of non-native providers, for messages/help. */
export function proxiedProviderIds() {
  return Object.entries(PROVIDERS)
    .filter(([, c]) => !c.native)
    .map(([id]) => id);
}
