/* Chat Capsule v0.4.1 — page-side capture engine.
   Injected on demand via chrome.scripting.executeScript (activeTab + scripting).
   Exposes window.__chatCapsule = { capture, insert, last }.
   Must never send anything anywhere; it only reads the page DOM and returns data to the popup.

   Platform adapter contract (every adapter implements):
     id              — string identifier
     name            — human-readable name (null for generic)
     match(host)     — RegExp.test(host)
     collect()       — returns [{ el, role, confidence }]
     conversationId()— returns string | null
     inputs          — ordered list of CSS selectors for the compose box
     supportsDeepCapture — boolean (default true)
*/
(() => {
  "use strict";

  if (window.__chatCapsule && window.__chatCapsule._loaded) return; // idempotent re-injection

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "BUTTON", "SVG", "TEMPLATE", "IFRAME", "CANVAS",
    "AUDIO", "VIDEO", "INPUT", "SELECT", "TEXTAREA", "OBJECT",
  ]);

  /* ---------------------------------------------------------------
     Rich text → Markdown (keeps code blocks, tables, links, lists)
     --------------------------------------------------------------- */
  function toMarkdown(root) {
    const meta = { code: 0, tables: 0, images: 0, links: [] };
    const blocks = []; // code blocks parked so whitespace cleanup can't touch them
    const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ""; } };

    function kids(node, ctx) {
      let s = "";
      for (const c of node.childNodes) s += walk(c, ctx);
      return s;
    }
    const oneLine = (s) => s.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();

    function walk(node, ctx) {
      if (node.nodeType === 3) return node.nodeValue.replace(/[ \t\r\n\f]+/g, " ");
      if (node.nodeType !== 1) return "";
      const tag = node.tagName.toUpperCase();
      if (SKIP.has(tag)) return "";

      if (node.classList && node.classList.contains("katex")) {
        const ann = node.querySelector('annotation[encoding="application/x-tex"]');
        if (ann) {
          const tex = ann.textContent.trim();
          return node.closest(".katex-display") ? "\n\n$$" + tex + "$$\n\n" : "$" + tex + "$";
        }
      }
      if (node.getAttribute("aria-hidden") === "true") return "";

      switch (tag) {
        case "PRE": {
          const codeEl = node.querySelector("code");
          const code = (codeEl || node).textContent.replace(/\n$/, "");
          let lang = "";
          const cls = String((codeEl && codeEl.className) || node.className || "");
          const m = cls.match(/(?:language|lang)-([\w+#.-]+)/i);
          if (m) lang = m[1];
          else if (codeEl) {
            const first = node.firstElementChild;
            const cands = first && first !== codeEl && !first.contains(codeEl)
              ? [first, first.querySelector("span")] : [];
            for (const c of cands) {
              const t = c && c.textContent.trim();
              if (t && /^[A-Za-z][\w+#.-]{0,19}$/.test(t)) { lang = t; break; }
            }
          }
          meta.code++;
          const fence = code.includes("```") ? "````" : "```";
          blocks.push(fence + lang + "\n" + code + "\n" + fence);
          return "\n\n\u0000" + (blocks.length - 1) + "\u0000\n\n";
        }
        case "CODE": {
          const t = node.textContent;
          return t.includes("`") ? "`` " + t + " ``" : "`" + t + "`";
        }
        case "TABLE": {
          const rows = [...node.querySelectorAll("tr")].map((tr) =>
            [...tr.children].filter((c) => /^(TD|TH)$/i.test(c.tagName))
              .map((c) => oneLine(kids(c, ctx)).replace(/\|/g, "\\|")));
          if (!rows.length || !rows[0].length) return kids(node, ctx);
          meta.tables++;
          const w = Math.max(...rows.map((r) => r.length));
          const pad = (r) => { const x = r.slice(); while (x.length < w) x.push(""); return "| " + x.join(" | ") + " |"; };
          const lines = [pad(rows[0]), "| " + Array(w).fill("---").join(" | ") + " |", ...rows.slice(1).map(pad)];
          return "\n\n" + lines.join("\n") + "\n\n";
        }
        case "A": {
          const text = oneLine(kids(node, ctx));
          const href = node.getAttribute("href") || "";
          if (!href || /^(javascript:|#)/i.test(href)) return text;
          const url = abs(href);
          if (!/^https?:/i.test(url)) return text;
          if (meta.links.length < 300 && !meta.links.includes(url)) meta.links.push(url);
          return !text || text === url ? url : "[" + text + "](" + url + ")";
        }
        case "IMG": {
          const alt = node.getAttribute("alt") || "image";
          const src = node.getAttribute("src") || "";
          meta.images++;
          if (!src || /^(data|blob):/i.test(src)) return "[image: " + alt + "]";
          return "![" + alt + "](" + abs(src) + ")";
        }
        case "BR": return "\n";
        case "HR": return "\n\n---\n\n";
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
          return "\n\n" + "#".repeat(Number(tag[1])) + " " + oneLine(kids(node, ctx)) + "\n\n";
        case "UL": case "OL": {
          const ordered = tag === "OL";
          let n = parseInt(node.getAttribute("start") || "1", 10) || 1;
          const items = [];
          for (const li of node.children) {
            if (li.tagName.toUpperCase() !== "LI") {
              const t = walk(li, ctx).trim();
              if (t) items.push(t);
              continue;
            }
            const body = kids(li, ctx).trim().replace(/\n{2,}/g, "\n").replace(/\n/g, "\n  ");
            items.push((ordered ? n++ + ". " : "- ") + body);
          }
          return "\n\n" + items.join("\n") + "\n\n";
        }
        case "BLOCKQUOTE":
          return "\n\n" + kids(node, ctx).trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
        case "STRONG": case "B": { const t = kids(node, ctx).trim(); return t ? "**" + t + "**" : ""; }
        case "EM": case "I": { const t = kids(node, ctx).trim(); return t ? "*" + t + "*" : ""; }
        case "DEL": case "S": { const t = kids(node, ctx).trim(); return t ? "~~" + t + "~~" : ""; }
        case "P": case "SECTION": case "ARTICLE": case "FIGURE": case "FIGCAPTION":
        case "DETAILS": case "SUMMARY": case "DL": case "DT": case "DD":
          return "\n\n" + kids(node, ctx) + "\n\n";
        case "DIV": case "LI": case "MAIN": case "ASIDE": case "HEADER": case "FOOTER": case "TR":
          return "\n" + kids(node, ctx) + "\n";
        default:
          return kids(node, ctx);
      }
    }

    let md = kids(root, {});
    md = md.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    md = md.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
    return { text: md, meta };
  }

  /* ---------------------------------------------------------------
     Roles, de-duplication
     --------------------------------------------------------------- */
  function roleFromAttr(v) {
    v = String(v || "").toLowerCase().trim();
    if (v === "user" || v === "human" || v === "me") return "User";
    if (v === "assistant" || v === "ai" || v === "bot" || v === "model" || v === "gpt") return "Assistant";
    return null;
  }

  const USER_TOKENS = new Set(["user", "human", "query", "question", "prompt", "me", "you"]);
  const BOT_TOKENS = new Set(["assistant", "bot", "ai", "model", "response", "answer", "reply", "claude", "gpt", "gemini"]);

  function tokensOf(el) {
    const s = (el.getAttribute("data-testid") || "") + " " + String(typeof el.className === "string" ? el.className : "");
    return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  // explicit attribute 0.98, class/testid words 0.7, ancestors 0.45, unknown → null
  function inferRole(el) {
    for (const a of ["data-message-author-role", "data-role", "data-author", "data-sender"]) {
      const r = roleFromAttr(el.getAttribute(a));
      if (r) return { role: r, confidence: 0.98 };
    }
    const look = (e) => {
      const t = tokensOf(e);
      const u = t.some((x) => USER_TOKENS.has(x));
      const b = t.some((x) => BOT_TOKENS.has(x));
      return u && !b ? "User" : b && !u ? "Assistant" : null;
    };
    const own = look(el);
    if (own) return { role: own, confidence: 0.7 };
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const r = look(p);
      if (r) return { role: r, confidence: 0.45 };
    }
    return null;
  }

  // Parent and child nodes can both match. Drop wrappers that hold several messages,
  // then keep only the outermost remaining match so one message is never counted twice.
  function pruneNested(cands) {
    const els = cands.map((c) => c.el);
    const kept = cands.filter((c) => {
      let n = 0;
      for (const o of els) if (o !== c.el && c.el.contains(o) && ++n >= 2) return false;
      return true;
    });
    const set = new Set(kept.map((c) => c.el));
    return kept.filter((c) => {
      for (let p = c.el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  function finalize(cands) {
    let list = pruneNested(cands.filter((c) => c.el));
    list = list.map((c) => {
      if (c.role) return c;
      const r = inferRole(c.el);
      return r ? { ...c, role: r.role, confidence: r.confidence } : { ...c, role: null, confidence: 0 };
    });
    for (let i = 0; i < list.length; i++) {
      if (list[i].role) continue;
      let prev = null, next = null;
      for (let j = i - 1; j >= 0; j--) if (list[j].role) { prev = list[j]; break; }
      for (let j = i + 1; j < list.length; j++) if (list[j].role) { next = list[j]; break; }
      const opp = (r) => (r === "User" ? "Assistant" : "User");
      list[i].role = prev ? opp(prev.role) : next ? opp(next.role) : "User";
      list[i].confidence = 0.35;
    }
    const out = [];
    for (const c of list) {
      const { text, meta } = toMarkdown(c.el);
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.role === c.role && last.text === text && text.length >= 20) continue;
      out.push({ role: c.role, confidence: c.confidence, text, meta });
    }
    return { messages: out, domCount: list.length, firstEl: list.length ? list[0].el : null };
  }

  /* ---------------------------------------------------------------
     Site adapters
     --------------------------------------------------------------- */
  const q = (sel) => [...document.querySelectorAll(sel)];

  const ADAPTERS = [
    {
      id: "chatgpt", name: "ChatGPT",
      match: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
      collect: () => q("[data-message-author-role]").map((el) => ({
        el, role: roleFromAttr(el.getAttribute("data-message-author-role")), confidence: 0.98,
      })).filter((c) => c.role),
      conversationId: () => (location.pathname.match(/\/c\/([\w-]+)/) || [])[1] || null,
      inputs: ["#prompt-textarea", "div.ProseMirror[contenteditable='true']", "textarea"],
      supportsDeepCapture: true,
    },
    {
      id: "claude", name: "Claude",
      match: /(^|\.)claude\.ai$/,
      collect: () => q('[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response, .font-claude-message')
        .map((el) => {
          const isUser = el.matches('[data-testid="user-message"]');
          return { el, role: isUser ? "User" : "Assistant", confidence: el.hasAttribute("data-testid") ? 0.95 : 0.9 };
        }),
      conversationId: () => (location.pathname.match(/\/chat\/([\w-]+)/) || [])[1] || null,
      inputs: ["div.ProseMirror[contenteditable='true']", "[data-testid='chat-input']", "div[contenteditable='true']"],
      supportsDeepCapture: true,
    },
    {
      id: "gemini", name: "Gemini",
      match: /(^|\.)gemini\.google\.com$/,
      collect: () => q("user-query, model-response").map((el) => {
        const isUser = el.tagName.toLowerCase() === "user-query";
        const inner = isUser ? el.querySelector(".query-text") || el : el.querySelector("message-content") || el;
        return { el: inner, role: isUser ? "User" : "Assistant", confidence: 0.95 };
      }),
      conversationId: () => (location.pathname.match(/\/app\/([\w-]+)/) || [])[1] || null,
      inputs: ["rich-textarea .ql-editor", "div.ql-editor[contenteditable='true']", "div[contenteditable='true']"],
      supportsDeepCapture: true,
    },
    {
      id: "copilot", name: "Copilot",
      match: /(^|\.)copilot\.microsoft\.com$/,
      collect: () => q('[data-testid="user-message"], [data-testid="bot-message"], [class*="user-message"], [class*="bot-message"]')
        .map((el) => {
          const isUser = el.matches('[data-testid="user-message"]') || /user-message/i.test(el.className);
          return { el, role: isUser ? "User" : "Assistant", confidence: 0.85 };
        }),
      conversationId: () => null,
      inputs: ["textarea[placeholder]", "div[contenteditable='true'][role='textbox']", "div[contenteditable='true']"],
      supportsDeepCapture: false,
    },
    {
      id: "perplexity", name: "Perplexity",
      match: /(^|\.)perplexity\.ai$/,
      collect: () => q('[data-testid="user-message-text"], .prose, [class*="answer"]')
        .map((el) => {
          const isUser = el.matches('[data-testid="user-message-text"]');
          return { el, role: isUser ? "User" : "Assistant", confidence: isUser ? 0.9 : 0.75 };
        }),
      conversationId: () => (location.pathname.match(/\/search\/([\w-]+)/) || [])[1] || null,
      inputs: ["textarea[placeholder]", "div[contenteditable='true']"],
      supportsDeepCapture: false,
    },
  ];

  const GENERIC = {
    id: "generic", name: null,
    collect: () => q([
      "[data-message-author-role]", "[data-role]", "[data-author]", "[data-sender]",
      '[data-testid*="user-message"]', '[data-testid*="assistant-message"]', '[data-testid*="bot-message"]',
      '[class*="user-message"]', '[class*="assistant-message"]', '[class*="bot-message"]',
      '[class*="human-message"]', '[class*="ai-message"]', '[class*="chat-message"]',
    ].join(", ")).map((el) => ({ el, role: null, confidence: 0 })),
    conversationId: () => null,
    inputs: [
      "#prompt-textarea", "div.ProseMirror[contenteditable='true']", "rich-textarea .ql-editor",
      "div[contenteditable='true'][role='textbox']", "div[contenteditable='true']", "textarea",
    ],
    supportsDeepCapture: false,
  };

  const snapshot = (adapter) => finalize(adapter.collect());

  /* ---------------------------------------------------------------
     Scrolling / deep capture
     --------------------------------------------------------------- */
  function findScroller(el) {
    for (let p = el && el.parentElement; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return document.scrollingElement || document.documentElement;
  }

  const fp = (m) => m.role + "|" + m.text.length + "|" + m.text.slice(0, 160);

  // Stitch overlapping snapshots (top → bottom) into one list.
  function mergeSnapshots(snaps) {
    let merged = [];
    let gaps = 0;
    for (const snap of snaps) {
      if (!snap.length) continue;
      if (!merged.length) { merged = snap.slice(); continue; }
      let k = Math.min(merged.length, snap.length);
      for (; k > 0; k--) {
        let same = true;
        for (let i = 0; i < k; i++) {
          if (fp(merged[merged.length - k + i]) !== fp(snap[i])) { same = false; break; }
        }
        if (same) break;
      }
      if (k === 0) gaps++;
      merged = merged.concat(snap.slice(k));
    }
    return { messages: merged, gaps };
  }

  async function deepCapture(adapter, firstEl) {
    const scroller = findScroller(firstEl);
    const original = scroller.scrollTop;
    let prevH = -1, still = 0;
    for (let i = 0; i < 60 && still < 3; i++) {
      scroller.scrollTop = 0;
      await sleep(300);
      const h = scroller.scrollHeight;
      still = h === prevH ? still + 1 : 0;
      prevH = h;
    }
    const reachedTop = scroller.scrollTop <= 2;
    const top = snapshot(adapter).messages;

    scroller.scrollTop = scroller.scrollHeight;
    await sleep(350);
    const bottom = snapshot(adapter).messages;
    let result;
    if (top.length && bottom.some((m) => fp(m) === fp(top[0]))) {
      result = { messages: bottom, gaps: 0, virtualized: false };
    } else {
      const snaps = [top];
      const step = Math.max(300, Math.floor(scroller.clientHeight * 0.7));
      let pos = 0;
      for (let guard = 0; guard < 600; guard++) {
        pos += step;
        const max = scroller.scrollHeight - scroller.clientHeight;
        scroller.scrollTop = Math.min(pos, max);
        await sleep(180);
        snaps.push(snapshot(adapter).messages);
        if (pos >= max) break;
      }
      const merged = mergeSnapshots(snaps);
      result = { messages: merged.messages, gaps: merged.gaps, virtualized: true };
    }
    scroller.scrollTop = original;
    return { ...result, reachedTop };
  }

  /* ---------------------------------------------------------------
     capture()
     --------------------------------------------------------------- */
  async function capture(opts) {
    opts = opts || {};
    const host = location.hostname;
    const specific = ADAPTERS.find((a) => a.match.test(host)) || null;
    const warnings = [];
    let adapter = null, snap = null;

    for (const a of [specific, GENERIC].filter(Boolean)) {
      let s = null;
      try { s = snapshot(a); } catch (e) { s = null; }
      if (s && s.messages.length) { adapter = a; snap = s; break; }
    }

    let result;
    if (!adapter) {
      const sel = String(window.getSelection() || "").trim();
      const base = { site: host, siteId: "page", url: location.href, title: document.title, conversationId: null };
      if (sel) {
        result = { ...base, method: "selection", messages: [{ role: "Notes", text: sel, confidence: 1, meta: {} }] };
      } else {
        const main = document.querySelector("main, article") || document.body;
        const { text, meta } = toMarkdown(main);
        result = { ...base, method: "page", messages: [{ role: "Page", text: text.slice(0, 60000), confidence: 1, meta }] };
        warnings.push("No chat was recognised on this page, so the visible page text was captured instead.");
      }
      result.coverage = { captured: 1, domCount: 0, atTop: null, deep: false, virtualized: false, gaps: 0, complete: null };
    } else {
      if (adapter === GENERIC && specific) {
        warnings.push("The " + specific.name + " reader found nothing (the site may have changed), so a generic reader was used. Check the result carefully.");
      } else if (adapter === GENERIC) {
        warnings.push("This site isn't specifically supported. A generic reader was used, so check the result carefully.");
      }
      let messages = snap.messages;
      let method = "dom";
      let info = { reachedTop: false, virtualized: false, gaps: 0 };
      const scroller = findScroller(snap.firstEl);
      const scrollable = scroller.scrollHeight > scroller.clientHeight + 4;

      if (opts.deep && adapter.supportsDeepCapture !== false) {
        const d = await deepCapture(adapter, snap.firstEl);
        messages = d.messages;
        method = "dom-deep";
        info = { reachedTop: d.reachedTop, virtualized: d.virtualized, gaps: d.gaps };
        if (!d.reachedTop) warnings.push("Couldn't scroll all the way to the start of the chat.");
        if (d.gaps) warnings.push(d.gaps + " possible gap(s) between scrolled sections: some messages may be missing.");
      } else if (opts.deep && adapter.supportsDeepCapture === false) {
        warnings.push(adapter.name + " does not support deep capture. Standard capture was used.");
      }

      let complete = null;
      if (opts.deep && adapter.supportsDeepCapture !== false) complete = info.reachedTop && info.gaps === 0;
      else if (!scrollable) complete = true;
      else warnings.push("Captured what the page has loaded. In very long chats older messages may not be loaded yet. Use Deep capture to check.");

      if (messages.length && messages[0].role !== "User" && adapter !== GENERIC) {
        warnings.push("The first captured message isn't yours, so the start of the chat may be missing.");
        complete = false;
      }
      const guessed = messages.filter((m) => m.confidence < 0.6).length;
      if (guessed) warnings.push(guessed + " message role(s) were guessed (who said it). Check them in the message list.");

      result = {
        site: adapter.name || host, siteId: adapter.id, url: location.href, title: document.title,
        conversationId: adapter.conversationId(), method, messages,
        coverage: {
          captured: messages.length, domCount: snap.domCount, atTop: scroller.scrollTop <= 2,
          deep: !!opts.deep, virtualized: info.virtualized, gaps: info.gaps, complete,
        },
      };
    }

    const links = [];
    const stats = { user: 0, assistant: 0, codeBlocks: 0, tables: 0, links: 0, images: 0 };
    for (const m of result.messages) {
      if (m.role === "User") stats.user++;
      else if (m.role === "Assistant") stats.assistant++;
      const mt = m.meta || {};
      stats.codeBlocks += mt.code || 0;
      stats.tables += mt.tables || 0;
      stats.images += mt.images || 0;
      for (const l of mt.links || []) if (links.length < 200 && !links.includes(l)) links.push(l);
      delete m.meta;
    }
    stats.links = links.length;
    result.stats = stats;
    result.links = links;
    result.warnings = warnings;
    result.at = Date.now();
    api._last = result;
    return result;
  }

  /* ---------------------------------------------------------------
     insert(): editor-aware, verifies the text really arrived
     --------------------------------------------------------------- */
  const squash = (s) => String(s || "").replace(/\s+/g, "");
  const isVisible = (el) => {
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && !el.closest("[hidden]");
  };
  const isField = (el) => el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search)$/i.test(el.type || "text")));
  const isEditable = (el) => el && (isField(el) || el.isContentEditable);
  const readField = (el) => isField(el) ? el.value : typeof el.innerText === "string" ? el.innerText : el.textContent;

  function findInput() {
    if (isEditable(document.activeElement) && isVisible(document.activeElement)) return document.activeElement;
    const host = location.hostname;
    const adapter = ADAPTERS.find((a) => a.match.test(host)) || GENERIC;
    const lists = adapter === GENERIC ? [GENERIC.inputs] : [adapter.inputs, GENERIC.inputs];
    for (const sels of lists) {
      for (const s of sels) {
        const found = q(s).filter((e) => isVisible(e) && !e.disabled && !e.readOnly);
        if (found.length) return found[found.length - 1];
      }
    }
    return null;
  }

  async function insert(text) {
    if (!text) return { ok: false, error: "Nothing to insert." };
    const target = findInput();
    if (!target) return { ok: false, error: "No text box found. Click into the chat box first." };
    target.focus();

    const before = readField(target);
    const payload = (before.trim() ? "\n\n" : "") + text;
    const want = squash(text);
    const baseLen = squash(before).length;
    const check = () => {
      const now = squash(readField(target));
      const grew = now.length - baseLen;
      const verified = grew >= want.length * 0.9 && now.includes(want.slice(0, 60)) && now.includes(want.slice(-60));
      return { grew, verified };
    };

    if (isField(target)) {
      const proto = target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(target, before + payload);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(80);
      const r = check();
      return r.verified
        ? { ok: true, verified: true, method: "value" }
        : { ok: false, partial: r.grew > 0, method: "value", error: "The page didn't accept the text." };
    }

    const caretToEnd = () => {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const methods = [
      ["paste", () => {
        const dt = new DataTransfer();
        dt.setData("text/plain", payload);
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
      }],
      ["execCommand", () => {
        if (typeof document.execCommand !== "function") throw new Error("unsupported");
        document.execCommand("insertText", false, payload);
      }],
      ["beforeinput", () => {
        target.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", data: payload, bubbles: true, cancelable: true }));
      }],
    ];
    for (const [name, run] of methods) {
      caretToEnd();
      try { run(); } catch (e) { continue; }
      await sleep(120);
      const r = check();
      if (r.verified) return { ok: true, verified: true, method: name };
      if (r.grew > 0) return { ok: false, partial: true, method: name, error: "The text box only took part of the text." };
    }
    return { ok: false, error: "The editor on this page didn't accept automatic insertion." };
  }

  const api = {
    _loaded: true,
    capture,
    insert,
    last: () => (api._last && Date.now() - api._last.at < 15 * 60 * 1000 ? api._last : null),
    _last: null,
    _test: { mergeSnapshots, toMarkdown, pruneNested, inferRole },
  };
  window.__chatCapsule = api;
})();
