/* Chat Capsule v5.0.0 — page-side capture engine.
   Injected on demand via chrome.scripting.executeScript (activeTab + scripting).
   Exposes window.__chatCapsule = { capture, insert, last, cancelCapture }.
   Must never send anything anywhere; it only reads the page (its DOM, or the shared page's own data from the same site) and returns it.

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

  function finalize(cands, scroller, adapter) {
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
      // Keep repeated turns: identical consecutive messages can still be distinct messages.
      const attachments = detectAttachments(c.el);
      let h = 0; try { h = Math.round(c.el.getBoundingClientRect().height); } catch (e) { /* ignore */ }
      let seq; try { seq = adapter && adapter.seq ? adapter.seq(c.el) : undefined; } catch (e) { seq = undefined; }
      out.push({ role: c.role, confidence: c.confidence, text, meta, attachments, y: absY(c.el, scroller), h, seq });
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
      collect: () => {
        const roleSelector = "[data-message-author-role]";
        const direct = q(roleSelector).map((el) => ({
          el, role: roleFromAttr(el.getAttribute("data-message-author-role")), confidence: 0.98,
        })).filter((c) => c.role);
        // ChatGPT shared pages currently render messages with DilResponseRoot and
        // text-size-chat classes instead of data-message-author-role attributes.
        if (location.pathname.startsWith("/share/")) {
          // Prefer the innermost markdown content. DilResponseRoot is a wrapper
          // around that content on some builds, so collecting both counts one
          // assistant reply twice and makes consecutive scans disagree.
          const assistantSelector = q('[data-markdown-text-style]').length
            ? '[data-markdown-text-style]'
            : q('[class*="MarkdownRoot"]').length
              ? '[class*="MarkdownRoot"]'
              : '[class*="DilResponseRoot"]';
          const userSelector = '.text-size-chat.whitespace-pre-wrap';
          const shared = q(assistantSelector + ", " + userSelector).filter((el) => {
            const style = getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden" &&
              !el.closest("[hidden]") && (el.innerText || el.textContent || "").trim().length > 0;
          });
          if (shared.length) return shared.map((el) => ({
            el,
            role: el.matches(assistantSelector) ? "Assistant" : "User",
            confidence: 0.82,
          }));
        }
        const turns = q('[data-testid^="conversation-turn-"]');
        if (!turns.length) return direct;

        const rows = turns.map((turn) => {
          const roleEl = turn.matches(roleSelector) ? turn : turn.querySelector(roleSelector);
          const role = roleEl && roleFromAttr(roleEl.getAttribute("data-message-author-role"));
          const guessed = role ? null : inferRole(turn);
          return { el: roleEl || turn, role: role || (guessed && guessed.role) || null, confidence: role ? 0.98 : guessed ? guessed.confidence : 0 };
        });
        // Some shared-chat layouts keep the turn container but omit the role attribute. Infer only
        // missing labels from the neighboring turn order; keep explicit roles authoritative.
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].role) continue;
          let anchor = -1;
          for (let j = i - 1; j >= 0; j--) if (rows[j].role) { anchor = j; break; }
          if (anchor >= 0) {
            rows[i].role = (i - anchor) % 2 ? (rows[anchor].role === "User" ? "Assistant" : "User") : rows[anchor].role;
          } else {
            for (let j = i + 1; j < rows.length; j++) if (rows[j].role) { anchor = j; break; }
            rows[i].role = anchor >= 0
              ? ((anchor - i) % 2 ? (rows[anchor].role === "User" ? "Assistant" : "User") : rows[anchor].role)
              : (i % 2 ? "Assistant" : "User");
          }
          rows[i].confidence = 0.35;
        }
        return rows;
      },
      orderStitch: () => /^\/share\//.test(location.pathname),
      seq: (el) => { const t = el.closest('[data-testid^="conversation-turn-"]'); const n = t && /conversation-turn-(\d+)/.exec(t.getAttribute('data-testid')); return n ? +n[1] : undefined; },
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
      supportsDeepCapture: true,
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
      supportsDeepCapture: true,
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
      supportsDeepCapture: true,
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
      supportsDeepCapture: true,
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
    supportsDeepCapture: true,
  };

  // Vertical position of an element inside its scroller's content. Stays the same however far we've scrolled.
  function absY(el, sc) {
    try {
      const r = el.getBoundingClientRect();
      if (!sc || sc === document.scrollingElement || sc === document.documentElement || sc === document.body) return r.top + (window.scrollY || 0);
      return r.top - sc.getBoundingClientRect().top + sc.scrollTop;
    } catch (e) { return 0; }
  }
  const snapshot = (adapter, scroller) => finalize(adapter.collect(), scroller, adapter);

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

  // Stable fingerprint for a message (shared with the verifier so both sides agree)
  const V = (typeof self !== "undefined" && self.CapsaVerify) || null;
  const fp = V ? V.fingerprint : (m) => {
    const text = String(m.text || ""); let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ (c + i), 0x85ebca6b); }
    return m.role + "|" + text.length + "|" + (a >>> 0).toString(36) + "." + (b >>> 0).toString(36);
  };

  // ---------------------------------------------------------------
  //  Reading the WHOLE chat, however long — and proving we did.
  //
  //  Chats are long in different ways, and a reader has to survive all of them:
  //   • older history loads lazily when you reach the top (slowly, in chunks)
  //   • only a window of messages is in the DOM (virtualized) and the rest appears as you scroll
  //   • many messages are identical ("continue", "yes")
  //   • the page is slow, or the tab is hidden and doesn't render at all
  //
  //  So nothing here is a fixed count or a fixed delay. Waits end when the page goes quiet
  //  (a MutationObserver), patience grows with how slow the page has proven to be, and the
  //  result is only trusted after TWO independent passes (different direction + step size)
  //  agree message-for-message and the structural checks in lib/verify.js pass.
  // ---------------------------------------------------------------
  const BUSY_SEL = '[aria-busy="true"],[role="progressbar"],[class*="spinner" i],[class*="loading" i],[data-testid*="loading" i],[data-testid*="spinner" i]';
  const MORE_RE = /^\s*(show|load|view|see|get)\s+(more|earlier|older|previous|all)\b/i;
  const HARD_MAX = 25 * 60 * 1000; // safety net only — progress, not the clock, ends a normal read

  function busyIndicator(scroller) {
    try {
      const sr = scroller === document.scrollingElement || scroller === document.documentElement
        ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
      for (const e of document.querySelectorAll(BUSY_SEL)) {
        if (e.closest("capsa-orb, #capsa-reading")) continue;
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (getComputedStyle(e).visibility === "hidden") continue;
        if (r.bottom < sr.top - 40 || r.top > sr.top + (sr.bottom - sr.top) * 0.5) continue; // only near the top of the chat
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // Only a "load earlier messages" control that belongs to the CHAT counts. "Show more" / "View all" in the
  // sidebar, header or footer (chat lists, menus) say nothing about missing messages.
  function loadMoreVisible(scroller) {
    try {
      const own = scroller && scroller !== document.scrollingElement && scroller !== document.documentElement && scroller !== document.body;
      const sr = own ? scroller.getBoundingClientRect() : null;
      for (const e of document.querySelectorAll("button,a,[role=button]")) {
        const t = (e.getAttribute("aria-label") || e.textContent || "").trim();
        if (t.length > 40 || !MORE_RE.test(t)) continue;
        if (e.closest('nav,aside,header,footer,[role="navigation"],[role="banner"],[role="complementary"],[role="menu"],[role="dialog"],capsa-orb,#capsa-reading')) continue;
        const r = e.getBoundingClientRect();
        if (sr && (r.right < sr.left || r.left > sr.right || r.bottom < sr.top - 80 || r.top > sr.bottom)) continue;
        if (r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden") return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // Wait until the subtree stops changing (adaptive), never a blind sleep.
  function settle(el, o) {
    const min = o.min, quiet = o.quiet, max = o.max;
    return new Promise((resolve) => {
      const t0 = Date.now();
      let last = t0;
      let mo = null;
      try {
        mo = new MutationObserver(() => { last = Date.now(); });
        mo.observe(el === document.scrollingElement || el === document.documentElement ? document.body : el, { childList: true, subtree: true, characterData: true });
      } catch (e) { mo = null; }
      const tick = () => {
        const now = Date.now();
        if (now - t0 >= max || (now - t0 >= min && now - last >= quiet)) { if (mo) mo.disconnect(); resolve(now - t0 >= max); return; }
        setTimeout(tick, 25);
      };
      setTimeout(tick, min);
    });
  }

  const nodeSig = (adapter, scroller) => {
    const c = adapter.collect();
    const first = c[0] && c[0].el ? (c[0].el.textContent || "").slice(0, 120) : "";
    return c.length + "|" + scroller.scrollHeight + "|" + first;
  };

  function makeCtl(opts) {
    const signal = opts.signal || null;
    const t0 = Date.now();
    const ctl = {
      t0, quiet: 150, patience: 1, latency: 0, timedOut: false,
      check() {
        if (signal && signal.aborted) throw new Error("deep-capture-cancelled");
        if (Date.now() - t0 > HARD_MAX) { ctl.timedOut = true; throw new Error("deep-capture-timeout"); }
      },
      prog(o) { o.round = ctl.round || 0; opts.prog(o); },
      async settleScroll(el) {
        const hitMax = await settle(el, { min: 110, quiet: ctl.quiet, max: 2500 });
        if (hitMax) ctl.quiet = Math.min(900, Math.round(ctl.quiet * 1.5)); // slow page: be more patient from now on
      },
    };
    return ctl;
  }

  // Bring in all older history. Ends when the chat has been quiet for longer than the slowest load seen so far.
  async function loadHistory(adapter, scroller, ctl) {
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 4;
    if (!scrollable) return { reachedTop: true, settled: true, changes: 0, loadMore: loadMoreVisible(scroller) };
    const t0 = Date.now();
    let lastSig = "", lastChange = t0, maxGap = ctl.latency, changes = 0, busyFor = 0, settled = false;
    const base = (ctl.historyDone ? 1400 : 3000) * ctl.patience;   // history already loaded in an earlier round: don't wait as long
    for (;;) {
      ctl.check();
      scroller.scrollTop = 1; await sleep(60); scroller.scrollTop = 0; // a small wiggle re-fires "reached the top" handlers
      await settle(scroller, { min: 200, quiet: ctl.quiet, max: 1200 });
      const sig = nodeSig(adapter, scroller), now = Date.now();
      if (sig !== lastSig) {
        if (lastSig) { maxGap = Math.max(maxGap, now - lastChange); changes++; }
        lastSig = sig; lastChange = now;
      }
      ctl.prog({ phase: "loading-history", found: adapter.collect().length });
      const quietFor = now - lastChange, need = Math.max(base, 2.5 * maxGap);
      if (quietFor > need) {
        if (busyIndicator(scroller) && busyFor < 90000) { busyFor += 400; continue; } // a spinner is still showing: keep waiting (bounded)
        settled = true; break;
      }
    }
    ctl.latency = Math.max(ctl.latency, maxGap);
    ctl.historyDone = settled && scroller.scrollTop <= 2;
    return { reachedTop: scroller.scrollTop <= 2, settled, changes, loadMore: loadMoreVisible(scroller) };
  }

  // Same message? Same text and about the same place on the page.
  function sameMsg(k, m, tolNear, tolFar, uniqueFp, mayDrift) {
    if (k.fp !== fp(m)) return false;
    const dy = Math.abs(k.y - m.y);
    if (dy <= tolNear) return true;
    // Unique text may have drifted as a list re-measures itself — but only at or after the place we have already
    // reached in this window. A look-alike far above (the same "continue" sent twice) is a different message.
    return !!(uniqueFp && mayDrift && dy <= tolFar);
  }

  // Stitch overlapping windows (given top-to-bottom) into one ordered list. Overlap is judged by text AND position.
  function stitch(windows, vh) {
    const known = [];
    const counts = () => { const c = new Map(); for (const k of known) c.set(k.fp, (c.get(k.fp) || 0) + 1); return c; };
    const find = (m, cnt, from) => known.findIndex((k, idx) => sameMsg(k, m, Math.max(60, vh * 0.25), vh * 3, (cnt.get(fp(m)) || 0) === 1, idx >= from));
    for (const snap of windows) {
      const cnt = counts();
      let cursor = 0;
      for (const m of snap) {
        const i = find(m, cnt, cursor);
        if (i >= 0) {
          cursor = i + 1;
          if (m.text.length > known[i].m.text.length) known[i].m = m; // keep the fuller render
          known[i].y = m.y; known[i].h = m.h;
        } else {
          known.splice(cursor, 0, { fp: fp(m), y: m.y, h: m.h, seq: m.seq, m });
          cursor++;
          cnt.set(fp(m), (cnt.get(fp(m)) || 0) + 1);
        }
      }
    }
    return known;
  }

  // Virtualized lists (ChatGPT shared pages) re-measure rows as they scroll, so vertical positions drift and can't
  // be trusted to line two looks at the page up. The order of the messages can: each new look continues the
  // previous one, so line them up by the run of messages they have in common.
  function stitchByOrder(windows) {
    const known = [];
    for (const snap of windows) {
      const W = snap.map((m) => ({ fp: fp(m), y: m.y, h: m.h, seq: m.seq, m }));
      if (!W.length) continue;
      if (!known.length) { known.push(...W); continue; }
      let placed = false;
      const from = Math.max(0, known.length - 60);
      for (let p = from; p <= known.length && !placed; p++) {
        const t = known.length - p;
        const n = Math.min(t, W.length);
        let ok = n > 0;
        for (let i = 0; ok && i < n; i++) if (known[p + i].fp !== W[i].fp) ok = false;
        if (!ok) continue;
        for (let i = 0; i < n; i++) { if (W[i].m.text.length > known[p + i].m.text.length) known[p + i].m = W[i].m; known[p + i].y = W[i].y; }
        if (W.length > t) known.push(...W.slice(t));
        placed = true;
      }
      if (!placed) known.push(...W);   // no common run: keep them (the jump check will flag the break)
    }
    return known;
  }

  // How many messages two looks share as one unbroken run (same order). A single shared message that also repeats
  // elsewhere (several "continue" replies) proves nothing, so it doesn't count.
  function orderedOverlap(a, b) {
    const A = a.map(fp), B = b.map(fp);
    let best = 0;
    for (let p = 0; p < A.length; p++) {
      let k = 0;
      while (p + k < A.length && k < B.length && A[p + k] === B[k]) k++;
      if (k && p + k === A.length) best = Math.max(best, k);       // tail of the old look = head of the new one
    }
    for (let q = 0; q < B.length; q++) {
      let k = 0;
      while (q + k < B.length && k < A.length && B[q + k] === A[k]) k++;
      if (k && q + k === B.length) best = Math.max(best, k);       // new look sits inside / before the old one
    }
    if (best === 1) {
      const f = best && A.find((x) => B.includes(x));
      const dup = A.filter((x) => x === f).length + B.filter((x) => x === f).length;
      if (dup > 2) return 0;
    }
    return best;
  }

  const overlapCount = (a, b, vh) => {
    const used = new Set(); let n = 0;
    const tolerance = Math.max(120, vh * 1.1);
    for (const m of b) {
      const i = a.findIndex((x, j) => !used.has(j) && fp(x) === fp(m) && Math.abs(x.y - m.y) <= tolerance);
      if (i >= 0) { used.add(i); n++; }
    }
    return n;
  };

  // One walk over the whole chat (down or up) at the given step size.
  async function scanPass(adapter, scroller, dir, stepFactor, ctl) {
    const vh = Math.max(200, scroller.clientHeight || window.innerHeight || 600);
    const base = Math.max(120, Math.floor(vh * stepFactor));
    const maxTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const go = async (v) => { scroller.scrollTop = Math.max(0, Math.min(v, maxTop())); await ctl.settleScroll(scroller); };
    const read = () => snapshot(adapter, scroller).messages;
    let step = base, jumps = 0, stall = 0;
    const windows = [], seen = new Set();

    await go(dir === "down" ? 0 : maxTop());
    let prev = read();
    for (let i = 0; i < 4 && !prev.length; i++) { await sleep(300); await ctl.settleScroll(scroller); prev = read(); }
    if (prev.length) windows.push(prev); else jumps++;
    let pos = scroller.scrollTop, steps = 0;
    for (;;) {
      ctl.check();
      if (dir === "down" ? pos >= maxTop() - 1 : pos <= 1) break;
      await go(dir === "down" ? Math.min(pos + step, maxTop()) : Math.max(pos - step, 0));
      let snap = read();
      if (!snap.length) { await sleep(400); await ctl.settleScroll(scroller); snap = read(); }
      const now = scroller.scrollTop;
      if (Math.abs(now - pos) < 1) { if (++stall >= 3) break; continue; }
      stall = 0;
      const ov = adapter && adapter.orderStitch && adapter.orderStitch()
        ? (snap.length && prev.length ? orderedOverlap(prev, snap) : 1)
        : (snap.length && prev.length ? overlapCount(prev, snap, vh) : 1);
      if (snap.length && prev.length && ov === 0) {
        if (step > 70) { step = Math.floor(step / 2); await go(pos); continue; } // went too far: back up and take a smaller step
        jumps++;
      }
      if (!snap.length) jumps++;
      if (snap.length) { windows.push(snap); prev = snap; }
      pos = now; step = Math.min(base, step * 2); steps++;
      const max = maxTop() || 1;
      for (const m of snap) seen.add(fp(m) + "@" + Math.round(m.y / 40));
      ctl.prog({ phase: "scanning", found: seen.size, pct: Math.min(99, Math.round((dir === "down" ? pos / max : 1 - pos / max) * 100)), dir });
    }
    const reachedEnd = dir === "down" ? scroller.scrollTop >= maxTop() - 2 : scroller.scrollTop <= 2;
    const ordered = dir === "down" ? windows : windows.slice().reverse();
    const known = adapter && adapter.orderStitch && adapter.orderStitch() ? stitchByOrder(ordered) : stitch(ordered, vh);
    return { known, jumps, reachedEnd, steps };
  }

  // A hidden (or throttled) tab gets few or no animation frames, so scroll-driven loading and virtual lists
  // never update in it — and a "reached the top, nothing more loads" verdict would be a lie. Require a run of
  // real frames, each arriving promptly; one lucky frame in a throttled tab proves nothing.
  const framesRunning = async () => {
    if (document.visibilityState === "hidden") return false;
    if (document.documentElement.hasAttribute("data-capsa-test-offscreen")) return false; // test hook: lets the suite simulate an off-screen tab
    for (let i = 0; i < 5; i++) {
      const ok = await new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 400);
        requestAnimationFrame(() => { if (!done) { done = true; clearTimeout(t); resolve(true); } });
      });
      if (!ok) return false;
    }
    return true;
  };

  async function verifiedRead(adapter, firstEl, opts) {
    const ctl = makeCtl(opts);
    const scroller = findScroller(firstEl);
    if (scroller.scrollHeight > scroller.clientHeight + 4 && !(await framesRunning())) {
      const msgs = snapshot(adapter, scroller).messages;
      return { messages: msgs, virtualized: null, needsVisible: true, reachedTop: false, timedOut: false, gaps: 0, latency: 0,
        verification: { verified: false, checks: [], count: msgs.length, passes: 0, reasons: ["the page is hidden, so the site won't load or draw the rest of this long chat"] } };
    }
    const fromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop; // where the reader was
    // The browser nudges scrollTop by itself when rows above resize ("scroll anchoring"); on a virtual list that
    // makes our steps land somewhere else. Turn it off while we read, put it back afterwards.
    const anchorEls = [scroller, document.documentElement].filter((e, i, a) => e && a.indexOf(e) === i);
    const anchorOld = anchorEls.map((e) => e.style.overflowAnchor);
    anchorEls.forEach((e) => { e.style.overflowAnchor = "none"; });
    const unanchor = () => anchorEls.forEach((e, i) => { e.style.overflowAnchor = anchorOld[i]; });
    const vh = Math.max(200, scroller.clientHeight || window.innerHeight || 600);
    const read = () => snapshot(adapter, scroller).messages;
    const passes = [], keep = [];
    const FACTORS = [0.78, 0.62, 0.85, 0.7, 0.5, 0.8];
    let ev = null, hist = null, virtualized = false, lastPassEnded = true;

    try {
      for (let round = 0; round < FACTORS.length; round++) {
        ctl.round = round + 1; ctl.patience = 1 + round * 0.6;
        hist = await loadHistory(adapter, scroller, ctl);

        // Is anything virtualized? If the top window and the bottom window hold the same things, no.
        scroller.scrollTop = 0; await ctl.settleScroll(scroller);
        const top = read();
        scroller.scrollTop = scroller.scrollHeight; await ctl.settleScroll(scroller);
        const bottom = read();
        virtualized = !(top.length && bottom.length >= top.length && bottom.some((m) => fp(m) === fp(top[0]) && Math.abs(m.y - top[0].y) < 4));

        let known, jumps = 0, reachedEnd = true;
        if (!virtualized) {
          // Everything is in the page. Read it once now; the next round re-reads it after a pause and the two must match.
          if (round > 0) await sleep(400 * round);
          scroller.scrollTop = 0; await ctl.settleScroll(scroller);
          known = stitch([read()], vh);
        } else {
          const dir = round % 2 === 0 ? "down" : "up";
          const pass = await scanPass(adapter, scroller, dir, FACTORS[round], ctl);
          known = pass.known; jumps = pass.jumps; reachedEnd = pass.reachedEnd;
        }
        lastPassEnded = reachedEnd;
        passes.push({ fps: known.map((k) => k.fp), entries: known.map((k) => ({ y: k.y, h: k.h, seq: k.seq })), jumps, known });
        keep.push(passes[passes.length - 1]);

        ev = V.evaluate({
          passes: passes.map((p) => ({ fps: p.fps, entries: p.entries, jumps: p.jumps })),
          reachedTop: hist.reachedTop, topSettled: hist.settled, loadMore: hist.loadMore,
          bottomReached: lastPassEnded, timedOut: ctl.timedOut,
        });
        ctl.prog({ phase: "verifying", found: known.length, round: round + 1, ok: ev.verified });
        if (ev.verified) break;
        // Two passes that agree but fail a structural check won't change by repeating; stop and report.
        if (passes.length >= 2 && V.firstDifference(passes[passes.length - 1].fps, passes[passes.length - 2].fps) < 0 && round >= 2) break;
      }
    } catch (e) {
      if (e.message !== "deep-capture-timeout") { unanchor(); restore(scroller, fromBottom); throw e; }
    }
    unanchor();
    restore(scroller, fromBottom);
    const best = ev && ev.verified ? passes[passes.length - 1] : passes.slice().sort((a, b) => b.fps.length - a.fps.length)[0];
    const messages = best ? best.known.map((k) => k.m) : [];
    return { messages, virtualized, verification: ev || { verified: false, checks: [], count: 0, passes: 0, reasons: ["nothing could be read"] },
      reachedTop: !!(hist && hist.reachedTop), timedOut: ctl.timedOut, gaps: passes.reduce((n, p) => n + p.jumps, 0), latency: ctl.latency };
  }

  function restore(sc, fromBottom) {
    try { sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - fromBottom); } catch (e) { /* ignore */ }
  }

  async function deepCapture(adapter, firstEl, opts) {
    opts = opts || {};
    const prog = (o) => { api._progress = o; if (opts.onProgress) { try { opts.onProgress(o); } catch (e) { /* ignore */ } } };
    const res = await verifiedRead(adapter, firstEl, { signal: opts.signal, prog });
    for (const m of res.messages) { delete m.y; delete m.h; delete m.seq; }
    prog({ phase: "done", found: res.messages.length, pct: 100 });
    return res;
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
  //  A shared claude.ai page loads its messages from the site's own data. When that is reachable from the page
  //  (same origin, your own browser session), it is the complete conversation by construction — no scrolling,
  //  nothing to miss. Anything unexpected returns null and the normal page reader takes over.
  // ---------------------------------------------------------------
  let lastShareApiReport = null;
  async function shareApi() {
    if (!/(^|\.)claude\.ai$/.test(location.hostname)) return null;
    const m = location.pathname.match(/^\/share\/([0-9a-f-]{16,})/i);
    if (!m) return null;
    if (shareApi.failed >= 2) return null;
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
      const res = await fetch("/api/chat_snapshots/" + m[1] + "?rendering_mode=messages&render_all_tools=true", { credentials: "include", signal: ac.signal, headers: { accept: "application/json" } });
      clearTimeout(t);
      if (!res.ok) { lastShareApiReport = { status: "http-" + res.status }; shareApi.failed = (shareApi.failed || 0) + 1; return null; }
      const data = await res.json();
      const arr = Array.isArray(data) ? data : (data && (data.chat_messages || data.messages || (data.snapshot && data.snapshot.chat_messages))) || null;
      lastShareApiReport = { status: Array.isArray(arr) ? "ok" : "unexpected-shape", topLevelKeys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).slice(0, 40) : [], entries: Array.isArray(arr) ? arr.length : 0, entryKeys: Array.isArray(arr) && arr[0] && typeof arr[0] === "object" ? Object.keys(arr[0]).slice(0, 40) : [] };
      if (!Array.isArray(arr) || !arr.length) { shareApi.failed = (shareApi.failed || 0) + 1; return null; }
      const textOf = (x) => {
        if (typeof x.text === "string" && x.text.trim()) return x.text;
        if (Array.isArray(x.content)) return x.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n");
        if (typeof x.content === "string") return x.content;
        return "";
      };
      const sorted = arr.slice();
      if (sorted.every((x) => x && typeof x.index === "number")) sorted.sort((a, b) => a.index - b.index);
      // Account for EVERY entry: kept with text, kept as a short placeholder (tool use / thinking / image-only turns),
      // or skipped for a stated reason. Nothing may vanish silently.
      const messages = [], skipped = {}, placeholders = {};
      const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
      for (const x of sorted) {
        if (!x || typeof x !== "object") { bump(skipped, "invalid_entry"); continue; }
        const who = String(x.sender || x.role || "").toLowerCase();
        const role = who === "human" || who === "user" ? "User" : who === "assistant" || who === "ai" ? "Assistant" : null;
        if (!role) { bump(skipped, "unrecognized_sender"); continue; }
        let text = textOf(x).trim();
        if (!text) {
          const blocks = Array.isArray(x.content) ? x.content : [];
          const types = blocks.map((b) => String((b && b.type) || ""));
          const has = (re) => types.some((t) => re.test(t));
          const hasFiles = (Array.isArray(x.attachments) && x.attachments.length) || (Array.isArray(x.files) && x.files.length);
          if (has(/tool|function|action/i)) { text = "[tool use]"; bump(placeholders, "tool"); }
          else if (has(/thinking|reasoning|thought/i)) { text = "[thinking]"; bump(placeholders, "thinking"); }
          else if (has(/image|file|document|attachment|audio|video/i) || hasFiles) { text = "[image or attachment]"; bump(placeholders, "attachment"); }
          else { bump(skipped, "empty"); continue; }
        }
        messages.push({ role, text, confidence: 1, attachments: [], meta: {} });
      }
      const placeholderN = Object.values(placeholders).reduce((n, c) => n + c, 0);
      const skippedN = Object.values(skipped).reduce((n, c) => n + c, 0);
      const textual = messages.length - placeholderN;
      if (!messages.length || textual < 1) { shareApi.failed = (shareApi.failed || 0) + 1; return null; }
      const roles = new Set(messages.map((x) => x.role));
      const accounted = messages.length + skippedN === arr.length;
      // Linked chain (if the data has one): a parent that is nowhere in the data means a message is missing.
      const uuids = new Set(sorted.map((x) => x && x.uuid).filter(Boolean));
      const withParent = sorted.filter((x) => x && typeof x.parent_message_uuid === "string" && x.parent_message_uuid);
      const brokenList = withParent.filter((x) => !uuids.has(x.parent_message_uuid) && !/^0{8}-0{4}-/.test(x.parent_message_uuid));
      const chainUsed = withParent.length >= 2 && uuids.size >= 2;
      const chainOk = !chainUsed || brokenList.every((x) => x === sorted[0]);   // only the very first message may point outside (the conversation root)
      // Declared total, if the data states one.
      const totalKey = data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).find((k) => typeof data[k] === "number" && /total|count/i.test(k) && /message|chat|snapshot/i.test(k));
      const declaredOk = !totalKey || data[totalKey] === arr.length;
      // Message numbering is informational only: real data may skip numbers for entries that aren't messages.
      const idxs = sorted.map((x) => x && x.index);
      const numbered = idxs.every((n) => typeof n === "number");
      const dense = numbered && idxs.every((n, i) => i === 0 || n === idxs[i - 1] + 1);
      const checks = [
        { id: "source", ok: true, detail: "read from the shared page's own data, not by scrolling" },
        { id: "both-sides", ok: messages.length < 3 || roles.size === 2, detail: roles.size === 2 ? "both your messages and the replies are present" : "only one side of the conversation came back" },
        { id: "accounting", ok: accounted, detail: accounted ? ("every entry accounted for (" + messages.length + " kept" + (placeholderN ? ", " + placeholderN + " as [placeholders]" : "") + (skippedN ? ", " + skippedN + " skipped" : "") + ")") : "some entries in the data are unaccounted for" },
        { id: "chain", ok: chainOk, detail: chainUsed ? (chainOk ? "each message links to the one before it" : "a message links to a parent that is missing from the data") : "messages are not linked (skipped)" },
        { id: "declared", ok: declaredOk, detail: totalKey ? (declaredOk ? "the data's own message count matches" : "the data says " + data[totalKey] + " messages but " + arr.length + " came back") : "no message count in the data (skipped)" },
        { id: "numbering", ok: true, detail: numbered ? (dense ? "message numbers are consecutive" : "message numbers skip (informational; not used)") : "messages are not numbered (skipped)" },
      ];
      const reasons = checks.filter((c) => !c.ok).map((c) => c.detail);
      const verification = { verified: reasons.length === 0, checks, count: messages.length, passes: 1, reasons, source: "api" };
      return {
        site: "Claude", siteId: "claude", url: location.href, title: (document.title || "").replace(" - Claude", "").trim() || "Shared chat",
        conversationId: m[1], method: "api", messages, attachmentManifest: [],
        coverage: { captured: messages.length, domCount: arr.length, atTop: true, deep: false, virtualized: false, gaps: chainOk && accounted ? 0 : 1, duplicatesRemoved: 0, reachedTop: true, complete: verification.verified },
        verification, needsVisible: false, visibility: document.visibilityState,
      };
    } catch (e) { shareApi.failed = (shareApi.failed || 0) + 1; return null; }
  }

  // ChatGPT shared links embed the complete selected conversation in React Flight
  // stream chunks. Read that authoritative sequence directly so DOM virtualization
  // and repeated scroll scans cannot drop or double-count turns.
  let lastChatgptShare = null;
  function chatgptShareResult(parsed, sourceNote) {
    const roles = new Set(parsed.messages.map((m) => m.role));
    const skippedN = parsed.skipped ? Object.values(parsed.skipped).reduce((n, c) => n + c, 0) : 0;
    const both = roles.size === 2;
    const complete = !parsed.partial;
    const accounted = parsed.count == null || parsed.messages.length + skippedN === parsed.count;
    const verification = {
      verified: both && accounted && complete,
      checks: [
        { id: "source", ok: true, detail: sourceNote },
        { id: "complete", ok: complete, detail: complete ? "the data does not say there is more to load" : "the data says there are more messages than it returned" },
        { id: "both-sides", ok: both, detail: both ? "both user and assistant messages are present" : "one side of the conversation is missing" },
        { id: "accounting", ok: accounted, detail: accounted ? ("every entry accounted for (" + parsed.messages.length + " kept" + (skippedN ? ", " + skippedN + " hidden/system/empty skipped" : "") + ")") : "entries do not add up" },
      ],
      count: parsed.messages.length,
      passes: 1,
      reasons: [].concat(both ? [] : ["one side of the conversation is missing"], accounted ? [] : ["entries do not add up"], complete ? [] : ["the page's data says there are more messages than it returned"]),
      source: "share-data",
    };
    return {
      site: "ChatGPT", siteId: "chatgpt", url: location.href,
      title: parsed.title || document.title.replace(" - ChatGPT", "").trim() || "Shared chat",
      conversationId: (location.pathname.match(/\/share\/(?:e\/)?([^/?]+)/) || [])[1] || null,
      method: "share-rsc", messages: parsed.messages, attachmentManifest: [],
      coverage: { captured: parsed.messages.length, domCount: parsed.count || parsed.messages.length, atTop: true, deep: true, virtualized: false, gaps: 0, duplicatesRemoved: 0, reachedTop: true, complete: verification.verified },
      verification, needsVisible: false, visibility: document.visibilityState,
    };
  }

  function getTap() {
    return new Promise((resolve) => {
      let done = false;
      const h = (e) => { done = true; document.removeEventListener("capsa-tap-data", h); try { resolve(JSON.parse(e.detail)); } catch (_) { resolve(null); } };
      document.addEventListener("capsa-tap-data", h);
      try { document.dispatchEvent(new CustomEvent("capsa-tap-get")); } catch (_) {}
      setTimeout(() => { if (!done) { document.removeEventListener("capsa-tap-data", h); resolve(null); } }, 600);
    });
  }

  function pageDataUrls() {
    const out = [];
    try {
      for (const e of performance.getEntriesByType("resource")) {
        if (!/^(fetch|xmlhttprequest)$/.test(e.initiatorType)) continue;
        let u; try { u = new URL(e.name); } catch (_) { continue; }
        if (u.origin !== location.origin) continue;
        if (/\/(ces|rgstr|statsig|analytics|log|telemetry|sentinel)\b|\.(js|css|png|svg|woff2?)$/i.test(u.pathname)) continue;
        if (!out.includes(u.href)) out.push(u.href);
      }
    } catch (_) {}
    return out.slice(-15);
  }

  async function tappedShare(parser, maxWait, allowReplay) {
    const t0 = Date.now();
    let installed = false, seen = 0;
    do {
      const tap = await getTap();
      if (!tap) break;
      installed = true; seen = tap.items.length;
      let best = null;
      for (const it of tap.items) { const x = parser.fromText(it.text); if (x && (!best || x.messages.length > best.messages.length)) best = x; }
      if (best) return { parsed: best, note: "tap: " + best.messages.length + " messages from " + seen + " responses" };
      await sleep(250);
    } while (Date.now() - t0 < maxWait && document.visibilityState === "visible");
    if (installed) return { parsed: null, note: "tap: " + seen + " responses, no conversation in them" };
    if (allowReplay === false) return { parsed: null, note: "tap not installed" };
    let tried = 0, best = null;
    for (const url of pageDataUrls()) {
      try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
        const res = await fetch(url, { credentials: "include", signal: ac.signal });
        clearTimeout(t); tried++;
        if (!res.ok) continue;
        const x = parser.fromText(await res.text());
        if (x && (!best || x.messages.length > best.messages.length)) best = x;
      } catch (_) {}
    }
    return { parsed: best, note: "tap not installed; replayed " + tried + " page requests" + (best ? ": " + best.messages.length + " messages" : ", no conversation") };
  }

  // Two independent routes to the full conversation, both without scrolling:
  //  1) the data embedded in the page itself (any shape: found by structure, not by name);
  //  2) the site's own share endpoint, asked from the page (same origin, so no extra permission).
  async function chatgptShareData() {
    lastChatgptShare = { embedded: "none", api: "not-tried" };
    if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname) || !/^\/share\//.test(location.pathname)) return null;
    const parser = typeof self !== "undefined" && self.CapsaShareRsc;
    if (!parser) return null;
    try {
      const parsed = parser.extractAny(document);
      if (parsed && parsed.messages.length >= 2) {
        lastChatgptShare.embedded = parsed.messages.length + " messages via " + parsed.source;
        const r = chatgptShareResult(parsed, "read the complete conversation embedded in the shared page");
        if (r.verification.verified) return r;
        lastChatgptShare.embedded += " (not accepted: " + r.verification.reasons.join("; ") + ")";
      }
    } catch (e) { lastChatgptShare.embedded = "error"; }
    // Route 2: what the page itself downloaded to draw the conversation (kept by share-tap.js from the moment the
    // page started loading). If the tap isn't there (page was open before the extension), ask for the same
    // same-origin data the page asked for. A short look first, then the share endpoint, then a longer wait.
    const tapTry = async (wait, replay) => {
      try {
        const got = await tappedShare(parser, wait, replay);
        lastChatgptShare.tap = got.note;
        if (got.parsed) {
          const r = chatgptShareResult(got.parsed, "read the conversation from the data this page downloaded to show it");
          if (r.verification.verified) return r;
          lastChatgptShare.tap += " (not accepted: " + r.verification.reasons.join("; ") + ")";
        }
      } catch (e) { lastChatgptShare.tap = "error"; }
      return null;
    };
    const quick = await tapTry(2500, true);
    if (quick) return quick;
    const id = (location.pathname.match(/^\/share\/(?:e\/)?([0-9a-f-]{16,})/i) || [])[1];
    if (!id) return null;
    for (const url of ["/backend-api/share/" + id, "/backend-api/public/share/" + id]) {
      try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
        const res = await fetch(url, { credentials: "include", signal: ac.signal, headers: { accept: "application/json" } });
        clearTimeout(t);
        if (!res.ok) { lastChatgptShare.api = "http-" + res.status; continue; }
        const parsed = parser.fromTree(await res.json());
        if (parsed && parsed.messages.length >= 2) {
          lastChatgptShare.api = parsed.messages.length + " messages";
          const r = chatgptShareResult(parsed, "read the complete conversation from the shared page's own data service");
          if (r.verification.verified) return r;
          lastChatgptShare.api += " (not accepted: " + r.verification.reasons.join("; ") + ")";
        } else lastChatgptShare.api = "unexpected-shape";
      } catch (e) { lastChatgptShare.api = e && e.name === "AbortError" ? "timeout" : "request-failed"; }
    }
    return await tapTry(10000, false);
  }

  // A text-free skeleton of the page (selectors and counts only, never what anyone wrote), so a layout the
  // readers don't understand can be diagnosed and fixed.
  function diagnose(captureResult) {
    try {
      const mask = (v) => String(v || "").replace(/[0-9a-f]{8,}(-[0-9a-f]{4,})*/gi, "*").slice(0, 80);
      const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
      const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
      const testids = {}; document.querySelectorAll("[data-testid]").forEach((e) => bump(testids, mask(e.getAttribute("data-testid"))));
      const sig = (e) => e.tagName.toLowerCase() + (typeof e.className === "string" ? e.className.split(/\s+/).filter(Boolean).slice(0, 3).map((c) => "." + mask(c)).join("") : "");
      const blocks = {}, attrs = {};
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n = 0, node;
      while ((node = tw.nextNode()) && n < 4000) {
        n++;
        if (node.nodeValue.trim().length < 60) continue;
        let e = node.parentElement;
        for (let d = 0; e && d < 3; d++, e = e.parentElement) {
          bump(blocks, d + ":" + sig(e));
          for (const a of e.getAttributeNames()) if (/^(data-|role$|aria-)/.test(a)) bump(attrs, a + (a === "role" ? "=" + e.getAttribute(a) : ""));
        }
      }
      const scrollers = [];
      document.querySelectorAll("body *").forEach((e) => {
        if (scrollers.length >= 8) return;
        const st = getComputedStyle(e);
        if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 4) scrollers.push(sig(e) + " " + e.clientHeight + "/" + e.scrollHeight);
      });
      const sharePage = location.pathname.startsWith("/share/") && /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname);
      const scripts = Array.from(document.scripts || []).map((e) => e.textContent || "");
      const flightScripts = sharePage ? scripts.filter((s) => s.includes("streamController.enqueue(")).length : 0;
      let rscCount = null;
      if (sharePage && self.CapsaShareRsc) {
        try { const p = self.CapsaShareRsc.extractAny(document); rscCount = p ? p.messages.length : 0; } catch (_) { rscCount = -1; }
      }
      const last = captureResult || api._last;
      const captureInfo = last ? {
        method: last.method || null,
        count: Array.isArray(last.messages) ? last.messages.length : 0,
        verified: last.verification ? !!last.verification.verified : null,
        source: last.verification && last.verification.source || null,
        reasons: last.verification && Array.isArray(last.verification.reasons) ? last.verification.reasons : [],
      } : null;
      const hits = {};
      for (const sel of ['[data-testid="user-message"]', ".font-claude-response", ".font-claude-message", "[data-message-author-role]", "article", '[role="article"]', "[data-message-id]", '[class*="message"]', '[class*="turn"]', "[contenteditable=true]", "iframe", "main"]) {
        try { hits[sel] = document.querySelectorAll(sel).length; } catch (e) { hits[sel] = -1; }
      }
      return JSON.stringify({
        capsaReport: 1, readerBuild: "share-v12", host: location.hostname, path: mask(location.pathname), visibility: document.visibilityState,
        shareSelectorHits: location.hostname === "chatgpt.com" && location.pathname.startsWith("/share/") ? {
          assistantClassRoots: document.querySelectorAll('[class*="DilResponseRoot"], [class*="MarkdownRoot"]').length,
          assistantTextFallback: document.querySelectorAll('[data-markdown-text-style]').length,
          userText: document.querySelectorAll('.text-size-chat.whitespace-pre-wrap').length,
        } : null,
        claudeShare: lastShareApiReport,
        network: sharePage ? pageDataUrls().map((u) => { try { const x = new URL(u); return mask(x.pathname) + (x.search ? "?" + [...x.searchParams.keys()].join("&") : ""); } catch (_) { return "?"; } }) : null,
        shareData: sharePage ? { scriptCount: scripts.length, flightScripts, parserAvailable: !!self.CapsaShareRsc, parsedMessages: rscCount, shape: self.CapsaShareRsc ? self.CapsaShareRsc.shape(document) : null, tried: lastChatgptShare } : null,
        capture: captureInfo,
        bodyTextLen: (document.body.innerText || "").length, selectorHits: hits,
        testids: top(testids, 25), textBlocks: top(blocks, 25), attrs: top(attrs, 20), scrollers,
      });
    } catch (e) { return JSON.stringify({ capsaReport: 1, error: String(e && e.message || e) }); }
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

    let apiRaw = null;
    if (opts.api !== false) {
      try { apiRaw = await chatgptShareData(); } catch (e) { apiRaw = null; }
      if (!apiRaw) { try { apiRaw = await shareApi(); } catch (e) { apiRaw = null; } }
    }

    for (const a of (apiRaw ? [] : [specific, GENERIC].filter(Boolean))) {
      let s = null;
      try { s = snapshot(a); } catch (e) { s = null; }
      if (s && s.messages.length) { adapter = a; snap = s; break; }
    }

    let result;
    if (apiRaw) {
      result = apiRaw;
      adapter = { id: apiRaw.siteId || "claude", name: apiRaw.site || "Claude" };
      warnings.push(apiRaw.method === "share-rsc"
        ? "Read the selected conversation from the shared page data; no scrolling was needed."
        : "Read from the shared page's own data, so nothing could be missed by scrolling.");
    } else if (!adapter) {
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

      let verification = null, needsVisible = false;
      const wantVerify = opts.verify === true || opts.deep === true;
      if (wantVerify && adapter.supportsDeepCapture !== false) {
        try {
          const d = await deepCapture(adapter, snap.firstEl || document.body, {
            signal: api._cancelController ? api._cancelController.signal : null,
            onProgress: opts.onProgress || null,
          });
          messages = d.messages;
          method = "dom-verified";
          verification = d.verification;
          needsVisible = !!d.needsVisible;
          info = { reachedTop: d.reachedTop && !d.timedOut, virtualized: d.virtualized, gaps: d.gaps };
          if (!verification.verified) warnings.push("Couldn't prove the whole chat was captured: " + verification.reasons.join("; ") + ".");
        } catch (e) {
          if (e.message === "deep-capture-cancelled") {
            warnings.push("Capture was cancelled. Only part of the chat was read.");
            method = "dom-partial";
            verification = { verified: false, checks: [], count: messages.length, passes: 0, reasons: ["cancelled"] };
          } else {
            warnings.push("Reading the whole chat failed (" + (e.message || "unknown error") + ").");
            verification = { verified: false, checks: [], count: messages.length, passes: 0, reasons: ["the reader failed: " + (e.message || "unknown error")] };
          }
        }
      } else if (wantVerify) {
        verification = { verified: false, checks: [], count: messages.length, passes: 0, reasons: [(adapter.name || "This site") + " can't be verified automatically"] };
      }

      let complete = verification ? verification.verified : (!scrollable ? true : null);

      // Verify ordering
      const ordering = verifyOrdering(messages);
      if (ordering.suspiciousOrdering) {
        warnings.push("Message ordering looks unusual (" + ordering.longestSameRole + " consecutive same-role messages). Check captured content carefully.");
      }

      // A chat may genuinely open with the assistant (a greeting, a system prompt, a shared page). That is only
      // suspicious when we have NOT proven we reached the top. If the read verified (the top was reached and
      // settled, two passes agree), the first message is simply the first message: note it, don't reject it.
      if (messages.length && messages[0].role !== "User" && !genericAdapter) {
        const topProven = !!(verification && verification.verified);
        if (topProven) {
          warnings.push("This chat starts with a message from the assistant (the start of the chat was reached and checked).");
        } else {
          warnings.push("The first captured message isn't from you, so the start of the conversation may be missing.");
          complete = false;
          if (verification) { verification.verified = false; verification.reasons.push("the first message isn't yours, and the start of the chat wasn't confirmed"); }
        }
      }
      // Only one side of the conversation found (all replies, or all of your messages): the page's layout is
      // not what the reader expects. That is never a complete chat, however well the scrolling went.
      if (messages.length >= 3) {
        const rs = new Set(messages.map((m) => m.role));
        if (rs.size === 1) {
          const only = [...rs][0] === "User" ? "your messages" : "the replies";
          warnings.push("Only " + only + " were found; the other side of the conversation was not recognised.");
          complete = false;
          if (verification) { verification.verified = false; verification.reasons.push("only " + only + " were found — this page's layout may have changed"); }
        }
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
        verification,
        needsVisible,
        visibility: document.visibilityState,
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
      delete m.meta; delete m.y;
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

    if (result.verification && !result.verification.verified && opts.verify) result.report = diagnose(result);
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

    // The box took only part of a long text: say so AND put the whole thing on the clipboard, so nothing is silently half-pasted.
    const partialFallback = async (method) => {
      const cb = await insertViaClipboard(text);
      return { ok: false, partial: true, method, clipboardFilled: !!cb.clipboardFilled, fallback: "clipboard",
        error: "The text box only took part of the text (long messages are cut by some chat editors)." + (cb.clipboardFilled ? " The FULL capsule is on your clipboard: clear the box, then paste (Ctrl+V / Cmd+V)." : " Clear the box and use Copy instead.") };
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
        : r.grew > 0 ? await partialFallback("value") : { ok: false, partial: false, method: "value", error: "The page didn't accept the text." };
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
      if (r.grew > 0) return partialFallback(name);
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
    _progress: null,
    capture: startCapture,
    insert,
    cancelCapture,
    diagnose,
    last: () => (api._last && Date.now() - api._last.at < 15 * 60 * 1000 ? api._last : null),
    _test: { toMarkdown, pruneNested, inferRole, computeQuality, verifyOrdering, stitch },
  };
  window.__chatCapsule = api;
})();
