/* Capsa — Meter logic (pure: no DOM, no network, no storage; runs in the page and in Node).

   Turns what claude.ai already sends to the browser into the numbers the Meter shows:

     - usage windows   session (5 h) and weekly (7 d), as a % used and a reset time
     - per-model weekly usage when the endpoint reports it
     - context size    ≈ tokens of the current branch of the chat, against the 200 000-token window
     - cache timer     the prompt cache lasts ~5 minutes after the last assistant message
     - messages left   learned from YOUR own usage: how many % one message cost on this model, scaled by chat size

   Nothing here is exact and nothing pretends to be: every number that is a guess is marked "~" by the caller.
   The usage-window parsing follows the public behaviour of the MIT-licensed "Claude Counter" extension. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaMeter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CONTEXT_LIMIT = 200000;
  const CACHE_MS = 5 * 60 * 1000;
  const ROOT_ID = "00000000-0000-4000-8000-000000000000";
  const WARN_PCT = 75, RED_PCT = 90;

  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const clampPct = (p) => Math.max(0, Math.min(100, p));

  /* ------------------------------------------------------------------ usage windows */
  function win(w, hours, scale) {
    if (!w || typeof w !== "object") return null;
    const u = num(w.utilization);
    if (u === null) return null;
    let at = null;
    if (typeof w.resets_at === "string") { const t = Date.parse(w.resets_at); at = Number.isFinite(t) ? t : null; }
    else if (num(w.resets_at) !== null) at = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;   // seconds or ms
    return { pct: clampPct(u * scale), resetsAt: at, hours };
  }

  /** GET /api/organizations/<org>/usage  (percentages 0–100, rounded) */
  function parseUsageEndpoint(raw) {
    if (!raw || typeof raw !== "object") return null;
    const session = win(raw.five_hour, 5, 1), weekly = win(raw.seven_day, 168, 1);
    const models = {};
    for (const k of Object.keys(raw)) {
      const m = /^seven_day_(.+)$/.exec(k);
      if (!m) continue;
      const w = win(raw[k], 168, 1);
      if (w) models[m[1].replace(/_/g, " ")] = w;
    }
    if (!session && !weekly) return null;
    return { session, weekly, models };
  }

  /** the live "message_limit" event of the completion stream (fractions 0–1, unrounded) */
  function parseMessageLimit(raw) {
    if (!raw || !raw.windows || typeof raw.windows !== "object") return null;
    const session = win(raw.windows["5h"], 5, 100), weekly = win(raw.windows["7d"], 168, 100);
    const models = {};
    for (const k of Object.keys(raw.windows)) {
      const m = /^7d_(.+)$/.exec(k);
      if (!m) continue;
      const w = win(raw.windows[k], 168, 100);
      if (w) models[m[1].replace(/_/g, " ")] = w;
    }
    if (!session && !weekly) return null;
    return { session, weekly, models };
  }

  /** newer snapshot wins, but a stream event that lacks per-model data keeps the models we already knew */
  function mergeUsage(prev, next) {
    if (!next) return prev || null;
    if (!prev) return next;
    const models = Object.assign({}, prev.models || {}, next.models || {});
    return { session: next.session || prev.session, weekly: next.weekly || prev.weekly, models };
  }

  /* ------------------------------------------------------------------ formatting */
  function countdown(ms, now) {
    if (ms == null) return "";
    const d = Math.max(0, ms - (now == null ? Date.now() : now));
    const s = Math.floor(d / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h " + String(m % 60).padStart(2, "0") + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  }
  const level = (pct) => (pct >= RED_PCT ? "red" : pct >= WARN_PCT ? "warn" : "ok");
  const fmtPct = (p) => (p < 10 ? p.toFixed(1) : String(Math.round(p))) + "%";
  const fmtTok = (n) => (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

  /* ------------------------------------------------------------------ context size */
  // Cheap, dependency-free estimate (Claude's real tokenizer isn't public). Marked "~" everywhere it is shown.
  function estimateTokens(text) {
    const s = String(text || "");
    if (!s) return 0;
    const wide = (s.match(/[ऀ-ॿ぀-ヿ㐀-鿿가-힯]/g) || []).length;   // Indic / CJK cost ~1 token per char
    return Math.ceil((s.length - wide) / 3.8 + wide);
  }

  function trunk(conv) {
    const list = Array.isArray(conv && conv.chat_messages) ? conv.chat_messages : [];
    const by = new Map(); for (const m of list) if (m && m.uuid) by.set(m.uuid, m);
    const out = []; let id = conv && conv.current_leaf_message_uuid;
    for (let guard = 0; id && id !== ROOT_ID && guard < 20000; guard++) {
      const m = by.get(id); if (!m) break;
      out.push(m); id = m.parent_message_uuid;
    }
    return out.reverse();
  }

  function stringify(v) { try { return JSON.stringify(v); } catch (e) { return ""; } }
  function messageText(m) {
    const parts = [];
    for (const c of Array.isArray(m && m.content) ? m.content : []) {
      if (!c || typeof c.type !== "string" || /thinking|^image$|^document$/.test(c.type)) continue;
      if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      else if (c.type === "tool_use") parts.push(stringify({ name: c.name, input: c.input }));
      else if (c.type === "tool_result") parts.push(stringify(c.content));
      else if (typeof c.text === "string") parts.push(c.text);
    }
    if (!parts.length && typeof (m && m.text) === "string") parts.push(m.text);
    for (const a of Array.isArray(m && m.attachments) ? m.attachments : []) if (a && typeof a.extracted_content === "string") parts.push(a.extracted_content);
    return parts.join("\n");
  }

  /** conversation JSON (…?tree=true) -> { tokens, messages, lastAssistantMs, cachedUntil, model } for the branch on screen */
  function conversationMetrics(conv) {
    const t = trunk(conv);
    let tokens = 0, last = null;
    for (const m of t) {
      tokens += estimateTokens(messageText(m));
      if (m.sender === "assistant" && m.created_at) { const ms = Date.parse(m.created_at); if (Number.isFinite(ms) && (!last || ms > last)) last = ms; }
    }
    return { tokens, messages: t.length, lastAssistantMs: last, cachedUntil: last ? last + CACHE_MS : null, model: (conv && typeof conv.model === "string" && conv.model) || null };
  }

  /* ------------------------------------------------------------------ models */
  function modelFamily(id) {
    const s = String(id || "").toLowerCase();
    if (/opus/.test(s)) return "opus";
    if (/sonnet/.test(s)) return "sonnet";
    if (/haiku/.test(s)) return "haiku";
    if (/fable|mythos/.test(s)) return "fable";
    return s ? "other" : "unknown";
  }
  // Only used to carry what was learned on one model over to another. They are rough relative costs, not Anthropic's numbers.
  const RELATIVE_COST = { haiku: 0.3, sonnet: 1, opus: 5, fable: 5, other: 1, unknown: 1 };

  /* ------------------------------------------------------------------ messages-left predictor */
  /* A sample = what ONE reply cost in session-% on one model, and how big the chat was then. Cost per message grows with
     the chat (the whole history is re-read), so the sample is stored per 1 000 tokens of context and scaled back up.  */
  const MAX_SAMPLES = 24;
  function addSample(samples, s) {
    samples = samples && typeof samples === "object" ? samples : {};
    const d = num(s && s.deltaPct), fam = modelFamily(s && s.model);
    if (d === null || d <= 0 || d > 40) return samples;                                 // reset in between, or a glitch
    const ctx = Math.max(0, num(s.ctxTokens) || 0);
    const per = d / ((ctx + 1500) / 1000);
    const list = (samples[fam] || []).concat([{ per, d, ctx, at: s.at || Date.now() }]).slice(-MAX_SAMPLES);
    return Object.assign({}, samples, { [fam]: list });
  }
  const median = (a) => { const b = a.slice().sort((x, y) => x - y); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : null; };

  /** { n, basis, confidence } or null. n = replies left at the current session %, in a chat of ctxTokens. */
  function messagesLeft(samples, model, remainingPct, ctxTokens) {
    remainingPct = num(remainingPct);
    if (remainingPct === null || !samples) return null;
    if (remainingPct <= 0) return { n: 0, basis: "limit reached", confidence: "high" };
    const fam = modelFamily(model);
    let per = null, basis = "", conf = "low";
    const own = samples[fam] || [];
    if (own.length >= 3) { per = median(own.map((x) => x.per)); basis = own.length + " of your replies on this model"; conf = own.length >= 8 ? "good" : "fair"; }
    else {
      // carry over from other models, scaled by relative cost
      const pool = [];
      for (const k of Object.keys(samples)) for (const x of samples[k] || []) pool.push(x.per * (RELATIVE_COST[fam] / (RELATIVE_COST[k] || 1)));
      const mine = own.map((x) => x.per);
      const all = pool.concat(mine);
      if (!all.length) return null;
      per = median(all);
      basis = own.length ? "few replies on this model so far" : "your replies on other models, scaled";
      conf = "low";
    }
    if (!per || per <= 0) return null;
    const perMsg = per * (((ctxTokens || 0) + 1500) / 1000);
    return { n: Math.max(0, Math.floor(remainingPct / perMsg)), basis, confidence: conf, perMsgPct: perMsg };
  }

  /* ------------------------------------------------------------------ local per-model tally (this browser, last 7 days) */
  function addTally(tally, model, now) {
    const fam = modelFamily(model);
    const list = (Array.isArray(tally) ? tally : []).filter((x) => x && now - x.at < 7 * 86400000).slice(-4000);
    list.push({ m: fam, at: now });
    return list;
  }
  function tallyByModel(tally, now) {
    const out = {};
    for (const x of Array.isArray(tally) ? tally : []) if (x && now - x.at < 7 * 86400000) out[x.m] = (out[x.m] || 0) + 1;
    return out;
  }

  /* ------------------------------------------------------------------ hand-off targets */
  const HANDOFF = {
    chatgpt: { name: "ChatGPT", url: "https://chatgpt.com/" },
    gemini: { name: "Gemini", url: "https://gemini.google.com/app" },
    grok: { name: "Grok", url: "https://grok.com/" },
  };
  const handoffTarget = (id) => (Object.prototype.hasOwnProperty.call(HANDOFF, id) ? HANDOFF[id] : null);

  /** one line a person can act on, from the numbers */
  function advice(usage, left) {
    const s = usage && usage.session;
    if (!s) return "";
    if (s.pct >= 100) return "Session limit reached" + (s.resetsAt ? " — resets in " + countdown(s.resetsAt) : "") + ". Hand off to keep going.";
    if (s.pct >= RED_PCT) return "Almost out of this session" + (left && left.n != null ? " (~" + left.n + " replies)" : "") + ". Hand off now, or wait for the reset.";
    if (s.pct >= WARN_PCT) return "Getting close to the session limit.";
    return "";
  }

  return {
    CONTEXT_LIMIT, CACHE_MS, WARN_PCT, RED_PCT, HANDOFF,
    parseUsageEndpoint, parseMessageLimit, mergeUsage, countdown, level, fmtPct, fmtTok,
    estimateTokens, trunk, messageText, conversationMetrics, modelFamily,
    addSample, messagesLeft, addTally, tallyByModel, handoffTarget, advice,
  };
});
