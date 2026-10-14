/* Capsa — floating orb on AI sites. Click (or drag) it; it opens the same card as the toolbar popup.
   Lives in a shadow root so the page's CSS can't touch it and ours can't touch the page. */
(function () {
  "use strict";
  if (window.top !== window || window.__capsaLauncher) return;
  window.__capsaLauncher = true;
  if (!window.CapsaCard || !window.CapsuleLib || !window.CapsaHosts) return;

  const SIZE = 56, MARGIN = 14;
  const host = document.createElement("capsa-orb");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483646;right:" + 24 + "px;bottom:" + 24 + "px;width:" + SIZE + "px;height:" + SIZE + "px;";
  const sh = host.attachShadow({ mode: "open" });

  sh.innerHTML = `
<style>
:host{all:initial}
.dock{position:absolute;inset:0;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
.bubble{position:absolute;right:0;bottom:0;height:${SIZE}px;width:${SIZE}px;border-radius:${SIZE / 2}px;border:0;padding:0;cursor:grab;color:#f7f6ea;
  display:flex;align-items:center;justify-content:flex-end;overflow:hidden;touch-action:none;background:#000;
  box-shadow:0 8px 26px rgba(8,6,4,.6),0 0 24px rgba(161,45,43,.55);
  transition:width .42s cubic-bezier(.3,1.5,.5,1),box-shadow .3s,transform .2s;animation:glow 3.6s ease-in-out infinite}
.bubble::before{content:"";position:absolute;left:50%;top:50%;width:320px;height:320px;margin:-160px 0 0 -160px;
  background:conic-gradient(from 0deg,#a12d2b,#dc6949,#f3b63f,#dc6949,#a12d2b);animation:spin 7s linear infinite}
.bubble::after{content:"";position:absolute;inset:2.5px;border-radius:${SIZE / 2}px;background:#000}
.lab,.ico{position:relative;z-index:1}
.bubble:hover,.bubble:focus-visible{width:136px;outline:0}
.bubble:active{cursor:grabbing;transform:scale(.96)}
.lab{position:absolute!important;left:22px;font-weight:650;font-size:13px;letter-spacing:.2px;opacity:0;transform:translateX(8px);transition:opacity .25s .05s,transform .3s .05s;white-space:nowrap}
.bubble:hover .lab,.bubble:focus-visible .lab{opacity:1;transform:none}
.ico{width:${SIZE}px;height:${SIZE}px;flex:none;display:grid;place-items:center}
.ico svg{width:32px;height:32px;overflow:visible}
.sc-sheet{fill:#f7f6ea;stroke:#f3b63f;stroke-width:.8}.sc-ln{stroke:#7d8176;stroke-width:1.6;stroke-linecap:round;fill:none}
.sc-scan{fill:#f3b63f;opacity:0}.sc-roll{fill:url(#cxroll)}.sc-rod{fill:#a12d2b}.sc-knob{fill:#f3b63f}
.sc-seal{fill:#be4939;stroke:#f3b63f;stroke-width:1.2}.sc-tick{fill:none;stroke:#f7f6ea;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:14;stroke-dashoffset:14}
.sc-l,.sc-r,.sc-sh,.sc-seal-g{transform-box:view-box;transform-origin:24px 24px;transition:transform .55s cubic-bezier(.3,1.35,.5,1)}
.sc-l{transform:translateX(8px)}.sc-r{transform:translateX(-8px)}.sc-sh{transform:scaleX(0)}.sc-seal-g{transform:scale(0);transform-origin:24px 30px}
.bubble:hover .sc-l,.bubble:focus-visible .sc-l{transform:translateX(3px)}.bubble:hover .sc-r,.bubble:focus-visible .sc-r{transform:translateX(-3px)}.bubble:hover .sc-sh,.bubble:focus-visible .sc-sh{transform:scaleX(.7)}
.dock[data-open="1"] .sc-l,.dock[data-open="1"] .sc-r,.dock[data-open="1"] .sc-sh{transform:none}
.dock[data-state="busy"] .sc-l{animation:scL 2.6s ease-in-out infinite}.dock[data-state="busy"] .sc-r{animation:scR 2.6s ease-in-out infinite}
.dock[data-state="busy"] .sc-sh{animation:scS 2.6s ease-in-out infinite}.dock[data-state="busy"] .sc-scan{animation:scScan 2.6s ease-in-out infinite}
.dock[data-state="busy"] .sc-ln{animation:scLn 2.6s ease-in-out infinite}
.dock[data-state="done"] .sc-l,.dock[data-state="done"] .sc-r,.dock[data-state="done"] .sc-sh{transform:none}
.dock[data-state="done"] .sc-seal-g{transform:scale(1);transition-delay:.25s}.dock[data-state="done"] .sc-tick{animation:draw .4s .6s ease-out forwards}
.pop{position:absolute;width:340px;max-width:calc(100vw - 28px);max-height:calc(100vh - ${SIZE + MARGIN * 2 + 12}px);overflow:auto;border-radius:24px;
  box-shadow:0 22px 60px rgba(8,6,4,.7),0 0 0 1px rgba(247,246,234,.1);opacity:0;transform:scale(.86) translateY(10px);pointer-events:none;
  transition:opacity .2s,transform .38s cubic-bezier(.3,1.5,.5,1);scrollbar-width:none}
.pop::-webkit-scrollbar{display:none}
.dock[data-open="1"] .pop{opacity:1;transform:none;pointer-events:auto}
.pop.up{bottom:${SIZE + 12}px;transform-origin:bottom right}.pop.down{top:${SIZE + 12}px;transform-origin:top right}
.pop.r{right:0}.pop.l{left:0}.pop.l.up{transform-origin:bottom left}.pop.l.down{transform-origin:top left}
@keyframes glow{50%{box-shadow:0 8px 26px rgba(8,6,4,.6),0 0 34px rgba(243,182,63,.5)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes scL{0%,100%{transform:translateX(8px)}30%,70%{transform:translateX(0)}}
@keyframes scR{0%,100%{transform:translateX(-8px)}30%,70%{transform:translateX(0)}}
@keyframes scS{0%,100%{transform:scaleX(0)}30%,70%{transform:scaleX(1)}}
@keyframes scScan{0%,30%{transform:translateX(0);opacity:0}34%{opacity:.85}66%{transform:translateX(19px);opacity:.85}70%,100%{transform:translateX(19px);opacity:0}}
@keyframes scLn{0%,28%{opacity:.15}45%,60%{opacity:1}100%{opacity:.15}}
@keyframes draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition-duration:.001s!important}}
</style>
<div class="dock" data-open="0">
  <div class="pop up r" part="pop"></div>
  <button class="bubble" aria-label="Capsa — capture this chat" aria-expanded="false" title="Capsa (drag to move)">
    <span class="lab">Capsa</span>
    <span class="ico"></span>
  </button>
</div>`;

  const dock = sh.querySelector(".dock");
  sh.querySelector(".ico").innerHTML = window.CapsaCard.SCROLL_SVG;
  const pop = sh.querySelector(".pop");
  const bubble = sh.querySelector(".bubble");
  let mounted = false, open = false;

  function place() {
    const r = host.getBoundingClientRect();
    const up = r.top + r.height / 2 > innerHeight / 2;
    const right = r.left + r.width / 2 > innerWidth / 2;
    pop.className = "pop " + (up ? "up" : "down") + " " + (right ? "r" : "l");
  }

  function setOpen(v) {
    open = v;
    if (v && !mounted) {
      mounted = true;
      window.CapsaCard.mount(pop.attachShadow({ mode: "open" }), { mode: "widget", onClose: () => setOpen(false), onState: (st) => { dock.dataset.state = st; } });
      // Keep page hotkeys (and paste handlers) from reacting to typing inside the card.
      ["keydown", "keyup", "keypress", "paste"].forEach((t) => pop.addEventListener(t, (e) => e.stopPropagation()));
    }
    if (v) place();
    dock.dataset.open = v ? "1" : "0";
    bubble.setAttribute("aria-expanded", String(v));
  }

  /* drag to move; a tap toggles */
  let drag = null;
  bubble.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = host.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, moved: false };
    bubble.setPointerCapture(e.pointerId);
  });
  bubble.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    const x = Math.min(Math.max(MARGIN, drag.l + dx), innerWidth - SIZE - MARGIN);
    const y = Math.min(Math.max(MARGIN, drag.t + dy), innerHeight - SIZE - MARGIN);
    host.style.left = x + "px"; host.style.top = y + "px"; host.style.right = "auto"; host.style.bottom = "auto";
    if (open) place();
  });
  bubble.addEventListener("pointerup", (e) => {
    try { bubble.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const d = drag; drag = null;
    if (!d) return;
    if (d.moved) {
      const r = host.getBoundingClientRect();
      try { chrome.storage.local.set({ orbPos: { fx: r.left / innerWidth, fy: r.top / innerHeight } }); } catch (_) { /* ignore */ }
    } else setOpen(!open);
  });
  bubble.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setOpen(!open); }
    else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) setOpen(false); }, true);

  function applyPos(p) {
    if (!p || typeof p.fx !== "number") return;
    const x = Math.min(Math.max(MARGIN, p.fx * innerWidth), innerWidth - SIZE - MARGIN);
    const y = Math.min(Math.max(MARGIN, p.fy * innerHeight), innerHeight - SIZE - MARGIN);
    host.style.left = x + "px"; host.style.top = y + "px"; host.style.right = "auto"; host.style.bottom = "auto";
  }
  window.addEventListener("resize", () => {
    const r = host.getBoundingClientRect();
    applyPos({ fx: r.left / Math.max(innerWidth, 1), fy: r.top / Math.max(innerHeight, 1) });
    if (open) place();
  });

  function setHidden(h) { host.style.display = h ? "none" : ""; if (h && open) setOpen(false); }

  try {
    chrome.storage.local.get(["orbPos", "orbHidden"]).then((g) => { applyPos(g.orbPos); setHidden(!!g.orbHidden); }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.orbHidden) setHidden(!!ch.orbHidden.newValue);
    });
  } catch (_) { /* extension context gone (updated/reloaded) */ }

  (document.body || document.documentElement).appendChild(host);
})();
