/* Chat Capsule v1.0 — AI Provider Abstraction Layer
   OpenAI-compatible interface that routes to:
     - Gemini (Google AI Studio / Vertex)
     - Ollama (local, OpenAI-compatible)
     - Any OpenAI-compatible endpoint (LM Studio, llama.cpp, LiteLLM gateway, etc.)
     - OpenAI directly
     - Anthropic Claude (via OpenAI-compatible compatibility layer or native)

   Principle: Chat Capsule never hard-couples to a specific provider.
   The core extension works without ANY AI provider.
   AI is purely optional enhancement.

   Security:
     - Keys are never committed to source
     - Keys are stored in chrome.storage.local (never extension code)
     - Raw conversation content is not logged
*/
"use strict";

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AIProvider = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Provider configurations                                              */
  /* ------------------------------------------------------------------ */

  const PROVIDERS = {
    gemini: {
      id: "gemini",
      name: "Google Gemini",
      protocol: "gemini",
      defaultModel: "gemini-1.5-flash",
      models: [
        { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", tier: "balanced" },
        { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", tier: "cheap" },
        { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", tier: "high-quality" },
      ],
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      requiresKey: true,
      local: false,
    },
    ollama: {
      id: "ollama",
      name: "Ollama (Local)",
      protocol: "openai-compatible",
      defaultModel: "llama3.2",
      models: [], // fetched dynamically
      baseUrl: "http://localhost:11434/v1",
      requiresKey: false,
      local: true,
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-compatible",
      defaultModel: "gpt-4o-mini",
      models: [
        { id: "gpt-4o-mini", name: "GPT-4o Mini", tier: "cheap" },
        { id: "gpt-4o", name: "GPT-4o", tier: "balanced" },
        { id: "o1-mini", name: "o1-mini", tier: "high-quality" },
      ],
      baseUrl: "https://api.openai.com/v1",
      requiresKey: true,
      local: false,
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic Claude",
      protocol: "anthropic",
      defaultModel: "claude-3-haiku-20240307",
      models: [
        { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", tier: "cheap" },
        { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", tier: "balanced" },
        { id: "claude-3-5-opus-20240229", name: "Claude 3 Opus", tier: "high-quality" },
      ],
      baseUrl: "https://api.anthropic.com",
      requiresKey: true,
      local: false,
    },
    custom: {
      id: "custom",
      name: "Custom Endpoint",
      protocol: "openai-compatible",
      defaultModel: "",
      models: [],
      baseUrl: "",
      requiresKey: false,
      local: false,
    },
    litellm: {
      id: "litellm",
      name: "LiteLLM Gateway",
      protocol: "openai-compatible",
      defaultModel: "",
      models: [],
      baseUrl: "http://localhost:4000/v1",
      requiresKey: false,
      local: false,
    },
  };

  /* ------------------------------------------------------------------ */
  /* Settings storage                                                     */
  /* ------------------------------------------------------------------ */

  const SETTINGS_KEY = "ai_provider_v1";

  async function loadSettings() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage) {
        const o = await chrome.storage.local.get(SETTINGS_KEY);
        return o[SETTINGS_KEY] || defaultSettings();
      }
    } catch (e) { /* offline / no chrome */ }
    return defaultSettings();
  }

  function defaultSettings() {
    return {
      providerId: "ollama",
      model: "llama3.2",
      customEndpoint: "",
      customModel: "",
      apiKey: "", // encrypted at rest via chrome.storage (not persisted in code)
      timeout: 30000,
      temperature: 0.3,
      maxOutputTokens: 2048,
      mode: "local-smart", // "disabled" | "local-smart" | "ai-enhanced"
    };
  }

  async function saveSettings(settings) {
    if (typeof chrome !== "undefined" && chrome.storage) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Core request helpers                                                 */
  /* ------------------------------------------------------------------ */

  function buildHeaders(providerId, apiKey, extra) {
    const h = { "Content-Type": "application/json", ...extra };
    if (apiKey) {
      if (providerId === "anthropic") {
        h["x-api-key"] = apiKey;
        h["anthropic-version"] = "2023-06-01";
      } else {
        h["Authorization"] = "Bearer " + apiKey;
      }
    }
    return h;
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Protocol: OpenAI-compatible (Ollama, LiteLLM, OpenAI, custom)       */
  /* ------------------------------------------------------------------ */

  async function callOpenAICompatible(baseUrl, apiKey, model, systemPrompt, userContent, opts) {
    opts = opts || {};
    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      max_tokens: opts.maxOutputTokens || 2048,
      stream: false,
    };
    if (opts.jsonSchema) {
      body.response_format = { type: "json_object" };
    }
    const res = await fetchWithTimeout(
      baseUrl.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: buildHeaders("openai", apiKey),
        body: JSON.stringify(body),
      },
      opts.timeout || 30000
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw Object.assign(new Error(`Provider returned ${res.status}: ${errText.slice(0, 200)}`), {
        code: res.status >= 429 ? "RATE_LIMIT" : res.status === 401 ? "AUTH_ERROR" : "PROVIDER_ERROR",
      });
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw Object.assign(new Error("Provider returned empty response"), { code: "INVALID_RESPONSE" });
    return {
      content,
      usage: data.usage || null,
      model: data.model || model,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Protocol: Gemini (Google Generative AI)                              */
  /* ------------------------------------------------------------------ */

  async function callGemini(apiKey, model, systemPrompt, userContent, opts) {
    opts = opts || {};
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: opts.temperature != null ? opts.temperature : 0.3,
        maxOutputTokens: opts.maxOutputTokens || 2048,
        ...(opts.jsonSchema ? { responseMimeType: "application/json" } : {}),
      },
    };
    const res = await fetchWithTimeout(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      opts.timeout || 30000
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw Object.assign(new Error(`Gemini returned ${res.status}: ${errText.slice(0, 200)}`), {
        code: res.status === 429 ? "RATE_LIMIT" : res.status === 401 ? "AUTH_ERROR" : "PROVIDER_ERROR",
      });
    }
    const data = await res.json();
    const part = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0];
    if (!part || !part.text) throw Object.assign(new Error("Gemini returned empty response"), { code: "INVALID_RESPONSE" });
    return {
      content: part.text,
      usage: data.usageMetadata ? {
        prompt_tokens: data.usageMetadata.promptTokenCount,
        completion_tokens: data.usageMetadata.candidatesTokenCount,
        total_tokens: data.usageMetadata.totalTokenCount,
      } : null,
      model,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Protocol: Anthropic                                                  */
  /* ------------------------------------------------------------------ */

  async function callAnthropic(apiKey, model, systemPrompt, userContent, opts) {
    opts = opts || {};
    const body = {
      model,
      max_tokens: opts.maxOutputTokens || 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    };
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: buildHeaders("anthropic", apiKey),
        body: JSON.stringify(body),
      },
      opts.timeout || 30000
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw Object.assign(new Error(`Anthropic returned ${res.status}: ${errText.slice(0, 200)}`), {
        code: res.status === 429 ? "RATE_LIMIT" : res.status === 401 ? "AUTH_ERROR" : "PROVIDER_ERROR",
      });
    }
    const data = await res.json();
    const content = data.content && data.content[0] && data.content[0].text;
    if (!content) throw Object.assign(new Error("Anthropic returned empty response"), { code: "INVALID_RESPONSE" });
    return {
      content,
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      } : null,
      model: data.model || model,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Retry / backoff                                                       */
  /* ------------------------------------------------------------------ */

  async function withRetry(fn, maxRetries) {
    maxRetries = maxRetries || 1;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (e.code === "AUTH_ERROR") throw e; // don't retry auth errors
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  /* ------------------------------------------------------------------ */
  /* Main public API                                                       */
  /* ------------------------------------------------------------------ */

  async function call(settings, systemPrompt, userContent, opts) {
    const p = PROVIDERS[settings.providerId] || PROVIDERS.custom;
    const apiKey = settings.apiKey || "";
    const model = settings.model || p.defaultModel;
    const baseUrl = (settings.providerId === "custom" || settings.providerId === "litellm")
      ? (settings.customEndpoint || p.baseUrl)
      : p.baseUrl;
    const callOpts = {
      temperature: settings.temperature,
      maxOutputTokens: settings.maxOutputTokens,
      timeout: settings.timeout,
      ...opts,
    };

    return withRetry(async () => {
      if (p.protocol === "gemini") {
        return callGemini(apiKey, model, systemPrompt, userContent, callOpts);
      }
      if (p.protocol === "anthropic") {
        return callAnthropic(apiKey, model, systemPrompt, userContent, callOpts);
      }
      // openai-compatible (ollama, openai, litellm, custom)
      return callOpenAICompatible(baseUrl, apiKey, model, systemPrompt, userContent, callOpts);
    }, 1);
  }

  async function testConnection(settings) {
    try {
      const result = await call(
        settings,
        "You are a connection test helper.",
        "Reply only: OK",
        { timeout: 10000, maxOutputTokens: 10 }
      );
      return { ok: true, model: result.model, latencyMs: null };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }

  async function listModels(settings) {
    try {
      const p = PROVIDERS[settings.providerId];
      if (!p) return { models: [] };
      // For providers with static model lists
      if (p.models && p.models.length) return { models: p.models };
      // For Ollama and similar: fetch /api/tags or /v1/models
      const baseUrl = (settings.customEndpoint || p.baseUrl || "").replace(/\/$/, "");
      if (!baseUrl) return { models: [] };
      const headers = {};
      if (settings.apiKey) headers["Authorization"] = "Bearer " + settings.apiKey;
      // Try OpenAI /v1/models
      const res = await fetchWithTimeout(
        baseUrl + "/models",
        { headers },
        8000
      );
      if (!res.ok) return { models: [] };
      const data = await res.json();
      const raw = data.data || data.models || [];
      return {
        models: raw.map((m) => ({
          id: m.id || m.name,
          name: m.id || m.name,
          tier: "balanced",
        })),
      };
    } catch (e) {
      return { models: [], error: e.message };
    }
  }

  function humanError(e) {
    const code = (e && e.code) || "";
    const msg = (e && e.message) || String(e);
    if (code === "AUTH_ERROR" || /401|unauthorized/i.test(msg)) return "Invalid API key. Check your provider settings.";
    if (code === "RATE_LIMIT" || /429|rate.?limit/i.test(msg)) return "Rate limit reached. Wait a moment and try again.";
    if (/abort|timeout/i.test(msg)) return "Request timed out. Check your connection and provider settings.";
    if (/network|fetch|ECONNREFUSED/i.test(msg)) return "Could not reach the AI provider. Is it running?";
    return msg.slice(0, 180);
  }

  function estimateCost(providerId, model, inputTokens, outputTokens) {
    // Rough cost estimates in USD per 1M tokens (as of late 2024)
    // These are estimates only — never used for billing
    const rates = {
      "gemini-1.5-flash": { in: 0.075, out: 0.30 },
      "gemini-1.5-pro": { in: 1.25, out: 5.00 },
      "gemini-2.0-flash": { in: 0.075, out: 0.30 },
      "gpt-4o-mini": { in: 0.15, out: 0.60 },
      "gpt-4o": { in: 5.00, out: 15.00 },
      "claude-3-haiku-20240307": { in: 0.25, out: 1.25 },
      "claude-3-5-sonnet-20241022": { in: 3.00, out: 15.00 },
    };
    const r = rates[model];
    if (!r) return null;
    const cost = (inputTokens / 1e6) * r.in + (outputTokens / 1e6) * r.out;
    return cost < 0.001 ? "< $0.001" : "$" + cost.toFixed(4);
  }

  return {
    PROVIDERS,
    loadSettings,
    defaultSettings,
    saveSettings,
    call,
    testConnection,
    listModels,
    humanError,
    estimateCost,
  };
});
