/* Capsa — text from a PDF, entirely in the browser (pure logic + DecompressionStream; also runs in Node).

   What it does: reads the PDF's objects (including compressed object streams), walks the page tree in order, decodes each page's
   content stream (Flate / ASCII85 / ASCIIHex), follows font changes and maps glyph codes to Unicode through each font's ToUnicode
   table — which is how Word, LibreOffice, Chrome and most generators store text.

   What it cannot do, and says so instead of guessing: scanned or image-only pages (no text exists to read — that needs OCR),
   encrypted files, fonts with no ToUnicode table and a non-Latin encoding, text drawn as vector outlines, and scrambled reading
   order on multi-column layouts. A result that is mostly unreadable is reported as "no readable text", never returned as garbage. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaPdfText = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LIMITS = { stream: 6 * 1024 * 1024, total: 40 * 1024 * 1024, pages: 600 };
  const latin1 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const toBytes = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };

  async function inflate(data, cap) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    const chunks = []; let total = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; chunks.push(value); if (total > cap) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; } } } catch (e) { /* damaged tail: keep what was read */ }
    const out = new Uint8Array(Math.min(total, cap)); let o = 0;
    for (const c of chunks) { const n = Math.min(c.length, out.length - o); if (n <= 0) break; out.set(c.subarray(0, n), o); o += n; }
    return out;
  }
  function ascii85(bytes) {
    const s = latin1(bytes).replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/, "");
    const out = []; let grp = [];
    for (const ch of s) {
      if (ch === "z" && !grp.length) { out.push(0, 0, 0, 0); continue; }
      grp.push(ch.charCodeAt(0) - 33);
      if (grp.length === 5) { let v = 0; for (const g of grp) v = v * 85 + g; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); grp = []; }
    }
    if (grp.length > 1) { const n = grp.length; while (grp.length < 5) grp.push(84); let v = 0; for (const g of grp) v = v * 85 + g; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, n - 1)); }
    return Uint8Array.from(out);
  }
  function asciiHex(bytes) {
    const s = latin1(bytes).replace(/[^0-9A-Fa-f]/g, ""); const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i + 1 < s.length; i += 2) out[i >> 1] = parseInt(s.substr(i, 2), 16);
    return out;
  }

  /** Decode a stream through its /Filter chain. Returns null for filters that cannot carry text here (images, LZW…). */
  async function decodeStream(dict, data) {
    const fm = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
    const filters = fm ? (fm[1].match(/\/\w+/g) || []).map((x) => x.slice(1)) : [];
    let d = data;
    for (const f of filters) {
      if (f === "FlateDecode" || f === "Fl") d = await inflate(d, LIMITS.stream);
      else if (f === "ASCII85Decode" || f === "A85") d = ascii85(d);
      else if (f === "ASCIIHexDecode" || f === "AHx") d = asciiHex(d);
      else return null;
    }
    return d;
  }

  /** ToUnicode CMap -> { codeLen, map } */
  function parseCMap(text) {
    const map = new Map(); let codeLen = 0;
    const cs = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(text); if (cs) codeLen = cs[1].length / 2;
    const u16 = (hex) => { let s = ""; for (let i = 0; i + 3 < hex.length + 1; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16)); return hex.length <= 2 ? String.fromCharCode(parseInt(hex, 16)) : s; };
    for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) { map.set(parseInt(m[1], 16), u16(m[2])); if (!codeLen) codeLen = m[1].length / 2; }
    for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16); if (!codeLen) codeLen = m[1].length / 2;
        if (m[3] !== undefined) { const base = m[3]; const last = parseInt(base.slice(-4), 16); const pre = base.slice(0, -4); for (let c = lo; c <= hi && c - lo < 70000; c++) map.set(c, pre ? u16(pre.padStart(4, "0")) + String.fromCharCode(last + (c - lo)) : String.fromCharCode(last + (c - lo))); }
        else { let c = lo; for (const h of m[4].matchAll(/<([0-9A-Fa-f]+)>/g)) { if (c > hi) break; map.set(c++, u16(h[1])); } }
      }
    }
    return { codeLen: codeLen || 2, map };
  }

  async function extract(bytes) {
    const raw = latin1(bytes);
    if (!/^%PDF-/.test(raw.slice(0, 1024))) return { text: "", note: "not a PDF" };
    if (/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(raw)) return { text: "", note: "encrypted PDF (password-protected)" };

    /* 1. objects (plain, then the ones packed inside object streams) */
    const objs = new Map();      // num -> { body, stream:{start,end}|null }
    const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g; let m;
    while ((m = re.exec(raw))) {
      const num = +m[1]; const bodyStart = m.index + m[0].length;
      const end = raw.indexOf("endobj", bodyStart); if (end < 0) break;
      let body = raw.slice(bodyStart, end), stream = null;
      const sm = /\bstream\r?\n/.exec(body);
      if (sm) { const sStart = bodyStart + sm.index + sm[0].length; let sEnd = raw.lastIndexOf("endstream", end); if (sEnd < sStart) sEnd = end; stream = { start: sStart, end: sEnd }; body = body.slice(0, sm.index); }
      objs.set(num, { body, stream }); re.lastIndex = end + 6;
    }
    let budget = LIMITS.total;
    const streamData = async (o) => {
      if (!o || !o.stream || budget <= 0) return null;
      const d = await decodeStream(o.body, bytes.subarray(o.stream.start, o.stream.end));
      if (d) budget -= d.length;
      return d;
    };
    for (const [num, o] of [...objs]) {
      if (!/\/Type\s*\/ObjStm/.test(o.body)) continue;
      const d = await streamData(o); if (!d) continue;
      const txt = latin1(d); const n = +(/\/N\s+(\d+)/.exec(o.body) || [0, 0])[1], first = +(/\/First\s+(\d+)/.exec(o.body) || [0, 0])[1];
      const nums = (txt.slice(0, first).match(/\d+/g) || []).map(Number);
      for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
        const on = nums[i * 2], off = nums[i * 2 + 1]; const nextOff = i + 1 < n ? nums[(i + 1) * 2 + 1] : txt.length - first;
        if (!objs.has(on)) objs.set(on, { body: txt.slice(first + off, first + nextOff), stream: null });
      }
    }
    const ref = (s) => { const r = /(\d+)\s+\d+\s+R/.exec(s || ""); return r ? +r[1] : null; };
    const dictOf = (s) => { const i = s.indexOf("<<"); if (i < 0) return ""; let depth = 0; for (let j = i; j < s.length - 1; j++) { if (s[j] === "<" && s[j + 1] === "<") { depth++; j++; } else if (s[j] === ">" && s[j + 1] === ">") { depth--; j++; if (!depth) return s.slice(i, j + 1); } } return s.slice(i); };
    /** value of /Key as raw text: a dict, an array or a ref/number (resolving one level of indirection) */
    const valueOf = (dict, key) => {
      const k = new RegExp("/" + key + "\\b\\s*"); const mm = k.exec(dict); if (!mm) return "";
      const rest = dict.slice(mm.index + mm[0].length);
      if (rest.startsWith("<<")) return dictOf(rest);
      if (rest.startsWith("[")) return rest.slice(0, rest.indexOf("]") + 1);
      const r = /^(\d+)\s+\d+\s+R/.exec(rest);
      if (r) { const o = objs.get(+r[1]); return o ? (dictOf(o.body) || o.body) : ""; }
      return (/^[^\s/<>\[\]]+/.exec(rest) || [""])[0];
    };

    /* 2. pages in reading order (walk /Pages from the catalog; fall back to object order) */
    const pages = []; const seen = new Set();
    const visit = (num, inherited) => {
      if (num == null || seen.has(num) || pages.length >= LIMITS.pages) return; seen.add(num);
      const o = objs.get(num); if (!o) return; const d = dictOf(o.body);
      const res = /\/Resources\b/.test(d) ? valueOf(d, "Resources") : inherited;
      if (/\/Kids\b/.test(d)) { const kids = /\/Kids\s*\[([^\]]*)\]/.exec(d); if (kids) for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) visit(+k[1], res); }
      else if (/\/Type\s*\/Page\b/.test(d)) pages.push({ num, d, res });
    };
    let rootPages = null;
    for (const [, o] of objs) { if (/\/Type\s*\/Catalog\b/.test(o.body)) { rootPages = ref(valueOfRaw(o.body, "Pages")); break; } }
    function valueOfRaw(body, key) { const mm = new RegExp("/" + key + "\\s+(\\d+\\s+\\d+\\s+R)").exec(body); return mm ? mm[1] : ""; }
    if (rootPages != null) visit(rootPages, "");
    if (!pages.length) for (const [num, o] of objs) if (/\/Type\s*\/Page\b(?!s)/.test(o.body)) pages.push({ num, d: dictOf(o.body), res: /\/Resources/.test(o.body) ? valueOf(dictOf(o.body), "Resources") : "" });
    if (!pages.length) return { text: "", note: "no pages found (damaged or unusual PDF)" };

    /* 3. fonts: name -> ToUnicode (cached by object number) */
    const fontCache = new Map();
    const fontFor = async (fontNum) => {
      if (fontCache.has(fontNum)) return fontCache.get(fontNum);
      const o = objs.get(fontNum); let f = { cmap: null, twoByte: false };
      if (o) {
        const d = dictOf(o.body); const tu = ref(/\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(d) ? /\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(d)[1] : "");
        if (tu != null) { const sd = await streamData(objs.get(tu)); if (sd) f.cmap = parseCMap(latin1(sd)); }
        f.twoByte = /\/Subtype\s*\/Type0/.test(d) || /\/Encoding\s*\/Identity-H/.test(d);
      }
      fontCache.set(fontNum, f); return f;
    };

    /* 4. page text */
    const out = []; let readable = 0, total = 0;
    for (const pg of pages) {
      const fonts = new Map();
      const fd = /\/Font\b/.test(pg.res) ? valueOf(pg.res, "Font") : "";
      for (const fm of fd.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts.set(fm[1], await fontFor(+fm[2]));
      const cont = valueOf(pg.d, "Contents") || ""; const rawC = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(pg.d);
      const refs = rawC ? [...rawC[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => +x[1]) : [];
      let content = "";
      for (const r of refs) { const sd = await streamData(objs.get(r)); if (sd) content += latin1(sd) + "\n"; }
      if (!/\bBT\b/.test(content)) continue;
      const lines = []; let line = "", curFont = null, lastY = null;
      const flush = () => { if (line.trim()) lines.push(line.replace(/[ \t]+/g, " ").trimEnd()); line = ""; };
      const decode = (bytesStr) => {
        const f = curFont;
        if (f && f.cmap) {
          const n = f.cmap.codeLen; let s = "";
          for (let i = 0; i + n <= bytesStr.length; i += n) { let code = 0; for (let k = 0; k < n; k++) code = code * 256 + (bytesStr.charCodeAt(i + k) & 255); const ch = f.cmap.map.get(code); s += ch !== undefined ? ch : (n === 1 ? String.fromCharCode(code) : ""); }
          return s;
        }
        if (f && f.twoByte) return "";                    // glyph ids with no map: unreadable, not guessed
        return bytesStr;
      };
      const ESC = { n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
      const lit = (s) => s.replace(/\\(?:([nrtbf()\\])|([0-7]{1,3})|\r?\n)/g, (a, c, oct) => (c !== undefined ? ESC[c] : oct !== undefined ? String.fromCharCode(parseInt(oct, 8) & 255) : ""));
      const hex = (h) => { h = h.replace(/\s+/g, ""); if (h.length % 2) h += "0"; let s = ""; for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.substr(i, 2), 16)); return s; };
      const tok = /\/([^\s/<>\[\]()]+)\s+[-\d.]+\s+Tf|\(((?:\\[\s\S]|[^\\()])*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f\s]+)>\s*(?:Tj|'|")|\[((?:\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|[^\]()<])*)\]\s*TJ|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|(?:-?[\d.]+\s+){4}(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|\bT\*|\bET\b/g;
      let t;
      while ((t = tok.exec(content))) {
        if (t[1] !== undefined) curFont = fonts.get(t[1]) || null;
        else if (t[2] !== undefined) line += decode(lit(t[2]));
        else if (t[3] !== undefined) line += decode(hex(t[3]));
        else if (t[4] !== undefined) { for (const p of t[4].matchAll(/\(((?:\\[\s\S]|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>|(-?[\d.]+)/g)) { if (p[1] !== undefined) line += decode(lit(p[1])); else if (p[2] !== undefined) line += decode(hex(p[2])); else if (+p[3] < -180) line += " "; } }
        else if (t[5] !== undefined) { if (Math.abs(+t[6]) > 0.5) flush(); else line += " "; }
        else if (t[8] !== undefined) { const y = +t[8]; if (lastY !== null && Math.abs(y - lastY) > 0.5) flush(); else if (line) line += " "; lastY = y; }
        else flush();
      }
      flush();
      const txt = lines.join("\n");
      total += txt.length; readable += (txt.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿऀ-ॿ一-鿿]/g) || []).length;
      if (txt.trim()) out.push(txt);
    }
    const text = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text || readable < 20 || readable / Math.max(1, total) < 0.4) return { text: "", note: "no readable text — scanned or image-only pages, or fonts that don't say which letters they draw (needs OCR)" };
    return { text, pages: pages.length };
  }

  return { extract, parseCMap, ascii85 };
});
