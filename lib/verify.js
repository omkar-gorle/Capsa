/* Capsa — completeness verification for a captured chat.
   Pure logic (no DOM) so it runs in the page, in the service worker and in Node tests.

   A capture is "verified" only when ALL of these hold:
     top        we reached the very start and nothing more was still loading there
     bottom     we reached the very end
     agree      two independent passes over the chat (different direction and step size) produced
                exactly the same messages in exactly the same order
     jumps      no scroll step landed on content that didn't overlap the previous one
     holes      no vertical gap between neighbouring messages big enough to hide a message
     sequence   when the site numbers its turns (e.g. ChatGPT), the numbers are consecutive
     time       the reader finished instead of running out of time
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaVerify = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const quantile = (arr, p) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  };

  /** Fingerprint the entire message: long replies often share an identical opening. */
  function fingerprint(m) {
    const text = String(m.text || "");
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ (c + i), 0x85ebca6b);
    }
    return m.role + "|" + text.length + "|" + (a >>> 0).toString(36) + "." + (b >>> 0).toString(36);
  }

  /** Where could a message be hiding? entries: [{y, h}] in reading order. -> [{after, gap}] */
  function findHoles(entries) {
    const gaps = [];
    for (let i = 0; i + 1 < entries.length; i++) {
      const a = entries[i], b = entries[i + 1];
      if (typeof a.y !== "number" || typeof b.y !== "number") return [];
      gaps.push(b.y - (a.y + (a.h || 0)));
    }
    const pos = gaps.filter((g) => g >= 0);
    const limit = Math.max(64, quantile(pos, 0.9) * 2 + 16);
    const holes = [];
    gaps.forEach((g, i) => { if (g > limit) holes.push({ after: i, gap: Math.round(g) }); });
    return holes;
  }

  /** Index of the first place two fingerprint lists differ, or -1. */
  function firstDifference(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return -1;
  }

  /** Sequence numbers (if the site gives them) must be consecutive. -> { available, ok, missing[] } */
  function checkSequence(seqs) {
    const nums = seqs.filter((n) => typeof n === "number" && isFinite(n));
    if (nums.length < Math.max(2, Math.floor(seqs.length * 0.9))) return { available: false, ok: true, missing: [] };
    const missing = [];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] <= nums[i - 1]) return { available: true, ok: false, missing, reason: "out of order" };
      for (let n = nums[i - 1] + 1; n < nums[i]; n++) { if (missing.length < 20) missing.push(n); }
    }
    const startsOk = nums[0] <= 1;
    return { available: true, ok: !missing.length && startsOk, missing, startsAt: nums[0] };
  }

  /**
   * evidence: {
   *   passes: [{ fps:[string], entries:[{y,h,seq?}], jumps:number }],   (the last two are compared)
   *   reachedTop, topSettled, loadMore, bottomReached, timedOut, firstRole
   * }
   * -> { verified, checks:[{id,ok,detail}], count, passes, reasons:[string] }
   */
  function evaluate(ev) {
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: detail || "" });
    const P = ev.passes || [];
    const last = P[P.length - 1], prev = P[P.length - 2];

    add("top", ev.reachedTop && ev.topSettled && !ev.loadMore,
      !ev.reachedTop ? "never reached the top of the chat" :
      ev.loadMore ? "the page still offers to load earlier messages" :
      !ev.topSettled ? "older messages were still arriving at the top" : "reached the start; nothing more loads");
    add("bottom", ev.bottomReached, ev.bottomReached ? "reached the end" : "never reached the end of the chat");

    let agreeOk = false, agreeDetail = "needs two passes";
    if (last && prev) {
      const d = firstDifference(last.fps, prev.fps);
      agreeOk = d < 0;
      agreeDetail = agreeOk ? "two independent passes found the same " + last.fps.length + " messages in the same order"
        : "passes disagree at message " + (d + 1) + " (" + prev.fps.length + " vs " + last.fps.length + " messages)";
    }
    add("agree", agreeOk, agreeDetail);

    const jumps = P.reduce((n, p) => n + (p.jumps || 0), 0);
    add("jumps", jumps === 0, jumps ? jumps + " scroll step(s) landed on content that didn't overlap the last" : "every scroll step overlapped the last");

    const holes = last ? findHoles(last.entries || []) : [];
    add("holes", holes.length === 0, holes.length ? holes.length + " gap(s) between messages could hide missing messages (after message " + (holes[0].after + 1) + ")" : "no gaps between messages");

    const seq = last ? checkSequence((last.entries || []).map((e) => e.seq)) : { available: false, ok: true, missing: [] };
    add("sequence", seq.ok, !seq.available ? "site doesn't number its turns (skipped)" : seq.ok ? "turn numbers are consecutive" :
      seq.missing.length ? "turn number(s) missing: " + seq.missing.slice(0, 8).join(", ") : seq.startsAt > 1 ? "numbering starts at " + seq.startsAt + ", not 1" : "turn numbers are out of order");

    add("time", !ev.timedOut, ev.timedOut ? "ran out of time before the chat settled" : "finished");

    const reasons = checks.filter((c) => !c.ok).map((c) => c.detail);
    return { verified: checks.every((c) => c.ok), checks, count: last ? last.fps.length : 0, passes: P.length, reasons };
  }

  return { fingerprint, findHoles, firstDifference, checkSequence, evaluate, quantile };
});
