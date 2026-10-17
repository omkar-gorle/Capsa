/* Capsa — secrets and capsule-lookalikes (pure logic).
   A capsule is pasted into another company's AI, so anything that looks like a credential is replaced BEFORE it is rendered,
   wherever it came from (chat text, notes, code blocks, files). The pattern list is deliberately about FORMS of secrets
   (prefixes, PEM blocks, "password = …"), not a promise to catch every secret: say so to users, and tell them to look.

   Also neutralises text inside a chat that imitates the capsule's own frame ("=== END CAPSULE ===") so a message cannot close the
   capsule early and pose as instructions. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaRedact = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MARK = "[REDACTED]";
  const RULES = [
    ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => "[REDACTED PRIVATE KEY]"],
    ["AWS key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => MARK],
    ["API key", /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g, () => MARK],
    ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, () => MARK],
    ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, () => MARK],
    ["Google key", /\bAIza[0-9A-Za-z_-]{30,}\b/g, () => MARK],
    ["Stripe key", /\b[rsp]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, () => MARK],
    ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, () => MARK],
    ["bearer token", /\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi, (m, p) => p + MARK],
    ["credentials in a URL", /\b([a-z][a-z0-9+.-]{1,12}:\/\/)[^\s:@\/]{1,64}:[^\s@\/]{3,128}@/gi, (m, p) => p + MARK + "@"],
    // password = "hunter2", "api_key": "abc123…", TOKEN=…  (value of 6+ chars; the NAME stays so the next AI knows what was there)
    ["secret assignment", /\b((?:[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?)([^\s"'`,;<>)\]}]{6,})/gi,
      (m, p, v) => (/^(?:\[REDACTED|true$|false$|null$|none$|undefined$|string$|your[_-]|<|\$\{|process\.env|os\.environ|getenv|env\.)/i.test(v) || /^[A-Za-z_]+\(/.test(v) ? m : p + MARK)],
    ["password in prose", /\b((?:my|the|its|his|her|our)\s+(?:password|passcode|pin)\s+(?:is|was|=|:)\s+)(\S{4,})/gi, (m, p) => p + MARK],
  ];

  /** @returns {{text:string, count:number, kinds:string[]}} */
  function redact(text) {
    let s = String(text == null ? "" : text); let count = 0; const kinds = [];
    for (const [kind, re, fn] of RULES) {
      s = s.replace(re, function () { const r = fn.apply(null, arguments); if (r !== arguments[0]) { count++; if (!kinds.includes(kind)) kinds.push(kind); } return r; });
    }
    return { text: s, count, kinds };
  }

  /** Lines that imitate the capsule frame are defanged ("===" -> "≡≡≡") so they cannot end or restart the capsule. */
  function defang(text) {
    return String(text || "").replace(/^([ \t>*_-]*)={3,}\s*(?:END\s+)?(?:CONTEXT\s+)?CAPSULE\s*={3,}/gim, (m, p) => p + "≡≡≡" + m.slice(p.length).replace(/=+/g, "").replace(/^\s*/, " ") + " ≡≡≡");
  }

  return { redact, defang, MARK };
});
