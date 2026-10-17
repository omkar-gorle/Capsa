/* Capsa — Meter (claude.ai only). A small pill that opens into: session + weekly usage with reset timers,
   context size against the 200k window, the prompt-cache countdown, a "replies left" estimate learned from your own
   use, and one-click hand-off of the whole chat to ChatGPT, Gemini or Grok.
   Everything is computed on this device from responses claude.ai already sends (see content/meter-tap.js). */
(function () {
  "use strict";
  if (window.top !== window || window.__capsaMeter) return;
  if (!/(^|\.)claude\.ai$/.test(location.hostname)) return;
  const M = window.CapsaMeter;
  if (!M) return;
  window.__capsaMeter = true;

  const MARK = "CapsaMeter";
  const KEY = "meter";
  const st = { usage: null, usageAt: 0, org: null, conv: null, metrics: null, convAt: 0, gen: null, samples: {}, tally: [], hidden: false, open: false, ui: null, busy: false, usageErr: "" };
  const pending = new Map();
  const listeners = {};
  const on = (t, f) => { listeners[t] = f; };
  const store = {
    get: () => new Promise((res) => { try { chrome.storage.local.get(KEY, (g) => res((g && g[KEY]) || {})); } catch (e) { res({}); } }),
    set: (patch) => { try { chrome.storage.local.get(KEY, (g) => chrome.storage.local.set({ [KEY]: Object.assign({}, (g && g[KEY]) || {}, patch) })); } catch (e) { /* extension reloaded */ } },
  };
  let saveT = 0;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(() => store.set({ samples: st.samples, tally: st.tally, usage: st.usage, usageAt: st.usageAt }), 600); };

  /* ---- talking to the tap ---- */
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data; if (!d || d.cm !== MARK) return;
    if (d.type === "response") { const p = pending.get(d.payload && d.payload.id); if (p) { pending.delete(d.payload.id); clearTimeout(p.t); d.payload.ok ? p.ok(d.payload.payload) : p.no(new Error(d.payload.error || "failed")); } return; }
    const f = listeners[d.type]; if (f) { try { f(d.payload || {}); } catch (e) { /* keep going */ } }
  });
  function ask(kind, payload, ms) {
    return new Promise((ok, no) => {
      const id = Date.now() + "-" + Math.random().toString(16).slice(2);
      const t = setTimeout(() => { pending.delete(id); no(new Error("timed out")); }, ms || 15000);
      pending.set(id, { ok, no, t });
      window.postMessage({ cm: MARK, type: "request", id, kind, payload }, "*");
    });
  }

  const cookieOrg = () => { try { const m = /(?:^|;\s*)lastActiveOrg=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; } };
  const convIdNow = () => { const m = /\/chat\/([^/?#]+)/.exec(location.pathname); return m ? m[1] : null; };

  /* ---- data ---- */
  async function refreshUsage() {
    const org = st.org || cookieOrg(); if (!org) { st.usageErr = "waiting for claude.ai to identify your account"; return render(); }
    try { const raw = await ask("usage", { orgId: org }); const u = M.parseUsageEndpoint(raw); if (u) { st.usage = M.mergeUsage(null, u); st.usageAt = Date.now(); st.usageErr = ""; } else st.usageErr = "usage data was not in the expected shape"; }
    catch (e) { st.usageErr = "couldn't read usage (" + e.message + ")"; }
    saveSoon(); render();
  }
  async function refreshConversation() {
    st.conv = convIdNow();
    if (!st.conv) { st.metrics = null; return render(); }
    const org = st.org || cookieOrg(); if (!org) return;
    try { await ask("conversation", { orgId: org, conversationId: st.conv }, 20000); } catch (e) { /* the page will fetch it itself */ }
  }

  on("org", (p) => { if (p.orgId && p.orgId !== st.org) { st.org = p.orgId; if (!st.usage) refreshUsage(); } });
  on("url", () => { if (convIdNow() !== st.conv) refreshConversation(); });
  on("conversation", (p) => {
    if (!p || !p.data || p.conversationId !== convIdNow()) return;
    st.metrics = M.conversationMetrics(p.data); st.convAt = Date.now();
    if (p.orgId) st.org = p.orgId; render();
  });
  on("message_limit", (raw) => {
    const u = M.parseMessageLimit(raw); if (!u) return;
    st.usage = M.mergeUsage(st.usage, u); st.usageAt = Date.now(); st.usageErr = "";
    saveSoon(); render();
  });
  on("generation_start", (p) => {
    st.gen = { model: p.model || (st.metrics && st.metrics.model) || null, startPct: st.usage && st.usage.session ? st.usage.session.pct : null, ctx: st.metrics ? st.metrics.tokens : 0, at: Date.now() };
    render();
  });
  on("generation_end", (p) => {
    const g = st.gen; st.gen = null;
    if (g && !p.aborted) {
      st.tally = M.addTally(st.tally, g.model, Date.now());
      const now = st.usage && st.usage.session ? st.usage.session.pct : null;
      if (g.startPct != null && now != null) st.samples = M.addSample(st.samples, { model: g.model, deltaPct: now - g.startPct, ctxTokens: g.ctx, at: Date.now() });
      st.lastModel = g.model;
      if (st.metrics) st.metrics.cachedUntil = Date.now() + M.CACHE_MS;      // until the real timestamp is read back
      saveSoon();
    }
    setTimeout(refreshConversation, 1200);
    render();
  });

  /* ---- UI ---- */
  const css = `
:host{all:initial}
*{box-sizing:border-box}
.w{position:fixed;left:16px;bottom:16px;z-index:2147483645;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f7f6ea}
.pill{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:15px;background:#000;border:1px solid rgba(247,246,234,.16);cursor:pointer;color:#f7f6ea;font:inherit;font-weight:600;box-shadow:0 6px 18px rgba(8,6,4,.55)}
.pill:hover{border-color:#f3b63f}
.dot{width:8px;height:8px;border-radius:50%;background:#f3b63f;flex:none}
.pill[data-l=warn] .dot{background:#dc6949}.pill[data-l=red] .dot{background:#ff3b30;animation:pulse 1.2s infinite}.pill[data-l=none] .dot{background:#7d8176}
.pill[data-l=red]{border-color:#ff3b30}
.panel{position:absolute;left:0;bottom:38px;width:318px;max-width:calc(100vw - 32px);max-height:calc(100vh - 80px);overflow:auto;background:#000;border:1px solid rgba(247,246,234,.14);border-radius:18px;padding:14px;box-shadow:0 22px 60px rgba(8,6,4,.7);display:none;scrollbar-width:none}
.panel::-webkit-scrollbar{display:none}
.w[data-open="1"] .panel{display:block}
.hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.hd b{font-size:13px;letter-spacing:.2px}
.ib{background:none;border:0;color:#7d8176;cursor:pointer;font:inherit;padding:2px 6px;border-radius:8px}.ib:hover{color:#f7f6ea;background:rgba(247,246,234,.08)}
.row{margin:10px 0}
.top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.top span:first-child{color:#f7f6ea;font-weight:600}.top span:last-child{color:#7d8176;font-size:11px;text-align:right}
.bar{position:relative;height:7px;border-radius:4px;background:#1b1713;margin-top:5px;overflow:visible}
.fill{height:100%;border-radius:4px;background:#f3b63f;transition:width .4s}
.bar[data-l=warn] .fill{background:#dc6949}.bar[data-l=red] .fill{background:#ff3b30}
.mk{position:absolute;top:-3px;width:2px;height:13px;background:#f7f6ea;opacity:.75;border-radius:1px}
.sub{color:#7d8176;font-size:11px;margin-top:3px}
.models{margin-top:4px;display:grid;gap:3px}
.models div{display:flex;justify-content:space-between;color:#a8ab9f;font-size:11px}
.advice{margin:10px 0 4px;padding:8px 10px;border-radius:10px;background:rgba(255,59,48,.12);border:1px solid rgba(255,59,48,.4);color:#ffb3ad;font-size:11.5px}
.advice:empty{display:none}
.sep{height:1px;background:rgba(247,246,234,.1);margin:12px 0}
.lab{color:#7d8176;font-size:11px;margin-bottom:6px}
.hand{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.hand button{height:32px;border-radius:10px;border:1px solid rgba(247,246,234,.18);background:#14100c;color:#f7f6ea;font:inherit;font-weight:600;cursor:pointer}
.hand button:hover:not(:disabled){border-color:#f3b63f;background:#1f1912}.hand button:disabled{opacity:.45;cursor:default}
.msg{margin-top:8px;color:#f3b63f;font-size:11px;min-height:14px}
.note{color:#7d8176;font-size:10.5px;margin-top:8px}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

  function build() {
    const host = document.createElement("capsa-meter");
    host.style.cssText = "all:initial";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>${css}</style>
<div class="w" data-open="0">
  <div class="panel" role="dialog" aria-label="Capsa meter">
    <div class="hd"><b>Capsa meter</b><span><button class="ib" data-a="refresh" title="Refresh usage">⟳</button><button class="ib" data-a="hide" title="Hide the meter">✕</button></span></div>
    <div class="row" data-k="session"><div class="top"><span>Session · 5 h</span><span data-v></span></div><div class="bar"><div class="fill"></div><i class="mk"></i></div><div class="sub" data-s></div></div>
    <div class="row" data-k="weekly"><div class="top"><span>Weekly · 7 d</span><span data-v></span></div><div class="bar"><div class="fill"></div><i class="mk"></i></div><div class="sub" data-s></div><div class="models" data-m></div></div>
    <div class="advice" data-a2></div>
    <div class="sep"></div>
    <div class="row" data-k="ctx"><div class="top"><span>This chat</span><span data-v></span></div><div class="bar"><div class="fill"></div></div><div class="sub" data-s></div></div>
    <div class="row" data-k="cache"><div class="top"><span>Prompt cache</span><span data-v></span></div><div class="sub" data-s></div></div>
    <div class="row" data-k="left"><div class="top"><span>Replies left</span><span data-v></span></div><div class="sub" data-s></div></div>
    <div class="sep"></div>
    <div class="lab">Out of room? Continue this chat on</div>
    <div class="hand"><button data-h="chatgpt">ChatGPT</button><button data-h="gemini">Gemini</button><button data-h="grok">Grok</button></div>
    <div class="msg" data-msg></div>
    <div class="note">Numbers marked ~ are estimates. Nothing leaves this device except the hand-off you click.</div>
  </div>
  <button class="pill" data-l="none" aria-expanded="false"><i class="dot"></i><span data-p>Meter</span></button>
</div>`;
    document.documentElement.appendChild(host);
    const q = (s) => sh.querySelector(s);
    const ui = { host, sh, w: q(".w"), pill: q(".pill"), p: q("[data-p]"), msg: q("[data-msg]"), advice: q("[data-a2]"), hand: [...sh.querySelectorAll("[data-h]")] };
    const grab = (k) => { const r = q('[data-k="' + k + '"]'); return { r, v: r.querySelector("[data-v]"), s: r.querySelector("[data-s]"), bar: r.querySelector(".bar"), fill: r.querySelector(".fill"), mk: r.querySelector(".mk"), m: r.querySelector("[data-m]") }; };
    ui.session = grab("session"); ui.weekly = grab("weekly"); ui.ctx = grab("ctx"); ui.cache = grab("cache"); ui.left = grab("left");
    ui.pill.addEventListener("click", () => setOpen(!st.open));
    sh.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.a === "refresh") { refreshUsage(); refreshConversation(); }
      if (b.dataset.a === "hide") { st.hidden = true; store.set({ hidden: true }); ui.host.style.display = "none"; showTab(); }
      if (b.dataset.h) handoff(b.dataset.h);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && st.open) setOpen(false); });
    return ui;
  }
  function setOpen(v) { st.open = !!v; st.ui.w.dataset.open = v ? "1" : "0"; st.ui.pill.setAttribute("aria-expanded", String(!!v)); if (v) { render(); if (!st.usage || Date.now() - st.usageAt > 60000) refreshUsage(); } store.set({ open: !!v }); }

  // when hidden, a tiny handle remains so it can be brought back
  let tab = null;
  function showTab() {
    if (tab) return;
    tab = document.createElement("button");
    tab.textContent = "◐"; tab.title = "Show Capsa meter";
    tab.style.cssText = "all:initial;position:fixed;left:6px;bottom:6px;z-index:2147483645;width:20px;height:20px;border-radius:10px;background:#000;color:#7d8176;font:12px/20px system-ui;text-align:center;cursor:pointer;border:1px solid rgba(247,246,234,.14)";
    tab.addEventListener("click", () => { st.hidden = false; store.set({ hidden: false }); st.ui.host.style.display = ""; tab.remove(); tab = null; render(); });
    document.documentElement.appendChild(tab);
  }

  function setBar(g, pct, lvl, markPct) {
    g.fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    g.bar.dataset.l = lvl;
    if (g.mk) { if (markPct == null) g.mk.style.display = "none"; else { g.mk.style.display = ""; g.mk.style.left = "calc(" + Math.max(0, Math.min(100, markPct)) + "% - 1px)"; } }
  }
  const elapsed = (w, now) => (w && w.resetsAt ? Math.max(0, Math.min(1, 1 - (w.resetsAt - now) / (w.hours * 3600000))) * 100 : null);

  function render() {
    const ui = st.ui; if (!ui || st.hidden) return;
    const now = Date.now();
    const u = st.usage, s = u && u.session, w = u && u.weekly;
    const model = (st.gen && st.gen.model) || (st.metrics && st.metrics.model) || st.lastModel || null;
    const ctx = st.metrics ? st.metrics.tokens : 0;
    const left = s ? M.messagesLeft(st.samples, model, 100 - s.pct, ctx) : null;

    // pill
    const lv = s ? M.level(s.pct) : "none";
    ui.pill.dataset.l = lv;
    ui.p.textContent = s ? M.fmtPct(s.pct) + (left && left.n != null ? " · ~" + left.n + " left" : "") : "Meter";

    // session
    if (s) {
      ui.session.v.textContent = M.fmtPct(s.pct) + " used";
      setBar(ui.session, s.pct, lv, elapsed(s, now));
      ui.session.s.textContent = s.resetsAt ? "resets in " + M.countdown(s.resetsAt, now) : "reset time not reported";
    } else { ui.session.v.textContent = "—"; setBar(ui.session, 0, "ok", null); ui.session.s.textContent = st.usageErr || "loading…"; }
    // weekly
    if (w) {
      const wl = M.level(w.pct);
      ui.weekly.v.textContent = M.fmtPct(w.pct) + " used";
      setBar(ui.weekly, w.pct, wl, elapsed(w, now));
      ui.weekly.s.textContent = w.resetsAt ? "resets in " + M.countdown(w.resetsAt, now) : "reset time not reported";
    } else { ui.weekly.v.textContent = "—"; setBar(ui.weekly, 0, "ok", null); ui.weekly.s.textContent = ""; }
    // per-model weekly: what claude.ai reports, plus what this browser counted
    const parts = [];
    for (const k of Object.keys((u && u.models) || {})) parts.push([k, M.fmtPct(u.models[k].pct) + " of weekly"]);
    const tal = M.tallyByModel(st.tally, now);
    const names = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable", other: "Other", unknown: "Unknown" };
    const counted = Object.keys(tal).map((k) => (names[k] || k) + " " + tal[k]).join(" · ");
    ui.weekly.m.textContent = "";
    for (const [k, v] of parts) { const d = document.createElement("div"); const a = document.createElement("span"), b = document.createElement("span"); a.textContent = k.charAt(0).toUpperCase() + k.slice(1); b.textContent = v; d.append(a, b); ui.weekly.m.appendChild(d); }
    if (counted) { const d = document.createElement("div"); const a = document.createElement("span"), b = document.createElement("span"); a.textContent = "Replies counted here (7 d)"; b.textContent = counted; d.append(a, b); ui.weekly.m.appendChild(d); }
    ui.advice.textContent = M.advice(u, left);

    // context
    if (st.metrics) {
      const pct = ctx / M.CONTEXT_LIMIT * 100;
      ui.ctx.v.textContent = "~" + M.fmtTok(ctx) + " / " + M.fmtTok(M.CONTEXT_LIMIT);
      setBar(ui.ctx, pct, M.level(pct), null);
      ui.ctx.s.textContent = st.metrics.messages + " messages on this branch · ~" + Math.round(pct) + "% of the window" + (pct >= 75 ? " — consider a hand-off or a fresh chat" : "");
    } else { ui.ctx.v.textContent = "—"; setBar(ui.ctx, 0, "ok", null); ui.ctx.s.textContent = st.conv ? "reading this chat…" : "open a chat to see its size"; }
    // cache
    const cu = st.metrics && st.metrics.cachedUntil;
    if (st.gen) { ui.cache.v.textContent = "reply in progress"; ui.cache.s.textContent = ""; }
    else if (cu && cu > now) { ui.cache.v.textContent = M.countdown(cu, now); ui.cache.s.textContent = "reply within this time to reuse the cached history (cheaper on limits)"; }
    else if (cu) { ui.cache.v.textContent = "expired"; ui.cache.s.textContent = "the next reply re-reads the whole chat at full cost"; }
    else { ui.cache.v.textContent = "—"; ui.cache.s.textContent = "starts after the first reply"; }
    // replies left
    if (left) {
      ui.left.v.textContent = "~" + left.n;
      ui.left.s.textContent = "based on " + left.basis + (left.confidence === "low" ? " — rough" : "");
    } else { ui.left.v.textContent = "—"; ui.left.s.textContent = s ? "learning: it needs to see a few of your replies finish" : "waiting for usage data"; }
  }

  /* ---- hand-off ---- */
  async function handoff(target) {
    if (st.busy) return;
    const t = M.handoffTarget(target); if (!t) return;
    st.busy = true; st.ui.hand.forEach((b) => (b.disabled = true));
    st.ui.msg.textContent = "Reading the whole chat…";
    let res;
    try { res = await new Promise((ok) => chrome.runtime.sendMessage({ type: "handoff", target, level: 1 }, (r) => ok(r || { ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no answer" }))); }
    catch (e) { res = { ok: false, error: "Capsa was updated — reload this tab." }; }
    if (!res || !res.ok) { done(res && res.error ? res.error : "Couldn't start the hand-off."); return; }
    // the capture runs in the background; follow it
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 900));
      let g = {};
      try { g = await new Promise((ok) => chrome.storage.local.get(["job", "progress"], (x) => ok(x || {}))); } catch (e) { break; }
      const j = g.job;
      if (j && j.state === "done") {
        const r = j.result || {};
        if (r.handoff) return done(r.handoff.inserted ? "Done — the capsule is in the " + t.name + " box. Review it, then send." : "Opened " + t.name + ". " + (r.handoff.note || "Open Capsa there and tap Copy."));
        if (r.unverified) return done("Couldn't verify the whole chat, so nothing was handed off. Open Capsa for details.");
        return done(r.error || "The hand-off didn't finish.");
      }
      if (g.progress && g.progress.text && Date.now() - g.progress.at < 8000) st.ui.msg.textContent = g.progress.text;
      if (Date.now() - t0 > 30 * 60 * 1000) return done("Still working — check the Capsa orb.");
    }
    done("Lost contact with Capsa — reload this tab.");
    function done(text) { st.busy = false; st.ui.hand.forEach((b) => (b.disabled = false)); st.ui.msg.textContent = text; }
  }

  /* ---- start ---- */
  async function start() {
    const saved = await store.get();
    st.samples = saved.samples || {}; st.tally = Array.isArray(saved.tally) ? saved.tally : [];
    if (saved.usage && Date.now() - (saved.usageAt || 0) < 3600000) { st.usage = saved.usage; st.usageAt = saved.usageAt; }
    st.hidden = !!saved.hidden;
    st.ui = build();
    if (st.hidden) { st.ui.host.style.display = "none"; showTab(); }
    st.org = cookieOrg();
    if (saved.open) setOpen(true);
    refreshConversation();
    refreshUsage();
    render();
    let lastReset = { s: null, w: null };
    setInterval(() => {
      render();
      const now = Date.now(), u = st.usage;
      // a window ended: the old % no longer applies
      if (u && u.session && u.session.resetsAt && now >= u.session.resetsAt && lastReset.s !== u.session.resetsAt) { lastReset.s = u.session.resetsAt; refreshUsage(); }
      if (u && u.weekly && u.weekly.resetsAt && now >= u.weekly.resetsAt && lastReset.w !== u.weekly.resetsAt) { lastReset.w = u.weekly.resetsAt; refreshUsage(); }
      if (!document.hidden && now - st.usageAt > 3600000) refreshUsage();
    }, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
