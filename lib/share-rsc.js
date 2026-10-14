/* Read the conversation embedded in ChatGPT's public share-page React Flight data. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaShareRsc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  function readStringArg(src, start) {
    while (/\s/.test(src[start] || "")) start++;
    if (src[start] !== '"') return null;
    let escaped = false;
    for (let i = start + 1; i < src.length; i++) {
      const c = src[i];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') {
        try { return { value: JSON.parse(src.slice(start, i + 1)), end: i + 1 }; }
        catch (_) { return null; }
      }
    }
    return null;
  }

  function flightPools(doc) {
    const pools = [];
    for (const script of Array.from(doc.scripts || [])) {
      const src = script.textContent || "";
      const marker = "streamController.enqueue(";
      let at = 0;
      while ((at = src.indexOf(marker, at)) !== -1) {
        const arg = readStringArg(src, at + marker.length);
        if (!arg) { at += marker.length; continue; }
        at = arg.end;
        let value = arg.value.trim();
        const pre = /^[A-Za-z]{1,2}\d+:/.exec(value);   // deferred chunks look like  P12:[ ... ]
        if (pre) value = value.slice(pre[0].length).trim();
        if (!value.startsWith("[")) continue;
        try {
          const pool = JSON.parse(value);
          if (Array.isArray(pool) && pool.length > 2) pools.push(pool);
        } catch (_) { /* other stream chunks are not the route's constant pool */ }
      }
    }
    return pools;
  }

  function decodePool(pool) {
    const cache = new Map();
    const keyName = (key) => /^_\d+$/.test(key) && typeof pool[Number(key.slice(1))] === "string"
      ? pool[Number(key.slice(1))] : key;
    const resolve = (value, depth) => {
      if (depth > 80) return null;
      if (typeof value === "number" && Number.isInteger(value)) {
        if (value < 0 || value >= pool.length) return value;
        if (cache.has(value)) return cache.get(value);
        cache.set(value, null);
        const result = resolve(pool[value], depth + 1);
        cache.set(value, result);
        return result;
      }
      if (Array.isArray(value)) return value.map((x) => resolve(x, depth + 1));
      if (isObj(value)) {
        const out = {};
        for (const [key, v] of Object.entries(value)) out[keyName(key)] = resolve(v, depth + 1);
        return out;
      }
      return value;
    };
    const result = {};
    for (let i = 1; i + 1 < pool.length; i += 2) {
      if (typeof pool[i] === "string" && !(pool[i] in result)) result[pool[i]] = resolve(pool[i + 1], 0);
    }
    return result;
  }

  function conversationCandidates(root) {
    const out = [], seen = new Set(), stack = [{ value: root, depth: 0 }];
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (!isObj(value) || seen.has(value) || depth > 12) continue;
      seen.add(value);
      const linear = Array.isArray(value.linear_conversation) ? value.linear_conversation : null;
      const mapping = isObj(value.mapping) ? value.mapping : null;
      if ((linear && linear.length) || (mapping && Object.keys(mapping).length)) out.push(value);
      for (const child of Object.values(value)) {
        if (isObj(child)) stack.push({ value: child, depth: depth + 1 });
        else if (Array.isArray(child)) for (const item of child) if (isObj(item)) stack.push({ value: item, depth: depth + 1 });
      }
    }
    return out.sort((a, b) => (b.linear_conversation?.length || Object.keys(b.mapping || {}).length) -
      (a.linear_conversation?.length || Object.keys(a.mapping || {}).length));
  }

  function mappingOrder(mapping) {
    const ids = Object.keys(mapping);
    let id = ids.find((key) => isObj(mapping[key]) && (mapping[key].parent == null));
    if (!id) return [];
    const out = [], seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const node = mapping[id];
      if (!isObj(node)) break;
      out.push(node);
      const children = node.children;
      id = Array.isArray(children) && typeof children[children.length - 1] === "string"
        ? children[children.length - 1] : null;
    }
    return out;
  }

  function textFromContent(content) {
    if (!isObj(content)) return "";
    if (content.content_type === "code" && typeof content.text === "string") {
      const language = typeof content.language === "string" && content.language !== "unknown" ? content.language : "";
      return content.text ? "```" + language + "\n" + content.text + "\n```" : "";
    }
    const parts = content.parts;
    if (Array.isArray(parts)) {
      return parts.map((part) => typeof part === "string" ? part :
        isObj(part) ? (typeof part.text === "string" ? part.text :
          /image/i.test(String(part.content_type || part.type || "")) ? "[image]" : "") : "").filter(Boolean).join("\n\n").trim();
    }
    return typeof content.text === "string" ? content.text.trim() : "";
  }


  // ---- structure-agnostic reader -------------------------------------------------------------
  // Whatever the wrappers are called today, a conversation is "a list of nodes that each hold a message with an
  // author role and some content". Find such lists anywhere in the page data instead of trusting one path.
  function keyNames(pool, obj) {
    const out = [];
    for (const k of Object.keys(obj)) out.push(/^_\d+$/.test(k) && typeof pool[Number(k.slice(1))] === "string" ? pool[Number(k.slice(1))] : k);
    return out;
  }

  function decodeAt(pool, cache, idx, depth) {
    if (depth > 60) return null;
    if (typeof idx !== "number" || !Number.isInteger(idx)) return idx;
    if (idx < 0) return null;                        // turbo-stream specials: undefined / null / NaN ...
    if (idx >= pool.length) return null;
    if (cache.has(idx)) return cache.get(idx);
    cache.set(idx, null);
    const v = pool[idx];
    let out;
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && /^[A-Z]$/.test(v[0]) && v.length <= 3 && v[0] !== "P") out = null;   // Date, Map, Set ...
      else if (v[0] === "P") out = null;                                                                    // deferred promise
      else out = v.map((x) => decodeAt(pool, cache, x, depth + 1));
    } else if (isObj(v)) {
      out = {};
      for (const [k, val] of Object.entries(v)) {
        const name = /^_\d+$/.test(k) && typeof pool[Number(k.slice(1))] === "string" ? pool[Number(k.slice(1))] : k;
        out[name] = decodeAt(pool, cache, val, depth + 1);
      }
    } else out = v;
    cache.set(idx, out);
    return out;
  }

  function roleOf(message) {
    const a = isObj(message.author) ? message.author : {};
    const raw = String(a.role || message.role || message.sender || a.name || "").toLowerCase();
    if (raw === "user" || raw === "human") return "User";
    if (raw === "assistant" || raw === "ai" || raw === "model") return "Assistant";
    return null;
  }

  function messageOf(node) {
    if (!isObj(node)) return null;
    if (isObj(node.message)) return node.message;
    if (isObj(node.payload) && messageOf(node.payload)) return messageOf(node.payload);   // event-style wrappers
    if (isObj(node.item) && messageOf(node.item)) return messageOf(node.item);
    if ((isObj(node.author) || node.role || node.sender) && node.content != null) return node;
    return null;
  }

  function textOfMessage(message) {
    const c = message.content;
    if (typeof c === "string") return c.trim();
    if (isObj(c)) return textFromContent(c);
    if (Array.isArray(c)) return c.map((b) => typeof b === "string" ? b : isObj(b) ? (typeof b.text === "string" ? b.text : textFromContent(b)) : "").filter(Boolean).join("\n\n").trim();
    return typeof message.text === "string" ? message.text.trim() : "";
  }

  // nodes -> {messages, accounted}; every node is either kept, or skipped for a stated reason (hidden/system/tool/empty)
  function messagesFromNodes(nodes) {
    const messages = [], skipped = {};
    const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
    for (const node of nodes) {
      const m = messageOf(node);
      if (!m) { skip("not_a_message"); continue; }
      const meta = isObj(m.metadata) ? m.metadata : {};
      if (meta.is_visually_hidden_from_conversation === true) { skip("hidden"); continue; }
      const role = roleOf(m);
      if (!role) { skip("system_or_tool"); continue; }
      const text = textOfMessage(m);
      if (!text) { skip("no_text"); continue; }
      messages.push({ role, text, confidence: 1, attachments: [], meta: {}, seq: messages.length });
    }
    return { messages, skipped, total: nodes.length };
  }

  function looksLikeNodeList(list) {
    if (!Array.isArray(list) || list.length < 2) return false;
    let hit = 0, roles = new Set();
    for (const n of list) { const m = messageOf(n); if (m) { hit++; const r = roleOf(m); if (r) roles.add(r); } }
    return hit >= Math.max(2, Math.floor(list.length * 0.2)) && roles.size >= 1;
  }

  // Find the best conversation inside an already-decoded object tree (API JSON, __NEXT_DATA__, decoded pool ...).
  function fromTree(root) {
    const found = [], seen = new Set(), stack = [{ v: root, d: 0 }];
    while (stack.length) {
      const { v, d } = stack.pop();
      if (v === null || typeof v !== "object" || seen.has(v) || d > 24) continue;
      seen.add(v);
      if (Array.isArray(v)) {
        if (looksLikeNodeList(v)) found.push({ nodes: v, title: null, kind: "list" });
        for (const x of v) if (x && typeof x === "object") stack.push({ v: x, d: d + 1 });
      } else {
        if (isObj(v.mapping) && Object.keys(v.mapping).length) {
          const lin = Array.isArray(v.linear_conversation) && v.linear_conversation.length ? v.linear_conversation : null;
          const nodes = lin ? lin.map((e) => (isObj(e) && !isObj(e.message) && typeof e.id === "string" ? v.mapping[e.id] || null : e)) : mappingOrder(v.mapping);
          if (nodes.length) found.push({ nodes, title: typeof v.title === "string" ? v.title : null, kind: lin ? "linear_conversation" : "mapping" });
        }
        for (const x of Object.values(v)) if (x && typeof x === "object") stack.push({ v: x, d: d + 1 });
      }
    }
    let best = null;
    for (const f of found) {
      const r = messagesFromNodes(f.nodes);
      const roles = new Set(r.messages.map((m) => m.role));
      const score = r.messages.length * (roles.size === 2 ? 1000 : 1) + r.messages.length;
      if (r.messages.length >= 2 && (!best || score > best.score)) best = { score, r, f };
    }
    if (!best) return null;
    return { messages: best.r.messages, title: best.f.title || "Shared chat", count: best.r.total, skipped: best.r.skipped, source: best.f.kind };
  }

  // "There is more than this" markers on the data that carried the conversation.
  function partialHint(root) {
    const stack = [{ v: root, d: 0 }];
    while (stack.length) {
      const { v, d } = stack.pop();
      if (!isObj(v) || d > 3) continue;
      for (const [k, x] of Object.entries(v)) {
        if (/^(has_more|has_next|has_next_page|truncated)$/i.test(k) && x === true) return true;
        if (/^(next_cursor|next_page_token|next_page|cursor_next)$/i.test(k) && typeof x === "string" && x) return true;
        if (isObj(x)) stack.push({ v: x, d: d + 1 });
      }
    }
    return false;
  }

  // Any text a page received: plain JSON, newline-separated JSON / event streams, or turbo-stream chunks.
  function fromText(text) {
    const t = String(text || "").trim();
    if (t.length < 50) return null;
    const vals = [];
    try { vals.push(JSON.parse(t)); } catch (_) {
      for (const line of t.split(/\r?\n/)) {
        let l = line.trim().replace(/^data:\s*/, "").replace(/^[A-Za-z]{1,2}\d+:/, "");
        if (l[0] !== "[" && l[0] !== "{") continue;
        try { vals.push(JSON.parse(l)); } catch (_) {}
      }
    }
    let best = null;
    const take = (x, root) => { if (x && x.messages.length >= 2 && (!best || x.messages.length > best.messages.length)) { best = x; best.partial = partialHint(root); } };
    for (const v of vals) {
      if (Array.isArray(v) && v.length > 2 && v.some((x) => isObj(x) && Object.keys(x).some((k) => /^_\d+$/.test(k)))) { try { take(fromPool(v), null); } catch (_) {} }
      try { take(fromTree(v), v); } catch (_) {}
    }
    if (!best && vals.length > 1) { try { take(fromTree(vals), null); } catch (_) {} }
    return best;
  }

  // Scan one flight pool for node lists without needing to know which key leads to them.
  function fromPool(pool) {
    const cache = new Map();
    const names = new Map();
    const nm = (i) => { if (!names.has(i)) names.set(i, isObj(pool[i]) ? keyNames(pool, pool[i]) : []); return names.get(i); };
    let best = null;
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (!Array.isArray(v) || v.length < 2 || !v.every((x) => Number.isInteger(x) && x >= 0 && x < pool.length)) continue;
      let hit = 0;
      for (const x of v) { const k = nm(x); if (k.includes("message") || (k.includes("author") && k.includes("content"))) hit++; }
      if (hit < Math.max(2, Math.floor(v.length * 0.6))) continue;
      const r = fromTree([decodeAt(pool, cache, i, 0)][0]);
      if (r && (!best || r.messages.length > best.messages.length)) best = r;
    }
    if (best) return best;
    return fromTree(decodePool(pool));
  }

  function scriptJsonBlobs(doc) {
    const out = [];
    for (const script of Array.from(doc.scripts || [])) {
      const src = script.textContent || "";
      if (src.length < 200 || src.includes("streamController.enqueue(")) continue;
      const t = String(script.type || (script.getAttribute && script.getAttribute("type")) || "");
      if (/json/i.test(t) || (script.id === "__NEXT_DATA__")) { try { out.push(JSON.parse(src)); } catch (_) {} }
    }
    return out;
  }

  function shape(doc) {
    // text-free summary for the page report
    const out = { pools: [], blobs: 0 };
    try {
      for (const pool of flightPools(doc)) {
        const strings = pool.filter((x) => typeof x === "string");
        const has = (w) => strings.includes(w);
        out.pools.push({ size: pool.length, linear: has("linear_conversation"), mapping: has("mapping"), author: has("author"), parts: has("parts"), content: has("content"), message: has("message"), role: has("role") });
      }
      out.blobs = scriptJsonBlobs(doc).length;
    } catch (_) { out.error = true; }
    return out;
  }

  function extract(doc) {
    for (const pool of flightPools(doc)) {
      const decoded = decodePool(pool);
      const data = conversationCandidates(decoded)[0];
      if (!data) continue;
      const mapping = isObj(data.mapping) ? data.mapping : {};
      const linear = Array.isArray(data.linear_conversation) ? data.linear_conversation : [];
      const nodes = linear.length ? linear.map((entry) => {
        if (!isObj(entry)) return null;
        if (isObj(entry.message)) return entry;
        return typeof entry.id === "string" ? mapping[entry.id] || null : null;
      }) : mappingOrder(mapping);
      const messages = [];
      for (const node of nodes) {
        if (!isObj(node) || !isObj(node.message)) continue;
        const message = node.message;
        const author = isObj(message.author) ? message.author : {};
        const rawRole = String(author.role || author.name || "").toLowerCase();
        const role = rawRole === "user" || rawRole === "human" ? "User" :
          rawRole === "assistant" || rawRole === "ai" ? "Assistant" : null;
        if (!role) continue;
        const text = textFromContent(message.content);
        const attachments = [];
        if (text) messages.push({ role, text, confidence: 1, attachments, meta: {}, seq: messages.length });
      }
      const roles = new Set(messages.map((m) => m.role));
      if (messages.length >= 2 && roles.size === 2) {
        return { messages, title: typeof data.title === "string" ? data.title : "Shared chat", count: nodes.length, source: linear.length ? "linear_conversation" : "mapping" };
      }
    }
    return null;
  }

  function extractAny(doc) {
    let best = null;
    const take = (x) => { if (x && x.messages.length >= 2 && (!best || x.messages.length > best.messages.length)) best = x; };
    for (const pool of flightPools(doc)) { try { take(fromPool(pool)); } catch (_) {} }
    if (best) return best;
    try { take(extract(doc)); } catch (_) {}
    if (best) return best;
    for (const blob of scriptJsonBlobs(doc)) { try { take(fromTree(blob)); } catch (_) {} }
    return best;
  }

  return { extract, extractAny, fromText, fromTree, fromPool, shape, flightPools, decodePool, conversationCandidates };
});
