/* Dependency-free checks: node tests/run.js */
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name); } };

/* manifest */
const m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
ok(m.manifest_version === 3, "manifest is MV3");
const files = [m.background.service_worker, m.action.default_popup, ...m.content_scripts.flatMap((c) => c.js), ...Object.values(m.icons)];
for (const f of files) ok(fs.existsSync(path.join(root, f)), "manifest file exists: " + f);
const cs = m.content_scripts[0];
ok(cs.js.indexOf("lib/hosts.js") !== -1 && cs.js.indexOf("lib/hosts.js") < cs.js.indexOf("ui/card.js"), "hosts.js loads before card.js");
ok(cs.js.indexOf("lib/capsule.js") < cs.js.indexOf("ui/card.js"), "capsule.js loads before card.js");
ok(cs.js.indexOf("lib/files.js") !== -1 && cs.js.indexOf("lib/files.js") < cs.js.indexOf("ui/card.js"), "files.js loads before card.js");
ok(m.host_permissions.length >= 7 && !m.optional_host_permissions, "AI sites are required host permissions (not optional)");
ok(!m.permissions.includes("tabs") && !m.permissions.includes("<all_urls>"), "no broad permissions");
const popupHtml = fs.readFileSync(path.join(root, "ui/popup.html"), "utf8");
for (const s of [...popupHtml.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1])) ok(fs.existsSync(path.join(root, "ui", s)), "popup script exists: " + s);
ok(popupHtml.indexOf("hosts.js") < popupHtml.indexOf("card.js") && popupHtml.indexOf("files.js") < popupHtml.indexOf("card.js") && popupHtml.indexOf("files.js") > 0, "popup loads hosts.js and files.js before card.js");

/* links */
global.self = global;
const H = require("../lib/hosts.js");
ok(H.validateLink("https://chatgpt.com/c/abc").ok, "chatgpt link ok");
ok(H.validateLink("https://chat.openai.com/share/abc").ok, "legacy openai link ok");
ok(H.validateLink("https://claude.ai/chat/abc").ok, "claude link ok");
ok(H.validateLink("https://gemini.google.com/app/abc").ok, "gemini link ok");
ok(H.validateLink("https://x.com/i/grok?conversation=1").ok, "grok-on-x link ok");
ok(!H.validateLink("https://x.com/home").ok, "plain x.com rejected");
ok(!H.validateLink("http://claude.ai/chat/abc").ok, "http rejected");
ok(!H.validateLink("javascript:alert(1)").ok, "javascript: rejected");
ok(!H.validateLink("https://evil.com/?u=https://claude.ai/").ok, "look-alike host rejected");
ok(!H.validateLink("https://claude.ai.evil.com/chat").ok, "suffix look-alike rejected");
ok(!H.validateLink("").ok && !H.validateLink("not a url").ok, "empty / junk rejected");
ok(H.isRestricted("chrome://extensions") && H.isRestricted("https://chromewebstore.google.com/x") && !H.isRestricted("https://claude.ai/"), "restricted-page detection");

/* rendering */
const L = require("../lib/capsule.js");
const raw = { site: "Claude", url: "https://claude.ai/chat/x", messages: [
  { role: "User", text: "Build a CSV parser that streams.", confidence: 1 },
  { role: "Assistant", text: "Use csv.DictReader in a generator.\n```python\nimport csv\n```", confidence: 1 },
  { role: "User", text: "Decision: use pandas chunks, because we need type inference.", confidence: 1 },
  { role: "Assistant", text: "Done — pandas.read_csv(path, chunksize=10000).", confidence: 1 }] };
const cap = L.buildCapsule(raw);
for (const [name, o] of [["compact", { mode: "l0", level: 0 }], ["standard", { mode: "l1", level: 1 }], ["extended", { mode: "l2", level: 2 }], ["smart", { mode: "smart", budget: 8000 }], ["full", { mode: "lossless", budget: 100000 }]]) {
  const r = L.renderCapsule(cap, Object.assign({ intent: "resume", clean: true }, o));
  ok(r.text.length > 0 && r.tokens > 0, "renders " + name);
}
const full = L.renderCapsule(cap, { mode: "lossless", budget: 100000 }).text;
ok(full.includes("Build a CSV parser") && full.includes("chunksize=10000"), "full mode keeps every message");

/* files, folders, zips */
(async () => {
  const zlib = require("zlib");
  const F = require("../lib/files.js");
  const crc = (b) => { let c, t = [], x = 0xffffffff; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  function makeZip(entries) { // entries: [{name, data(Buffer), deflate, flags}]
    const locals = [], central = []; let off = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name), raw = e.data, comp = e.deflate ? zlib.deflateRawSync(raw) : raw, method = e.deflate ? 8 : 0;
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags || 0, 6); lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(crc(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags || 0, 8); ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(crc(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
      locals.push(lh, name, comp); central.push(ch, name); off += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
  }
  const big = "line of code\n".repeat(3000);
  const zip = makeZip([
    { name: "proj/README.md", data: Buffer.from("# Demo\nA tiny project.\n"), deflate: true },
    { name: "proj/src/app.py", data: Buffer.from("print('hi')\n".repeat(50)) },
    { name: "proj/big.js", data: Buffer.from(big), deflate: true },
    { name: "proj/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 1, 2, 3]) },
    { name: "proj/.env", data: Buffer.from("API_KEY=abc") },
    { name: "proj/node_modules/x/index.js", data: Buffer.from("x") },
    { name: "../evil.txt", data: Buffer.from("nope") },
    { name: "proj/locked.txt", data: Buffer.from("zzz"), flags: 1 },
    { name: "proj/key.txt", data: Buffer.from("-----BEGIN RSA PRIVATE KEY-----\nabc") },
  ]);
  const f = (name, data) => ({ file: new File([data], name), path: name });
  const r = await F.fromFiles([f("bundle.zip", zip), f("notes.txt", "hello notes"), f("a/../../etc/passwd", "x")], []);
  const by = (p) => r.files.find((x) => x.path === p);
  ok(by("bundle/proj/README.md") && by("bundle/proj/README.md").text.includes("A tiny project"), "zip: deflated text file read");
  ok(by("bundle/proj/src/app.py") && by("bundle/proj/src/app.py").kind === "text", "zip: stored text file read");
  ok(by("bundle/proj/logo.png").kind === "binary", "zip: binary detected, not included");
  ok(by("bundle/proj/.env").kind === "secret", "zip: .env skipped as secret");
  ok(by("bundle/proj/key.txt").kind === "secret", "zip: private key in content skipped");
  ok(!r.files.some((x) => /node_modules/.test(x.path)), "zip: node_modules ignored");
  ok(!r.files.some((x) => /evil|passwd/.test(x.path)), "zip: path traversal rejected");
  ok(by("bundle/proj/locked.txt").note === "password-protected", "zip: password-protected flagged");
  ok(by("notes.txt").text === "hello notes", "plain file read");
  let bad = false; try { await F.fromFiles([f("x.zip", "not a zip at all")], []); } catch (e) { bad = true; }
  ok(!bad && (await F.fromFiles([f("x.zip", "not a zip at all")], [])).notes.length === 1, "corrupt zip reported, no crash");
  const est = L.estimateTokens;
  const none = F.render(r.files, [], { budget: 0, estimate: est }).text;
  ok(none.includes("README.md") && !none.includes("A tiny project"), "compact: names only");
  const some = F.render(r.files, [], { budget: 1500, estimate: est });
  ok(some.text.includes("A tiny project") && est(some.text) < 2600, "budgeted contents stay near the budget");
  ok(some.text.includes("lines omitted") || some.text.includes("Not included"), "oversized files are shortened or listed");
  ok(!some.text.includes("API_KEY"), "secret contents never rendered");
  const all = F.render(r.files, [], { budget: Infinity, estimate: est }).text;
  ok(all.includes("print('hi')"), "full: includes everything");
  const att = F.render([], [{ name: "report.pdf" }, { name: "unknown" }, { name: "data.csv" }], { budget: 0 }).text;
  ok(att.includes("report.pdf") && att.includes("data.csv") && !att.includes("- unknown"), "chat attachments listed, junk names dropped");
  /* verification (lib/verify.js) */
  const V = require("../lib/verify.js");
  const mkPass = (n, o) => { o = o || {}; const fps = [], entries = []; for (let i = 0; i < n; i++) { fps.push("m" + i); entries.push({ y: i * 100, h: 90, seq: o.seq ? i + 1 : undefined }); } return { fps, entries, jumps: o.jumps || 0 }; };
  const vb = (extra) => Object.assign({ passes: [mkPass(500), mkPass(500)], reachedTop: true, topSettled: true, loadMore: false, bottomReached: true, timedOut: false }, extra);
  ok(V.evaluate(vb()).verified, "verify: two agreeing passes + top + bottom = verified");
  ok(!V.evaluate(vb({ passes: [mkPass(500)] })).verified, "verify: a single pass is never enough");
  ok(!V.evaluate(vb({ passes: [mkPass(500), mkPass(499)] })).verified, "verify: passes that disagree by one message fail");
  ok(!V.evaluate(vb({ reachedTop: false })).verified, "verify: not reaching the top fails");
  ok(!V.evaluate(vb({ loadMore: true })).verified, "verify: a visible 'load earlier' button fails");
  ok(!V.evaluate(vb({ topSettled: false })).verified, "verify: history still arriving fails");
  ok(!V.evaluate(vb({ bottomReached: false })).verified, "verify: not reaching the bottom fails");
  ok(!V.evaluate(vb({ timedOut: true })).verified, "verify: running out of time fails");
  ok(!V.evaluate(vb({ passes: [mkPass(500, { jumps: 1 }), mkPass(500)] })).verified, "verify: a scroll jump with no overlap fails");
  const holey = mkPass(300); for (let i = 150; i < 300; i++) holey.entries[i].y += 900;
  ok(!V.evaluate(vb({ passes: [holey, holey] })).verified, "verify: a vertical hole between messages fails");
  ok(V.evaluate(vb({ passes: [mkPass(300, { seq: true }), mkPass(300, { seq: true })] })).verified, "verify: consecutive turn numbers pass");
  const sk = mkPass(300, { seq: true }); sk.entries.splice(100, 5); sk.fps.splice(100, 5);
  ok(!V.evaluate(vb({ passes: [sk, sk] })).verified, "verify: skipped turn numbers fail");
  ok(V.checkSequence([5, 6, 7]).ok === false, "verify: numbering that doesn't start at 1 fails");
  ok(V.fingerprint({ role: "User", text: "continue" }) === V.fingerprint({ role: "User", text: "continue" }) && V.fingerprint({ role: "User", text: "a" }) !== V.fingerprint({ role: "Assistant", text: "a" }), "verify: fingerprints are role-aware");
  const sameOpening = "a".repeat(200);
  ok(V.fingerprint({ role: "Assistant", text: sameOpening + " first" }) !== V.fingerprint({ role: "Assistant", text: sameOpening + " other" }), "verify: long messages sharing an opening remain distinct");

  /* ChatGPT share React Flight fixture: this must bypass the virtualized DOM reader. */
  const R = require("../lib/share-rsc.js");
  const pool = Array(40).fill(null);
  pool[1] = "root"; pool[2] = 8;
  pool[8] = { _9: 10, _11: 12 }; pool[9] = "linear_conversation"; pool[10] = [16, 30]; pool[11] = "title"; pool[12] = "Fixture chat";
  pool[16] = { _17: 18 }; pool[17] = "message"; pool[18] = { _19: 20, _21: 22 };
  pool[19] = "author"; pool[20] = { _23: 24 }; pool[23] = "role"; pool[24] = "user";
  pool[21] = "content"; pool[22] = { _25: 26, _27: 28 }; pool[25] = "content_type"; pool[26] = "text"; pool[27] = "parts"; pool[28] = ["hello"];
  pool[30] = { _31: 32 }; pool[31] = "message"; pool[32] = { _33: 34, _37: 38 };
  pool[33] = "author"; pool[34] = { _35: 36 }; pool[35] = "role"; pool[36] = "assistant";
  pool[37] = "content"; pool[38] = { _25: 26, _27: 39 }; pool[39] = ["world"];
  const flightScript = 'window.__reactRouterContext.streamController.enqueue(' + JSON.stringify(JSON.stringify(pool)) + ');';
  const share = R.extract({ scripts: [{ textContent: flightScript }] });
  ok(share && share.messages.length === 2 && share.messages[0].role === "User" && share.messages[1].role === "Assistant" && share.messages[1].text === "world", "share reader: full ordered transcript is read from React Flight data");

  /* real-shaped turbo-stream encoding (indices, deduped strings, deferred chunk) with renamed wrappers */
  const enc = (value) => {
    const pool = [], seen = new Map();
    const add = (v) => {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") { const k = typeof v + ":" + v; if (seen.has(k)) return seen.get(k); pool.push(v); seen.set(k, pool.length - 1); return pool.length - 1; }
      if (v === null) return -7;
      const slot = pool.length; pool.push(null);
      if (Array.isArray(v)) pool[slot] = v.map(add);
      else { const o = {}; for (const [k, x] of Object.entries(v)) o["_" + add(k)] = add(x); pool[slot] = o; }
      return slot;
    };
    add(value); return pool;
  };
  const node = (id, role, parts, extra) => ({ id, message: { id, author: { role }, content: { content_type: "text", parts }, metadata: extra || {} } });
  const convo = [node("a", "system", [""], { is_visually_hidden_from_conversation: true }), node("b", "user", ["Q1"]), node("c", "assistant", ["A1 **bold**"]), node("d", "user", ["Q2"]), node("e", "assistant", ["A2"])];
  const tree = { loaderData: { "routes/share.$shareId.($action)": { sharedConversationId: "x", serverResponse: { type: "data", data: { title: "T", linear_conversation: convo, current_node: "e" } } } } };
  const fl = (arr) => ({ textContent: "window.__reactRouterContext.streamController.enqueue(" + JSON.stringify(JSON.stringify(arr)) + ");" });
  const real = R.extractAny({ scripts: [fl(enc(tree))] });
  ok(real && real.messages.length === 4 && real.messages[0].text === "Q1" && real.skipped.hidden === 1 && real.count === 5, "share reader: real-shaped data is read, hidden system entry is accounted for");
  const deferred = R.extractAny({ scripts: [fl(enc({ loaderData: { x: { a: 1 } } })), { textContent: "window.__reactRouterContext.streamController.enqueue(" + JSON.stringify("P3:" + JSON.stringify(enc({ data: { whatever_name: convo } }))) + ");" }] });
  ok(deferred && deferred.messages.length === 4, "share reader: conversation delivered in a later chunk under an unknown key is still found");
  ok(R.fromTree({ title: "x", mapping: { r: { id: "r", parent: null, children: ["b"], message: null }, b: { id: "b", parent: "r", children: ["c"], message: convo[1].message }, c: { id: "c", parent: "b", children: [], message: convo[2].message } } }).messages.length === 2, "share reader: API-style mapping JSON is read in order");
  ok(!R.extractAny({ scripts: [fl(enc({ loaderData: { a: "nothing here" } }))] }), "share reader: a page without a conversation returns nothing (no invention)");
  const oneSided = R.extractAny({ scripts: [fl(enc({ d: [node("x", "user", ["a"]), node("y", "user", ["b"])] }))] });
  ok(oneSided && new Set(oneSided.messages.map((m) => m.role)).size === 1, "share reader: a one-sided list is reported as one-sided (the gate then refuses it)");

  const evs = []; for (let i = 0; i < 6; i++) evs.push({ type: "response_item", payload: { type: "message", role: i % 2 ? "assistant" : "user", content: [{ type: i % 2 ? "output_text" : "input_text", text: "m" + i }] } }, { type: "response_item", payload: { type: "function_call", name: "x" } });
  const ft = R.fromText(JSON.stringify({ items: evs }));
  ok(ft && ft.messages.length === 6 && ft.messages[1].role === "Assistant" && !ft.partial, "share reader: event-style items (payload wrappers, tool calls between) are read in order");
  ok(R.fromText(JSON.stringify({ items: evs, has_more: true })).partial === true, "share reader: 'has_more' marks the read as partial");
  const nd = R.fromText(evs.map((e) => "data: " + JSON.stringify(e)).join("\n"));
  ok(nd && nd.messages.length === 6, "share reader: newline / event-stream bodies are read");
  ok(R.fromText(JSON.stringify(enc(tree)).replace(/^/, "")) && R.fromText(JSON.stringify(enc(tree))).messages.length === 4, "share reader: turbo-stream body text is read");

  /* black UI */
  const cardSrc = fs.readFileSync(path.join(root, "ui/card.js"), "utf8");
  ok(/--bg:#000000/.test(cardSrc) && /\n  background:#000;/.test(cardSrc), "card background is pure black");
  ok(!/radial-gradient\([^)]*rgba\(161,45,43/.test(cardSrc), "card has no tinted glow behind the black");
  ok(/background:#000/.test(fs.readFileSync(path.join(root, "ui/popup.html"), "utf8")), "popup page is pure black");
  ok(/background:#000;/.test(fs.readFileSync(path.join(root, "content/launcher.js"), "utf8")), "floating button is pure black");

  /* every reader (incl. the generic fallback) must be verifiable, and never print "null" */
  const rt = fs.readFileSync(path.join(root, "content/capture-runtime.js"), "utf8");
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  ok(!/supportsDeepCapture:\s*false/.test(rt), "no site reader opts out of whole-chat verification");
  ok(/\(adapter\.name \|\| "This site"\)/.test(rt), "unverifiable message never says 'null'");

  ok(/const topProven = !!\(verification && verification\.verified\)/.test(rt), "a chat that opens with the assistant is accepted once the top is proven");

  ok(/async function shareApi\(/.test(rt) && /chat_snapshots/.test(rt), "shared claude.ai pages are read from the page's own data first");
  ok(/lib\/verify\.js", "lib\/share-rsc\.js", "content\/capture-runtime\.js"/.test(bg) && /chatgptShareData\(/.test(rt), "ChatGPT share capture loads and uses the embedded-data reader before DOM scanning");
  ok(/j\.kind === "capture" && Number\.isInteger\(j\.pageTabId\)/.test(bg) && /attempt: 1/.test(bg), "worker recovery automatically restarts a current-tab capture once");
  ok(/q\('\[data-markdown-text-style\]'\)\.length[\s\S]{0,120}\[data-markdown-text-style\]/.test(rt) && !/const classAssistantSelector/.test(rt), "shared ChatGPT pages capture markdown leaves without counting response wrappers twice");
  ok(/style\.display !== "none" && style\.visibility !== "hidden"/.test(rt), "shared ChatGPT pages skip hidden duplicate message nodes");
  ok(/only " \+ only \+ " were found/.test(rt), "a one-sided read (replies only / yours only) is never verified");
  ok(/function diagnose\(/.test(rt) && !/innerText\)?\.slice|textContent\.slice/.test(rt.slice(rt.indexOf("function diagnose("), rt.indexOf("function diagnose(") + 2600)), "page report is text-free");
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
