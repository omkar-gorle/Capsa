/* Chat Capsule v5 — AI Router
   Implements the full fallback chain:
     Local (Ollama) → LiteLLM → Cloud → Local Smart Capsule
   
   Privacy rule: never silently escalate to cloud if local fails.
   User must have explicitly configured and enabled cloud providers.
   
   Usage:
     const { AIRouter } = await import('./router.js');
     const router = new AIRouter(settings);
     const result = await router.extractState(capsule, transcript);
*/
"use strict";

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AIRouter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Provider type constants
  const PROVIDER_TYPES = {
    LOCAL: "local",           // Ollama, llama.cpp, LM Studio
    OPENAI_COMPAT: "openai-compatible", // OpenAI-format API
    NATIVE: "native",         // Platform-native API (Gemini)
    GATEWAY: "gateway",       // LiteLLM, OpenRouter
    CUSTOM: "custom",         // User-defined endpoint
  };

  // Default Ollama configuration
  const OLLAMA_DEFAULTS = {
    type: PROVIDER_TYPES.LOCAL,
    name: "Ollama",
    endpoint: "http://localhost:11434/v1",
    model: "llama3.2",
    requiresKey: false,
    timeout: 30000,
    maxOutputTokens: 2048,
    temperature: 0.1,
  };

  // Default timeout for connection tests
  const CONNECTION_TEST_TIMEOUT = 5000;
  const AI_REQUEST_TIMEOUT = 45000;

  class AIRouter {
    constructor(settings) {
      this._settings = settings || {};
      this._connectionCache = new Map(); // provider → { ok, checkedAt }
    }

    // ---- Provider configuration ----

    _buildProviders() {
      const s = this._settings;
      const providers = [];

      // 1. Ollama (local, default)
      if (s.ollama !== false) {
        providers.push({
          ...OLLAMA_DEFAULTS,
          endpoint: s.ollamaEndpoint || OLLAMA_DEFAULTS.endpoint,
          model: s.ollamaModel || OLLAMA_DEFAULTS.model,
        });
      }

      // 2. LiteLLM gateway (optional, self-hosted)
      if (s.litellmEndpoint) {
        providers.push({
          type: PROVIDER_TYPES.GATEWAY,
          name: "LiteLLM",
          endpoint: s.litellmEndpoint,
          model: s.litellmModel || "gpt-4o-mini",
          apiKey: s.litellmKey || null,
          requiresKey: !!s.litellmKey,
          timeout: AI_REQUEST_TIMEOUT,
          maxOutputTokens: s.maxOutputTokens || 2048,
          temperature: 0.1,
        });
      }

      // 3. Cloud providers (only if user explicitly enabled and has key)
      if (s.cloudProvider && s.cloudApiKey && s.allowCloud) {
        switch (s.cloudProvider) {
          case "openai":
            providers.push({
              type: PROVIDER_TYPES.OPENAI_COMPAT,
              name: "OpenAI",
              endpoint: "https://api.openai.com/v1",
              model: s.cloudModel || "gpt-4o-mini",
              apiKey: s.cloudApiKey,
              requiresKey: true,
              timeout: AI_REQUEST_TIMEOUT,
              maxOutputTokens: s.maxOutputTokens || 2048,
              temperature: 0.1,
            });
            break;
          case "gemini":
            providers.push({
              type: PROVIDER_TYPES.NATIVE,
              name: "Google Gemini",
              // Gemini uses a different API format
              endpoint: "https://generativelanguage.googleapis.com/v1beta",
              model: s.cloudModel || "gemini-1.5-flash-latest",
              apiKey: s.cloudApiKey,
              requiresKey: true,
              timeout: AI_REQUEST_TIMEOUT,
              maxOutputTokens: s.maxOutputTokens || 2048,
              temperature: 0.1,
            });
            break;
          case "anthropic":
            providers.push({
              type: PROVIDER_TYPES.OPENAI_COMPAT, // use openai-compat via proxy, or native
              name: "Anthropic Claude",
              endpoint: "https://api.anthropic.com/v1",
              model: s.cloudModel || "claude-3-haiku-20240307",
              apiKey: s.cloudApiKey,
              requiresKey: true,
              timeout: AI_REQUEST_TIMEOUT,
              maxOutputTokens: s.maxOutputTokens || 2048,
              temperature: 0.1,
            });
            break;
          case "openrouter":
            providers.push({
              type: PROVIDER_TYPES.GATEWAY,
              name: "OpenRouter",
              endpoint: "https://openrouter.ai/api/v1",
              model: s.cloudModel || "openai/gpt-4o-mini",
              apiKey: s.cloudApiKey,
              requiresKey: true,
              timeout: AI_REQUEST_TIMEOUT,
              maxOutputTokens: s.maxOutputTokens || 2048,
              temperature: 0.1,
            });
            break;
        }
      }

      // 4. Custom endpoint (user-defined OpenAI-compatible)
      if (s.customEndpoint) {
        providers.push({
          type: PROVIDER_TYPES.CUSTOM,
          name: s.customName || "Custom Endpoint",
          endpoint: s.customEndpoint,
          model: s.customModel || "default",
          apiKey: s.customKey || null,
          requiresKey: !!s.customKey,
          timeout: AI_REQUEST_TIMEOUT,
          maxOutputTokens: s.maxOutputTokens || 2048,
          temperature: 0.1,
        });
      }

      return providers;
    }

    // ---- Connection testing ----

    async testConnection(provider) {
      const cached = this._connectionCache.get(provider.name);
      if (cached && Date.now() - cached.checkedAt < 30000) return cached;

      const result = await this._doTestConnection(provider);
      this._connectionCache.set(provider.name, { ...result, checkedAt: Date.now() });
      return result;
    }

    async _doTestConnection(provider) {
      try {
        const signal = AbortSignal.timeout ? AbortSignal.timeout(CONNECTION_TEST_TIMEOUT) : null;
        const fetchOpts = { method: "GET", signal };
        const headers = {};
        if (provider.apiKey) headers["Authorization"] = "Bearer " + provider.apiKey;

        // For OpenAI-compatible endpoints, check /models
        if (provider.type !== PROVIDER_TYPES.NATIVE) {
          const url = provider.endpoint.replace(/\/+$/, "") + "/models";
          const res = await fetch(url, { ...fetchOpts, headers });
          return { ok: res.ok || res.status === 401, status: res.status, provider: provider.name };
        }

        // For Gemini native: ping endpoint root
        const url = provider.endpoint.replace(/\/+$/, "") + "/models?key=" + (provider.apiKey || "");
        const res = await fetch(url, fetchOpts);
        return { ok: res.ok || res.status === 400, status: res.status, provider: provider.name };
      } catch (e) {
        return { ok: false, error: e.message, provider: provider.name };
      }
    }

    // ---- Chat completion ----

    async _callProvider(provider, messages, systemPrompt) {
      const headers = { "Content-Type": "application/json" };
      if (provider.apiKey) headers["Authorization"] = "Bearer " + provider.apiKey;

      if (provider.type === PROVIDER_TYPES.NATIVE) {
        // Gemini native API format
        return this._callGeminiNative(provider, messages, systemPrompt);
      }

      // OpenAI-compatible format
      const body = JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        temperature: provider.temperature || 0.1,
        max_tokens: provider.maxOutputTokens || 2048,
        response_format: { type: "json_object" },
      });

      const signal = AbortSignal.timeout ? AbortSignal.timeout(provider.timeout || AI_REQUEST_TIMEOUT) : null;
      const res = await fetch(provider.endpoint.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST", headers, body, signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`${provider.name} returned HTTP ${res.status}`);
        err.status = res.status;
        err.body = text.slice(0, 200); // never log full response
        throw err;
      }

      const data = await res.json();
      return data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;
    }

    async _callGeminiNative(provider, messages, systemPrompt) {
      const headers = { "Content-Type": "application/json" };
      // Convert messages to Gemini format
      const contents = messages.map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content }],
      }));

      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: provider.temperature || 0.1,
          maxOutputTokens: provider.maxOutputTokens || 2048,
          responseMimeType: "application/json",
        },
      });

      const modelId = provider.model;
      const url = `${provider.endpoint.replace(/\/+$/, "")}/models/${modelId}:generateContent?key=${provider.apiKey}`;

      const signal = AbortSignal.timeout ? AbortSignal.timeout(provider.timeout || AI_REQUEST_TIMEOUT) : null;
      const res = await fetch(url, { method: "POST", headers, body, signal });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`Gemini returned HTTP ${res.status}`);
        err.status = res.status;
        err.body = text.slice(0, 200);
        throw err;
      }

      const data = await res.json();
      return data.candidates && data.candidates[0] && data.candidates[0].content
        ? data.candidates[0].content.parts[0].text
        : null;
    }

    // ---- Main extraction pipeline ----

    /**
     * extractState: runs the AI extraction pipeline with fallback.
     * Returns { state, provider, verified, fallback, warnings }
     * If all AI providers fail, returns { state: null, fallback: true }
     * so the caller can use local capsule generation instead.
     *
     * NEVER throws — always returns a usable result.
     * NEVER silently escalates to cloud without user opt-in.
     */
    async extractState(prompt, transcript, opts) {
      opts = opts || {};
      const providers = this._buildProviders();
      const warnings = [];

      // Privacy pre-flight: warn explicitly if cloud providers were configured but will be skipped
      if (!this._settings.allowCloud && this._settings.cloudProvider && this._settings.cloudApiKey) {
        warnings.push(
          "Cloud not enabled in settings: " + this._settings.cloudProvider +
          " is configured but allowCloud=false. Using local processing only."
        );
      }

      // Also warn if no providers are available at all
      if (providers.length === 0) {
        warnings.push("No AI providers configured. Using local capsule generation.");
        return { reply: null, provider: null, fallback: true, warnings };
      }

      for (const provider of providers) {
        // Privacy guard: skip cloud if user hasn't allowed it
        if ((provider.type === PROVIDER_TYPES.OPENAI_COMPAT ||
             provider.type === PROVIDER_TYPES.NATIVE ||
             provider.type === PROVIDER_TYPES.GATEWAY) &&
            provider.name !== "LiteLLM" &&
            !this._settings.allowCloud) {
          warnings.push(`Skipped ${provider.name}: cloud not enabled in settings`);
          continue;
        }

        try {
          const reply = await this._callProvider(
            provider,
            [{ role: "user", content: prompt }],
            opts.systemPrompt || "You are a helpful assistant. Respond only with valid JSON."
          );

          if (!reply) {
            warnings.push(`${provider.name}: empty response`);
            continue;
          }

          return {
            reply,
            provider: provider.name,
            providerType: provider.type,
            fallback: false,
            warnings,
          };
        } catch (e) {
          const reason = this._classifyError(e);
          warnings.push(`${provider.name} unavailable: ${reason}`);
          // Clear cached connection status on failure
          this._connectionCache.delete(provider.name);
        }
      }

      // All providers failed → signal fallback to local capsule
      return { reply: null, provider: null, fallback: true, warnings };
    }


    _classifyError(e) {
      if (!e) return "unknown error";
      if (e.name === "AbortError" || e.name === "TimeoutError") return "timeout";
      if (e.name === "TypeError" && /fetch|network/i.test(e.message)) return "network error";
      if (e.status === 401) return "unauthorized (check API key)";
      if (e.status === 403) return "forbidden";
      if (e.status === 404) return "model not found";
      if (e.status === 429) return "rate limited";
      if (e.status === 500 || e.status === 503) return "server error";
      if (e.status >= 400) return `HTTP ${e.status}`;
      return e.message ? e.message.slice(0, 80) : "unknown";
    }

    // ---- Status helpers ----

    async getProviderStatuses() {
      const providers = this._buildProviders();
      const results = await Promise.allSettled(
        providers.map(async (p) => ({
          name: p.name,
          type: p.type,
          model: p.model,
          ...(await this.testConnection(p)),
        }))
      );
      return results.map((r) => r.status === "fulfilled" ? r.value : { name: "unknown", ok: false });
    }
  }

  return { AIRouter, PROVIDER_TYPES, OLLAMA_DEFAULTS };
});
