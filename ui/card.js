/* Capsa — the card. One small UI, mounted in two places:
     • the toolbar popup            (ui/popup.html)
     • the floating orb on AI sites (content/launcher.js, inside a shadow root)
   It is a thin view: the service worker does the page work and saves the capture to
   chrome.storage.local ("last"); this file renders it and offers Copy / Insert / Download. */
(function (root) {
  "use strict";

  const L = root.CapsuleLib;
  const H = root.CapsaHosts;
  const F = root.CapsaFiles;

  /* ───────────────────────── styles ───────────────────────── */
  const CSS = `
.cx{
  --bg:#000000; --glass:rgba(247,246,234,.06); --line:rgba(247,246,234,.12);
  --text:#f7f6ea; --dim:#8e9287; --r1:#a12d2b; --r2:#be4939; --r3:#dc6949; --gold:#f3b63f; --moss:#7d8176; --bad:#f08a6c; --ok:#f7f6ea; --warn:#f3b63f;
  --grad:linear-gradient(135deg,#a12d2b 0%,#dc6949 100%); --gold-grad:linear-gradient(135deg,#f3b63f 0%,#dc6949 100%);
  box-sizing:border-box; width:340px; color:var(--text); color-scheme:dark; font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:#000;
  border-radius:24px; padding:14px 16px 12px; position:relative; overflow:hidden; text-align:left;
}
.cx *,.cx *::before,.cx *::after{box-sizing:border-box}
.cx button,.cx input,.cx textarea{font:inherit;color:inherit}
.cx button{cursor:pointer;border:0;background:none;padding:0}
.cx [hidden]{display:none!important}

/* header */
.hd{display:flex;align-items:center;gap:8px;min-height:26px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:.2px;font-size:14px}
.logo{width:20px;height:20px;display:block;flex:none}
.logo svg{width:100%;height:100%;overflow:visible}
.chip{margin-left:auto;font-size:11px;color:var(--dim);background:var(--glass);border:1px solid var(--line);border-radius:999px;padding:2px 9px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip:empty{display:none}
.x{width:26px;height:26px;border-radius:50%;color:var(--dim);display:grid;place-items:center;transition:background .2s,color .2s,transform .3s}
.x:hover{background:var(--glass);color:var(--text);transform:rotate(90deg)}
.x svg{width:14px;height:14px}

/* hero + orb */
.hero{display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 0 12px;text-align:center}
.cx[data-has="1"] .hero{flex-direction:row;text-align:left;gap:14px;padding:12px 0 10px}
.orb{--o:96px;position:relative;width:var(--o);height:var(--o);border-radius:50%;flex:none;transition:width .45s cubic-bezier(.3,1.5,.5,1),height .45s cubic-bezier(.3,1.5,.5,1),transform .2s}
.cx[data-has="1"] .orb{--o:58px}
.orb:hover{transform:scale(1.05)} .orb:active{transform:scale(.95)}
.orb:focus-visible{outline:2px solid var(--gold);outline-offset:4px}
.orb .halo,.orb .ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,var(--r1),var(--r3),var(--gold),var(--r3),var(--r1));animation:spin 7s linear infinite}
.orb .halo{filter:blur(16px);opacity:.55;inset:-2px}
.orb .disc{position:absolute;inset:4px;border-radius:50%;background:#000;display:grid;place-items:center;overflow:hidden}
.orb .disc svg{width:62%;height:62%;overflow:visible}
.cx[data-state="busy"] .ring,.cx[data-state="busy"] .halo{animation-duration:1.1s}
.cx[data-state="done"] .ring,.cx[data-state="done"] .halo{background:conic-gradient(from 0deg,var(--gold),var(--r3),var(--gold))}

/* the scroll: two rolls + a sheet between them. closed = rolls touch, open = sheet unrolled */
.sc-sheet{fill:#f7f6ea;stroke:#f3b63f;stroke-width:.8}
.sc-ln{stroke:#7d8176;stroke-width:1.6;stroke-linecap:round;fill:none}
.sc-scan{fill:#f3b63f;opacity:0}
.sc-roll{fill:url(#cxroll)}
.sc-rod{fill:#a12d2b}
.sc-knob{fill:#f3b63f}
.sc-seal{fill:#be4939;stroke:#f3b63f;stroke-width:1.2}
.sc-tick{fill:none;stroke:#f7f6ea;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:14;stroke-dashoffset:14}
.sc-l,.sc-r,.sc-sh,.sc-seal-g{transform-box:view-box;transform-origin:24px 24px}
.sc-l{transform:translateX(8px)} .sc-r{transform:translateX(-8px)} .sc-sh{transform:scaleX(0)} .sc-seal-g{transform:scale(0);transform-origin:24px 30px}
.sc-l,.sc-r,.sc-sh,.sc-seal-g{transition:transform .55s cubic-bezier(.3,1.35,.5,1)}
.orb:hover .sc-l{transform:translateX(4px)} .orb:hover .sc-r{transform:translateX(-4px)} .orb:hover .sc-sh{transform:scaleX(.55)}
.cx[data-state="busy"] .orb .sc-l{animation:scL 2.6s ease-in-out infinite}
.cx[data-state="busy"] .orb .sc-r{animation:scR 2.6s ease-in-out infinite}
.cx[data-state="busy"] .orb .sc-sh{animation:scS 2.6s ease-in-out infinite}
.cx[data-state="busy"] .orb .sc-scan{animation:scScan 2.6s ease-in-out infinite}
.cx[data-state="busy"] .orb .sc-ln{animation:scLn 2.6s ease-in-out infinite}
.cx[data-state="done"] .orb .sc-l,.cx[data-state="done"] .orb .sc-r,.cx[data-state="done"] .orb .sc-sh{transform:none}
.cx[data-state="done"] .orb .sc-seal-g{transform:scale(1);transition-delay:.25s}
.cx[data-state="done"] .orb .sc-tick{animation:draw .4s .6s ease-out forwards}
.hero-t{display:flex;flex-direction:column;gap:2px;min-width:0}
.hero-t b{font-size:15px;font-weight:650;letter-spacing:.1px}
.hero-t span{font-size:12px;color:var(--dim)}
.cx[data-has="1"] .hero-t b{font-size:14px}

/* link pill */
.link{display:flex;align-items:center;gap:6px;background:var(--glass);border:1px solid var(--line);border-radius:999px;padding:4px 4px 4px 14px;transition:border-color .2s,box-shadow .2s}
.link:focus-within{border-color:rgba(243,182,63,.75);box-shadow:0 0 0 3px rgba(243,182,63,.16)}
.link input{flex:1;min-width:0;background:none;border:0;outline:0;font-size:12.5px;padding:6px 0}
.link input::placeholder{color:var(--dim)}
.go{width:32px;height:32px;border-radius:50%;background:var(--gold-grad);display:grid;place-items:center;color:#000;transition:transform .25s cubic-bezier(.3,1.6,.5,1),filter .2s;flex:none}
.go svg{width:16px;height:16px;transition:transform .25s}
.go:hover{transform:scale(1.1)} .go:hover svg{transform:translateX(2px)}
.go:disabled,.orb:disabled{opacity:.5;cursor:default;transform:none}

/* files */
.files{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dim);background:var(--glass);border:1px dashed var(--line);border-radius:999px;padding:4px 11px;transition:color .2s,border-color .2s,transform .25s cubic-bezier(.3,1.6,.5,1)}
.pill:hover{color:var(--text);border-color:rgba(243,182,63,.6);transform:translateY(-1px)}
.pill b{color:var(--gold);font-weight:700;font-size:13px;line-height:1}
.fchip{display:inline-flex;align-items:center;gap:4px;margin-left:auto;font-size:11.5px;color:var(--text);background:rgba(243,182,63,.14);border:1px solid rgba(243,182,63,.4);border-radius:999px;padding:3px 4px 3px 10px}
.fchip button{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;color:var(--dim)}
.fchip button:hover{background:var(--glass);color:var(--text)}
.fchip svg{width:10px;height:10px}
.cx.drag{outline:2px dashed var(--gold);outline-offset:-8px}
/* status */
.st{display:flex;align-items:center;gap:8px;min-height:20px;margin:8px 2px 0;font-size:12px;color:var(--dim)}
.st:empty{display:none}
.stwrap{display:flex;align-items:center;justify-content:space-between;gap:8px}
.stwrap .st{flex:1;min-width:0}
.cancel{flex:none;margin:8px 2px 0;background:none;border:1px solid var(--dim);color:var(--dim);border-radius:999px;padding:2px 10px;font:inherit;font-size:11px;cursor:pointer}
.vrep{margin-top:8px;background:none;border:0;color:var(--dim);font:inherit;font-size:11.5px;text-decoration:underline;cursor:pointer;padding:0}
.vrep:hover{color:var(--fg,#f7f6ea)}
.cancel:hover{color:var(--bad);border-color:var(--bad)}
.st::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--dim);flex:none}
.st.ok{color:var(--ok)} .st.ok::before{background:var(--ok)}
.st.err{color:var(--bad)} .st.err::before{background:var(--bad)}
.st.warn{color:var(--warn)} .st.warn::before{background:var(--warn)}
.st.busy::before{background:var(--gold);animation:blink 1s infinite}

/* unverified: the capsule is held back */
.vbar{margin-top:10px;border:1px solid rgba(240,138,108,.55);border-radius:16px;padding:10px 12px;background:rgba(161,45,43,.12);animation:rise .3s ease-out}
.vbar b{display:block;font-size:12.5px;color:var(--bad);margin-bottom:4px}
.vbar ul{margin:0 0 8px;padding-left:16px;font-size:11.5px;color:var(--dim)}
.vbar .vb{display:flex;gap:8px}
.vbar button{flex:1;border-radius:999px;padding:7px 10px;font-size:12px;font-weight:650;border:1px solid var(--line);transition:transform .2s cubic-bezier(.3,1.6,.5,1),border-color .2s}
.vbar button:hover{transform:translateY(-1px);border-color:rgba(243,182,63,.6)}
.vbar .vb1{background:var(--gold-grad);color:#000;border:0}
.vbar .vb2{color:var(--dim)}

/* result */
.out{margin-top:10px;display:flex;flex-direction:column;gap:9px;animation:rise .4s cubic-bezier(.3,1.3,.5,1)}
.seg{--i:1;position:relative;display:grid;grid-template-columns:repeat(5,1fr);background:var(--glass);border:1px solid var(--line);border-radius:999px;padding:3px}
.seg .thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px)/5);border-radius:999px;background:var(--grad);transform:translateX(calc(var(--i)*100%));transition:transform .35s cubic-bezier(.3,1.4,.5,1);box-shadow:0 2px 12px rgba(161,45,43,.55)}
.seg button{position:relative;z-index:1;padding:6px 0;font-size:11px;font-weight:600;color:var(--dim);border-radius:999px;transition:color .2s}
.seg button[aria-pressed="true"]{color:#f7f6ea}
.seg button:hover:not([aria-pressed="true"]){color:var(--text)}
.meta{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dim);padding:0 4px}
.meta b{color:var(--text);font-weight:600}
.pv{width:100%;height:112px;resize:vertical;min-height:70px;max-height:260px;background:#000;border:1px solid var(--line);border-radius:16px;padding:10px 12px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e9e7d6;outline:0}
.pv{scrollbar-width:thin;scrollbar-color:#5a4a3c transparent}
.pv:focus{border-color:rgba(243,182,63,.6)}
.acts{display:flex;justify-content:center;align-items:flex-start;gap:20px;padding:4px 0 2px}
.act{display:flex;flex-direction:column;align-items:center;gap:5px;color:var(--dim);font-size:11px;position:relative;min-width:64px;white-space:nowrap}
.act .ic{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:var(--glass);border:1px solid var(--line);color:var(--text);transition:transform .3s cubic-bezier(.3,1.6,.5,1),background .2s,border-color .2s,box-shadow .2s;position:relative}
.act .ic svg{width:19px;height:19px}
.act:hover .ic{transform:translateY(-3px) scale(1.06);border-color:rgba(243,182,63,.6)}
.act:active .ic{transform:scale(.92)}
.act.main .ic{width:54px;height:54px;background:var(--gold-grad);border:0;color:#000;box-shadow:0 6px 22px rgba(220,105,73,.45)}
.act.main .ic svg{width:22px;height:22px}
.act.main{color:var(--text);font-weight:600}
.act em{font-style:normal}
.act.ok .ic{background:var(--gold);color:#000;border-color:transparent}
.spark{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px;border-radius:50%;background:var(--c);pointer-events:none;animation:fly .65s ease-out forwards}

/* footer */
.ft{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:9px;border-top:1px solid var(--line);font-size:11px;color:var(--dim)}
.sw{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}
.sw input{position:absolute;opacity:0;pointer-events:none}
.sw i{width:26px;height:15px;border-radius:999px;background:var(--glass);border:1px solid var(--line);position:relative;transition:background .2s}
.sw i::after{content:"";position:absolute;top:2px;left:2px;width:9px;height:9px;border-radius:50%;background:var(--dim);transition:transform .25s cubic-bezier(.3,1.6,.5,1),background .2s}
.sw input:checked+i{background:rgba(243,182,63,.25)} .sw input:checked+i::after{transform:translateX(11px);background:var(--gold)}
.sw input:focus-visible+i{outline:2px solid var(--gold)}

@keyframes spin{to{transform:rotate(360deg)}}
@keyframes breathe{50%{transform:scale(.9)}}
@keyframes scL{0%,100%{transform:translateX(8px)}30%,70%{transform:translateX(0)}}
@keyframes scR{0%,100%{transform:translateX(-8px)}30%,70%{transform:translateX(0)}}
@keyframes scS{0%,100%{transform:scaleX(0)}30%,70%{transform:scaleX(1)}}
@keyframes scScan{0%,30%{transform:translateX(0);opacity:0}34%{opacity:.85}66%{transform:translateX(19px);opacity:.85}70%,100%{transform:translateX(19px);opacity:0}}
@keyframes scLn{0%,28%{opacity:.15}45%,60%{opacity:1}100%{opacity:.15}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes blink{50%{opacity:.25}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes fly{to{transform:translate(var(--dx),var(--dy)) scale(.2);opacity:0}}
@media (prefers-reduced-motion:reduce){.cx *,.cx *::before,.cx *::after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important}}
`;

  /* ───────────────────────── icons ───────────────────────── */
  const I = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="3"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
    insert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h11m0 0l-4-4m4 4l-4 4M20 4v16"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };
  const SCROLL_SVG =
    '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<defs><linearGradient id="cxroll" x1="0" x2="1"><stop offset="0" stop-color="#d9d6c2"/><stop offset=".35" stop-color="#f7f6ea"/><stop offset="1" stop-color="#b9b6a2"/></linearGradient></defs>' +
      '<g class="sc-sh"><rect class="sc-sheet" x="14" y="10" width="20" height="28"/>' +
        '<path class="sc-ln" d="M18 16h12M18 21h12M18 26h8"/><rect class="sc-scan" x="14" y="10" width="3" height="28"/></g>' +
      '<g class="sc-seal-g"><circle class="sc-seal" cx="24" cy="30" r="5.5"/><path class="sc-tick" d="M21.2 30.2l2.1 2.2 3.8-4.6"/></g>' +
      '<g class="sc-l"><rect class="sc-rod" x="9.6" y="3.5" width="3" height="41" rx="1.5"/><rect class="sc-roll" x="6" y="9" width="10" height="30" rx="5"/>' +
        '<circle class="sc-knob" cx="11.1" cy="4.2" r="2.8"/><circle class="sc-knob" cx="11.1" cy="43.8" r="2.8"/></g>' +
      '<g class="sc-r"><rect class="sc-rod" x="35.4" y="3.5" width="3" height="41" rx="1.5"/><rect class="sc-roll" x="32" y="9" width="10" height="30" rx="5"/>' +
        '<circle class="sc-knob" cx="36.9" cy="4.2" r="2.8"/><circle class="sc-knob" cx="36.9" cy="43.8" r="2.8"/></g>' +
    "</svg>";
  const MINI_SCROLL = SCROLL_SVG.replace(/<defs>.*?<\/defs>/, "");

  /* ───────────────────────── markup ───────────────────────── */
  const MODES = [
    { id: "l0", label: "Compact", tip: "Goal, latest request and open tasks — the fastest handoff", opts: { mode: "l0", level: 0 } },
    { id: "l1", label: "Standard", tip: "Adds decisions, finished work and the latest code", opts: { mode: "l1", level: 1 } },
    { id: "l2", label: "Extended", tip: "Adds the most recent messages word-for-word", opts: { mode: "l2", level: 2 } },
    { id: "smart", label: "Smart", tip: "Compressed to fit a token budget, most important parts first", opts: { mode: "smart", budget: 8000 } },
    { id: "full", label: "Full", tip: "Every message, word-for-word — nothing left out", opts: { mode: "lossless", budget: 400000 } },
  ];

  function template(opts) {
    return (
      '<div class="cx" data-state="idle" data-has="0">' +
        '<div class="hd">' +
          '<span class="brand"><span class="logo" aria-hidden="true">' + MINI_SCROLL + '</span>Capsa</span>' +
          '<span class="chip" data-r="chip"></span>' +
          '<button class="x" data-r="close" aria-label="Close" title="Close"' + (opts.onClose ? "" : " hidden") + ">" + I.close + "</button>" +
        "</div>" +
        '<div class="hero">' +
          '<button class="orb" data-r="orb" aria-label="Capture this conversation"><span class="halo"></span><span class="ring"></span><span class="disc">' + SCROLL_SVG + "</span></button>" +
          '<div class="hero-t"><b data-r="title">Capture this chat</b><span data-r="sub">Tap the orb on any AI conversation</span></div>' +
        "</div>" +
        '<form class="link" data-r="form" autocomplete="off">' +
          '<input data-r="link" type="text" inputmode="url" spellcheck="false" placeholder="…or paste a chat link" aria-label="Chat link">' +
          '<button class="go" type="submit" data-r="go" aria-label="Capture from link" title="Capture from link">' + I.arrow + "</button>" +
        "</form>" +
        '<div class="files">' +
          '<button type="button" class="pill" data-r="addf" title="Add files or a .zip — text files are compressed into the context"><b>+</b>Files / zip</button>' +
          '<button type="button" class="pill" data-r="addd" title="Add a whole folder"><b>+</b>Folder</button>' +
          '<span class="fchip" data-r="fchip" hidden><span data-r="fcount"></span><button type="button" data-r="fclear" aria-label="Remove all files" title="Remove all files">' + I.close + "</button></span>" +
          '<input type="file" multiple hidden data-r="fin"><input type="file" webkitdirectory hidden data-r="din">' +
        "</div>" +
        '<div class="stwrap"><div class="st" data-r="st" role="status" aria-live="polite"></div><button type="button" class="cancel" data-r="cancel" hidden>Cancel</button></div>' +
        '<div class="vbar" data-r="vbar" hidden><b data-r="vt"></b><ul data-r="vl"></ul><div class="vb"><button type="button" class="vb1" data-r="vretry">Retry</button><button type="button" class="vb2" data-r="vuse" title="Make a capsule from what was read, clearly marked as not verified">Use anyway</button></div><button type="button" class="vrep" data-r="vrep" hidden title="Copies a text-free outline of the page layout (no messages) so the reader can be fixed">Copy page report</button></div>' +
        '<section class="out" data-r="out" hidden>' +
          '<div class="seg" data-r="seg" role="group" aria-label="Context size"><i class="thumb"></i>' +
            MODES.map((m) => '<button type="button" data-m="' + m.id + '" title="' + m.tip + '" aria-pressed="false">' + m.label + "</button>").join("") +
          "</div>" +
          '<div class="meta"><span data-r="tok"></span><span data-r="saved"></span></div>' +
          '<textarea class="pv" data-r="pv" spellcheck="false" aria-label="Context preview"></textarea>' +
          '<div class="acts">' +
            '<button class="act" data-r="copy"><span class="ic">' + I.copy + "</span><em>Copy</em></button>" +
            '<button class="act main" data-r="insert"><span class="ic">' + I.insert + "</span><em>Insert here</em></button>" +
            '<button class="act" data-r="dl"><span class="ic">' + I.down + "</span><em>Save .md</em></button>" +
          "</div>" +
        "</section>" +
        '<div class="ft"><label class="sw"><input type="checkbox" data-r="orbToggle"><i></i>Floating orb</label><span>On-device · nothing uploaded</span></div>' +
      "</div>"
    );
  }

  /* ───────────────────────── helpers ───────────────────────── */
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n));
  const slug = (s) => String(s || "capsa").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "capsa";

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: "Capsa was updated — reload this page and try again." });
          else resolve(res || { ok: false, error: "No response from Capsa." });
        });
      } catch (e) { resolve({ ok: false, error: "Capsa was updated — reload this page and try again." }); }
    });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  /* ───────────────────────── mount ───────────────────────── */
  function mount(host, opts) {
    opts = opts || {};
    const style = document.createElement("style");
    style.textContent = CSS;
    const wrap = document.createElement("div");
    wrap.innerHTML = template(opts);
    host.appendChild(style);
    host.appendChild(wrap.firstChild);

    const el = host.querySelector(".cx");
    const r = {};
    el.querySelectorAll("[data-r]").forEach((n) => { r[n.dataset.r] = n; });
    const segBtns = [...r.seg.querySelectorAll("button")];

    const S = { capsule: null, files: [], mode: "full", busy: false, edited: false, last: null, unv: null, action: null };
    let statusTimer = 0;

    /* -- small UI helpers -- */
    function status(text, kind, ms) {
      clearTimeout(statusTimer);
      r.st.textContent = text || "";
      r.st.className = "st" + (kind ? " " + kind : "");
      if (text && ms) statusTimer = setTimeout(() => { if (r.st.textContent === text) status(""); }, ms);
    }
    function setState(s) { el.dataset.state = s; if (opts.onState) opts.onState(s); }
    function setBusy(b) {
      S.busy = b;
      r.orb.disabled = b; r.go.disabled = b; r.link.disabled = b;
      r.cancel.hidden = !b;
      if (b) setState("busy");
    }
    function burst(btn) {
      const ic = btn.querySelector(".ic");
      const colors = ["#a12d2b", "#dc6949", "#f3b63f", "#f7f6ea"];
      for (let i = 0; i < 8; i++) {
        const s = document.createElement("i");
        s.className = "spark";
        const a = (Math.PI * 2 * i) / 8 + Math.random() * 0.5, d = 26 + Math.random() * 12;
        s.style.setProperty("--dx", Math.cos(a) * d + "px");
        s.style.setProperty("--dy", Math.sin(a) * d + "px");
        s.style.setProperty("--c", colors[i % colors.length]);
        ic.appendChild(s);
        setTimeout(() => s.remove(), 700);
      }
    }
    function flash(btn, label) {
      const em = btn.querySelector("em"), ic = btn.querySelector(".ic");
      const old = { t: em.textContent, h: ic.innerHTML };
      if (btn._t) return;
      btn.classList.add("ok"); em.textContent = label; ic.innerHTML = I.check;
      burst(btn);
      btn._t = setTimeout(() => { btn.classList.remove("ok"); em.textContent = old.t; ic.innerHTML = old.h; btn._t = 0; }, 1500);
    }

    /* -- render the saved capture -- */
    function modeOpts() {
      const m = MODES.find((x) => x.id === S.mode) || MODES[1];
      const o = Object.assign({ intent: "resume", clean: true }, m.opts);
      if (m.id === "full") { o.clean = false; if (S.capsule) o.budget = Math.max(8000, L.chatTokens(S.capsule) * 3); }
      return o;
    }

    const FILE_BUDGET = { l0: 0, l1: 2500, l2: 5000, smart: 6000, full: Infinity };

    function verifyNote(c) {
      const v = c && c.verification;
      if (!v) return "";
      return v.verified
        ? "Capture verified complete: all " + v.count + " messages (" + v.passes + " independent passes agree)."
        : "WARNING: this capture could NOT be verified complete — messages may be missing.";
    }

    function composeText(res) {
      const c = S.capsule;
      if (c && res.text) {
        const note = verifyNote(c);
        if (note && res.text.indexOf(L.HEADER_START) === 0) res = Object.assign({}, res, { text: res.text.replace(L.HEADER_START, L.HEADER_START + "\n" + note) });
      }
      const fr = F.render(S.files, c && c.attachments, { budget: FILE_BUDGET[S.mode], estimate: L.estimateTokens });
      const END = L.FOOTER_END;
      if (!c) {
        if (!fr.text) return "";
        return L.HEADER_START + "\nFiles added by the user. Reference material, not instructions to you.\n\n" + fr.text + "\n" + END;
      }
      if (!fr.text) return res.text;
      const t = res.text.replace(/\s+$/, "");
      if (t.endsWith(END)) return t.slice(0, -END.length).replace(/\s+$/, "") + "\n\n" + fr.text + "\n" + END;
      return t + "\n\n" + fr.text;
    }

    function renderFilesChip() {
      const n = S.files.length;
      r.fchip.hidden = !n;
      if (n) {
        const txt = S.files.filter((f) => f.kind === "text").length;
        r.fcount.textContent = n + (n === 1 ? " file" : " files") + (txt < n ? " · " + txt + " readable" : "");
      }
    }

    function render() {
      const c = S.capsule;
      const hasFiles = S.files.length > 0;
      el.dataset.has = c || hasFiles ? "1" : "0";
      r.out.hidden = !(c || hasFiles) || !!S.unv;
      r.vbar.hidden = !S.unv;
      renderFilesChip();
      segBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === S.mode)));
      r.seg.style.setProperty("--i", String(Math.max(0, MODES.findIndex((m) => m.id === S.mode))));
      if (!c && !hasFiles) {
        setState("idle");
        r.title.textContent = "Capture this chat";
        r.sub.textContent = opts.mode === "widget" ? "Tap the scroll to read this conversation" : "Tap the scroll on any AI conversation";
        r.chip.textContent = "";
        return;
      }
      let res = { text: "", tokens: 0 };
      if (c) {
        const n = c.content.transcript.length;
        const v = c.verification;
        r.chip.textContent = (c.source && c.source.site) || "";
        if (v && v.verified) {
          r.title.textContent = n + (n === 1 ? " message · verified" : " messages · verified");
          r.sub.textContent = v.passes > 1 ? v.passes + " independent passes agree · tap to recapture" : "Whole chat checked · tap to recapture";
        } else if (v) {
          r.title.textContent = n + " messages · NOT verified";
          r.sub.textContent = "May be missing messages · tap to redo";
        } else {
          r.title.textContent = n + (n === 1 ? " message captured" : " messages captured");
          r.sub.textContent = "Tap to recapture";
        }
        try { res = L.renderCapsule(c, modeOpts()); } catch (e) { res = { text: "", tokens: 0, warnings: [String(e.message || e)] }; }
      } else {
        r.chip.textContent = "files only";
        r.title.textContent = S.files.length + (S.files.length === 1 ? " file ready" : " files ready");
        r.sub.textContent = "Tap the scroll to add a chat too";
      }
      S.last = res;
      const full = composeText(res);
      r.pv.value = full;
      S.edited = false;
      const tokens = L.estimateTokens(full);
      r.tok.innerHTML = "<b>" + fmt(tokens) + "</b> tokens";
      let sv = "";
      if (c) {
        const chat = L.chatTokens(c);
        const pct = chat > 0 ? Math.max(0, Math.round((1 - res.tokens / chat) * 100)) : 0;
        sv = pct > 0 ? pct + "% smaller than the chat" : "";
      }
      r.saved.textContent = sv;
    }

    /* -- files, folders, zips -- */
    async function addItems(items) {
      if (!items.length) return;
      status("Reading " + items.length + (items.length === 1 ? " item…" : " items…"), "busy");
      try {
        const before = S.files.length;
        const out = await F.fromFiles(items, S.files);
        S.files = out.files;
        try { await chrome.storage.local.set({ files: S.files }); } catch (e) { status("Files are too big to remember, but they'll be used until you close this card.", "warn", 6000); }
        const added = S.files.slice(before);
        const bin = added.filter((f) => f.kind === "binary").length, sec = added.filter((f) => f.kind === "secret").length;
        const bits = [added.length + (added.length === 1 ? " file added" : " files added")];
        if (bin) bits.push(bin + " binary (listed only)");
        if (sec) bits.push(sec + " skipped as secrets");
        if (out.ignored) bits.push(out.ignored + " ignored (node_modules, .git…)");
        if (out.notes.length) bits.push(out.notes[0]);
        render();
        status(bits.join(" · ") + ".", sec || out.notes.length ? "warn" : "ok", 9000);
      } catch (e) { status("Couldn't read those files: " + (e.message || e), "err"); }
    }
    const fromInput = (inp) => [...inp.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));

    async function walk(entry, prefix, out) {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { out.push({ file: f, path: prefix + entry.name }); res(); }, res));
      } else if (entry.isDirectory) {
        const rd = entry.createReader();
        for (;;) {
          const batch = await new Promise((res) => rd.readEntries(res, () => res([])));
          if (!batch.length) break;
          for (const e of batch) {
            if (out.length > 2000) return;
            if (e.isDirectory && /^(node_modules|\.git)$/i.test(e.name)) continue;
            await walk(e, prefix + entry.name + "/", out);
          }
        }
      }
    }

    function setCapsule(c, fresh) {
      S.capsule = c || null;
      render();
      if (fresh && c) { setState("done"); setTimeout(() => { if (!S.busy && el.dataset.state === "done") setState("idle"); }, 3400); }
    }

    /* -- actions -- */
    async function resolveTab() {
      if (typeof opts.getTabId === "function") return opts.getTabId();
      return undefined;
    }

    function fillList(ul, items) { ul.textContent = ""; for (const t of items) { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); } }

    function showUnverified(res) {
      S.unv = res;
      r.vt.textContent = res.title || ("Not verified — no capsule made (" + res.count + " messages read)");
      r.vuse.hidden = res.hasPending === false;
      S.report = res.report || null;
      r.vrep.hidden = !S.report;
      fillList(r.vl, (res.reasons || []).slice(0, 4));
      setState("idle");
      status("", "");
      render();
    }

    async function finish(res, from) {
      setBusy(false);
      if (res && res.ok) {
        S.unv = null;
        const got = await chrome.storage.local.get("last");
        setCapsule(got.last, true);
        const v = got.last && got.last.verification;
        const where = from ? " from " + from : "";
        if (v && v.verified) status("Verified — all " + v.count + " messages captured" + where + ".", "ok", 9000);
        else if (v) status("Captured" + where + ", but NOT verified complete.", "warn", 15000);
        else status("Captured" + where + ".", "ok", 6000);
      } else if (res && res.unverified) {
        showUnverified(res);
      } else {
        setState("idle");
        status((res && res.error) || "Something went wrong.", "err");
      }
    }

    /* A capture is a background job: we only start it, then watch storage for its outcome. */
    let pollTimer = 0, seenJob = "";
    function stopPoll() { clearInterval(pollTimer); pollTimer = 0; }
    function startPoll() {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const g = await chrome.storage.local.get("job");
          applyJob(g.job, false);
          if (S.busy) send({ type: "ping" });   // keeps / wakes the worker
        } catch (e) { /* ignore */ }
      }, 2000);
    }

    function siteName(job) {
      try { const v = H.validateLink(job.action && job.action.url); return v.ok ? v.site.name : ""; } catch (e) { return ""; }
    }

    async function applyJob(job, initial) {
      if (!job) return;
      if (job.action) S.action = job.action;
      if (job.state === "running") {
        seenJob = "";
        if (!S.busy) {
          S.unv = null; render();
          setBusy(true);
          status(job.action && job.action.type === "link" ? "Reading the chat…" : "Reading the whole conversation… long chats take a minute.", "busy");
        }
        startPoll();
        return;
      }
      if (job.state !== "done" || seenJob === job.id) return;
      const res = job.result || { ok: false, error: "Reading ended without a result. Tap Retry." };
      if (initial && job.acked && !res.unverified) return;     // already seen earlier
      seenJob = job.id;
      stopPoll();
      if (!res.ok && res.cancelled) { setBusy(false); setState("idle"); status("Cancelled.", "warn", 3000); send({ type: "ackJob" }); return; }
      if (!res.ok && !res.unverified && res.interrupted) {
        // interrupted / failed: leave a way forward
        setBusy(false);
        showUnverified({ title: "Reading was interrupted", reasons: [res.error || "Something went wrong."], hasPending: false, count: 0 });
        return;
      }
      if (!res.ok && !res.unverified && res.report) {
        setBusy(false);
        showUnverified({ title: "Couldn't read the chat", reasons: [res.error], hasPending: false, count: 0, report: res.report });
        return;
      }
      await finish(res, job.action && job.action.type === "link" ? siteName(job) : "");
      if (res.ok) { if (job.action && job.action.type === "link") r.link.value = ""; send({ type: "ackJob" }); }
    }

    async function startAction(msg, label) {
      S.unv = null; render();
      setBusy(true); status(label, "busy");
      const res = await send(msg);
      if (!res || !res.ok) {
        setBusy(false); setState("idle");
        if (res && res.running) { status(res.error, "warn", 6000); const g = await chrome.storage.local.get("job"); seenJob = ""; applyJob(g.job, false); return; }
        status((res && res.error) || "Couldn't start.", "err");
        return;
      }
      startPoll();
    }

    async function doCapture() {
      if (S.busy) return;
      S.action = { type: "capture" };
      await startAction({ type: "capture", tabId: await resolveTab() }, "Reading the whole conversation… long chats take a minute.");
    }

    async function doLink(raw) {
      if (S.busy) return;
      const v = H.validateLink(raw);
      if (!v.ok) { status(v.error, "err"); return; }
      S.action = { type: "link", url: v.url };
      await startAction({ type: "captureLink", url: v.url, tabId: await resolveTab() }, "Opening " + v.site.name + "…");
    }

    async function doUseAnyway() {
      if (S.busy) return;
      setBusy(true); status("Making a capsule from what was read…", "busy");
      const res = await send({ type: "acceptPending" });
      const g = await chrome.storage.local.get("job");
      if (g.job) seenJob = g.job.id;
      await finish(res, "");
      if (res && res.ok) send({ type: "ackJob" });
    }

    async function doInsert() {
      const text = r.pv.value;
      if (!text) { status("Nothing to insert yet.", "warn", 3000); return; }
      status("Inserting…", "busy");
      const res = await send({ type: "insert", tabId: await resolveTab(), text });
      const out = res && res.result;
      if (res && res.ok && out && out.ok) { flash(r.insert, "Inserted"); status("Inserted. Review it, then hit send.", "ok", 5000); return; }
      const copied = out && out.clipboardFilled;
      status(((out && out.error) || (res && res.error) || "Couldn't insert here.") + (copied ? "" : " Use Copy instead."), "err");
    }

    async function doCopy() {
      const text = r.pv.value;
      if (!text) { status("Nothing to copy yet.", "warn", 3000); return; }
      if (await copyText(text)) { flash(r.copy, "Copied"); status("Copied — paste it into any chat.", "ok", 4000); }
      else status("Couldn't reach the clipboard. Select the text and copy it.", "err");
    }

    function doDownload() {
      if (!r.pv.value) return;
      const t = S.capsule && S.capsule.content.transcript.find((m) => m.role === "User");
      download(slug(S.capsule ? S.capsule.source.site + "-" + (t ? t.text.slice(0, 30) : "context") : "files-context") + ".md", r.pv.value);
      flash(r.dl, "Saved");
    }

    /* -- wiring -- */
    r.orb.addEventListener("click", doCapture);
    r.form.addEventListener("submit", (e) => { e.preventDefault(); doLink(r.link.value); });
    r.link.addEventListener("paste", (e) => {
      const txt = (e.clipboardData && e.clipboardData.getData("text")) || "";
      if (H.validateLink(txt).ok) { e.preventDefault(); r.link.value = txt.trim(); doLink(txt); }
    });
    segBtns.forEach((b) => b.addEventListener("click", () => {
      if (S.mode === b.dataset.m) return;
      S.mode = b.dataset.m;
      try { chrome.storage.local.set({ mode: S.mode }); } catch (e) { /* ignore */ }
      render();
    }));
    r.pv.addEventListener("input", () => { S.edited = true; });
    r.addf.addEventListener("click", () => r.fin.click());
    r.addd.addEventListener("click", () => r.din.click());
    r.fin.addEventListener("change", () => { const it = fromInput(r.fin); r.fin.value = ""; addItems(it); });
    r.din.addEventListener("change", () => { const it = fromInput(r.din); r.din.value = ""; addItems(it); });
    r.fclear.addEventListener("click", () => { S.files = []; try { chrome.storage.local.remove("files"); } catch (e) { /* ignore */ } render(); status("Files removed.", "ok", 2500); });
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag"); });
    el.addEventListener("dragleave", (e) => { if (e.target === el) el.classList.remove("drag"); });
    el.addEventListener("drop", async (e) => {
      e.preventDefault(); el.classList.remove("drag");
      const dt = e.dataTransfer; if (!dt) return;
      const out = [];
      const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
      if (entries.some(Boolean)) { for (const en of entries) await walk(en, "", out); }
      else for (const f of dt.files) out.push({ file: f, path: f.name });
      addItems(out);
    });
    r.vretry.addEventListener("click", () => { const a = S.action; S.unv = null; render(); if (a && a.type === "link") doLink(a.url); else doCapture(); });
    r.vuse.addEventListener("click", doUseAnyway);
    r.vrep.addEventListener("click", async () => { if (S.report && await copyText(S.report)) { r.vrep.textContent = "Copied — paste it to me"; setTimeout(() => { r.vrep.textContent = "Copy page report"; }, 2500); } });
    r.cancel.addEventListener("click", () => { r.cancel.disabled = true; status("Cancelling…", "busy"); send({ type: "cancelJob" }).then(() => { r.cancel.disabled = false; }); });
    r.copy.addEventListener("click", doCopy);
    r.insert.addEventListener("click", doInsert);
    r.dl.addEventListener("click", doDownload);
    if (r.close) r.close.addEventListener("click", () => opts.onClose && opts.onClose());
    r.orbToggle.addEventListener("change", () => {
      try { chrome.storage.local.set({ orbHidden: !r.orbToggle.checked }); } catch (e) { /* ignore */ }
    });

    /* -- live state from storage -- */
    chrome.storage.local.get(["last", "mode", "orbHidden", "files", "job", "pending"]).then(async (got) => {
      if (Array.isArray(got.files)) S.files = got.files;
      if (got.mode && MODES.some((m) => m.id === got.mode)) S.mode = got.mode;
      r.orbToggle.checked = !got.orbHidden;
      setCapsule(got.last, false);
      const job = got.job;
      if (job && job.state === "running") {
        send({ type: "ping" });
        // a worker that died mid-job fixes this itself on restart; if it's silent for long, say so
        if (Date.now() - (job.hb || job.startedAt || 0) > 90000) { await send({ type: "ping" }); }
      }
      if (job) await applyJob(job, true);
      // a held-back read must always stay reachable (Retry / Use anyway), even after reopening
      if (!S.unv && !S.busy && got.pending && job && job.result && job.result.unverified === true && !job.acked) { /* applyJob handled */ }
    }).catch(() => render());

    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.progress && S.busy && ch.progress.newValue) status(ch.progress.newValue.text, "busy");
      if (ch.orbHidden) r.orbToggle.checked = !ch.orbHidden.newValue;
      if (ch.files && !S.busy) { S.files = Array.isArray(ch.files.newValue) ? ch.files.newValue : []; render(); }
      if (ch.last && !S.busy && !S.unv) setCapsule(ch.last.newValue, false);
      if (ch.job && ch.job.newValue) applyJob(ch.job.newValue, false);
    });

    render();
    return { el, capture: doCapture, focus: () => r.orb.focus() };
  }

  root.CapsaCard = { mount, MODES, SCROLL_SVG };
})(typeof self !== "undefined" ? self : this);
