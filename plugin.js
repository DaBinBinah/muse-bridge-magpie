// MuseBridge provider plugin for Magpie / OpenCode.
//
// MuseBridge (https://github.com/DaBinBinah/muse-bridge) is an OpenAI-compatible
// reverse proxy for muse.ai. It already speaks Chat Completions, so this plugin
// does exactly one thing: forward the gateway's requests to the user's running
// MuseBridge server with the right Authorization header, and refresh the model
// list from the server's /v1/models.
//
// Contract notes (https://usemagpie.ai/docs/zh/plugins):
// - Only the plugin entry and the _internal test object are exported; every
//   exported function would otherwise be treated as a plugin.
// - config uses ??= so user configuration is never overwritten.
// - Error statuses pass through unchanged: MuseBridge already maps 401 to bad
//   credentials, 404 to model rejection and 429/5xx to failover.
// - The streamed body is forwarded as-is (only content-length/content-encoding
//   are dropped from the synthesized response headers).

const PROVIDER_ID = "musebridge";
const DEFAULT_BASE = "http://127.0.0.1:18610";
const CONTEXT_LIMIT = 131072;
const OUTPUT_LIMIT = 16384;

// muse.ai model limits are not published; conservative OpenAI-class defaults.
const MODEL_LIMIT = { context: CONTEXT_LIMIT, output: OUTPUT_LIMIT };

// Chat models MuseBridge exposes (image/video models are left out: Magpie's
// chat gateway cannot use them, and selecting them would only produce a 404).
// MuseBridge also routes unknown model ids to muse-chat, so anything new the
// server lists is kept by mapModels() rather than hidden.
const CHAT_BASE = {
  "muse-chat": { name: "Muse Chat (默认)", limit: MODEL_LIMIT, tool_call: true },
  "gpt-4o": { name: "gpt-4o → Muse Chat", limit: MODEL_LIMIT, tool_call: true },
  "gpt-4o-mini": { name: "gpt-4o-mini → Muse Chat", limit: MODEL_LIMIT, tool_call: true },
  "gpt-4.1": { name: "gpt-4.1 → Muse Chat", limit: MODEL_LIMIT, tool_call: true },
  "gpt-5": { name: "gpt-5 → Muse Chat", limit: MODEL_LIMIT, tool_call: true },
  "claude-sonnet-4": { name: "claude-sonnet-4 → Muse Chat", limit: MODEL_LIMIT, tool_call: true },
  "deepseek-chat": { name: "deepseek-chat → Muse Chat", limit: MODEL_LIMIT, tool_call: true },
};

// Known non-chat models on /v1/models — dropped from the plugin's catalog.
const NON_CHAT = new Set(["muse-image", "muse-video", "dall-e-3", "gpt-image-1", "sora"]);

export const MuseBridge = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER_ID] ??= {
      name: "MuseBridge (muse.ai)",
      npm: "@ai-sdk/openai-compatible",
      models: _internal.staticModels(),
    };
  },

  auth: {
    provider: PROVIDER_ID,
    methods: [{
      type: "api",
      label: "MuseBridge API Key",
      placeholder: "m2a-…（管理面板或服务端 data/api_key 里取）",
      prompts: [{
        type: "text",
        key: "baseURL",
        message: "MuseBridge 服务地址（回车用默认）",
        placeholder: DEFAULT_BASE,
        validate: (v) => (_internal.normalizeBase(v) === null
          ? "需为 http(s):// 开头的服务地址"
          : undefined),
      }],
    }],
    loader: async (getAuth) => {
      const auth = await getAuth();
      if (!auth?.key) return {};
      const ctx = _internal.resolveCtx(auth);
      if (!ctx) return {};
      return { baseURL: `${ctx.base}/v1`, fetch: _internal.bridgeFetch.bind(ctx) };
    },
  },

  provider: {
    id: PROVIDER_ID,
    async models(provider, { auth } = {}) {
      const ctx = auth ? _internal.resolveCtx(auth) : null;
      if (!ctx) return provider.models;
      try {
        const res = await fetch(`${ctx.base}/v1/models`, {
          headers: { Authorization: `Bearer ${ctx.key}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`/v1/models ${res.status}`);
        const body = await res.json();
        const mapped = _internal.mapModels(body?.data ?? [], provider.models);
        return mapped ?? provider.models; // empty/absent list → static catalog
      } catch {
        // 上游 ping 失败时保留静态目录（契约约定：原样返回 provider.models）。
        return provider.models;
      }
    },
  },
});

export const _internal = {
  DEFAULT_BASE,
  PROVIDER_ID,

  /** Trim a server address; empty → default. Returns null when not http(s). */
  normalizeBase(v) {
    const s = String(v ?? "").trim().replace(/\/+$/, "");
    if (!s) return DEFAULT_BASE;
    return /^https?:\/\/.+/i.test(s) ? s : null;
  },

  /** Non-empty, no whitespace — enough for a bearer token. */
  isValidKey(v) {
    return typeof v === "string" && v.length > 0 && !/\s/.test(v);
  },

  /** {key, metadata} → {base, key} or null when the key is unusable. */
  resolveCtx(auth) {
    const key = auth?.key;
    if (!_internal.isValidKey(key)) return null;
    const base = _internal.normalizeBase(auth?.metadata?.baseURL);
    return base ? { base, key } : null;
  },

  staticModels() {
    const out = {};
    for (const [id, m] of Object.entries(CHAT_BASE)) {
      out[id] = { ...m, limit: { ...m.limit } };
    }
    return out;
  },

  /** /v1/models rows → catalog entries, reusing base entries for known ids.
   * An empty/absent list (server hiccup, future version) falls back to the
   * static catalog rather than wiping the model picker. */
  mapModels(list, base = {}) {
    if (!Array.isArray(list) || !list.length) return null; // caller falls back
    const out = {};
    for (const row of list) {
      const id = typeof row === "string" ? row : row?.id;
      if (!id || NON_CHAT.has(id) || out[id]) continue;
      out[id] = base[id]
        ? { ...base[id], limit: { ...base[id].limit } }
        : { name: `${id} → Muse Chat`, limit: { ...MODEL_LIMIT }, tool_call: true };
    }
    return out;
  },

  /** Gateway headers + our Authorization; never log them. */
  forwardHeaders(init, key) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    return headers;
  },

  /** Response headers safe to re-emit (no length/encoding after body reuse). */
  sanitizeHeaders(headers) {
    const h = new Headers(headers);
    h.delete("content-length");
    h.delete("content-encoding");
    return h;
  },

  errorResponse(status, message, code) {
    return new Response(
      JSON.stringify({ error: { message, type: "bridge_error", code } }),
      { status, headers: { "content-type": "application/json" } },
    );
  },

  /**
   * Custom fetch installed by the loader. `this` = {base, key}.
   * Network failures become a 502 (5xx → the gateway may fail over) with a
   * human-readable message; upstream error statuses pass through untouched.
   */
  async bridgeFetch(input, init) {
    let upstream;
    try {
      upstream = await fetch(input, {
        ...init,
        headers: _internal.forwardHeaders(init, this.key),
      });
    } catch (err) {
      if (init?.signal?.aborted || err?.name === "AbortError") throw err;
      return _internal.errorResponse(
        502,
        `无法连接 MuseBridge 服务（${this.base}）：${err?.message ?? err}。`
          + "请确认 muse2api 已启动（python -m muse2api）。",
        "bridge_unreachable",
      );
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: _internal.sanitizeHeaders(upstream.headers),
    });
  },
};
