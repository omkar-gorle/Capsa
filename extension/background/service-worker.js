/* Chat Capsule v5.0.0 — Service Worker (MV3)
   Handles:
   - Extension icon click → open side panel or popup
   - Message routing between popup/sidepanel and content scripts
   - Settings management via chrome.storage.sync
   - Host permission requests

   SECURITY: All messages are validated before processing.
   No user data is logged. No external connections are made here.
*/
"use strict";

const SW_VERSION = "5.0.0";

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  // Side panel not supported (older Chrome) — popup behavior is the fallback
});

// ---- Message validation ----
const ALLOWED_TYPES = new Set([
  "PING", "OPEN_SIDE_PANEL", "REQUEST_HOST_PERMISSION", "CHECK_HOST_PERMISSION",
  "GET_SETTINGS", "SET_SETTINGS",
]);

function isValidMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (typeof msg.type !== "string") return false;
  if (!ALLOWED_TYPES.has(msg.type)) return false;
  return true;
}

// ---- Message handler ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Validate: only accept messages from our own extension
  if (sender.id && sender.id !== chrome.runtime.id) return false;

  if (!isValidMessage(msg)) {
    sendResponse({ ok: false, error: "unknown message type" });
    return false;
  }

  if (msg.type === "PING") {
    sendResponse({ ok: true, version: SW_VERSION });
    return true;
  }

  if (msg.type === "OPEN_SIDE_PANEL") {
    if (!msg.tabId || typeof msg.tabId !== "number") {
      sendResponse({ ok: false, error: "invalid tabId" });
      return false;
    }
    chrome.sidePanel.open({ tabId: msg.tabId }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "REQUEST_HOST_PERMISSION") {
    const origins = Array.isArray(msg.origins) ? msg.origins.filter((o) => typeof o === "string") : [];
    if (!origins.length) {
      sendResponse({ granted: false, error: "no origins provided" });
      return false;
    }
    chrome.permissions.request({ origins }, (granted) => {
      sendResponse({ granted: !!granted });
    });
    return true; // keep channel open for async response
  }

  if (msg.type === "CHECK_HOST_PERMISSION") {
    const origins = Array.isArray(msg.origins) ? msg.origins.filter((o) => typeof o === "string") : [];
    if (!origins.length) {
      sendResponse({ has: false });
      return false;
    }
    chrome.permissions.contains({ origins }, (has) => {
      sendResponse({ has: !!has });
    });
    return true;
  }

  if (msg.type === "GET_SETTINGS") {
    chrome.storage.sync.get(["settings"], (data) => {
      sendResponse({ ok: true, settings: data.settings || {} });
    });
    return true;
  }

  if (msg.type === "SET_SETTINGS") {
    // Never log settings — they may contain API keys
    const settings = msg.settings && typeof msg.settings === "object" ? msg.settings : {};
    // Sanitize: strip any unexpected fields, keep known keys only
    const ALLOWED_SETTINGS_KEYS = new Set([
      "mode", "budget", "intent", "clean", "deep", "ollama", "ollamaEndpoint",
      "ollamaModel", "litellmEndpoint", "litellmModel", "litellmKey",
      "allowCloud", "cloudProvider", "cloudModel", "cloudApiKey",
      "customEndpoint", "customName", "customModel", "customKey",
      "maxOutputTokens", "autoDeepCapture", "theme",
    ]);
    const clean = {};
    for (const [k, v] of Object.entries(settings)) {
      if (ALLOWED_SETTINGS_KEYS.has(k)) clean[k] = v;
    }
    chrome.storage.sync.set({ settings: clean }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

// ---- Install / Update handler ----
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Set privacy-first defaults on first install
    chrome.storage.sync.set({
      settings: {
        mode: "smart",
        budget: 8000,
        intent: "resume",
        clean: true,
        deep: false,
        ollama: true,
        ollamaEndpoint: "http://localhost:11434/v1",
        ollamaModel: "llama3.2",
        allowCloud: false, // Privacy-first default: cloud requires explicit opt-in
        autoDeepCapture: false,
      },
    });
  }
  // Do not log version or install details — avoid leaking any info
});
