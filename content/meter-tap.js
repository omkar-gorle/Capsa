/* Capsa — Meter tap (runs in the PAGE's own world on claude.ai, before the page's scripts).

   It does three small things and nothing else:
     1. wraps fetch() so it can SEE (never change) three kinds of response claude.ai already receives:
          - the live "message_limit" event inside a reply's event stream  -> exact session / weekly %
          - the conversation tree the page loads                          -> size of the chat, time of the last reply
          - the start of a reply (and which model)                        -> to learn what one message costs you
     2. answers two requests from Capsa's isolated script: "fetch usage" and "fetch this conversation",
        made with your own signed-in session, to claude.ai only
     3. says when the address changes (the app navigates without reloading)

   Nothing is sent anywhere else. The approach follows the MIT-licensed "Claude Counter" extension.
   Messages use window.postMessage with a marker; only values are displayed, so a page that spoofed them
   could at most make the Meter show a wrong number. */
(function () {
  "use strict";
  if (window.__capsaMeterTap) return;
  window.__capsaMeterTap = true;
  const MARK = "CapsaMeter";
  const nativeFetch = window.fetch;
  const post = (type, payload) => { try { window.postMessage({ cm: MARK, type, payload }, "*"); } catch (e) { /* ignore */ } };

  // single-page navigation
  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k].bind(history);
    history[k] = function () { const r = orig.apply(null, arguments); post("url", { path: location.pathname }); return r; };
  }
  window.addEventListener("popstate", () => post("url", { path: location.pathname }));

  const abs = (i) => { try { if (typeof i === "string") return new URL(i, location.href).href; if (i instanceof URL) return i.href; if (i && i.url) return i.url; } catch (e) { /* ignore */ } return ""; };
  const orgOf = (u) => { const m = /\/api\/organizations\/([^/?#]+)/.exec(u); return m ? m[1] : null; };
  const convOf = (u) => { const m = /\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?#]+)/.exec(u); return m ? { orgId: m[1], conversationId: m[2] } : null; };

  function modelFromBody(body) {
    try { if (typeof body === "string") { const j = JSON.parse(body); if (j && typeof j.model === "string") return j.model; } } catch (e) { /* not JSON */ }
    return null;
  }

  window.fetch = async function () {
    const args = arguments;
    const url = abs(args[0]);
    const opts = args[1] || {};
    const org = orgOf(url); if (org) post("org", { orgId: org });
    const isCompletion = !!url && /\/(?:retry_)?completion(?:\?|$)/.test(url) && String(opts.method || (args[0] && args[0].method) || "GET").toUpperCase() === "POST";
    if (isCompletion) post("generation_start", { model: modelFromBody(opts.body), conv: (convOf(url) || {}).conversationId || null });

    const res = await nativeFetch.apply(window, args);
    try {
      const ct = res.headers.get("content-type") || "";
      if (/event-stream/.test(ct)) watchStream(res, isCompletion);
      const c = convOf(url);
      if (c && /[?&]tree=/.test(url) && res.ok) res.clone().json().then((data) => post("conversation", { orgId: c.orgId, conversationId: c.conversationId, data })).catch(() => {});
    } catch (e) { /* never break the page */ }
    return res;
  };

  async function watchStream(res, isCompletion) {
    try {
      const body = res.clone().body;
      const reader = body && body.getReader && body.getReader();
      if (!reader) return;
      const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const r = await reader.read(); if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        const lines = buf.split(/\r\n|\r|\n/); buf = lines.pop() || "";
        for (const ln of lines) {
          if (ln.indexOf("data:") !== 0) continue;
          const raw = ln.slice(5).trim(); if (!raw || raw.indexOf("message_limit") < 0) continue;
          try { const j = JSON.parse(raw); if (j && j.type === "message_limit" && j.message_limit) post("message_limit", j.message_limit); } catch (e) { /* partial */ }
        }
      }
      if (isCompletion) post("generation_end", {});
    } catch (e) { if (isCompletion) post("generation_end", { aborted: true }); }
  }

  // requests from the isolated Meter script
  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data; if (!d || d.cm !== MARK || d.type !== "request") return;
    const reply = (ok, payload, error) => post("response", { id: d.id, ok, payload, error });
    try {
      const org = d.payload && d.payload.orgId;
      if (!org || !/^[\w-]{8,64}$/.test(org)) throw new Error("no organization id");
      if (d.kind === "usage") {
        const r = await nativeFetch("/api/organizations/" + org + "/usage", { credentials: "include" });
        if (!r.ok) throw new Error("usage " + r.status);
        return reply(true, await r.json());
      }
      if (d.kind === "conversation") {
        const id = d.payload.conversationId; if (!id || !/^[\w-]{8,64}$/.test(id)) throw new Error("no conversation id");
        const r = await nativeFetch("/api/organizations/" + org + "/chat_conversations/" + id + "?tree=true&rendering_mode=messages&render_all_tools=true", { credentials: "include" });
        if (!r.ok) throw new Error("conversation " + r.status);
        const j = await r.json();
        post("conversation", { orgId: org, conversationId: id, data: j });
        return reply(true, null);
      }
      throw new Error("unknown request");
    } catch (e) { reply(false, null, String((e && e.message) || e)); }
  });
})();
