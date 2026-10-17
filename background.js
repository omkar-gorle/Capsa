/* Capsa v6 — service worker.
   Does all the page work (capture / link capture / insert) so the popup and the floating
   widget stay thin, and so a capture finishes even if the popup closes mid-way.
   Nothing here talks to the network except opening the chat page the user pasted. */
"use strict";
importScripts("lib/redact.js", "lib/notes.js", "lib/understand.js", "lib/capsule.js", "lib/hosts.js");

const L = self.CapsuleLib;
const H = self.CapsaHosts;
const RUNTIME = ["lib/verify.js", "lib/share-rsc.js", "content/capture-runtime.js"]; // shared-page payload reader must load before runtime
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- errors people can act on ---------- */
class UserError extends Error {}
function friendly(e) {
  if (e instanceof UserError) return e.message;
  const m = String((e && e.message) || e);
  if (/No tab with id|tab.*(closed|removed)/i.test(m)) return "That tab was closed. Open the chat again and retry.";
  if (/Cannot access|cannot be scripted|extensions gallery|manifest must request permission/i.test(m))
    return "Capsa can't read this page. Open an AI chat (ChatGPT, Claude, Gemini…) or paste a chat link.";
  return m.slice(0, 200);
}

/* ---------- page bridge ---------- */
async function tabInfo(tabId) {
  try { return await chrome.tabs.get(tabId); }
  catch (e) { throw new UserError("That tab was closed. Open the chat again and retry."); }
}

async function injectRuntime(tabId, allFrames) {
  const target = allFrames ? { tabId, allFrames: true } : { tabId };
  await chrome.scripting.executeScript({ target, files: RUNTIME });
}

// verify:true = read the WHOLE chat and prove it (two independent passes, gap checks).
// Shared conversations can render inside a same-site iframe, so inspect accessible frames and
// prefer the frame that produced a verified chat with the most messages.
async function pageCapture(tabId, verify) {
  try {
    await injectRuntime(tabId, true);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (v) => window.__chatCapsule.capture({ verify: v }),
      args: [!!verify],
    });
    const chats = (results || []).map((r) => r && r.result).filter(isChat);
    if (chats.length) {
      chats.sort((a, b) => Number(!!(b.verification && b.verification.verified)) - Number(!!(a.verification && a.verification.verified)) || b.messages.length - a.messages.length);
      return chats[0];
    }
  } catch (e) { /* a restricted frame may prevent all-frame capture; fall back to the top frame */ }

  await injectRuntime(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (v) => window.__chatCapsule.capture({ verify: v }),
    args: [!!verify],
  });
  return r && r.result;
}

const isChat = (raw) => raw && raw.siteId !== "page" && raw.messages && raw.messages.length > 0;

/* ---------- live progress while a long chat is read ---------- */
function progressText(p) {
  if (!p) return "Reading the whole chat…";
  if (p.phase === "loading-history") return "Loading older messages… " + p.found + " found so far";
  if (p.phase === "scanning") return "Pass " + (p.round || 1) + ": reading the chat " + (p.dir === "up" ? "bottom-up" : "top-down") + "… " + p.pct + "% · " + p.found + " messages";
  if (p.phase === "verifying") return p.ok ? "Verified — both passes agree." : "Pass " + p.round + " done (" + p.found + " messages). Checking it against another pass…";
  return "Reading the whole chat…";
}

// A small banner inside the page being read, so a visible window explains itself.
async function setBanner(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (t) => {
        let h = document.getElementById("capsa-reading");
        if (!h) {
          h = document.createElement("div");
          h.id = "capsa-reading";
          h.style.cssText = "all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none";
          const sh = h.attachShadow({ mode: "open" });
          sh.innerHTML = '<style>.b{font:600 13px/1.4 system-ui,sans-serif;color:#f7f6ea;background:#000;border:1.5px solid #f3b63f;border-radius:999px;padding:9px 18px;box-shadow:0 8px 30px rgba(0,0,0,.7);display:flex;gap:10px;align-items:center;max-width:80vw}.d{width:9px;height:9px;border-radius:50%;background:#f3b63f;animation:p 1s infinite;flex:none}@keyframes p{50%{opacity:.25}}</style><div class="b"><i class="d"></i><span class="t"></span></div>';
          document.documentElement.appendChild(h);
        }
        h.shadowRoot.querySelector(".t").textContent = t;
      },
      args: [text],
    });
  } catch (e) { /* page busy or gone */ }
}

async function withProgress(tabId, fn, banner) {
  let stop = false;
  (async () => {
    while (!stop) {
      await sleep(900);
      if (stop) break;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => (window.__chatCapsule && window.__chatCapsule._progress) || null });
        const text = progressText(r && r.result);
        if (!stop) { report(text); if (banner && banner()) setBanner(tabId, "Capsa is reading this chat — " + text); }
      } catch (e) { /* tab busy or gone */ }
    }
  })();
  try { return await fn(); } finally { stop = true; }
}

/* ---------- save: a capsule exists only for a VERIFIED capture ---------- */
async function saveCapsule(raw, verified) {
  const capsule = L.buildCapsule(raw);
  capsule.attachments = (raw.attachmentManifest || []).slice(0, 50).map((a) => ({ name: String(a.name || "").slice(0, 200), type: a.type || "file" }));
  const v = raw.verification;
  capsule.verification = verified === null ? null : {
    verified: !!verified, passes: v ? v.passes : 0, count: capsule.content.transcript.length,
    checks: v ? v.checks.map((c) => ({ id: c.id, ok: c.ok })) : [], reasons: verified ? [] : (v ? v.reasons : []),
  };
  try {
    await chrome.storage.local.set({ last: capsule });
    await chrome.storage.local.remove("pending");
  } catch (e) {
    throw new UserError("Couldn't save the capture (storage is full). Clear Capsa's data and retry.");
  }
  return capsule;
}

function summary(capsule, raw) {
  const v = capsule.verification;
  return {
    ok: true,
    verified: v ? v.verified : null,
    site: capsule.source.site,
    count: capsule.content.transcript.length,
    passes: v ? v.passes : 0,
    warnings: (raw && raw.warnings) || [],
  };
}

// The gate. Verified -> capsule. Anything else -> held back as "pending", no capsule.
async function finishCapture(raw) {
  checkCancel();
  if (!raw || !raw.messages || !raw.messages.length) throw new UserError("Nothing readable on this page.");
  if (raw.siteId === "page") { // not a chat (selected text / page text): nothing to verify
    const capsule = await saveCapsule(raw, null);
    return summary(capsule, raw);
  }
  const v = raw.verification;
  if (v && v.verified) {
    const capsule = await saveCapsule(raw, true);
    return summary(capsule, raw);
  }
  let hasPending = true;
  try { await chrome.storage.local.set({ pending: raw }); } catch (e) { hasPending = false; /* too large to hold: Retry still works */ }
  return {
    ok: false, unverified: true, hasPending, count: raw.messages.length,
    reasons: v && v.reasons && v.reasons.length ? v.reasons : ["the chat could not be checked"],
    needsVisible: !!raw.needsVisible,
    report: raw.report || null,
    error: "Couldn't verify the whole chat, so no capsule was made.",
  };
}

async function acceptPending() {
  const got = await chrome.storage.local.get("pending");
  if (!got.pending) throw new UserError("Nothing is waiting. Capture the chat again.");
  const capsule = await saveCapsule(got.pending, false);
  const res = summary(capsule, got.pending);
  await patchJob({ state: "done", finishedAt: Date.now(), result: res });
  setBadge("warn");
  return res;
}

/* ---------- jobs: a capture runs on its own, and the card just watches it ----------
   The card may close at any moment (Chrome closes a popup the instant focus moves to another window, and
   Capsa sometimes has to open a visible window to read a long chat), and Chrome may stop an idle worker.
   So the outcome is never handed back through one long-lived message: it is written to storage
   (job = running | done + result), and any card that opens — now or later — picks it up from there. */
let jobRunning = null, cancelFlag = false, keepTimer = 0;

class Cancelled extends UserError {}
function checkCancel() { if (cancelFlag) throw new Cancelled("Cancelled."); }

function keepAlive(on) {
  if (on && !keepTimer) keepTimer = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ } }, 20000);
  if (!on && keepTimer) { clearInterval(keepTimer); keepTimer = 0; }
}

async function patchJob(patch) {
  const g = await chrome.storage.local.get("job");
  const job = Object.assign({}, g.job || {}, patch, { hb: Date.now() });
  try { await chrome.storage.local.set({ job }); } catch (e) { /* ignore */ }
  return job;
}

function setBadge(kind) {
  try {
    const m = { run: ["…", "#f3b63f"], ok: ["✓", "#f3b63f"], warn: ["!", "#dc6949"], err: ["!", "#a12d2b"], none: ["", "#000000"] }[kind] || ["", "#000000"];
    chrome.action.setBadgeText({ text: m[0] });
    chrome.action.setBadgeBackgroundColor({ color: m[1] });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#000000" });
  } catch (e) { /* ignore */ }
}

async function startJob(kind, action, fn) {
  if (jobRunning) return { ok: false, running: true, error: "Already reading a chat — it will finish on its own." };
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  jobRunning = id; cancelFlag = false;
  const startedAt = Date.now();
  await chrome.storage.local.set({ job: { id, kind, action, state: "running", startedAt, hb: startedAt } });
  setBadge("run"); keepAlive(true);
  (async () => {
    let result;
    try { result = await fn(); }
    catch (e) { result = { ok: false, error: friendly(e), cancelled: e instanceof Cancelled, report: (e && e.report) || null }; }
    const b = result.ok ? (result.verified === false ? "warn" : "ok") : (result.unverified ? "warn" : result.cancelled ? "none" : "err");
    await patchJob({ id, state: "done", finishedAt: Date.now(), result });
    setBadge(b); jobRunning = null; cancelFlag = false; keepAlive(false);
  })();
  return { ok: true, started: true, id };
}

async function cancelJob() {
  if (!jobRunning) return { ok: true };
  cancelFlag = true;
  const g = await chrome.storage.local.get("job");
  const tabs = [g.job && g.job.tabId, g.job && g.job.pageTabId].filter(Boolean);
  for (const t of tabs) {
    try { await chrome.scripting.executeScript({ target: { tabId: t }, func: () => window.__chatCapsule && window.__chatCapsule.cancelCapture && window.__chatCapsule.cancelCapture() }); } catch (e) { /* ignore */ }
  }
  report("Cancelling…");
  return { ok: true };
}

// A worker that starts up and finds a job still "running" is looking at the corpse of a job whose worker died.
(async () => {
  try {
    const g = await chrome.storage.local.get("job");
    const j = g.job;
    if (j && j.state === "running" && !jobRunning) {
      if (j.tabId) { try { await chrome.tabs.remove(j.tabId); } catch (e) { /* gone */ } }
      // A read that Chrome cut short is restarted once, while the source tab/link is still available.
      // Keep the attempt marker in storage so a second worker death cannot create an endless restart loop.
      const a = j.action || {};
      if (!a.attempt && Date.now() - (j.startedAt || j.hb || 0) < 10 * 60 * 1000) {
        if (j.kind === "link" && a.url) {
          startJob("link", { type: "link", url: a.url, rt: a.rt, attempt: 1 }, () => captureLink(a.url, a.rt));
          return;
        }
        if (j.kind === "capture" && Number.isInteger(j.pageTabId)) {
          try {
            await chrome.tabs.get(j.pageTabId);
            await chrome.storage.local.set({ job: Object.assign({}, j, { action: { type: "capture", attempt: 1 }, state: "recovering", hb: Date.now() }) });
            startJob("capture", { type: "capture", attempt: 1 }, () => captureTab(j.pageTabId));
            return;
          } catch (e) { /* the source tab is no longer available */ }
        }
      }
      await chrome.storage.local.set({ job: Object.assign({}, j, {
        state: "done", finishedAt: Date.now(), hb: Date.now(),
        result: { ok: false, interrupted: true, error: "Reading was interrupted — Chrome stopped Capsa's background worker. Nothing was lost; tap Retry." },
      }) });
      setBadge("err");
    }
  } catch (e) { /* ignore */ }
})();

/* ---------- capture the tab you are on ---------- */
async function captureTab(tabId) {
  const tab = await tabInfo(tabId);
  if (H.isRestricted(tab.url)) {
    throw new UserError("Chrome doesn't allow extensions on this page. Open a chat, or paste a chat link instead.");
  }
  await chrome.storage.local.remove("pending");
  await patchJob({ pageTabId: tabId });
  report("Reading the whole chat…");
  const raw = await withProgress(tabId, () => pageCapture(tabId, true));
  return finishCapture(raw);
}

/* ---------- capture from a pasted link ---------- */
function waitForLoad(tabId, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return; done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      chrome.tabs.onRemoved.removeListener(onRem);
      fn(v);
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(resolve); };
    const onRem = (id) => { if (id === tabId) finish(reject, new UserError("The chat tab was closed before it finished loading.")); };
    const timer = setTimeout(() => finish(resolve), ms); // slow page: try anyway
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onRemoved.addListener(onRem);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(resolve); }, () => {});
  });
}

const SIGNIN_RE = /\/(log-?in|sign-?in|auth)\b/i;

async function captureLink(url, returnTabId) {
  const v = H.validateLink(url);
  if (!v.ok) throw new UserError(v.error);
  await chrome.storage.local.remove("pending");

  const returnTab = returnTabId ? await chrome.tabs.get(returnTabId).catch(() => null) : null;
  const tab = await chrome.tabs.create(Object.assign({ url: v.url, active: false }, returnTab ? { windowId: returnTab.windowId } : {}));
  const tabId = tab.id;
  let visible = false;
  await patchJob({ tabId });

  // Some sites only render (and only load older messages) while the page is on screen. When that
  // happens we move the tab into a visible window, say so, and read it there.
  const surface = async (why) => {
    if (visible) return;
    visible = true;
    report(why);
    try { await chrome.windows.create({ tabId, type: "popup", width: 1000, height: 780, focused: true }); }
    catch (e) { try { await chrome.tabs.update(tabId, { active: true }); } catch (e2) { /* ignore */ } }
    await sleep(900);
    setBanner(tabId, why);
  };

  try {
    report("Opening " + v.site.name + "…");
    await waitForLoad(tabId, 30000);
    const landed = await tabInfo(tabId);
    if (!H.siteOf(landed.url)) {
      throw new UserError("That link sent the browser to a sign-in page. Sign in to " + v.site.name + " in Chrome, then paste the link again.");
    }

    // 1. wait for the chat to show up at all
    report("Reading the conversation…");
    const started = Date.now();
    let found = false;
    while (Date.now() - started < 45000) {
      checkCancel();
      let r = null;
      try { r = await pageCapture(tabId, false); } catch (e) { r = null; }
      if (isChat(r)) { found = true; break; }
      if (!visible && Date.now() - started > 9000) await surface("This site only shows a chat while its page is on screen. Capsa opened a visible window — leave it open while it reads.");
      if (Date.now() - started > 5000) {
        const t = await tabInfo(tabId).catch(() => null);
        if (t && SIGNIN_RE.test(t.url || "")) throw new UserError("This chat needs you to sign in to " + v.site.name + " first. Sign in, then paste the link again.");
      }
      await sleep(1400);
    }
    if (!found) {
      const t = await tabInfo(tabId).catch(() => null);
      if (t && /login|signin|sign-in|auth|accounts\.google/i.test(t.url || "")) {
        throw new UserError("This chat needs you to sign in to " + v.site.name + " first. Sign in, then paste the link again.");
      }
      const err = new UserError("Couldn't find a conversation at that link. It may be private, deleted, or still loading — open it once in Chrome and retry. If it opens fine in Chrome, tap Copy page report below.");
      try {
        await injectRuntime(tabId);
        const [rr] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__chatCapsule.diagnose() });
        err.report = rr && rr.result;
      } catch (e) { /* the page may be gone */ }
      throw err;
    }

    // 2. read it all and verify — hidden first; visible if the page can't be read while hidden
    let raw = await withProgress(tabId, () => pageCapture(tabId, true), () => visible);
    if (raw && raw.needsVisible && !visible) {
      await surface("This chat is long and the site only loads it while the page is on screen. Capsa opened a visible window — leave it open while it reads.");
      raw = await withProgress(tabId, () => pageCapture(tabId, true), () => visible);
    }
    return await finishCapture(raw);
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already gone */ }
    if (returnTab) {
      try { await chrome.windows.update(returnTab.windowId, { focused: true }); } catch (e) { /* ignore */ }
      try { await chrome.tabs.update(returnTab.id, { active: true }); } catch (e) { /* ignore */ }
    }
  }
}

/* ---------- insert into the chat box of a tab ---------- */
async function insertInto(tabId, text) {
  const tab = await tabInfo(tabId);
  if (H.isRestricted(tab.url)) throw new UserError("Open a chat first — Chrome doesn't allow extensions on this page.");
  await injectRuntime(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (t) => window.__chatCapsule.insert(t),
    args: [String(text || "")],
  });
  return { ok: true, result: (r && r.result) || { ok: false, error: "No response from the page." } };
}

/* ---------- hand-off: read the whole chat, then drop the capsule into another AI's box ---------- */
const HANDOFF = { chatgpt: { name: "ChatGPT", url: "https://chatgpt.com/" }, gemini: { name: "Gemini", url: "https://gemini.google.com/app" }, grok: { name: "Grok", url: "https://grok.com/" } };

async function handoffJob(tabId, targetId, level) {
  const tgt = Object.prototype.hasOwnProperty.call(HANDOFF, targetId) ? HANDOFF[targetId] : null;
  if (!tgt) throw new UserError("Unknown hand-off target.");
  const res = await captureTab(tabId);                                    // same gate as everywhere: no verified read, no capsule
  if (!res || !res.ok || res.verified === false) return res;
  const got = await chrome.storage.local.get("last");
  if (!got.last) throw new UserError("The capture finished but could not be found. Try again.");
  const r = L.renderCapsule(got.last, { level: level === 2 ? 2 : 1 });
  if (!r || !r.text) throw new UserError("Nothing to hand off.");
  report("Opening " + tgt.name + "…");
  const tab = await chrome.tabs.create({ url: tgt.url, active: true });
  await waitForLoad(tab.id, 25000);
  let inserted = false;
  for (let i = 0; i < 10 && !inserted; i++) {                             // the chat box can take a few seconds to appear
    await sleep(i ? 1500 : 800);
    try { const ins = await insertInto(tab.id, r.text); inserted = !!(ins && ins.result && ins.result.ok); } catch (e) { /* page not ready, or signed out */ }
  }
  return Object.assign({}, res, { handoff: { target: targetId, inserted, tokens: r.tokens, note: inserted ? "" : "The capsule is saved — open Capsa there and tap Insert or Copy." } });
}

/* ---------- messages ---------- */
const progressKey = "progress";
async function report(text) { try { await chrome.storage.local.set({ [progressKey]: { text, at: Date.now() } }); } catch (e) { /* ignore */ } }

async function handle(msg, sender) {
  const tabId = msg.tabId || (sender.tab && sender.tab.id);
  switch (msg && msg.type) {
    case "capture":
      if (!tabId) throw new UserError("No tab to capture.");
      return startJob("capture", { type: "capture" }, () => captureTab(tabId));
    case "captureLink": {
      const v = H.validateLink(msg.url);
      if (!v.ok) throw new UserError(v.error);
      return startJob("link", { type: "link", url: v.url, rt: tabId }, () => captureLink(v.url, tabId));
    }
    case "handoff":
      if (!tabId) throw new UserError("No tab to hand off.");
      return startJob("capture", { type: "capture", handoff: String(msg.target || "") }, () => handoffJob(tabId, String(msg.target || ""), msg.level));
    case "cancelJob":
      return cancelJob();
    case "ackJob": {
      setBadge("none");
      const g = await chrome.storage.local.get("job");
      if (g.job && g.job.state === "done" && !g.job.acked) await patchJob({ acked: true });
      return { ok: true };
    }
    case "acceptPending":
      return acceptPending();
    case "insert":
      if (!tabId) throw new UserError("No tab to insert into.");
      return insertInto(tabId, msg.text);
    case "ping":
      return { ok: true };
    default:
      throw new UserError("Unknown request.");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: friendly(e) }));
  return true; // async
});

/* ---------- show the floating orb on already-open AI tabs after install/update ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const patterns = chrome.runtime.getManifest().content_scripts[0].matches;
    const files = chrome.runtime.getManifest().content_scripts[0].js;
    const tabs = await chrome.tabs.query({ url: patterns });
    for (const t of tabs) {
      chrome.scripting.executeScript({ target: { tabId: t.id }, files }).catch(() => {});
    }
    // the Meter on already-open claude.ai tabs (the tap has to live in the page's own world)
    for (const t of await chrome.tabs.query({ url: ["https://claude.ai/*"] })) {
      chrome.scripting.executeScript({ target: { tabId: t.id }, world: "MAIN", files: ["content/meter-tap.js"] })
        .then(() => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["lib/meter.js", "content/meter.js"] })).catch(() => {});
    }
  } catch (e) { /* not fatal */ }
});
