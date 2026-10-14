/* Capsa — shared-page data tap. Runs inside the page (not the extension sandbox) before the page's own scripts, on
   ChatGPT share pages only. It keeps a copy of the JSON the page itself downloads to draw the conversation, so the
   reader can use that instead of scrolling. It only listens; it changes nothing the page sees and sends nothing anywhere. */
(function () {
  "use strict";
  if (window.__capsaTap) return;
  window.__capsaTap = true;
  const store = [];
  let total = 0;
  const MAX = 40, CAP = 30 * 1024 * 1024;
  function keep(url, status, text) {
    try {
      if (typeof text !== "string" || text.length < 150 || status < 200 || status > 299) return;
      if (total + text.length > CAP) return;
      store.push({ url: String(url || "").slice(0, 300), status, text });
      total += text.length;
      while (store.length > MAX) total -= store.shift().text.length;
    } catch (e) { /* ignore */ }
  }
  try {
    const of = window.fetch;
    window.fetch = function () {
      const p = of.apply(this, arguments);
      try {
        const a0 = arguments[0];
        const url = a0 && a0.url ? a0.url : a0;
        p.then((r) => { try { r.clone().text().then((t) => keep(url, r.status, t)).catch(() => {}); } catch (e) {} }).catch(() => {});
      } catch (e) { /* ignore */ }
      return p;
    };
  } catch (e) { /* ignore */ }
  try {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url) {
      try {
        this.addEventListener("load", () => {
          try {
            const rt = this.responseType;
            if (rt === "" || rt === "text") keep(url, this.status, this.responseText);
            else if (rt === "json" && this.response) keep(url, this.status, JSON.stringify(this.response));
          } catch (e) {}
        });
      } catch (e) {}
      return open.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }
  document.addEventListener("capsa-tap-get", () => {
    try { document.dispatchEvent(new CustomEvent("capsa-tap-data", { detail: JSON.stringify({ installed: true, items: store }) })); } catch (e) {}
  });
})();
