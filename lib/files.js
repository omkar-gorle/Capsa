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
  const IGNORE_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$|\.map$/i;
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
    const nl = (text.match(/\n/g) || []).length + 1;
    const minified = /\.min\.(?:js|css)$/i.test(path) || (text.length > 4000 && text.length / nl > 400);   // a bundle: huge lines, nothing a reader can use
    return { path, size, kind: "text", text: cut ? text.slice(0, LIM.maxStoredChars) : text, truncated: cut || undefined, minified: minified || undefined };
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
  async function readZip(buf, budget, want) {
    const v = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const notes = [];
    let eocd = -1;
    for (let i = v.length - 22; i >= Math.max(0, v.length - 65557); i--) {
      if (u32(v, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("That doesn't look like a valid zip file.");
    let count = u16(v, eocd + 10), cdOff = u32(v, eocd + 16);
    if (count === 0xffff || cdOff === 0xffffffff) {
      // Zip64: the real numbers are in the zip64 end-of-central-directory record, found through its locator (20 bytes before the EOCD)
      const loc = eocd - 20;
      if (loc < 0 || u32(v, loc) !== 0x07064b50) throw new Error("This zip uses a format Capsa can't read (Zip64 without a locator).");
      const rec = u32(v, loc + 8);                                   // low 32 bits of the offset (archives are capped far below 4 GB here)
      if (u32(v, loc + 12) !== 0 || rec + 56 > v.length || u32(v, rec) !== 0x06064b50) throw new Error("This zip uses a format Capsa can't read (damaged Zip64 record).");
      count = u32(v, rec + 32); cdOff = u32(v, rec + 48);
      if (u32(v, rec + 36) !== 0 || u32(v, rec + 52) !== 0) throw new Error("This zip is too large to read.");
    }
    const entries = [];
    let p = cdOff;
    for (let n = 0; n < count && p + 46 <= v.length && u32(v, p) === 0x02014b50; n++) {
      if (n >= LIM.maxZipEntries) { notes.push("Zip has more than " + LIM.maxZipEntries + " entries — the rest were skipped."); break; }
      const flags = u16(v, p + 8), method = u16(v, p + 10);
      let cSize = u32(v, p + 20), uSize = u32(v, p + 24);
      const nl = u16(v, p + 28), el = u16(v, p + 30), cl = u16(v, p + 32);
      let lho = u32(v, p + 42);
      if (cSize === 0xffffffff || uSize === 0xffffffff || lho === 0xffffffff) {   // Zip64 extra field: only the fields that overflowed, in this order
        let q = p + 46 + nl; const qe = q + el;
        while (q + 4 <= qe) {
          const id = u16(v, q), sz = u16(v, q + 2);
          if (id === 0x0001) {
            let o = q + 4;
            if (uSize === 0xffffffff) { uSize = u32(v, o); o += 8; }
            if (cSize === 0xffffffff) { cSize = u32(v, o); o += 8; }
            if (lho === 0xffffffff) { lho = u32(v, o); o += 8; }
            break;
          }
          q += 4 + sz;
        }
      }
      const rawName = new TextDecoder("utf-8").decode(v.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (rawName.endsWith("/")) continue;
      const path = cleanPath(rawName);
      if (!path) { notes.push("Skipped an unsafe path in the zip."); continue; }
      const base = { path, size: uSize };
      if (IGNORE_DIR.test(path) || IGNORE_FILE.test(path) || SECRET_NAME.test(path)) { entries.push({ ...base, bytes: null }); continue; }
      if (want && !want(path)) { entries.push({ ...base, bytes: null, skipped: true }); continue; }   // caller only needs some entries (office documents)
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


  /* ───────────── documents: Word / Excel / PowerPoint / OpenDocument / PDF → text (best effort, entirely in the browser) ───────────── */
  const DOC_EXT = /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp|pdf)$/i;
  const xmlText = (x) => String(x || "").replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const dec = (b) => new TextDecoder("utf-8").decode(b);
  const tidyDoc = (t) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  function wordXml(x) {
    return tidyDoc(xmlText(x.replace(/<w:tab\/>/g, "\t").replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n").replace(/<\/w:p>\s*<\/w:tc>/g, " | ").replace(/<\/w:tr>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")).replace(/ \| \n/g, "\n"));
  }
  const colNum = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref || "A")[0]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  function sheetXml(x, strings) {
    const rows = []; let rn = 0;
    for (const rm of x.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (++rn > 300) { rows.push("[… more rows not included …]"); break; }
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], body = cm[2] || "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs); const t = /\bt="(\w+)"/.exec(attrs);
        let val = "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (t && t[1] === "s" && v) val = strings[+v[1]] || "";
        else if (t && t[1] === "inlineStr") val = xmlText((body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((z) => z.replace(/<[^>]+>/g, "")).join(""));
        else if (v) val = xmlText(v[1]);
        const f = /<f[^>]*>([\s\S]*?)<\/f>/.exec(body);
        if (f) val = (val !== "" ? val + "  " : "") + "{=" + xmlText(f[1]).slice(0, 40) + "}";
        const ci = ref ? colNum(ref[1]) : cells.length;
        if (ci > 40) continue;
        while (cells.length < ci) cells.push("");
        cells[ci] = String(val).replace(/\s+/g, " ");
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      if (cells.length) rows.push(cells.join(" | "));
    }
    return rows.join("\n");
  }
  async function officeText(path, bytes) {
    const ext0 = ext(path);
    const wants = ext0 === "docx" || ext0 === "docm" ? (p) => /^word\/(document|footnotes|endnotes)\.xml$/.test(p)
      : /^(xlsx|xlsm)$/.test(ext0) ? (p) => /^xl\/(sharedStrings|workbook)\.xml$|^xl\/worksheets\/sheet\d+\.xml$/.test(p)
      : /^(pptx|pptm)$/.test(ext0) ? (p) => /^ppt\/slides\/slide\d+\.xml$|^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p)
      : (p) => p === "content.xml";
    const { entries } = await readZip(bytes, { left: LIM.maxReadBytes * 4 }, wants);
    const get = (p) => { const e = entries.find((x) => x.path === p); return e && e.bytes ? dec(e.bytes) : ""; };
    const num = (a, b) => (parseInt(/(\d+)\.xml$/.exec(a)[1], 10) - parseInt(/(\d+)\.xml$/.exec(b)[1], 10));
    if (ext0 === "docx" || ext0 === "docm") return { kind: "Word document", text: ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"].map((p) => wordXml(get(p))).filter(Boolean).join("\n\n") };
    if (ext0 === "xlsx" || ext0 === "xlsm") {
      const strings = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText((m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((z) => z.replace(/<[^>]+>/g, "")).join("")));
      const names = [...get("xl/workbook.xml").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => xmlText(m[1]));
      const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.path) && e.bytes).sort((a, b) => num(a.path, b.path));
      return { kind: "Excel workbook", text: sheets.map((e, i) => "## sheet: " + (names[i] || "Sheet" + (i + 1)) + "\n" + sheetXml(dec(e.bytes), strings)).join("\n\n"), note: "values shown; formulas in {=…}" };
    }
    if (ext0 === "pptx" || ext0 === "pptm") {
      const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.path) && e.bytes).sort((a, b) => num(a.path, b.path));
      const notes = entries.filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.path) && e.bytes).sort((a, b) => num(a.path, b.path));
      const tx = (x) => tidyDoc(xmlText(x.replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")));
      return { kind: "PowerPoint deck", text: slides.map((e, i) => "## slide " + (i + 1) + "\n" + tx(dec(e.bytes)) + (notes[i] ? "\n[speaker notes] " + tx(dec(notes[i].bytes)).replace(/\n+/g, " ") : "")).join("\n\n") };
    }
    return { kind: "OpenDocument file", text: tidyDoc(xmlText(get("content.xml").replace(/<text:(?:tab)\/>/g, "\t").replace(/<\/text:(?:p|h)>/g, "\n").replace(/<\/table:table-cell>/g, " | ").replace(/<[^>]+>/g, ""))) };
  }

  let RED = null;
  try { RED = (typeof module === "object" && module.exports) ? require("./redact.js") : ((typeof self !== "undefined" ? self : globalThis).CapsaRedact || null); } catch (e) { RED = null; }
  let PDF = null;
  try { PDF = (typeof module === "object" && module.exports) ? require("./pdftext.js") : ((typeof self !== "undefined" ? self : globalThis).CapsaPdfText || null); } catch (e) { PDF = null; }
  async function pdfText(bytes) {
    if (!PDF) return { kind: "PDF", text: "", note: "PDF reader not loaded" };
    const r = await PDF.extract(bytes);
    return { kind: "PDF", text: r.text, note: r.note };
  }
  /** Document bytes -> a stored text record, or null when it is not a readable document. */
  async function readDocument(path, bytes, size) {
    if (!DOC_EXT.test(path) || !bytes) return null;
    try {
      const r = /\.pdf$/i.test(path) ? await pdfText(bytes) : await officeText(path, bytes);
      if (!r.text) return { path, size, kind: "binary", note: r.note || (r.kind + ": no text found") };
      if (SECRET_BODY.test(r.text)) return { path, size, kind: "secret" };
      const cut = r.text.length > LIM.maxStoredChars;
      return { path, size, kind: "text", doc: r.kind, docNote: r.note, text: cut ? r.text.slice(0, LIM.maxStoredChars) : r.text, truncated: cut || undefined };
    } catch (e) { return { path, size, kind: "binary", note: "couldn't read this document (" + (e && e.message || "damaged") + ")" }; }
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
            let rec = classify(prefix + "/" + e.path, e.bytes, e.size);
            if (rec.kind === "binary" && e.bytes && DOC_EXT.test(e.path)) rec = (await readDocument(prefix + "/" + e.path, e.bytes, e.size)) || rec;
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
      let rec = classify(path, bytes, file.size);
      if (rec.kind === "binary" && bytes && DOC_EXT.test(path)) rec = (await readDocument(path, bytes, file.size)) || rec;
      push(rec);
    }
    const merged = (existing || []).concat(out);
    const kept = merged.filter((f) => f.kind !== "ignored");
    if (kept.length > LIM.maxFiles) notes.push("Kept the first " + LIM.maxFiles + " files.");
    return { files: kept.slice(0, LIM.maxFiles), ignored: merged.length - kept.length, notes };
  }


  /* ───────────── digest: what each file IS, in one line (so even Compact says more than a file name) ───────────── */
  const oneL = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const cut = (t, n) => { t = oneL(t); return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…"; };
  const uniq = (a) => a.filter((x, i) => x && a.indexOf(x) === i);
  const CODE_EXT = new Set("js jsx ts tsx mjs cjs py java c h cpp hpp cc cs go rs rb php swift kt scala lua sh vue svelte".split(" "));
  function symbols(text, e) {
    const out = [];
    const grab = (re, g) => { let m; re.lastIndex = 0; while ((m = re.exec(text)) && out.length < 40) out.push(m[g || 1]); };
    if (/^(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/.test(e)) { grab(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g); grab(/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g); grab(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g); }
    else if (e === "py") { grab(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm); grab(/^\s*class\s+([A-Za-z_]\w*)/gm); }
    else if (/^(java|cs|kt|scala|swift)$/.test(e)) { grab(/\b(?:class|interface|enum|object|struct)\s+([A-Za-z_]\w*)/g); }
    else if (e === "go") { grab(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm); }
    else if (e === "rs") { grab(/\bfn\s+([A-Za-z_]\w*)/g); grab(/\bstruct\s+([A-Za-z_]\w*)/g); }
    return uniq(out).filter((n) => !/^(?:if|for|while|switch|catch|function)$/.test(n));
  }
  function leadComment(text) {
    const head = text.slice(0, 1500);
    let m = /^\s*(?:#!.*\n)?\s*\/\*+\s*([\s\S]*?)\*\//.exec(head);
    if (m) return m[1].split("\n").map((l) => l.replace(/^\s*\*+\s?/, "").trim()).filter(Boolean)[0] || "";
    m = /^\s*(?:#!.*\n)?((?:\s*(?:\/\/|#)(?!!)[^\n]*\n?){1,4})/.exec(head);
    if (m) return m[1].split("\n").map((l) => l.replace(/^\s*(?:\/\/|#)+\s?/, "").trim()).filter(Boolean)[0] || "";
    m = /^\s*(?:#!.*\n)?\s*(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')/.exec(head);
    if (m) return m[1].split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    return "";
  }
  /** One line describing a text file: its purpose and (for code) what it defines. */
  function digest(f) {
    const text = String(f.text || ""); const e = ext(f.path); const base = f.path.split("/").pop().toLowerCase();
    const lines = text ? text.split("\n").length : 0;
    let what = "", defs = [];
    if (f.minified) return { lines, what: "minified/bundled file — not summarised, contents not included", defs: [] };
    if (f.doc) {
      const words = (text.match(/\S+/g) || []).length; const first = (text.split("\n").find((l) => l.trim().length > 3 && !/^## /.test(l)) || "").trim();
      return { lines, what: f.doc + ", ~" + words + " words" + (f.docNote ? " (" + f.docNote + ")" : "") + (first ? " — starts: " + cut(first, 90) : ""), defs: [] };
    }
    try {
      if (base === "package.json") {
        const j = JSON.parse(text); const deps = Object.keys(Object.assign({}, j.dependencies, j.devDependencies));
        what = "npm package" + (j.name ? " “" + j.name + "”" : "") + (j.description ? " — " + cut(j.description, 80) : "") + (j.scripts ? "; scripts: " + Object.keys(j.scripts).slice(0, 6).join(", ") : "") + (deps.length ? "; deps: " + deps.slice(0, 6).join(", ") + (deps.length > 6 ? " +" + (deps.length - 6) : "") : "");
      } else if (base === "manifest.json") {
        const j = JSON.parse(text);
        what = (j.manifest_version ? "browser-extension manifest v" + j.manifest_version : "manifest") + (j.name ? " “" + j.name + "”" : "") + (j.version ? " " + j.version : "") + (Array.isArray(j.permissions) ? "; permissions: " + j.permissions.slice(0, 6).join(", ") : "");
      } else if (e === "json") {
        const j = JSON.parse(text); what = Array.isArray(j) ? "JSON list of " + j.length : "JSON with keys: " + Object.keys(j).slice(0, 8).join(", ");
      } else if (e === "md" || e === "mdx" || e === "txt" || e === "rst") {
        const h = /^\s*#{1,3}\s+(.+)$/m.exec(text); const para = text.split(/\n{2,}/).map((p) => p.replace(/^#+.*$/gm, "").trim()).find((p) => p.length > 20) || "";
        what = (h ? cut(h[1], 60) : "") + (para ? (h ? " — " : "") + cut(para, 110) : "");
      } else if (e === "html" || e === "htm") {
        const t = /<title[^>]*>([^<]*)<\/title>/i.exec(text); const sc = (text.match(/<script/gi) || []).length;
        what = "HTML page" + (t && t[1].trim() ? " “" + cut(t[1], 50) + "”" : "") + (sc ? ", " + sc + " script(s)" : "");
      } else if (e === "css" || e === "scss" || e === "less") {
        what = "styles: " + (text.match(/\{/g) || []).length + " rules" + (/:root/.test(text) ? ", theme variables" : "");
      } else if (CODE_EXT.has(e)) {
        what = cut(leadComment(text), 110); defs = symbols(text, e);
      } else if (e === "yml" || e === "yaml" || e === "toml" || e === "ini" || e === "cfg" || e === "conf") {
        what = "config: " + uniq((text.match(/^[A-Za-z_][\w.-]*(?=\s*[:=])/gm) || [])).slice(0, 8).join(", ");
      } else if (e === "csv" || e === "tsv") {
        what = "table, " + Math.max(0, lines - 1) + " rows; columns: " + cut((text.split("\n")[0] || "").replace(/\t/g, ","), 90);
      } else if (e === "sql") {
        what = "SQL: " + uniq((text.match(/\b(?:CREATE\s+TABLE|ALTER\s+TABLE|INSERT\s+INTO)\s+(?:IF NOT EXISTS\s+)?[`"\[]?([\w.]+)/gi) || []).map((x) => x.split(/\s+/).pop().replace(/[`"\[]/g, ""))).slice(0, 6).join(", ");
      } else {
        what = cut((text.split("\n").find((l) => l.trim().length > 8) || ""), 90);
      }
    } catch (err) { what = ""; }
    return { lines, what: oneL(what), defs: defs.slice(0, 8) };
  }
  /** Project-level line: how many files, which languages, where to start. */
  function overview(list) {
    const text = list.filter((f) => f.kind === "text");
    if (!text.length) return "";
    const langs = new Map(); for (const f of text) { const e = ext(f.path); langs.set(e, (langs.get(e) || 0) + 1); }
    const top = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => v + " ." + k).join(", ");
    const entry = text.filter((f) => PRIORITY.test(f.path)).slice(0, 3).map((f) => f.path);
    const dirs = uniq(text.map((f) => f.path.includes("/") ? f.path.split("/")[0] : "")).filter(Boolean).slice(0, 6);
    return "Overview: " + text.length + " readable file(s) (" + top + ")" + (entry.length ? "; start with " + entry.join(", ") : "") + (dirs.length ? "; folders: " + dirs.join(", ") : "");
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
      const ov = overview(list); if (ov) lines.push(ov);
      for (const f of list) {
        if (f.kind === "text") {
          const d = digest(f);
          lines.push("- " + f.path + " (" + fmtSize(f.size) + ", " + d.lines + " lines)" + (d.what ? " — " + d.what : "") + (d.defs.length ? "; defines: " + d.defs.join(", ") : ""));
        } else {
          const tag = f.kind === "secret" ? " — skipped, looks like a secret" : " — binary, not included" + (f.note ? " (" + f.note + ")" : "");
          lines.push("- " + f.path + " (" + fmtSize(f.size) + ")" + tag);
        }
      }
    }
    let included = 0;
    const texts = list.filter((f) => f.kind === "text" && !f.minified).sort((a, b) => (PRIORITY.test(b.path) - PRIORITY.test(a.path)) || (a.text.length - b.text.length));
    const perFile = budget === Infinity ? Infinity : Math.max(500, Math.min(3000, Math.floor(budget / Math.max(1, Math.min(texts.length, 4)))));
    const omitted = [];
    for (const f of texts) {
      if (budget <= 0) { omitted.push(f.path); continue; }
      const room = Math.min(perFile, budget);
      if (room < 120) { omitted.push(f.path); continue; }
      const c = clip(f.text, room, est);
      const body = (RED ? RED.redact(RED.defang(c.text)).text : c.text).replace(/```/g, "ʼʼʼ");
      lines.push("", "### " + f.path + (c.cut || f.truncated ? " (shortened)" : ""), "```", body, "```");
      budget -= est(c.text); included++;
    }
    if (omitted.length) lines.push("", opts.budget === 0 || opts.budget == null ? "File contents are not included at this size — the lines above say what each file is. Ask me for any file by name." : "Contents not included (over the size limit — ask for them if needed): " + omitted.join(", "));
    if (names.length) {
      lines.push("", "## ATTACHED IN THE ORIGINAL CHAT (" + names.length + ")",
        "These files were in the chat but can't be carried over automatically — upload them again if needed:",
        ...names.map((n) => "- " + n));
    }
    return { text: lines.join("\n"), included, listed: list.length };
  }

  return { LIM, cleanPath, classify, readZip, fromFiles, render, chatAttachmentNames, fmtSize, digest, overview };
});
