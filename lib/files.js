/* Capsa — files, folders and zips.
   Reads what the user adds, decides what can safely travel as text, and renders a
   budgeted "FILES" section for the context. Pure logic + standard web APIs
   (TextDecoder, DecompressionStream) so it runs in the browser and in Node tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaFiles = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LIM = {
    maxFiles: 300,              // files kept per context
    maxReadBytes: 2 * 1024 * 1024,   // per file / per zip entry
    maxTotalBytes: 25 * 1024 * 1024, // everything read in one add
    maxZipEntries: 1000,
    maxStoredChars: 150000,     // text kept per file
  };

  const TEXT_EXT = new Set(("js jsx ts tsx mjs cjs py java c h cpp hpp cc cs go rs rb php swift kt kts scala r m mm lua pl sh bash zsh ps1 bat cmd " +
    "json yaml yml toml xml csv tsv sql graphql gql html htm css scss sass less md mdx txt log ini cfg conf env.example gitignore editorconfig " +
    "dockerfile makefile gradle properties tex rst vue svelte astro ipynb").split(" "));
  const IGNORE_DIR = /(^|\/)(node_modules|\.git|__pycache__|\.venv|venv|\.next|\.nuxt|dist|build|coverage|\.idea|\.vscode|target)(\/|$)/i;
  const IGNORE_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$/i;
  const SECRET_NAME = /(^|\/)(\.env(\..+)?|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.\w+)?|secrets?(\.\w+)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;
  const SECRET_BODY = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9]{32,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/;
  const PRIORITY = /(^|\/)(readme|package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|main\.\w+|index\.\w+|app\.\w+|manifest\.json)/i;

  const ext = (p) => { const b = p.split("/").pop().toLowerCase(); const i = b.lastIndexOf("."); return i <= 0 ? b : b.slice(i + 1); };

  /** Clean a path: forward slashes, no drive letter / leading slash, no "..". -> string | null */
  function cleanPath(p) {
    let s = String(p || "").replace(/\\/g, "/").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "");
    const parts = s.split("/").filter((x) => x && x !== ".");
    if (!parts.length || parts.some((x) => x === "..")) return null;
    s = parts.join("/");
    return s.length > 260 ? null : s;
  }

  function decodeText(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { return null; }
  }

  /** Turn raw bytes into a stored record. */
  function classify(path, bytes, size) {
    const name = path.toLowerCase();
    if (IGNORE_DIR.test(name) || IGNORE_FILE.test(name)) return { path, size, kind: "ignored" };
    if (SECRET_NAME.test(name)) return { path, size, kind: "secret" };
    if (!bytes) return { path, size, kind: "binary", note: "too large to read" };
    const head = bytes.subarray(0, 4096);
    let nul = false;
    for (let i = 0; i < head.length; i++) if (head[i] === 0) { nul = true; break; }
    if (nul) return { path, size, kind: "binary" };
    const text = decodeText(bytes);
    if (text === null) return { path, size, kind: "binary" };
    if (SECRET_BODY.test(text)) return { path, size, kind: "secret" };
    const cut = text.length > LIM.maxStoredChars;
    return { path, size, kind: "text", text: cut ? text.slice(0, LIM.maxStoredChars) : text, truncated: cut || undefined };
  }

  /* ───────────── zip ───────────── */
  const u16 = (v, o) => v[o] | (v[o + 1] << 8);
  const u32 = (v, o) => (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0;

  async function inflateRaw(data, cap) {
    const ds = new DecompressionStream("deflate-raw");
    const reader = new Blob([data]).stream().pipeThrough(ds).getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { try { await reader.cancel(); } catch (e) { /* ignore */ } return null; }
      chunks.push(value);
    }
    const out = new Uint8Array(total); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /** List + read entries of a zip. -> { entries:[{path,size,bytes|null,note?}], notes:[] } */
  async function readZip(buf, budget) {
    const v = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const notes = [];
    let eocd = -1;
    for (let i = v.length - 22; i >= Math.max(0, v.length - 65557); i--) {
      if (u32(v, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("That doesn't look like a valid zip file.");
    const count = u16(v, eocd + 10), cdOff = u32(v, eocd + 16);
    if (count === 0xffff || cdOff === 0xffffffff) throw new Error("Zip64 archives aren't supported.");
    const entries = [];
    let p = cdOff;
    for (let n = 0; n < count && p + 46 <= v.length && u32(v, p) === 0x02014b50; n++) {
      if (n >= LIM.maxZipEntries) { notes.push("Zip has more than " + LIM.maxZipEntries + " entries — the rest were skipped."); break; }
      const flags = u16(v, p + 8), method = u16(v, p + 10), cSize = u32(v, p + 20), uSize = u32(v, p + 24);
      const nl = u16(v, p + 28), el = u16(v, p + 30), cl = u16(v, p + 32), lho = u32(v, p + 42);
      const rawName = new TextDecoder("utf-8").decode(v.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (rawName.endsWith("/")) continue;
      const path = cleanPath(rawName);
      if (!path) { notes.push("Skipped an unsafe path in the zip."); continue; }
      const base = { path, size: uSize };
      if (IGNORE_DIR.test(path) || IGNORE_FILE.test(path) || SECRET_NAME.test(path)) { entries.push({ ...base, bytes: null }); continue; }
      if (flags & 1) { entries.push({ ...base, bytes: null, note: "password-protected" }); continue; }
      if (uSize > LIM.maxReadBytes || budget.left < uSize) { entries.push({ ...base, bytes: null, note: "too large to read" }); continue; }
      if (u32(v, lho) !== 0x04034b50) { entries.push({ ...base, bytes: null, note: "damaged entry" }); continue; }
      const start = lho + 30 + u16(v, lho + 26) + u16(v, lho + 28);
      const raw = v.subarray(start, start + cSize);
      let bytes = null;
      try {
        if (method === 0) bytes = raw;
        else if (method === 8) bytes = await inflateRaw(raw, Math.min(LIM.maxReadBytes, Math.max(uSize, 1) + 1024));
      } catch (e) { bytes = null; }
      if (bytes) budget.left -= bytes.length;
      entries.push({ ...base, bytes, note: bytes ? undefined : "couldn't be unpacked" });
    }
    return { entries, notes };
  }

  /* ───────────── add from the browser ───────────── */
  /** items: [{ file: File, path?: string }] -> { files, notes } */
  async function fromFiles(items, existing) {
    const out = [], notes = [];
    const have = new Set((existing || []).map((f) => f.path.toLowerCase()));
    const budget = { left: LIM.maxTotalBytes };
    const push = (rec) => {
      const k = rec.path.toLowerCase();
      if (have.has(k)) return;
      have.add(k); out.push(rec);
    };
    for (const it of items) {
      const file = it.file;
      const path = cleanPath(it.path || file.webkitRelativePath || file.name);
      if (!path) { notes.push("Skipped a file with an unsafe path."); continue; }
      if (/\.zip$/i.test(path)) {
        try {
          if (file.size > LIM.maxTotalBytes) throw new Error("That zip is too large (max 25 MB).");
          const { entries, notes: zn } = await readZip(new Uint8Array(await file.arrayBuffer()), budget);
          notes.push(...zn);
          const prefix = path.replace(/\.zip$/i, "");
          for (const e of entries) {
            const rec = classify(prefix + "/" + e.path, e.bytes, e.size);
            if (e.note && rec.kind !== "ignored" && rec.kind !== "secret") rec.note = e.note;
            push(rec);
          }
        } catch (err) { notes.push(path + ": " + err.message); }
        continue;
      }
      if (IGNORE_DIR.test(path) || IGNORE_FILE.test(path) || SECRET_NAME.test(path)) { push(classify(path, null, file.size)); continue; }
      let bytes = null;
      if (file.size <= LIM.maxReadBytes && budget.left >= file.size) {
        bytes = new Uint8Array(await file.arrayBuffer()); budget.left -= bytes.length;
      }
      push(classify(path, bytes, file.size));
    }
    const merged = (existing || []).concat(out);
    const kept = merged.filter((f) => f.kind !== "ignored");
    if (kept.length > LIM.maxFiles) notes.push("Kept the first " + LIM.maxFiles + " files.");
    return { files: kept.slice(0, LIM.maxFiles), ignored: merged.length - kept.length, notes };
  }

  /* ───────────── render ───────────── */
  const fmtSize = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1).replace(/\.0$/, "") + " KB" : (n / 1048576).toFixed(1) + " MB");

  function clip(text, maxTokens, est) {
    if (est(text) <= maxTokens) return { text, cut: false };
    const maxChars = Math.max(200, maxTokens * 4);
    const headN = Math.floor(maxChars * 0.7), tailN = maxChars - headN;
    const dropped = text.slice(headN, text.length - tailN).split("\n").length;
    return { text: text.slice(0, headN) + "\n… [" + dropped + " lines omitted] …\n" + text.slice(text.length - tailN), cut: true };
  }

  /** Real-looking filenames only (the page scraper can return junk). */
  function chatAttachmentNames(list) {
    return (list || []).map((a) => String(a && a.name || "").trim()).filter((n) => /^[^\n]{1,120}\.[A-Za-z0-9]{1,6}$/.test(n))
      .filter((n, i, a) => a.indexOf(n) === i);
  }

  /** files: stored records; opts: { budget (tokens of contents, Infinity = all), estimate(text) } */
  function render(files, chatAttachments, opts) {
    opts = opts || {};
    const est = opts.estimate || ((s) => Math.ceil(s.length / 4));
    let budget = opts.budget == null ? 0 : opts.budget;
    const lines = [];
    const names = chatAttachmentNames(chatAttachments);
    const list = (files || []).slice();
    if (!list.length && !names.length) return { text: "", included: 0, listed: 0 };

    if (list.length) {
      lines.push("## FILES (" + list.length + ")");
      for (const f of list) {
        const tag = f.kind === "text" ? "" : f.kind === "secret" ? " — skipped, looks like a secret" : " — binary, not included" + (f.note ? " (" + f.note + ")" : "");
        lines.push("- " + f.path + " (" + fmtSize(f.size) + ")" + tag);
      }
    }
    let included = 0;
    const texts = list.filter((f) => f.kind === "text").sort((a, b) => (PRIORITY.test(b.path) - PRIORITY.test(a.path)) || (a.text.length - b.text.length));
    const perFile = budget === Infinity ? Infinity : Math.max(500, Math.min(3000, Math.floor(budget / Math.max(1, Math.min(texts.length, 4)))));
    const omitted = [];
    for (const f of texts) {
      if (budget <= 0) { omitted.push(f.path); continue; }
      const room = Math.min(perFile, budget);
      if (room < 120) { omitted.push(f.path); continue; }
      const c = clip(f.text, room, est);
      const body = c.text.replace(/```/g, "ʼʼʼ");
      lines.push("", "### " + f.path + (c.cut || f.truncated ? " (shortened)" : ""), "```", body, "```");
      budget -= est(c.text); included++;
    }
    if (omitted.length) lines.push("", "Not included (over the size limit — ask for them if needed): " + omitted.join(", "));
    if (names.length) {
      lines.push("", "## ATTACHED IN THE ORIGINAL CHAT (" + names.length + ")",
        "These files were in the chat but can't be carried over automatically — upload them again if needed:",
        ...names.map((n) => "- " + n));
    }
    return { text: lines.join("\n"), included, listed: list.length };
  }

  return { LIM, cleanPath, classify, readZip, fromFiles, render, chatAttachmentNames, fmtSize };
});
