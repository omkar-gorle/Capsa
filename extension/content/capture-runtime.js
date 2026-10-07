/* Chat Capsule v5.0.0 — page-side capture engine.
   Injected on demand via chrome.scripting.executeScript (activeTab + scripting).
   Exposes window.__chatCapsule = { capture, insert, last, cancelCapture }.
   Must never send anything anywhere; it only reads the page DOM and returns data to the popup.

   SECURITY: This file runs in the content-script isolated world. It cannot access
   extension internals. It only reads DOM and returns plain data objects.

   Platform adapter contract:
     id                  — string identifier (lower-case, no spaces)
     name                — human-readable name (null for generic)
     match               — RegExp to test against location.hostname
     collect()           — returns [{ el, role, confidence }] in DOM order
     conversationId()    — returns string | null
     getTitle()          — returns string | null (conversation title if available)
     inputs              — ordered list of CSS selectors for the compose box (most specific first)
     supportsDeepCapture — boolean (default true)
*/
(() => {
  "use strict";

  if (window.__chatCapsule && window.__chatCapsule._loaded) return; // idempotent re-injection

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Tags to skip entirely during DOM traversal
  const SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "BUTTON", "SVG", "TEMPLATE", "IFRAME", "CANVAS",
    "AUDIO", "VIDEO", "INPUT", "SELECT", "TEXTAREA", "OBJECT",
  ]);

  // ---------------------------------------------------------------
  //  Safe URL absolutification — rejects javascript: and data: URLs
  // ---------------------------------------------------------------
  function safeAbs(href) {
    if (!href) return "";
    const trimmed = href.trim();
    if (/^(javascript:|data:|vbscript:)/i.test(trimmed)) return "";
    try {
      const url = new URL(trimmed, location.href).href;
      if (!/^https?:/i.test(url)) return "";
      return url;
    } catch (e) { return ""; }
  }

  // ---------------------------------------------------------------
  //  Rich text → Markdown
  //  Keeps code blocks, tables, links, lists, headings, blockquotes.
  //  Attachment references are returned separately in meta.attachments.
  // ---------------------------------------------------------------
  function toMarkdown(root) {
    const meta = {
      code: 0, tables: 0, images: 0, links: [],
      attachments: [], // { name, type, status, src }
    };
    const blocks = []; // code blocks parked so whitespace cleanup can't touch them

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
      if (node.getAttribute("aria-hidden") === "true") return "";

      // KaTeX math
      if (node.classList && node.classList.contains("katex")) {
        const ann = node.querySelector('annotation[encoding="application/x-tex"]');
        if (ann) {
          const tex = ann.textContent.trim();
          return node.closest(".katex-display") ? "\n\n$$" + tex + "$$\n\n" : "$" + tex + "$";
        }
      }

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
          // Reject javascript: URLs (XSS defense)
          if (!href || /^(javascript:|#|vbscript:)/i.test(href.trim())) return text;
          const url = safeAbs(href);
          if (!url) return text;
          if (meta.links.length < 300 && !meta.links.includes(url)) meta.links.push(url);
          return !text || text === url ? url : "[" + text + "](" + url + ")";
        }
        case "IMG": {
          const alt = (node.getAttribute("alt") || "image").trim().slice(0, 200);
          const src = node.getAttribute("src") || "";
          meta.images++;
          // Detect uploaded attachments vs inline images
          const isAttachment = node.closest("[data-testid*='file']") ||
                               node.closest("[class*='attachment']") ||
                               node.closest("[class*='upload']");
          if (isAttachment) {
            const name = alt || "image";
            const url = safeAbs(src);
            const status = url && !/^(blob:|data:)/i.test(src) ? "referenced" : "unavailable";
            meta.attachments.push({ name, type: "image", status, src: url || null });
            return "[attachment: " + name + "]";
          }
          if (!src || /^(data:|blob:)/i.test(src)) return "[image: " + alt + "]";
          return "![" + alt + "](" + safeAbs(src) + ")";
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

  // ---------------------------------------------------------------
  //  Attachment detection (explicit file upload UI elements)
  // ---------------------------------------------------------------
  function detectAttachments(rootEl) {
    const attachments = [];
    const seen = new Set();
    // Common attachment UI selectors across platforms
    const ATTACH_SELECTORS = [
      "[data-testid*='file']", "[class*='attachment']", "[class*='upload']",
      "[class*='file-preview']", "[class*='artifact']", "figure[class*='file']",
      "div[class*='file-card']", "[data-filetype]",
    ];
    for (const sel of ATTACH_SELECTORS) {
      for (const el of rootEl.querySelectorAll(sel)) {
        // Extract name from aria-label, title, or filename span
        const name = (
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.querySelector("[class*='filename'], [class*='file-name'], span")?.textContent ||
          "unknown"
        ).trim().slice(0, 200);
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const ext = name.split(".").pop().toLowerCase();
        const type = /^(png|jpg|jpeg|gif|webp|svg)$/.test(ext) ? "image"
          : /^(pdf)$/.test(ext) ? "pdf"
          : /^(doc|docx)$/.test(ext) ? "document"
          : /^(xls|xlsx|csv)$/.test(ext) ? "spreadsheet"
          : "file";
        attachments.push({ name, type, status: "detected" });
      }
    }
    return attachments;
  }

  // ---------------------------------------------------------------
  //  Role inference
  // ---------------------------------------------------------------
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

  // Parent/child deduplication — drop wrappers holding multiple messages
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
    // Fill gaps: if we can't infer a role, alternate based on neighbors
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
      // Deduplication: identical consecutive messages with same role only deduplicated
      // if they are exact text matches AND at least 20 chars long.
      // We do NOT deduplicate across different roles.
      const last = out[out.length - 1];
      if (last && last.role === c.role && last.text === text && text.length >= 20) continue;
      const attachments = detectAttachments(c.el);
      out.push({ role: c.role, confidence: c.confidence, text, meta, attachments });
    }
    return { messages: out, domCount: list.length, firstEl: list.length ? list[0].el : null };
  }

  // ---------------------------------------------------------------
  //  Site adapters — centralized selectors, easy to repair
  // ---------------------------------------------------------------
  const q = (sel) => [...document.querySelectorAll(sel)];

  const ADAPTERS = [
    {
      id: "chatgpt", name: "ChatGPT",
      match: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
      collect: () => q("[data-message-author-role]").map((el) => ({
        el, role: roleFromAttr(el.getAttribute("data-message-author-role")), confidence: 0.98,
      })).filter((c) => c.role),
      conversationId: () => (location.pathname.match(/\/c\/([\w-]+)/) || [])[1] || null,
      getTitle: () => document.title.replace(" - ChatGPT", "").trim() || null,
      inputs: [
        "#prompt-textarea",
        "div[data-id='prompt-textarea']",
        "div.ProseMirror[contenteditable='true']",
        "textarea[data-testid='chat-input']",
        "textarea",
      ],
      supportsDeepCapture: true,
    },
    {
      id: "claude", name: "Claude",
      match: /(^|\.)claude\.ai$/,
      collect: () => q([
        '[data-testid="user-message"]',
        '[data-testid="assistant-message"]',
        '.font-claude-response',
        '.font-claude-message',
        '[class*="human-turn"]',
        '[class*="ai-turn"]',
      ].join(", ")).map((el) => {
        const isUser = el.matches('[data-testid="user-message"]') ||
                       /human-turn|user-turn/i.test(el.className);
        return {
          el, role: isUser ? "User" : "Assistant",
          confidence: el.hasAttribute("data-testid") ? 0.95 : 0.8,
        };
      }),
      conversationId: () => (location.pathname.match(/\/chat\/([\w-]+)/) || [])[1] || null,
      getTitle: () => document.title.replace(" - Claude", "").trim() || null,
      inputs: [
        "div.ProseMirror[contenteditable='true']",
        "[data-testid='chat-input']",
        "div[contenteditable='true'][aria-label]",
        "div[contenteditable='true']",
      ],
      supportsDeepCapture: true,
    },
    {
      id: "gemini", name: "Gemini",
      match: /(^|\.)gemini\.google\.com$/,
      collect: () => q("user-query, model-response").map((el) => {
        const isUser = el.tagName.toLowerCase() === "user-query";
        const inner = isUser
          ? el.querySelector(".query-text, [class*='query-content']") || el
          : el.querySelector("message-content, [class*='response-content'], .markdown") || el;
        return { el: inner, role: isUser ? "User" : "Assistant", confidence: 0.95 };
      }),
      conversationId: () => (location.pathname.match(/\/app\/([\w-]+)/) || [])[1] || null,
      getTitle: () => document.title.replace(" - Gemini", "").trim() || null,
      inputs: [
        "rich-textarea .ql-editor",
        "div.ql-editor[contenteditable='true']",
        "[data-testid='chat-input']",
        "div[contenteditable='true']",
      ],
      supportsDeepCapture: true,
    },
    {
      id: "copilot", name: "Copilot",
      match: /(^|\.)copilot\.microsoft\.com$/,
      collect: () => q([
        '[data-testid="user-message"]',
        '[data-testid="bot-message"]',
        '[class*="user-message"]',
        '[class*="bot-message"]',
        '[class*="HumanMessage"]',
        '[class*="BotMessage"]',
      ].join(", ")).map((el) => {
        const isUser = el.matches('[data-testid="user-message"]') ||
                       /user-message|HumanMessage/i.test(el.className);
        return { el, role: isUser ? "User" : "Assistant", confidence: 0.85 };
      }),
      conversationId: () => null,
      getTitle: () => document.title.replace(" - Copilot", "").trim() || null,
      inputs: [
        "textarea[placeholder]",
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true']",
      ],
      supportsDeepCapture: false,
    },
    {
      id: "perplexity", name: "Perplexity",
      match: /(^|\.)perplexity\.ai$/,
      collect: () => q([
        '[data-testid="user-message-text"]',
        '[class*="UserMessage"]',
        '.prose',
        '[class*="answer"]',
        '[class*="Answer"]',
        '[class*="AiMessage"]',
      ].join(", ")).map((el) => {
        const isUser = el.matches('[data-testid="user-message-text"]') ||
                       /UserMessage/i.test(el.className);
        return { el, role: isUser ? "User" : "Assistant", confidence: isUser ? 0.9 : 0.75 };
      }),
      conversationId: () => (location.pathname.match(/\/search\/([\w-]+)/) || [])[1] || null,
      getTitle: () => document.title.replace(" | Perplexity", "").trim() || null,
      inputs: ["textarea[placeholder]", "div[contenteditable='true']"],
      supportsDeepCapture: false,
    },
    {
      id: "grok", name: "Grok",
      // Fixed: was double-escaped \\. in character class
      match: /(^|\.)grok\.com$|(^|\.)x\.com$/,
      collect: () => q([
        '[data-testid="user-query"]',
        '[data-testid="response"]',
        '[class*="message-bubble"]',
        '[class*="user-message"]',
        '[class*="UserMessage"]',
        '[class*="assistant-message"]',
        '[class*="GrokMessage"]',
      ].join(", ")).map((el) => {
        const isUser = el.matches('[data-testid="user-query"]') ||
                       /user[-_]?message|UserMessage/i.test(el.className);
        return { el, role: isUser ? "User" : "Assistant", confidence: el.hasAttribute("data-testid") ? 0.9 : 0.75 };
      }),
      // Fixed: was double-escaped \\w in regex
      conversationId: () => (location.pathname.match(/\/conversation\/([\w-]+)/) || [])[1] || null,
      getTitle: () => document.title.replace(" on X", "").replace(" | Grok", "").trim() || null,
      inputs: [
        "textarea[placeholder]",
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true']",
      ],
      supportsDeepCapture: false,
    },
    {
      id: "deepseek", name: "DeepSeek",
      match: /(^|\.)chat\.deepseek\.com$/,
      collect: () => q([
        '[class*="human_question"]',
        '[class*="ds-message-container"]',
        '[class*="user-content"]',
        '[class*="assistant-message"]',
        '[class*="UserMessage"]',
        '[class*="AssistantMessage"]',
      ].join(", ")).map((el) => {
        const isUser = /human[_-]?question|user[_-]?content|UserMessage/i.test(el.className) ||
                       /^user$/i.test(el.getAttribute("data-role") || "");
        return { el, role: isUser ? "User" : "Assistant", confidence: 0.8 };
      }),
      // Fixed: was double-escaped \\w in regex
      conversationId: () => (location.pathname.match(/\/chat\/([\w-]+)/) || [])[1] || null,
      getTitle: () => document.title.replace(" - DeepSeek", "").trim() || null,
      inputs: [
        "#chat-input",
        "textarea#chat-input",
        "textarea[placeholder]",
        "div[contenteditable='true']",
      ],
      supportsDeepCapture: false,
    },
  ];

  const GENERIC = {
    id: "generic", name: null,
    match: null,
    collect: () => q([
      "[data-message-author-role]", "[data-role]", "[data-author]", "[data-sender]",
      '[data-testid*="user-message"]', '[data-testid*="assistant-message"]', '[data-testid*="bot-message"]',
      '[class*="user-message"]', '[class*="assistant-message"]', '[class*="bot-message"]',
      '[class*="human-message"]', '[class*="ai-message"]', '[class*="chat-message"]',
    ].join(", ")).map((el) => ({ el, role: null, confidence: 0 })),
    conversationId: () => null,
    getTitle: () => document.title || null,
    inputs: [
      "#prompt-textarea", "div.ProseMirror[contenteditable='true']", "rich-textarea .ql-editor",
      "div[contenteditable='true'][role='textbox']", "div[contenteditable='true']", "textarea",
    ],
    supportsDeepCapture: false,
  };

  const snapshot = (adapter) => finalize(adapter.collect());

  // ---------------------------------------------------------------
  //  Quality scoring
  // ---------------------------------------------------------------
  function computeQuality(info) {
    // info: { messages, coverage, adapter, warnings }
    let score = 100;
    const msgs = info.messages || [];
    const cov = info.coverage || {};

    // Completeness
    if (cov.complete === false) score -= 30;
    else if (cov.complete === null) score -= 10; // unknown

    // Gap penalty
    const gaps = cov.gaps || 0;
    score -= Math.min(gaps * 10, 30);

    // Role confidence
    const guessed = msgs.filter((m) => m.confidence < 0.6).length;
    if (msgs.length > 0) score -= Math.floor((guessed / msgs.length) * 20);

    // Message count: fewer than 2 messages is suspicious
    if (msgs.length < 2) score -= 15;

    // Platform detection confidence
    if (info.genericAdapter) score -= 15;

    // Deep capture bonus
    if (cov.deep && cov.reachedTop) score += 5;

    // Attachment detection
    const attachmentCount = msgs.reduce((n, m) => n + (m.attachments || []).length, 0);
    if (attachmentCount > 0) score -= 5; // unavailable attachments reduce quality

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ---------------------------------------------------------------
  //  Scrolling / deep capture with cancellation and progress
  // ---------------------------------------------------------------
  function findScroller(el) {
    for (let p = el && el.parentElement; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Stable fingerprint for a message — role + text length + first 200 chars
  // Using 200 chars (up from 160) to reduce false-positive deduplication
  const fp = (m) => m.role + "|" + m.text.length + "|" + m.text.slice(0, 200);

  // Stitch overlapping snapshots (top → bottom) into one chronological list.
  // Gap is reported when no overlap is found between consecutive snapshots.
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

  // Deep capture with:
  //   - AbortController cancellation support
  //   - progress callback
  //   - max-iteration guard (safety limit: 400 steps = ~72 seconds)
  //   - minimum scroll step to avoid infinite loops
  //   - scroll restoration
  async function deepCapture(adapter, firstEl, opts) {
    opts = opts || {};
    const signal = opts.signal || null;
    const onProgress = opts.onProgress || (() => {});
    const MAX_SCROLL_STEPS = 400;
    const SCROLL_SLEEP = 200; // ms per step
    const SETTLE_SLEEP = 350;
    const STABLE_REQUIRED = 3;

    const scroller = findScroller(firstEl);
    const original = scroller.scrollTop;

    const checkAbort = () => {
      if (signal && signal.aborted) throw new Error("deep-capture-cancelled");
    };

    // Phase 1: Scroll to top and wait for all content to load
    let prevH = -1, still = 0;
    for (let i = 0; i < 60 && still < STABLE_REQUIRED; i++) {
      checkAbort();
      scroller.scrollTop = 0;
      await sleep(300);
      const h = scroller.scrollHeight;
      still = h === prevH ? still + 1 : 0;
      prevH = h;
      onProgress({ phase: "scrolling-top", step: i, total: 60 });
    }
    const reachedTop = scroller.scrollTop <= 2;

    // Phase 2: Capture at top
    checkAbort();
    const top = snapshot(adapter).messages;
    onProgress({ phase: "captured-top", count: top.length });

    // Phase 3: Capture at bottom
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(SETTLE_SLEEP);
    checkAbort();
    const bottom = snapshot(adapter).messages;

    let result;
    if (top.length && bottom.some((m) => fp(m) === fp(top[0]))) {
      // All content visible without virtualization
      result = { messages: bottom, gaps: 0, virtualized: false };
      onProgress({ phase: "complete-no-virtualization", count: bottom.length });
    } else {
      // Virtualized: scroll step by step collecting snapshots
      const snaps = [top];
      const step = Math.max(200, Math.floor(scroller.clientHeight * 0.6));
      let pos = 0;
      let lastH = scroller.scrollHeight;

      for (let guard = 0; guard < MAX_SCROLL_STEPS; guard++) {
        checkAbort();
        pos += step;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (max <= 0) break;
        scroller.scrollTop = Math.min(pos, max);
        await sleep(SCROLL_SLEEP);

        // Check if page loaded more content (lazy loading)
        const newH = scroller.scrollHeight;
        if (newH > lastH + 50) {
          // Page expanded — give it more time to settle
          await sleep(SETTLE_SLEEP);
          lastH = scroller.scrollHeight;
        }

        const snap = snapshot(adapter).messages;
        snaps.push(snap);
        onProgress({ phase: "scrolling", step: guard, total: MAX_SCROLL_STEPS, count: snap.length });

        if (pos >= max) break;
      }

      const merged = mergeSnapshots(snaps);
      result = { messages: merged.messages, gaps: merged.gaps, virtualized: true };
      onProgress({ phase: "merged", count: merged.messages.length, gaps: merged.gaps });
    }

    // Restore original scroll position
    scroller.scrollTop = original;
    return { ...result, reachedTop };
  }

  // ---------------------------------------------------------------
  //  Attachment manifest builder
  // ---------------------------------------------------------------
  function buildAttachmentManifest(messages) {
    const manifest = [];
    const seen = new Set();
    for (const m of messages) {
      for (const a of m.attachments || []) {
        const key = (a.name || "").toLowerCase() + "|" + (a.type || "");
        if (seen.has(key)) continue;
        seen.add(key);
        manifest.push({ ...a });
      }
    }
    return manifest;
  }

  // ---------------------------------------------------------------
  //  Duplicate removal after final merge (cross-message dedup)
  //  Unlike finalize()'s intra-adapter dedup, this operates on the
  //  fully-merged message list. Uses stable fingerprints.
  //  Does NOT remove identical messages from different roles.
  // ---------------------------------------------------------------
  function deduplicateMessages(messages) {
    const seen = new Set();
    const out = [];
    let removed = 0;
    for (const m of messages) {
      const key = fp(m);
      if (seen.has(key)) {
        removed++;
        continue;
      }
      seen.add(key);
      out.push(m);
    }
    return { messages: out, duplicatesRemoved: removed };
  }

  // ---------------------------------------------------------------
  //  Ordering verification
  // ---------------------------------------------------------------
  function verifyOrdering(messages) {
    // Check: User and Assistant should alternate (roughly).
    // A strict alternation check is too aggressive (multi-turn tool use),
    // so we check for consecutive same-role sequences longer than 3.
    let longestSame = 0, cur = 0, lastRole = null;
    for (const m of messages) {
      if (m.role === lastRole) cur++;
      else { longestSame = Math.max(longestSame, cur); cur = 1; lastRole = m.role; }
    }
    longestSame = Math.max(longestSame, cur);
    const suspiciousOrdering = longestSame > 4;
    return { suspiciousOrdering, longestSameRole: longestSame };
  }

  // ---------------------------------------------------------------
  //  capture()
  // ---------------------------------------------------------------
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
      // No chat found — capture page text or selection
      const sel = String(window.getSelection() || "").trim();
      const base = { site: host, siteId: "page", url: location.href, title: document.title, conversationId: null };
      if (sel) {
        result = { ...base, method: "selection", messages: [{ role: "Notes", text: sel, confidence: 1, attachments: [] }] };
      } else {
        const main = document.querySelector("main, article") || document.body;
        const { text, meta } = toMarkdown(main);
        result = { ...base, method: "page", messages: [{ role: "Page", text: text.slice(0, 60000), confidence: 1, attachments: [] }] };
        warnings.push("No chat was recognised on this page, so the visible page text was captured instead.");
      }
      result.coverage = { captured: 1, domCount: 0, atTop: null, deep: false, virtualized: false, gaps: 0, duplicatesRemoved: 0, complete: null };
      result.attachmentManifest = [];
    } else {
      const genericAdapter = adapter === GENERIC;
      if (genericAdapter && specific) {
        warnings.push("The " + specific.name + " reader found nothing (the site may have changed), so a generic reader was used. Check the result carefully.");
      } else if (genericAdapter) {
        warnings.push("This site isn't specifically supported. A generic reader was used, so check the result carefully.");
      }

      let messages = snap.messages;
      let method = "dom";
      let info = { reachedTop: false, virtualized: false, gaps: 0 };
      const scroller = findScroller(snap.firstEl || document.body);
      const scrollable = scroller.scrollHeight > scroller.clientHeight + 4;
      let duplicatesRemoved = 0;

      if (opts.deep && adapter.supportsDeepCapture !== false) {
        try {
          const d = await deepCapture(adapter, snap.firstEl || document.body, {
            signal: api._cancelController ? api._cancelController.signal : null,
            onProgress: opts.onProgress || null,
          });
          // Deduplicate the merged result
          const dedup = deduplicateMessages(d.messages);
          messages = dedup.messages;
          duplicatesRemoved = dedup.duplicatesRemoved;
          method = "dom-deep";
          info = { reachedTop: d.reachedTop, virtualized: d.virtualized, gaps: d.gaps };
          if (!d.reachedTop) warnings.push("Couldn't scroll all the way to the start of the chat. Capture may be incomplete — try scrolling to the top manually first.");
          if (d.gaps) warnings.push(d.gaps + " possible gap(s) between scrolled sections. Some messages may be missing.");
        } catch (e) {
          if (e.message === "deep-capture-cancelled") {
            warnings.push("Deep capture was cancelled. Only partially captured messages are included.");
            method = "dom-partial";
          } else {
            warnings.push("Deep capture failed (" + (e.message || "unknown error") + "). Standard capture used.");
          }
        }
      } else if (opts.deep && adapter.supportsDeepCapture === false) {
        warnings.push(adapter.name + " does not support deep capture — the DOM is fully rendered. Standard capture used.");
      }

      let complete = null;
      if (opts.deep && adapter.supportsDeepCapture !== false) complete = info.reachedTop && info.gaps === 0;
      else if (!scrollable) complete = true;
      else warnings.push("Captured what the page has loaded. In very long chats, older messages may not be loaded yet. Use Deep Capture to check.");

      // Verify ordering
      const ordering = verifyOrdering(messages);
      if (ordering.suspiciousOrdering) {
        warnings.push("Message ordering looks unusual (" + ordering.longestSameRole + " consecutive same-role messages). Check captured content carefully.");
      }

      if (messages.length && messages[0].role !== "User" && !genericAdapter) {
        warnings.push("The first captured message isn't from you, so the start of the conversation may be missing.");
        complete = false;
      }
      const guessed = messages.filter((m) => m.confidence < 0.6).length;
      if (guessed) warnings.push(guessed + " message role(s) were guessed (who said it). Check them carefully.");

      // Build attachment manifest
      const attachmentManifest = buildAttachmentManifest(messages);
      if (attachmentManifest.length) {
        warnings.push(
          attachmentManifest.length + " attachment(s) detected. " +
          attachmentManifest.filter((a) => a.status === "unavailable").length +
          " unavailable (file content cannot be transferred)."
        );
      }

      result = {
        site: adapter.name || host,
        siteId: adapter.id,
        url: location.href,
        title: adapter.getTitle ? adapter.getTitle() : document.title,
        conversationId: adapter.conversationId(),
        method,
        messages,
        attachmentManifest,
        coverage: {
          captured: messages.length,
          domCount: snap.domCount,
          atTop: scroller.scrollTop <= 2,
          deep: !!opts.deep,
          virtualized: info.virtualized,
          gaps: info.gaps,
          duplicatesRemoved,
          reachedTop: info.reachedTop,
          complete,
        },
      };
    }

    // Aggregate stats
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
      // Remove meta from message (keep attachments)
      delete m.meta;
    }
    stats.links = links.length;
    result.stats = stats;
    result.links = links;
    result.warnings = warnings;
    result.at = Date.now();

    // Compute quality score
    const genericAdapter = adapter === GENERIC;
    result.quality = computeQuality({
      messages: result.messages,
      coverage: result.coverage,
      adapter,
      genericAdapter,
      warnings,
    });

    api._last = result;
    return result;
  }

  // ---------------------------------------------------------------
  //  insert() — editor-aware with clipboard fallback
  // ---------------------------------------------------------------
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
    if (!target) {
      // No input found — try clipboard as fallback
      const cb = await insertViaClipboard(text);
      return { ...cb, fallback: "clipboard" };
    }
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

    // Textarea / input: use native value setter
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

    // contenteditable: try multiple strategies in order
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

    // All insertion methods failed — fall back to clipboard
    const cb = await insertViaClipboard(text);
    return { ...cb, fallback: "clipboard" };
  }

  // Clipboard fallback: write text to clipboard and inform user
  async function insertViaClipboard(text) {
    try {
      if (typeof navigator.clipboard !== "undefined" && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return { ok: false, clipboardFilled: true, error: "The editor didn't accept automatic insertion. The capsule text has been copied to your clipboard — paste it manually (Ctrl+V / Cmd+V)." };
      }
    } catch (e) { /* fall through */ }
    return { ok: false, clipboardFilled: false, error: "The editor on this page didn't accept automatic insertion and clipboard access was not available. Copy the capsule text manually." };
  }

  // ---------------------------------------------------------------
  //  Cancellation support
  // ---------------------------------------------------------------
  function cancelCapture() {
    if (api._cancelController) {
      api._cancelController.abort();
      api._cancelController = null;
    }
  }

  function startCapture(opts) {
    // Cancel any in-progress capture
    cancelCapture();
    if (typeof AbortController !== "undefined") {
      api._cancelController = new AbortController();
    }
    return capture(opts);
  }

  // ---------------------------------------------------------------
  //  Public API
  // ---------------------------------------------------------------
  const api = {
    _loaded: true,
    _last: null,
    _cancelController: null,
    capture: startCapture,
    insert,
    cancelCapture,
    last: () => (api._last && Date.now() - api._last.at < 15 * 60 * 1000 ? api._last : null),
    _test: { mergeSnapshots, toMarkdown, pruneNested, inferRole, computeQuality, deduplicateMessages, verifyOrdering },
  };
  window.__chatCapsule = api;
})();
