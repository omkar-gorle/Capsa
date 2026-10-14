/* Capsa — supported AI sites + chat-link validation.
   Pure logic (no DOM, no chrome.*). Shared by the service worker, the card UI and tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaHosts = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SITES = [
    { id: "chatgpt", name: "ChatGPT", test: (u) => /^(www\.)?chatgpt\.com$|^chat\.openai\.com$/.test(u.hostname) },
    { id: "claude", name: "Claude", test: (u) => /^(www\.)?claude\.ai$/.test(u.hostname) },
    { id: "gemini", name: "Gemini", test: (u) => u.hostname === "gemini.google.com" },
    { id: "copilot", name: "Copilot", test: (u) => u.hostname === "copilot.microsoft.com" },
    { id: "perplexity", name: "Perplexity", test: (u) => /^(www\.)?perplexity\.ai$/.test(u.hostname) },
    { id: "grok", name: "Grok", test: (u) => u.hostname === "grok.com" || (u.hostname === "x.com" && u.pathname.indexOf("/i/grok") === 0) },
    { id: "deepseek", name: "DeepSeek", test: (u) => u.hostname === "chat.deepseek.com" },
  ];

  function toUrl(s) {
    try { return new URL(String(s).trim()); } catch (e) { return null; }
  }

  /** Which supported AI site does this URL belong to? -> site object | null */
  function siteOf(url) {
    const u = typeof url === "string" ? toUrl(url) : url;
    if (!u || u.protocol !== "https:") return null;
    return SITES.find((s) => s.test(u)) || null;
  }

  /** Validate a pasted chat link. -> { ok, url, site } | { ok:false, error } */
  function validateLink(input) {
    const raw = String(input || "").trim();
    if (!raw) return { ok: false, error: "Paste a chat link first." };
    const u = toUrl(raw);
    if (!u) return { ok: false, error: "That doesn't look like a link." };
    if (u.protocol !== "https:") return { ok: false, error: "Only https:// chat links work." };
    const site = siteOf(u);
    if (!site) return { ok: false, error: "Capsa can't open that site. Try ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok or DeepSeek." };
    return { ok: true, url: u.href, site };
  }

  /** Pages Chrome never lets any extension touch. */
  function isRestricted(url) {
    if (!url) return true;
    return /^(chrome|edge|about|brave|opera|vivaldi|chrome-extension|moz-extension|devtools|view-source|chrome-search|chrome-untrusted):/i.test(url) ||
      /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url);
  }

  return { SITES, siteOf, validateLink, isRestricted };
});
