"use strict";
/* Chat Capsule v1.0 — Popup controller.
   Coordinates: capture, capsule rendering, AI provider, storage, import/export.
   Never logs conversation content.
*/

const L = CapsuleLib;
const P = AIProvider;
const Prompts = AIPrompts;
const Verifier = AIVerifier;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const IN_TAB = params.has("tab");
const TARGET_TAB = IN_TAB ? Number(params.get("tab")) : null;
if (IN_TAB) { document.body.classList.add("wide"); $("openTab").hidden = true; }

const state = {
  capsule: null, excluded: new Set(), edited: false, live: false,
  last: null, aiReply: "", chatTokens: 0, lastLevel: null, profile: null,
  aiSettings: null, aiRunning: false,
};
const LEVEL_OF = { l0: 0, l1: 1, l2: 2 };
const STORE_KEY = "capsules_v3";
const PROFILE_KEY = "profile_v1";

/* ── Helpers ── */
function setStatus(msg, kind) {
  const s = $("status");
  s.textContent = msg || "";
  s.className = "status" + (kind ? " " + kind : "");
}

function fillList(ul, items) {
  ul.textContent = "";
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = t;
    ul.appendChild(li);
  }
}

function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (/cannot access|chrome:\/\/|extensions gallery|Cannot script|cannot be scripted/i.test(m))
    return "Chrome does not allow extensions on this page. Open a normal website and try again.";
  if (/No tab with id|tab.*closed/i.test(m)) return "That tab was closed. Go back to the chat tab and try again.";
  if (/OperationError|decrypt/i.test(m)) return "Wrong passphrase, or the file is not a valid encrypted capsule.";
  return m;
}

const slug = (s) => (s || "capsule").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "capsule";

/* ── Tab navigation ── */
document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const pane = $("pane-" + btn.dataset.tab);
    if (pane) pane.classList.add("active");
    if (btn.dataset.tab === "history") renderSaved();
  };
});

/* ── Page bridge ── */
async function getTabId() {
  if (TARGET_TAB) return TARGET_TAB;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  return tab.id;
}

async function callPage(name, args) {
  const tabId = await getTabId();
  // Try the new path first, fall back to legacy
  const scriptFile = "extension/content/capture-runtime.js";
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/capture.js"] });
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (n, a) => window.__chatCapsule[n](...a),
    args: [name, args || []],
  });
  return res && res.result;
}

async function peekLast() {
  try {
    const tabId = await getTabId();
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.__chatCapsule && window.__chatCapsule.last && window.__chatCapsule.last()) || null,
    });
    return res && res.result;
  } catch (e) { return null; }
}

/* ── Capture ── */
function setBusy(b) { for (const id of ["capture", "deep", "generate"]) { const el = $(id); if (el) el.disabled = b; } }

function adopt(cap) {
  state.capsule = L.buildCapsule(cap);
  state.chatTokens = 0;
  state.aiReply = "";
  state.excluded = new Set();
  state.edited = false;
  state.live = true;
  showReport();
  renderMessages();
  regenerate(true);
  // Show preview pane
  $("previewBox").hidden = false;
}

async function doCapture(deep) {
  setBusy(true);
  setStatus(deep ? "Scrolling the chat to load older messages. Keep this window open." : "Reading the page…");
  try {
    const cap = await callPage("capture", [{ deep: !!deep }]);
    if (!cap || !cap.messages || !cap.messages.length) throw new Error("Nothing could be captured on this page.");
    adopt(cap);
    updatePlatformBadge(cap);
    setStatus("");
  } catch (e) {
    setStatus(friendlyError(e), "error");
  } finally {
    setBusy(false);
  }
}

function updatePlatformBadge(cap) {
  const badge = $("platformBadge");
  badge.textContent = cap.site || cap.siteId || "Unknown";
  const covBadge = $("coverageBadge");
  const cov = cap.coverage || {};
  if (cov.complete === true) {
    $("coverageIcon").textContent = "✓";
    $("coverageText").textContent = "Complete";
    covBadge.hidden = false;
  } else if (cov.complete === false) {
    $("coverageIcon").textContent = "⚠";
    $("coverageText").textContent = "Partial";
    covBadge.hidden = false;
  }
}

/* ── Report ── */
function showReport() {
  const c = state.capsule;
  const t = c.content.transcript;
  const users = t.filter((m) => m.role === "User").length;
  const asst = t.filter((m) => m.role === "Assistant").length;
  const other = t.length - users - asst;
  const s = c.stats || {};
  const cov = c.coverage || {};
  const icon = cov.complete === false ? "⚠" : "✓";
  $("repTitle").textContent = `${icon} ${t.length} message${t.length === 1 ? "" : "s"} from ${c.source.site}`;
  $("repCounts").textContent =
    `You ${users} · Assistant ${asst}${other ? " · Other " + other : ""} · Code ${s.codeBlocks || 0} · Tables ${s.tables || 0} · Links ${s.links || 0}`;
  const methods = { dom: "page text", "dom-deep": "page text + scrolling", selection: "selection", page: "page text", legacy: "legacy" };
  const covText = cov.complete === true ? "verified complete" : cov.complete === false ? "possibly incomplete" : "not verified";
  $("repMeta").textContent = `Read from: ${methods[c.captureMethod] || c.captureMethod} · Coverage: ${covText}`;
  fillList($("repWarn"), c.warnings || []);
  $("deep").hidden = !state.live || c.captureMethod === "selection" || c.captureMethod === "page" || cov.deep === true;
  $("report").hidden = false;
  $("build").hidden = false;
}

/* ── Profile ── */
async function loadProfile() {
  const o = await chrome.storage.local.get(PROFILE_KEY);
  state.profile = o[PROFILE_KEY] || null;
  if (state.profile) {
    $("profName").value = state.profile.name || "";
    $("profTone").value = state.profile.tone || "";
    $("profStack").value = state.profile.stack || "";
    $("profConstraints").value = (state.profile.constraints || []).join("\n");
    $("profNotes").value = state.profile.notes || "";
  }
}

async function saveProfile() {
  const constraints = $("profConstraints").value.split("\n").map((s) => s.trim()).filter(Boolean);
  state.profile = {
    name: $("profName").value.trim() || "",
    tone: $("profTone").value.trim() || "",
    stack: $("profStack").value.trim() || "",
    constraints,
    notes: $("profNotes").value.trim() || "",
  };
  const empty = !state.profile.name && !state.profile.tone && !state.profile.stack && !constraints.length && !state.profile.notes;
  if (empty) {
    await chrome.storage.local.remove(PROFILE_KEY);
    state.profile = null;
    $("profStatus").textContent = "Profile cleared.";
  } else {
    await chrome.storage.local.set({ [PROFILE_KEY]: state.profile });
    $("profStatus").textContent = "Profile saved.";
  }
  $("profStatus").className = "status ok";
  regenerate(true);
}

/* ── Build / preview ── */
function currentMode() {
  const radio = document.querySelector('input[name="mode"]:checked');
  return radio ? radio.value : "l1";
}

function options() {
  const mode = currentMode();
  const o = {
    mode: mode === "ai-smart" ? "smart" : mode, // ai-smart falls back to smart locally
    budget: Number($("budget").value),
    intent: $("intent").value,
    excluded: state.excluded,
    clean: $("clean").checked,
    profile: $("useProfile").checked ? state.profile : null,
  };
  if (mode in LEVEL_OF) o.level = LEVEL_OF[mode];
  return o;
}

function syncControls() {
  const m = currentMode();
  $("budget").disabled = !(m === "smart" || m === "lossless" || m === "ai-smart");
  $("aiBox").hidden = m !== "ai-smart";
  updateAiStatusInCapture();
}

function updateMeter(tokens, budget, extra) {
  const pct = Math.min(100, Math.round((tokens / budget) * 100));
  $("meterBar").style.width = pct + "%";
  $("meterBar").className = "meter-bar" + (tokens > budget ? " over" : "");
  $("meterText").textContent = `≈ ${tokens.toLocaleString()} of ${budget.toLocaleString()} tokens` + (extra ? " · " + extra : "");
}

function showSaving(tokens) {
  if (!state.capsule) { $("saving").textContent = ""; return; }
  if (!state.chatTokens) state.chatTokens = L.chatTokens(state.capsule);
  $("saving").textContent = L.savingText(state.chatTokens, tokens) + " · estimated";
}

function regenerate(force) {
  if (!state.capsule) return;
  if (state.edited && !force) {
    $("regen").hidden = false;
    setStatus("Options changed. Click Regenerate to rebuild (edits will be replaced).");
    return;
  }
  syncControls();
  const o = options();
  const m = currentMode();
  let r;
  if (m === "ai-smart") {
    if (!state.aiReply.trim()) {
      // Run AI automatically if settings exist
      runAiExtraction();
      return;
    }
    r = L.renderAiSummary(state.capsule, state.aiReply, { intent: o.intent });
  } else {
    r = L.renderCapsule(state.capsule, o);
  }
  state.last = r;
  if (o.level != null) state.lastLevel = o.level;
  $("preview").value = r.text;
  state.edited = false;
  $("regen").hidden = true;
  const names = { level0: "compact", level1: "standard", level2: "extended" };
  const modeNote = r.mode === "lossless" && m === "smart" ? "lossless (no user messages)" : (names[r.mode] || r.mode);
  updateMeter(r.tokens, r.budget, r.mode === "ai" ? "written by original AI" : `${r.included}/${r.total} msgs · ${modeNote}`);
  showSaving(r.tokens);
  fillList($("buildWarn"), r.warnings);
  $("msgsSummary").textContent = `Messages (${r.included} of ${r.total} included)`;
}

/* ── AI extraction ── */
async function runAiExtraction() {
  if (state.aiRunning) return;
  if (!state.aiSettings || state.aiSettings.mode === "disabled") {
    setStatus("Configure an AI provider in the AI tab first.", "warn");
    return;
  }
  const msgs = (state.capsule.content.transcript || [])
    .filter((m) => !state.excluded.has(m.i))
    .slice(0, 200); // hard limit: never send more than 200 msgs

  // Privacy confirmation for cloud providers
  const prov = P.PROVIDERS[state.aiSettings.providerId] || {};
  if (!prov.local) {
    const confirmed = confirm(
      `AI Enhanced Mode\n\nThe selected conversation content will be sent to:\nProvider: ${prov.name}\nModel: ${state.aiSettings.model}\n\nLocal capture and validation happen first.\n\nContinue?`
    );
    if (!confirmed) return;
  }

  state.aiRunning = true;
  setBusy(true);
  setStatus("AI analyzing conversation…", "");

  try {
    const prompt = Prompts.extractStatePrompt(msgs);
    const result = await P.call(
      state.aiSettings,
      prompt.system,
      prompt.user,
      { jsonSchema: true, timeout: state.aiSettings.timeout || 30000 }
    );

    const parsed = Verifier.parseAIJson(result.content);
    const verified = Verifier.verify(parsed, msgs);

    const aiText = buildAiCapsuleText(parsed, verified.warnings);
    state.aiReply = aiText;

    const r = L.renderAiSummary(state.capsule, aiText, { intent: $("intent").value });
    state.last = r;
    $("preview").value = r.text;
    state.edited = false;
    $("regen").hidden = true;
    updateMeter(r.tokens, r.budget, "AI extracted");
    showSaving(r.tokens);
    fillList($("buildWarn"), [...r.warnings, ...verified.warnings]);
    $("msgsSummary").textContent = `Messages (${msgs.length} analyzed by AI)`;
    setStatus(verified.ok ? "AI extraction complete." : "AI extraction complete with warnings.", verified.ok ? "ok" : "warn");
  } catch (e) {
    setStatus("AI failed: " + P.humanError(e) + " — using local Smart Capsule instead.", "warn");
    // Fallback to local smart capsule
    const o = options();
    o.mode = "smart";
    const r = L.renderCapsule(state.capsule, o);
    state.last = r;
    $("preview").value = r.text;
    updateMeter(r.tokens, r.budget, "local fallback");
    showSaving(r.tokens);
    fillList($("buildWarn"), [...r.warnings, "AI unavailable — local Smart Capsule was used instead."]);
  } finally {
    state.aiRunning = false;
    setBusy(false);
  }
}

function buildAiCapsuleText(state_obj, warnings) {
  const lines = [];
  if (state_obj.goal) lines.push("GOAL: " + state_obj.goal);
  if (state_obj.currentState) lines.push("CURRENT STATE: " + state_obj.currentState);
  if (state_obj.latestRequest && state_obj.latestRequest !== state_obj.goal)
    lines.push("LATEST REQUEST: " + state_obj.latestRequest);
  if (state_obj.constraints && state_obj.constraints.length)
    lines.push("CONSTRAINTS:\n" + state_obj.constraints.map((c) => "- " + c).join("\n"));
  if (state_obj.decisions && state_obj.decisions.length)
    lines.push("DECISIONS:\n" + state_obj.decisions.map((d) => `- ${d.text}${d.reason ? " (" + d.reason + ")" : ""}`).join("\n"));
  if (state_obj.supersededDecisions && state_obj.supersededDecisions.length)
    lines.push("SUPERSEDED:\n" + state_obj.supersededDecisions.map((d) => `- ~~${d.text}~~ → ${d.replacedBy}`).join("\n"));
  if (state_obj.completedTasks && state_obj.completedTasks.length)
    lines.push("DONE:\n" + state_obj.completedTasks.map((t) => "- ✅ " + t).join("\n"));
  if (state_obj.openTasks && state_obj.openTasks.length)
    lines.push("OPEN:\n" + state_obj.openTasks.map((t) => "- ☐ " + t).join("\n"));
  if (state_obj.nextAction) lines.push("NEXT ACTION: " + state_obj.nextAction);
  if (warnings && warnings.length) lines.push("\n⚠ Verification notes:\n" + warnings.map((w) => "- " + w).join("\n"));
  return lines.join("\n\n");
}

function renderMessages() {
  const box = $("msglist");
  box.textContent = "";
  for (const m of state.capsule.content.transcript) {
    const row = document.createElement("label");
    row.className = "msg" + (state.excluded.has(m.i) ? " off" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !state.excluded.has(m.i);
    cb.onchange = () => {
      if (cb.checked) state.excluded.delete(m.i); else state.excluded.add(m.i);
      row.classList.toggle("off", !cb.checked);
      regenerate(true);
    };
    const who = document.createElement("span");
    who.className = "who" + (m.confidence < 0.6 ? " guess" : "");
    who.textContent = (m.role === "User" ? "Me" : m.role) + (m.confidence < 0.6 ? " ?" : "");
    if (m.confidence < 0.6) who.title = "Role was guessed";
    const pv = document.createElement("span");
    pv.className = "pv";
    pv.textContent = m.text.replace(/\s+/g, " ").slice(0, 120);
    row.append(cb, who, pv);
    box.appendChild(row);
  }
}

function setSelection(fn) {
  state.excluded = new Set(state.capsule.content.transcript.filter((m) => !fn(m)).map((m) => m.i));
  renderMessages();
  regenerate(true);
}

/* ── AI Settings Tab ── */
function updateAiPrivacyBlock() {
  const pid = $("aiProvider").value;
  const prov = P.PROVIDERS[pid] || {};
  const block = $("aiPrivacyBlock");
  const icon = $("privacyIcon");
  const title = $("privacyTitle");
  const body = $("privacyBody");
  if (prov.local) {
    icon.textContent = "🔒";
    title.textContent = "Local AI";
    body.textContent = "Processing stays on this device. No conversation content leaves your browser.";
    block.style.borderColor = "var(--accent-g)";
  } else {
    icon.textContent = "☁️";
    title.textContent = "Cloud AI";
    body.textContent = `Selected content will be sent to ${prov.name}. You will be shown a confirmation before processing.`;
    block.style.borderColor = "var(--accent-y)";
  }
  $("apiKeyRow").hidden = !prov.requiresKey;
  $("customEndpointRow").hidden = !(pid === "custom" || pid === "litellm");
  $("customModelRow").hidden = !(pid === "custom" || pid === "litellm" || pid === "ollama");
}

function updateAiStatusInCapture() {
  if (!$("aiBox").hidden) {
    const s = state.aiSettings;
    if (s && s.mode !== "disabled" && s.providerId) {
      const prov = P.PROVIDERS[s.providerId] || {};
      $("aiProviderName").textContent = prov.name || s.providerId;
      updatePrivacyNotice(s, prov);
    } else {
      $("aiProviderName").textContent = "No AI configured";
    }
  }
}

function updatePrivacyNotice(s, prov) {
  const notice = $("privacyNotice");
  const text = $("privacyText");
  if (prov.local) {
    notice.hidden = false;
    text.textContent = "LOCAL — processing stays on this device";
  } else if (s && s.providerId) {
    notice.hidden = false;
    text.textContent = `CLOUD — content sent to ${prov.name || s.providerId}`;
  } else {
    notice.hidden = true;
  }
}

async function loadAiSettings() {
  state.aiSettings = await P.loadSettings();
  // Populate UI
  $("aiProvider").value = state.aiSettings.providerId || "ollama";
  $("aiApiKey").value = state.aiSettings.apiKey || "";
  $("aiEndpoint").value = state.aiSettings.customEndpoint || "";
  $("aiTimeout").value = Math.round((state.aiSettings.timeout || 30000) / 1000);
  $("aiTemp").value = state.aiSettings.temperature || 0.3;
  $("aiMaxTokens").value = state.aiSettings.maxOutputTokens || 2048;
  updateAiProviderUI();
}

function updateAiProviderUI() {
  updateAiPrivacyBlock();
  // Populate model selector
  const pid = $("aiProvider").value;
  const prov = P.PROVIDERS[pid] || {};
  const sel = $("aiModel");
  sel.innerHTML = '<option value="">— select or type below —</option>';
  if (prov.models && prov.models.length) {
    prov.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (m.tier ? ` (${m.tier})` : "");
      if (state.aiSettings && m.id === state.aiSettings.model) opt.selected = true;
      sel.appendChild(opt);
    });
  }
}

async function saveAiSettings() {
  const pid = $("aiProvider").value;
  const modelSel = $("aiModel").value;
  const modelCustom = $("aiModelCustom").value.trim();
  const model = modelCustom || modelSel || P.PROVIDERS[pid]?.defaultModel || "";
  const settings = {
    providerId: pid,
    model,
    apiKey: $("aiApiKey").value.trim(),
    customEndpoint: $("aiEndpoint").value.trim(),
    timeout: Number($("aiTimeout").value) * 1000,
    temperature: Number($("aiTemp").value),
    maxOutputTokens: Number($("aiMaxTokens").value),
    mode: "ai-enhanced",
  };
  await P.saveSettings(settings);
  state.aiSettings = settings;
  setStatus("AI settings saved.", "ok");
  updateAiStatusInCapture();
}

async function testAiConnection() {
  $("aiTest").disabled = true;
  $("aiConnectionStatus").hidden = false;
  const dot = $("aiConnectionStatus").querySelector(".dot");
  dot.className = "dot yellow";
  $("aiConnText").textContent = "Testing…";
  try {
    const settings = {
      providerId: $("aiProvider").value,
      model: $("aiModelCustom").value.trim() || $("aiModel").value || "",
      apiKey: $("aiApiKey").value.trim(),
      customEndpoint: $("aiEndpoint").value.trim(),
      timeout: 10000,
    };
    const result = await P.testConnection(settings);
    if (result.ok) {
      dot.className = "dot green";
      $("aiConnText").textContent = `Connected · model: ${result.model || "unknown"}`;
      // Fetch model list
      const models = await P.listModels(settings);
      if (models.models && models.models.length) {
        renderModelList(models.models, settings);
      }
    } else {
      dot.className = "dot red";
      $("aiConnText").textContent = P.humanError({ message: result.error, code: result.code });
    }
  } catch (e) {
    $("aiConnectionStatus").querySelector(".dot").className = "dot red";
    $("aiConnText").textContent = P.humanError(e);
  } finally {
    $("aiTest").disabled = false;
  }
}

function renderModelList(models, settings) {
  const card = $("modelListCard");
  const list = $("modelList");
  list.textContent = "";
  models.slice(0, 20).forEach((m) => {
    const item = document.createElement("div");
    item.className = "model-item";
    item.innerHTML = `<span>${m.name || m.id}</span><span class="model-tier">${m.tier || ""}</span>`;
    item.onclick = () => {
      $("aiModelCustom").value = m.id;
      $("aiModel").value = m.id;
      setStatus("Model selected: " + m.id, "ok");
    };
    list.appendChild(item);
  });
  card.hidden = false;
}

/* ── Insert / copy ── */
async function insertText(text) {
  setStatus("Inserting…");
  try {
    const r = await callPage("insert", [text]);
    if (r && r.ok) { setStatus("Inserted and verified in the chat box. Review, then send.", "ok"); return; }
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { /* ignore */ }
    const why = (r && r.error) || "Could not insert.";
    if (r && r.partial) {
      setStatus(why + " Clear the box and paste yourself" + (copied ? " (full capsule is on the clipboard)." : "."), "error");
    } else {
      setStatus(why + (copied ? " Capsule is on the clipboard. Paste with Ctrl/Cmd+V." : ""), "error");
    }
  } catch (e) {
    setStatus(friendlyError(e), "error");
  }
}

/* ── Storage ── */
async function loadList() {
  const o = await chrome.storage.local.get(STORE_KEY);
  return Array.isArray(o[STORE_KEY]) ? o[STORE_KEY] : [];
}

function titleOf(c) {
  const first = c.content.transcript.find((m) => m.role === "User");
  const label = first ? first.text.replace(/\s+/g, " ").slice(0, 40) : c.source.title || "Capsule";
  return `${c.source.site}: ${label}`;
}

async function packEntry(c) {
  const z = await L.gzipB64(JSON.stringify(c));
  return { id: c.id, title: titleOf(c), site: c.source.site, capturedAt: c.capturedAt, messages: c.content.transcript.length, z };
}

async function unpackEntry(e) {
  const o = JSON.parse(await L.gunzipB64(e.z));
  const v = L.validateCapsule(o);
  if (!v.ok) throw new Error(v.error);
  return L.sanitizeCapsule(o);
}

async function writeList(list) {
  try {
    await chrome.storage.local.set({ [STORE_KEY]: list });
    return true;
  } catch (e) {
    setStatus("Storage is full. Delete or download some capsules first.", "error");
    return false;
  }
}

async function migrateLegacy() {
  for (const key of ["capsules_v2", "capsules"]) {
    const o = await chrome.storage.local.get(key);
    if (!Array.isArray(o[key]) || !o[key].length) continue;
    const list = await loadList();
    for (const old of o[key]) {
      try {
        let c;
        if (old.z) c = await unpackEntry(old);
        else c = await L.sealCapsule(L.fromLegacy(old));
        list.push(await packEntry(c));
      } catch (e) { /* skip broken */ }
    }
    if (await writeList(list)) await chrome.storage.local.remove(key);
  }
}

function snapshotForSave() {
  const c = JSON.parse(JSON.stringify(state.capsule));
  const keep = c.content.transcript.filter((m) => !state.excluded.has(m.i));
  c.content.transcript = keep.map((m, i) => ({ ...m, i }));
  c.content.autoFacts = L.extractFacts(c.content.transcript);
  return c;
}

async function saveCurrent() {
  if (!state.capsule) return;
  const c = snapshotForSave();
  if (!c.content.transcript.length) { setStatus("Select at least one message to save.", "error"); return; }
  c.id = L.uuid();
  await L.sealCapsule(c);
  const list = await loadList();
  list.unshift(await packEntry(c));
  if (await writeList(list)) { setStatus("Saved.", "ok"); await renderSaved(); }
}

async function updateStorageMeter() {
  try {
    const used = await chrome.storage.local.getBytesInUse(null);
    const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
    const pct = Math.round((used / quota) * 100);
    const el = $("storage");
    el.textContent = `Storage: ${(used / 1048576).toFixed(2)} of ${(quota / 1048576).toFixed(0)} MB (${pct}%)` +
      (pct >= 80 ? " — almost full; download older capsules and delete them." : "");
    el.className = "storage-meter" + (pct >= 80 ? " error" : "");
  } catch (e) { $("storage").textContent = ""; }
}

async function openEntry(e, thenInsert) {
  try {
    state.capsule = await unpackEntry(e);
    state.chatTokens = 0; state.aiReply = "";
    state.excluded = new Set(); state.edited = false; state.live = false;
    $("previewBox").hidden = false;
    showReport(); renderMessages(); regenerate(true);
    if (thenInsert) await insertText($("preview").value);
    else setStatus("Loaded. Adjust options, then Copy or Insert.", "ok");
    // Switch to Capture tab to show the loaded capsule
    document.querySelector('.tab[data-tab="capture"]').click();
  } catch (err) {
    setStatus("Could not open: " + friendlyError(err), "error");
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function downloadEntry(e) {
  try {
    const c = await unpackEntry(e);
    const pass = $("passphrase").value;
    let payload = pass ? await L.encryptJson(c, pass) : c;
    download(slug(e.title) + ".capsule", JSON.stringify(payload, null, 1), "application/json");
  } catch (err) { setStatus("Export failed: " + friendlyError(err), "error"); }
}

async function renderSaved() {
  const list = await loadList();
  const box = $("saved");
  box.textContent = "";
  if (!list.length) {
    const p = document.createElement("div"); p.className = "empty";
    p.textContent = "Nothing saved yet."; box.appendChild(p);
  }
  for (const e of list) {
    const row = document.createElement("div"); row.className = "item";
    const t = document.createElement("div"); t.className = "t";
    const b = document.createElement("b"); b.textContent = e.title;
    const s = document.createElement("span");
    s.textContent = `${e.messages} msgs · ${new Date(e.capturedAt).toLocaleDateString()} · ${Math.max(1, Math.round(e.z.length / 1024))} KB`;
    t.append(b, s);
    const mk = (text, title, fn) => {
      const x = document.createElement("button"); x.textContent = text; x.title = title;
      x.className = "btn-xs"; x.onclick = fn; return x;
    };
    const del = mk("Delete", "Delete permanently", async () => {
      if (del.dataset.armed !== "1") {
        del.dataset.armed = "1"; del.textContent = "Sure?";
        setTimeout(() => { del.dataset.armed = ""; del.textContent = "Delete"; }, 2800);
        return;
      }
      const all = await loadList();
      if (await writeList(all.filter((x) => x.id !== e.id))) await renderSaved();
    });
    del.className += " danger-ish";
    row.append(t,
      mk("Load", "Load into the builder", () => openEntry(e, false)),
      mk("Insert", "Load and insert into the chat box", () => openEntry(e, true)),
      mk("↓", "Download as .capsule", () => downloadEntry(e)),
      del
    );
    box.appendChild(row);
  }
  await updateStorageMeter();
}

async function importFile(file) {
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("File is too large.");
    const text = await file.text();
    let raw = JSON.parse(text);
    if (raw.enc) {
      const pass = $("passphrase").value || prompt("This capsule is encrypted. Enter the passphrase:");
      if (!pass) throw new Error("Passphrase required.");
      raw = await L.decryptJson(raw, pass);
    }
    const v = L.validateCapsule(raw);
    if (!v.ok) throw new Error(v.error);
    const c = L.sanitizeCapsule(raw);
    await L.sealCapsule(c);
    const list = await loadList();
    list.unshift(await packEntry(c));
    if (await writeList(list)) {
      setStatus("Imported.", "ok");
      await renderSaved();
      state.capsule = c; state.chatTokens = 0;
      state.excluded = new Set(); state.edited = false; state.live = false;
      $("previewBox").hidden = false;
      showReport(); renderMessages(); regenerate(true);
    }
  } catch (e) {
    setStatus("Import failed: " + friendlyError(e), "error");
  }
}

/* ── Events ── */
$("capture").onclick = () => doCapture(false);
$("deep").onclick = () => doCapture(true);

document.querySelectorAll('input[name="mode"]').forEach((r) => { r.onchange = () => regenerate(false); });
$("budget").onchange = () => regenerate(false);
$("intent").onchange = () => regenerate(false);
$("clean").onchange = () => regenerate(false);
$("useProfile").onchange = () => regenerate(false);
$("preview").oninput = () => { state.edited = true; };
$("regen").onclick = () => regenerate(true);
$("generate").onclick = () => {
  const m = currentMode();
  if (m === "ai-smart") runAiExtraction();
  else regenerate(true);
};

$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("preview").value);
    setStatus("Copied to clipboard.", "ok");
  } catch (e) { setStatus("Could not copy: " + e.message, "error"); }
};
$("insert").onclick = () => insertText($("preview").value);
$("save").onclick = () => saveCurrent();
$("dlMd").onclick = () => {
  if (!$("preview").value) return;
  download(slug(titleOf(state.capsule)) + ".md", $("preview").value, "text/markdown");
};
$("dlCapsule").onclick = async () => {
  if (!state.capsule) return;
  const c = snapshotForSave();
  await L.sealCapsule(c);
  const pass = $("passphrase").value;
  let payload = pass ? await L.encryptJson(c, pass) : c;
  download(slug(titleOf(c)) + ".capsule", JSON.stringify(payload, null, 1), "application/json");
};

$("selAll").onclick = () => setSelection(() => true);
$("selNone").onclick = () => setSelection(() => false);
$("selMine").onclick = () => setSelection((m) => m.role === "User");

$("profSave").onclick = () => saveProfile();

$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = () => {
  const f = $("importFile").files && $("importFile").files[0];
  if (f) importFile(f);
  $("importFile").value = "";
};

$("openTab").onclick = async () => {
  try {
    const tabId = await getTabId();
    chrome.tabs.create({ url: chrome.runtime.getURL("extension/popup/popup.html?tab=" + tabId) });
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL("extension/popup/popup.html?tab=0") });
  }
};

$("openSidePanel").onclick = async () => {
  try {
    const tabId = await getTabId();
    await chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL", tabId });
  } catch (e) { /* side panel not supported */ }
};

$("useLast").onclick = async () => {
  const last = await peekLast();
  if (last) { adopt(last); updatePlatformBadge(last); }
};

// AI settings tab events
$("aiProvider").onchange = updateAiProviderUI;
$("aiTest").onclick = testAiConnection;
$("aiSave").onclick = saveAiSettings;

$("aiCopy").onclick = async () => {
  if (!state.capsule) return;
  try {
    await navigator.clipboard.writeText(L.aiPrompt(state.capsule));
    setStatus("Prompt copied. Paste it into the old chat.", "ok");
  } catch (e) { setStatus("Could not copy prompt.", "error"); }
};
$("aiUse").onclick = () => {
  state.aiReply = $("aiReply").value;
  regenerate(true);
};
$("aiReply").oninput = () => { state.aiReply = $("aiReply").value; };

/* ── Boot ── */
(async () => {
  await migrateLegacy();
  await loadProfile();
  await loadAiSettings();
  await renderSaved();
  const last = await peekLast();
  if (last && last.messages && last.messages.length) {
    $("lastBanner").hidden = false;
    $("lastText").textContent = `Last capture on this page: ${last.messages.length} messages.`;
    updatePlatformBadge(last);
  }
  syncControls();
})();
