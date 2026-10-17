/* Capsa — structured conversation understanding (pure logic, no DOM, no network; runs in the page, the worker and Node).

   Four stages that are kept apart on purpose, so each can be tested and changed alone:

     1. extract(messages)         -> items      what was said: goals, requirements, prohibitions, decisions, corrections,
                                                errors, fixes, tasks, technical details, references. Nothing is dropped here.
     2. resolve(items)            -> items      how it changed over time: a correction supersedes ONLY what it clearly refers to;
                                                a later plain mention is not an override; unclear cases are flagged, not guessed.
     3. rank(items)               -> model      importance tiers (see TIERS) and a score inside each tier.
     4. generate(model, options)  -> text       fits a token budget by dropping the LOWEST tier first; tier-1 items are never dropped.
        verify(model, text)       -> report     checks that the critical items are in the text and that nothing superseded is shown as active.

   understand(messages, options) runs stages 1-3. generate() and verify() take its result.
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaUnderstand = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Importance tiers, most important first. A lower number is kept longer when space runs out. */
  const TIERS = {
    CONSTRAINT: 1, PROHIBITION: 1, DECISION: 1,      // critical constraints, explicit prohibitions, final decisions
    GOAL: 2,                                          // core goal and desired outcome
    STATE: 3, CORRECTION: 3, BLOCKER: 3, NEXT: 3,     // current state, corrections, blockers, next actions
    TECH: 4,                                          // essential technical details and dependencies
    RATIONALE: 5, HISTORY: 5,                         // supporting rationale and useful history
    NOISE: 6,                                         // redundant explanations, conversational filler: never emitted
  };

  /* ------------------------------------------------------------------ small text helpers */
  const FENCE = /(`{3,4})([\w+#.-]*)\n([\s\S]*?)\1/g;
  const stripCode = (t) => String(t || "").replace(/(`{3,4})[\s\S]*?\1/g, " ").replace(/`{3,4}[\s\S]*$/, " ");
  const oneLine = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const clip = (t, n) => { t = oneLine(t); return t.length <= n ? t : t.slice(0, Math.max(1, n - 1)).replace(/\s+\S*$/, "") + "…"; };
  const norm = (t) => oneLine(t).toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
  // typed-fast noise: ". . ", "...", ",,", "//" carry no meaning and make the notes look broken
  const speech = (t) => oneLine(String(t || "").replace(/(?:\s*\.){2,}/g, " ").replace(/\s*,{2,}/g, ",").replace(/\s+\/\/+\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1")).replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, "");
  function sentences(text) {
    return stripCode(text)
      .split(/\n+/)
      .filter((ln) => !/^\s*#{1,6}\s/.test(ln))                                              // markdown headings are labels, not statements
      .map((ln) => ln.replace(/\*\*([^*]{1,40}):\*\*\s*/g, ""))                              // "**Zips:** ..." -> "..."
      .join("\n")
      .split(/(?<=[.!?।])\s+|\n+/)
      .map((s) => s.replace(/^\s*(?:[-*•>]|\d+[.)])\s+/, "").replace(/^\*+|\*+$/g, "").trim())
      .filter((s) => s.length >= 8 && s.length <= 420 && !(/:\s*$/.test(s) && s.length < 70) && s.split(/\s+/).length >= 2);
  }
  const isQuestion = (s) => /\?\s*$/.test(s);

  const STOP = new Set(("the a an and or but if then than that this these those with without for from into onto over under about after before while when where which what who whom whose how why " +
    "are was were been being have has had having does did doing done will would could should shall may might must can cannot just also very much more most some any all each every other such only own same " +
    "not nor too its it's i'm i've i'll i'd you your yours our ours their them they his her him she he we us me my mine one two get got make made let lets use used using need needs want wants like please thanks thank " +
    "here there now still again really actually already even ever never always " +
    "hai hain tha thi the ko ka ki ke se me mein aur ya yeh ye woh wo kya bhi toh to hi par pe ek isko usko isme usme abhi bas koi kuch mujhe mera meri mere hum tum aap apna").split(/\s+/));
  function stem(w) { return w.length > 5 ? w.replace(/(?:ing|ed|es|s)$/, "") : w.replace(/s$/, ""); }
  function topicOf(text) {
    const set = new Set();
    const s = String(text || "");
    for (const f of s.match(/[\w./-]+\.[a-z]{1,5}\b/gi) || []) set.add(f.toLowerCase());               // file names
    for (const id of s.match(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+_[a-z0-9_]+\b/g) || []) set.add(id.toLowerCase()); // identifiers
    for (let w of s.toLowerCase().replace(/colour/g, "color").split(/[^a-z0-9\u0900-\u097F]+/)) {
      if (CANON.size && CANON.has(w)) w = CANON.get(w);                                  // a typo counts as the word it was meant to be
      if ((w.length >= 3 || (w.length === 2 && /[a-z]/.test(w) && /\d/.test(w))) && !STOP.has(w) && !/^\d+$/.test(w)) set.add(/[\u0900-\u097F]/.test(w) ? w : stem(w));
    }
    return set;
  }
  /* Typos: "extention" and "extension" are one topic. Built once per conversation from its own vocabulary:
     words that differ by 1-2 letters are merged into the spelling used most (the assistant's spelling wins ties). */
  let CANON = new Map();
  function buildCanon(messages) {
    const cnt = new Map();
    for (const m of messages || []) {
      const wgt = m.role === "Assistant" ? 2 : 1;
      for (const w of String(m.text || "").replace(/(`{3,4})[\s\S]*?\1/g, " ").toLowerCase().split(/[^a-z]+/)) if (w.length >= 6 && w.length <= 18) cnt.set(w, (cnt.get(w) || 0) + wgt);
    }
    const buckets = new Map();
    for (const w of cnt.keys()) { const k = w[0] + w[1]; (buckets.get(k) || buckets.set(k, []).get(k)).push(w); }
    const canon = new Map();
    const lev = (a, b, max) => {
      if (Math.abs(a.length - b.length) > max) return max + 1;
      let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.length; i++) {
        const cur = [i]; let rowMin = i;
        for (let j = 1; j <= b.length; j++) { const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); cur.push(v); if (v < rowMin) rowMin = v; }
        if (rowMin > max) return max + 1; prev = cur;
      }
      return prev[b.length];
    };
    for (const list of buckets.values()) {
      list.sort((a, b) => cnt.get(b) - cnt.get(a) || b.length - a.length);
      for (let i = 0; i < list.length; i++) {
        const rare = list[i]; if (canon.has(rare)) continue;
        for (let j = 0; j < i; j++) {
          const common = list[j]; if (canon.has(common) || cnt.get(common) <= cnt.get(rare)) continue;
          if (common.startsWith(rare) || rare.startsWith(common)) continue;                  // option / options, show / shown are inflections, not typos
          const max = rare.length >= 8 ? 2 : 1;
          if (lev(rare, common, max) <= max && cnt.get(common) >= 2 * cnt.get(rare) - 1) { canon.set(rare, common); break; }
        }
      }
    }
    return canon;
  }
  function overlap(a, b) {
    if (!a.size || !b.size) return 0;
    let n = 0; for (const x of a) if (b.has(x)) n++;
    return n / Math.min(a.size, b.size);
  }
  const sharedCount = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
  // a shared word counts as "specific" when it is long or looks like an identifier / file name (react, localstorage, app.vue)
  const specificShared = (a, b) => { let n = 0; for (const x of a) if (b.has(x) && (x.length >= 7 || /[._\d]/.test(x))) n++; return n; };
  const linked = (a, b) => sharedCount(a, b) >= 2 || specificShared(a, b) >= 1;

  // key-notes layer (lib/notes.js) is optional: without it the older "at a glance" block is used
  let N = null, NMOD = null;
  try {
    NMOD = (typeof module === "object" && module.exports) ? require("./notes.js") : ((typeof self !== "undefined" ? self : globalThis).CapsaNotes || null);
    if (NMOD) N = NMOD.create({ topicOf, sharedCount, canon: (w) => (CANON.size && CANON.has(w) ? CANON.get(w) : w) });
  } catch (e) { N = null; NMOD = null; }
  // Hindi / Hinglish alternatives for the phrase patterns below (no-op when notes.js is missing)
  const HIK = (k) => new RegExp((NMOD && NMOD.HI[k]) || "(?!)", "i");
  const orRe = (re, k) => { const h = HIK(k); return { test: (t) => re.test(t) || h.test(t), exec: (t) => re.exec(t) || h.exec(t), source: re.source }; };

  /* ------------------------------------------------------------------ patterns */
  const RE_QUOTE_NEG_NOISE = /\b(?:don'?t|do not|can'?t|cannot|won'?t) (?:know|understand|get|see|have|think|remember|care|mind|want to know|really)\b/i;
  const HI_PROHIB = "mat\\s+(?:karo|kar|use|add|change|hatao|chhedo|badlo)|nahi+n? chahiye|kabhi nahi+n?|bilkul nahi+n?|nahi+n? karna|(?:मत\\s+\\S+|नहीं चाहिए|कभी नहीं)";
  const RE_PROHIB = new RegExp("\\b(?:don'?t|do not|never|must not|mustn'?t|should not|shouldn'?t|not allowed|no more|stop (?:using|doing|adding|making|changing|suggesting)|avoid|without (?:using|adding|changing|touching|any)|under no circumstances|off[- ]limits)\\b|" + HI_PROHIB, "i");
  const RE_REQ = orRe(/(?:^(?:please\s+)?use\b)|\b(?:remember to|must|need(?:s)? to|have to|has to|make sure|ensure|always|required?|requirement|should|i want|i need|only|at least|at most|no more than|keep (?:it|the|this|all)|has got to|it has to|needs? (?:a|an|the)\b|use only)\b/i, "req");
  const RE_PREF = /\b(?:i prefer|i like|i love|i hate|i don'?t like|call me|my name is|keep (?:it|the answers?|answers?|replies|responses?|explanations?) (?:short|simple|brief|minimal|concise)|in a (?:simple|short|friendly|formal) (?:way|tone)|tone|style|minimal|beginner|explain (?:it )?(?:simply|like))\b/i;
  const RE_CORR = orRe(/^(?:no[,.!:]|nope\b|wait\b|actually\b|hold on\b|instead\b|correction\b|sorry,? i meant\b|on second thought\b|scrap that\b|forget (?:that|it|about)\b|never ?mind\b|that'?s (?:wrong|not (?:right|correct|what))\b|not what i\b|i (?:meant|said|asked|told)\b|you (?:missed|forgot|ignored|didn'?t|did not|misunderstood)\b|change (?:it|that|this|the)\b.*\bto\b)|\b(?:rather than|not [\w .'-]{2,40}, (?:but |use |make |do )|ignore (?:that|my (?:last|previous|earlier))|i changed my mind|let'?s (?:go with|use|switch|do)|switch(?:ing)? to|replace (?:it|that|this)? ?with)\b/i, "corr");
  const RE_COMPLAINT = orRe(/\b(?:still (?:the same|not|broken|failing|wrong|getting|showing|happening|no)|not working|doesn'?t work|didn'?t work|isn'?t working|same (?:error|problem|issue)|nothing (?:is )?fixed|not fixed|it failed|that failed|didn'?t fix|did not fix|worse|wrong again|again the same)\b/i, "complaint");
  const RE_ALLOW = /\b(?:you can (?:now )?|go ahead and|it'?s (?:fine|ok|okay|alright) to|feel free to|now you may|you may now|you're allowed to)\b/i;
  const RE_DECISION = /\b(?:let'?s (?:use|go with|do|build|keep)|we(?:'ll| will| are going to|'re going to) (?:use|go with|do|build|keep)|decided|decision|going with|i(?:'ll| will) (?:use|go with)|settled on|we chose|chosen|final (?:choice|answer|version|decision)|(?:use|go with|choose|pick) [^.]{1,60} (?:instead of|rather than|over)|switch(?:ing)? to|go(?:ing)? back to|revert(?:ed)? (?:back )?to|stick with|go with (?:option|choice|plan|approach)\b|drop [\w .'-]{2,30})\b/i;
  const TOK = "(?:[^.,;]|\\.(?=\\w))";   // a name may contain a dot: Chart.js, Node.js, v3.2
  const RE_INSTEAD = new RegExp("\\b(?:use|go with|choose|pick|using|switch(?:ing)? to|move to|prefer)\\s+(" + TOK + "{2,60}?)\\s+(?:instead of|rather than|over|not)\\s+(" + TOK + "{2,60})", "i");
  const RE_NOT_USE = new RegExp("\\bnot\\s+(" + TOK + "{2,40}?),\\s*(?:use|go with|make it|do|but)\\s+(" + TOK + "{2,60})", "i");
  const RE_SKIP_USE = new RegExp("\\b(?:skip|drop|remove|ditch|forget|cancel|scrap|without|no need for)\\s+(" + TOK + "{2,50}?)\\s*[,;]?\\s*(?:and\\s+|but\\s+)?(?:use|go with|take|pick|choose|add|try|do)\\s+(" + TOK + "{2,60}?)(?:\\s+instead)?(?=[.,;!]|$)", "i");
  const RE_REPLACE = new RegExp("\\b(?:replace|swap(?: out)?|change)\\s+(" + TOK + "{2,50}?)\\s+(?:with|for|to|by)\\s+(" + TOK + "{2,60})", "i");
  const RE_REVERT = new RegExp("\\b(?:go(?:ing)? back to|revert(?:ed)? (?:back )?to|switch(?:ing)? back to|stick with|keep using|back to)\\s+(" + TOK + "{2,50}?)(?=[,;!]|\\.(?!\\w)|\\s+(?:because|since|as|and|but)\\b|$)", "i");
  /* "use Y instead of X", "not X, use Y", "skip X, use Y", "replace X with Y"  ->  { chosen: Y, rejected: X } */
  function swapOf(s) {
    let m;
    if ((m = RE_INSTEAD.exec(s))) return { chosen: clip(m[1], 60), rejected: clip(m[2], 60) };
    if ((m = RE_NOT_USE.exec(s))) return { chosen: clip(m[2], 60), rejected: clip(m[1], 60) };
    if ((m = RE_SKIP_USE.exec(s))) return { chosen: clip(m[2], 60), rejected: clip(m[1], 60) };
    if ((m = RE_REPLACE.exec(s))) return { chosen: clip(m[2], 60), rejected: clip(m[1], 60) };
    return null;
  }
  /* "go back to X": X is chosen again, and what replaced it (the latest other choice so far) is rejected */
  function revertOf(s, items) {
    const m = RE_REVERT.exec(s); if (!m) return null;
    const chosen = clip(m[1].replace(/[.,;!]+$/, ""), 60), ct = topicOf(chosen);
    for (let k = items.length - 1; k >= 0; k--) {
      const x = items[k];
      if ((x.kind === "decision" || x.asDecision) && x.chosen && !(sharedCount(topicOf(x.chosen), ct) >= 1)) return { chosen, rejected: x.chosen };
    }
    return { chosen, rejected: null };
  }
  /* "go with option B" -> the text of option B from the assistant's list, so the notes say WHAT was chosen */
  function withOption(s, prevA) {
    if (!prevA) return s;
    const ORD = { first: ["1", "A"], second: ["2", "B"], third: ["3", "C"], fourth: ["4", "D"] };
    let labels = null, m;
    if ((m = /\b(?:option|choice|opt|plan|approach|number)\s*[:#]?\s*([A-Da-d]|[1-5])\b/i.exec(s))) labels = [m[1].toUpperCase()];
    else if ((m = /\bthe (first|second|third|fourth)\s+(?:one|option|choice)\b/i.exec(s))) labels = ORD[m[1].toLowerCase()];
    else if ((m = /^(?:go with |pick |choose |take |let'?s (?:go with|do) )?([A-Da-d])[).]?\s*$/i.exec(s.trim()))) labels = [m[1].toUpperCase()];
    if (!labels) return s;
    const body = stripCode(prevA).replace(/\*\*/g, "");
    for (const lb of labels) {
      const r = new RegExp("(?:^|\\n|[\\s;(])(?:option\\s*)?" + lb + "[).:]\\s*([^;\\n]{3,90}?)(?=;|\\n|\\s+[A-D1-5][).]\\s|\\.\\s|$)", "i").exec(body);
      if (r) return s.replace(/[.!\s]+$/, "") + " (= " + lb + ": " + r[1].trim().replace(/[.;,]+$/, "") + ")";
    }
    return s;
  }
  const RE_ISSUE = /\b(?:error|exception|traceback|fail(?:s|ed|ing|ure)?|bug|crash(?:es|ed)?|not working|doesn'?t work|broken|stuck|timed? ?out|cannot|can'?t|undefined|null|403|404|500)\b/i;
  const RE_DONE = orRe(/(?:^[\s]*(?:✅|✔️?|☑️?))|\b(?:implemented|fixed|resolved|completed|deployed|added|created|updated|refactored|renamed|removed|installed|migrated|finished|works? now|now works|is done)\b/i, "done");
  const RE_VERIFIED = /\b(?:verified|confirmed (?:working|fixed)|tests? (?:pass(?:ed|es)?|are passing|all pass)|all (?:\d+ )?(?:tests? )?pass(?:ed|ing)?|works? (?:now|correctly|as expected)|passes?|✅)\b/i;
  const RE_ATTEMPT = /\b(?:i tried|we tried|tried to|attempted|let me try|trying|retry|retrying|workaround)\b/i;
  const RE_PENDING = orRe(/\b(?:todo|to-do|still need to|not yet|left to do|remaining|next step|will (?:need|have) to|haven'?t yet|pending|later)\b/i, "pending");
  const RE_TASK_HEAD = /^(?:#{1,6}\s*)?\**\s*(?:next steps?|remaining(?: work| tasks)?|to-?do|open (?:issues|tasks|items|questions)|action items|still to do|what'?s left)\s*\**:?\s*\**$/i;
  const RE_REQUEST = orRe(/^(?:please\s+)?(?:add|make|fix|create|build|write|implement|update|change|remove|show|give|get|improve|refactor|rename|convert|generate|test|check|explain|find|set up|setup|install|run|delete|support|handle|allow|enable|disable|include|continue|finish|can you|could you|would you|i want you to|i need you to)\b/i, "request");
  const RE_GOALSENT = /^(?:i want to|i'?d like to|i would like to|i(?:'m| am) (?:trying|building|making|working)|help me|we need to (?:build|make|create)|build me|create a|can you (?:build|make|create|help))\b/i;
  const RE_STRONGREQ = /\b(?:must|always|required?|have to|has to|need(?:s)? to|make sure|ensure|at least|at most|no more than|only)\b/i;
  const RE_ACK = orRe(/^(?:yes|yep|yeah|ok(?:ay)?|good|great|perfect|nice|thanks?|thank you|do it|go ahead|sounds good|that works|works|exactly|correct|right|cool|awesome|looks good|lgtm|ship it)\b/i, "ack");
  const RE_RATIONALE = /\b(?:because|since|so that|in order to|the reason|that'?s why|due to|as it|this way|which (?:means|avoids|prevents|allows|keeps))\b/i;
  // an assistant sentence is a BLOCKER only when it is stuck on something from me ("waiting for older history" is a diagnosis, not a blocker)
  const RE_BLOCKER = /\b(?:i(?:'m| am) (?:blocked|stuck|unable)|(?:i|we) (?:can'?t|cannot) (?:proceed|continue|access|run|open|read)|blocked (?:on|by)|blocker|waiting (?:for|on) (?:you|your|me|my|approval|access)|need (?:your|you to|access|permission|approval|the file|a key|credentials)|requires? your)\b/i;
  const RE_CMD_INLINE = /`((?:npm|npx|pip3?|python3?|node|git|docker|cargo|go|make|curl|yarn|pnpm|brew|apt(?:-get)?|chmod|cd|ls|cat|bash|sh|java|mvn|gradle|dotnet|kubectl|terraform|pytest|jest|playwright)\b[^`\n]{0,100})`/g;
  const RE_VERSION = /\b(node(?:\.js)?|python|npm|java|react|vue|angular|svelte|chrome|chromium|firefox|django|flask|fastapi|postgres(?:ql)?|mysql|docker|go|golang|rust|typescript|next(?:\.js)?|windows|macos|ubuntu|manifest(?: ?v)?|mv)\s*v?(\d+(?:\.\d+){0,2})\b/gi;
  const RE_TESTRES = /\b(\d+)\s+(?:tests?\s+)?(passed|failed|errors?|skipped)\b/gi;
  const RE_URL = /https?:\/\/[^\s)>\]"'`]{4,120}/g;
  const RE_FILE = /\b[\w][\w./-]{0,60}\.(?:js|jsx|ts|tsx|py|json|md|html|css|csv|xlsx|docx|pdf|zip|sql|yml|yaml|toml|java|go|rs|cpp|c|h|sh|ipynb|png|jpe?g|gif|svg|txt|env)\b/gi;
  const RE_FOLDER = /(?:^|[\s"'(])((?:[.~]?\/)?(?:[\w.-]+\/){1,6}[\w.-]*)(?=[\s"'),.:;]|$)|\b(?:folder|directory)\s+(?:called |named )?[`"']?([\w./-]{2,50})/gi;
  const RE_SHOT = /\b(?:screenshot|screen shot|screen-shot|image attached|attached image|attached (?:a )?photo|see (?:the )?(?:image|picture|screenshot))\b/i;

  /* ------------------------------------------------------------------ stage 1: extract */
  let SEQ = 0;
  const tidy = (t) => { const x = oneLine(t).replace(/^(?:(?:actually|well|so|ok(?:ay)?|and|also|now|then|no|nope|wait|hmm|look|right|good|great|perfect)[,.!:\s]+)+(?=\S)/i, ""); return x.charAt(0).toUpperCase() + x.slice(1); };
  function mk(kind, text, ctx, extra) {
    if (ctx.role === "User" && CANON.size) text = String(text).replace(/[A-Za-z]{6,18}/g, (w) => { const c = CANON.get(w.toLowerCase()); return c ? (w[0] === w[0].toUpperCase() ? c[0].toUpperCase() + c.slice(1) : c) : w; });   // show my typos as the word I meant
    text = tidy(speech(String(text)).replace(/^\s*(?:✅|✔️?|☑️?|-|\*)+\s*/, "").replace(/^(?:here(?:'s| is| are)[^:]{0,40}:\s*)(?:(?:✅|✔️?)\s*)?/i, ""));
    return Object.assign({
      id: ++SEQ, kind, text: clip(text, 240), by: ctx.role === "User" ? "user" : "assistant", n: ctx.n, idx: ctx.idx, role: ctx.role,
      tier: TIERS[kind.toUpperCase()] || 5, topic: topicOf(text), active: true, supersededBy: null, supersedes: [], count: 1, lastN: ctx.n, strong: false,
    }, extra || {});
  }

  function extract(messages, options) {
    options = options || {};
    SEQ = 0;
    try { CANON = buildCanon(messages); } catch (e) { CANON = new Map(); }
    const items = [];
    const refs = { urls: new Map(), files: new Map(), folders: new Map(), shots: [] };
    const tech = { commands: [], versions: new Map(), tests: [] };
    const msgs = messages || [];
    const users = msgs.map((m, i) => (m.role === "User" ? i : -1)).filter((i) => i >= 0);
    const lastUserIdx = users.length ? users[users.length - 1] : -1;

    msgs.forEach((m, idx) => {
      const n = (m.i != null ? m.i : idx) + 1;
      const ctx = { n, idx, role: m.role };
      const text = /^\s*\[tool use\]\s*$/i.test(String(m.text || "")) ? "" : String(m.text || "");   // a bare tool step says nothing
      const plain = stripCode(text);

      /* --- references: links, files, folders, screenshots (with where they came from) --- */
      for (const u of plain.match(RE_URL) || []) { const k = u.replace(/[.,;:]+$/, ""); if (!refs.urls.has(k)) refs.urls.set(k, { n, role: m.role }); }
      for (const f of plain.match(RE_FILE) || []) { const k = f.replace(/^[./]+/, ""); if (!/^https?/i.test(k) && !refs.files.has(k.toLowerCase())) refs.files.set(k.toLowerCase(), { name: k, n, role: m.role }); }
      // folders: only real-looking ones. "on/off", "file/folder/zip", "folder attachments" are prose, not paths.
      RE_FOLDER.lastIndex = 0; let fm;
      while ((fm = RE_FOLDER.exec(plain))) {
        const explicit = !!fm[2];
        const k = (fm[1] || fm[2] || "").replace(/\/$/, "");
        if (k.length <= 2 || /^https?:/i.test(k) || /\.\w{1,5}$/.test(k) || refs.folders.has(k)) continue;
        const pathy = /^(?:[.~]\/)|\/$/.test(fm[1] || "") || [...refs.files.keys()].some((f) => f.startsWith(k.toLowerCase() + "/"));
        const named = explicit && /\b(?:called|named)\b/i.test(fm[0]);
        if (pathy || named) refs.folders.set(k, { n, role: m.role });
      }
      // a folder is also any directory that a mentioned file lives in (src/ui/Login.jsx -> src/ui)
      for (const f of refs.files.values()) { const d = f.name.includes("/") ? f.name.replace(/\/[^/]+$/, "") : ""; if (d && d.length > 2 && !refs.folders.has(d) && !/^https?:/i.test(d)) refs.folders.set(d, { n: f.n, role: f.role }); }
      for (const a of m.attachments || []) {
        const nm = a && (a.name || a.filename); if (!nm) continue;
        if (/image|png|jpe?g|gif|webp|screenshot/i.test(String(a.type || "") + nm)) refs.shots.push({ name: nm, n, attached: true });
        else if (!refs.files.has(String(nm).toLowerCase())) refs.files.set(String(nm).toLowerCase(), { name: nm, n, role: m.role, attached: true });
      }
      if (m.role === "User" && RE_SHOT.test(plain)) refs.shots.push({ name: "screenshot mentioned", n, attached: false });

      /* --- technical details (both sides): commands, versions, test results --- */
      FENCE.lastIndex = 0; let cm;
      while ((cm = FENCE.exec(text))) {
        if (/^(?:sh|bash|shell|zsh|cmd|powershell|ps1|console|terminal)$/i.test(cm[2] || "")) {
          for (const line of cm[3].split("\n").map((l) => l.trim().replace(/^\$\s*/, "")).filter(Boolean).slice(0, 4)) tech.commands.push({ t: clip(line, 110), n });
        }
      }
      RE_CMD_INLINE.lastIndex = 0; let im;
      while ((im = RE_CMD_INLINE.exec(plain))) tech.commands.push({ t: clip(im[1], 110), n });
      RE_VERSION.lastIndex = 0; let vm;
      while ((vm = RE_VERSION.exec(plain))) tech.versions.set(vm[1].toLowerCase(), vm[2]);
      RE_TESTRES.lastIndex = 0; let tm; const tr = [];
      while ((tm = RE_TESTRES.exec(plain))) tr.push(tm[1] + " " + tm[2].toLowerCase());
      if (tr.length) tech.tests.push({ t: tr.join(", "), n });

      const sents = sentences(text);
      if (m.role === "User") {
        const firstUser = idx === users[0];
        let prevA = ""; for (let j = idx - 1; j >= 0; j--) if (msgs[j].role === "Assistant" && String(msgs[j].text || "").trim() && !/^\s*\[tool use\]\s*$/i.test(msgs[j].text)) { prevA = msgs[j].text; break; }
        sents.forEach((s, si) => {
          s = withOption(s, prevA);
          const q = isQuestion(s);
          if (RE_QUOTE_NEG_NOISE.test(s) && !RE_REQ.test(s)) return;
          // order matters: one sentence becomes one primary item
          if (!q && RE_CORR.test(s)) {
            const it = mk("correction", s, ctx, { strong: true });
            const ins = swapOf(s) || revertOf(s, items);
            if (ins) { it.chosen = ins.chosen; it.rejected = ins.rejected; it.asDecision = true; const rs = /\b(?:because|since|so that|as)\b[^.]{3,120}|,\s*the [^.]{3,100}/i.exec(s); if (rs) it.reason = clip(rs[0].replace(/^,\s*/, ""), 130); }
            if (RE_ALLOW.test(s)) it.lifts = true;
            if (RE_PROHIB.test(s)) it.negative = true;
            items.push(it);
          } else if (!q && RE_COMPLAINT.test(s)) {
            items.push(mk("blocker", s, ctx, { complaint: true }));
          } else if (!q && RE_PROHIB.test(s)) {
            items.push(mk("prohibition", s, ctx, { strong: /\b(?:never|must not|under no circumstances|absolutely)\b/i.test(s) }));
          } else if (!q && RE_PREF.test(s)) {
            items.push(mk("preference", s, ctx));
          } else if (!q && RE_DECISION.test(s)) {
            const it = mk("decision", s, ctx, { by: "user", confirmed: true });
            const ins = swapOf(s) || revertOf(s, items); if (ins) { it.chosen = ins.chosen; it.rejected = ins.rejected; }
            items.push(it);
          } else if (!q && RE_ALLOW.test(s)) {
            items.push(mk("correction", s, ctx, { lifts: true }));
          } else if (!q && RE_REQ.test(s) && !(RE_GOALSENT.test(s) && !RE_STRONGREQ.test(s)) && !(/^(?:and |also |now |but )?i (?:want|need) you to\b/i.test(s) && !RE_STRONGREQ.test(s))) {   // "I want you to do X" is a request (a task), not a standing rule
            items.push(mk("constraint", s, ctx, { strong: /\b(?:must|always|required|have to|make sure|ensure)\b/i.test(s) }));
          } else if (RE_ISSUE.test(s) && !q && s.length > 12) {
            items.push(mk("blocker", s, ctx, { error: true }));
          }
          if (q && idx === lastUserIdx) items.push(mk("question", s, ctx));
        });
        // what I asked for = tasks (one per request sentence); resolved later against the assistant's replies
        const isRule = (x) => RE_PROHIB.test(x) || (RE_STRONGREQ.test(x) && !RE_REQUEST.test(x.replace(/^(?:please\s+)?/i, "")));
        for (const sx of sents) {
          if (isQuestion(sx) && !/^(?:can|could|would) you\b/i.test(sx)) continue;
          if (RE_CORR.test(sx) || RE_COMPLAINT.test(sx) || isRule(sx) || /^(?:make sure|ensure)\b/i.test(sx)) continue;
          const core = sx.replace(/^(?:(?:also|and|now|next|then|ok(?:ay)?|good|great|perfect|so|well)[,.!\s]+)+/i, "");
          if (RE_REQUEST.test(core)) items.push(mk("task", core, ctx, { status: "pending", by: "user" }));
        }
        if (firstUser) {
          const gs = sents.filter((x) => !RE_PROHIB.test(x) && !(RE_STRONGREQ.test(x) && !RE_GOALSENT.test(x))).slice(0, 2);
          items.push(mk("goal", (gs.length ? gs : sents.slice(0, 1)).join(" ") || text, ctx, { strong: true }));
        } else {
          const g = sents.find((x) => /\b(?:my goal|the goal|i(?:'m| am) trying to|what i(?:'m| am) (?:after|building)|overall|in the end)\b/i.test(x));
          if (g) items.push(mk("goal", g, ctx));
        }
      } else if (m.role === "Assistant") {
        // checklists and "next steps" lists
        let inList = false;
        for (const raw of plain.split("\n")) {
          const line = raw.trim(); if (!line) continue;
          if (RE_TASK_HEAD.test(line)) { inList = true; continue; }
          const box = /^[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(line);
          const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
          if (box) { items.push(mk("task", box[2], ctx, { status: box[1] === " " ? "pending" : "done", by: "assistant" })); continue; }
          if (inList && bullet) { items.push(mk("task", bullet[1], ctx, { status: "pending", by: "assistant", listed: true })); continue; }
          inList = false;
        }
        const sl = sents.filter((s) => s.length <= 200);
        let lastDecision = null;
        for (const s of sl) {
          if (isQuestion(s)) continue;
          if (RE_DECISION.test(s) && !RE_PROHIB.test(s)) {
            const it = mk("decision", s, ctx, { by: "assistant", confirmed: false });
            const ins = swapOf(s); if (ins) { it.chosen = ins.chosen; it.rejected = ins.rejected; }
            items.push(it); lastDecision = it;
          } else if (RE_VERIFIED.test(s) && !RE_DONE.test(s) && s.length <= 160) {
            const prevT = [...items].reverse().find((x) => x.kind === "task" && x.n === n && x.by === "assistant" && (x.status === "done"));
            if (prevT) prevT.status = "verified";
          } else if (RE_VERIFIED.test(s) && RE_DONE.test(s)) {
            items.push(mk("task", s, ctx, { status: "verified", by: "assistant" }));
          } else if (RE_DONE.test(s) && s.length <= 160) {
            items.push(mk("task", s, ctx, { status: "done", by: "assistant" }));
          } else if (RE_ATTEMPT.test(s) && s.length <= 160) {
            items.push(mk("task", s, ctx, { status: "attempted", by: "assistant" }));
          } else if (RE_BLOCKER.test(s) && s.length <= 180) {
            items.push(mk("blocker", s, ctx, { by: "assistant" }));
          } else if (RE_PENDING.test(s) && s.length <= 160) {
            items.push(mk("task", s, ctx, { status: "pending", by: "assistant" }));
          }
          if (RE_RATIONALE.test(s) && lastDecision && lastDecision.n === n && lastDecision.text !== clip(s, 240)) lastDecision.reason = lastDecision.reason || clip(s, 150);
          else if (RE_RATIONALE.test(s) && s.length <= 200) items.push(mk("rationale", s, ctx));
        }
        // a "yes / good / go ahead" reply confirms the assistant's decision in the message before it
        const next = msgs[idx + 1];
        if (next && next.role === "User" && RE_ACK.test(oneLine(next.text)) && !RE_COMPLAINT.test(next.text)) for (const it of items) if (it.kind === "decision" && it.n === n) it.confirmed = true;
        // the same sentence also states the reason inside a decision
        for (const it of items) if (it.kind === "decision" && it.n === n && !it.reason) {
          const r = /\b(?:because|since|so that|in order to)\b[^.]{3,140}/i.exec(it.text); if (r && !it.text.toLowerCase().startsWith(r[0].toLowerCase().slice(0, 20))) it.reason = clip(r[0], 140);
        }
      }
    });

    // keep the last user message in view: it is the current request
    const lastUser = lastUserIdx >= 0 ? msgs[lastUserIdx] : null;
    return { items, refs, tech, meta: { count: msgs.length, lastUserN: lastUser ? ((lastUser.i != null ? lastUser.i : lastUserIdx) + 1) : null, firstN: msgs.length ? ((msgs[0].i != null ? msgs[0].i : 0) + 1) : 1 }, msgs };
  }

  /* ------------------------------------------------------------------ stage 2: resolve (chronology) */
  const ACTIVE_KINDS = new Set(["constraint", "prohibition", "decision", "preference", "goal"]);
  function resolve(ex) {
    const items = ex.items;
    const ambiguities = [];
    const rejectedApproaches = [];
    const failedAttempts = [];

    // 0. merge repeats: the same thing said again is reinforcement, not a new item and not an override
    const byKey = new Map();
    for (const it of items) {
      if (!ACTIVE_KINDS.has(it.kind) && it.kind !== "task") continue;
      const key = it.kind + "|" + norm(it.text).slice(0, 80);
      const seen = byKey.get(key);
      if (seen) { seen.count++; seen.lastN = it.n; it.dup = true; if (it.strong) seen.strong = true; } else byKey.set(key, it);
    }
    for (const d of items) {
      if (d.kind !== "decision" || d.by !== "assistant" || d.dup) continue;
      const u = [...items].reverse().find((x) => x.idx < d.idx && x.by === "user" && (x.kind === "decision" || x.asDecision) && d.idx - x.idx <= 2);
      if (u && (sharedCount(u.topic, d.topic) >= 2 || (u.chosen && sharedCount(topicOf(u.chosen), d.topic) >= 1))) { d.dup = true; u.count++; }   // "Reverted to Chart.js." only repeats "go back to Chart.js"
    }
    const live = items.filter((i) => !i.dup);

    // 1. corrections, explicit changes of decision, and lifted prohibitions
    const chron = live.slice().sort((a, b) => a.idx - b.idx || a.id - b.id);
    for (const c of chron) {
      if (c.kind !== "correction" && !(c.kind === "decision" && c.rejected)) continue;
      const earlier = chron.filter((x) => x.idx < c.idx || (x.idx === c.idx && x.id < c.id));
      const cands = earlier.filter((x) => x.active && (ACTIVE_KINDS.has(x.kind) || (x.kind === "correction" && x.asDecision)) && x.kind !== "goal");   // an earlier "use D3 instead" is itself a decision that can be reversed
      // explicit "use Y instead of X": anything about X is replaced
      if (c.rejected) {
        const rt = topicOf(c.rejected);
        const hit = cands.filter((x) => rt.size && (sharedCount(rt, x.topic) >= Math.min(rt.size, 2) || specificShared(rt, x.topic) >= 1) && x !== c && x.kind !== "goal");
        rejectedApproaches.push({ what: c.rejected, instead: c.chosen || null, n: c.n });
        for (const h of hit) { h.active = false; h.supersededBy = c; c.supersedes.push(h); }
        if (c.kind === "correction") { c.promote = true; }
        continue;
      }
      const ct = topicOf(c.text);
      // a plain complaint ("still the same problem") is about the assistant's last approach, not a rule
      const scored = cands.map((x) => ({ x, s: overlap(ct, x.topic), shared: sharedCount(ct, x.topic), spec: specificShared(ct, x.topic) })).filter((y) => linked(ct, y.x.topic) || y.s >= 0.6).sort((a, b) => b.s - a.s || b.spec - a.spec || b.x.idx - a.x.idx);
      // "I said no X!" restates a rule the assistant broke: that is reinforcement, not a new rule and not an override
      if (/\b(?:i (?:said|told|asked|meant)|you (?:missed|forgot|ignored|didn'?t|did not))\b|^that'?s wrong/i.test(c.text) && scored.length && scored[0].x.kind !== "decision") {
        const r = scored[0].x; r.count++; r.lastN = c.n; r.strong = true; r.restated = (r.restated || 0) + 1;
        c.reinforces = r; c.promote = false; c.absorbedByRule = true;
        let prev = null; for (let j = c.idx - 1; j >= 0; j--) if (ex.msgs[j].role === "Assistant") { prev = ex.msgs[j]; break; }
        if (prev) failedAttempts.push({ n: c.n, said: clip(c.text, 110), tried: gistOf(prev.text, 130), ofN: (prev.i != null ? prev.i : ex.msgs.indexOf(prev)) + 1, broke: clip(r.text, 80) });
        continue;
      }
      if (c.lifts) {
        const p = scored.find((y) => y.x.kind === "prohibition");
        if (p) {
          const scope = /\bonly\s+(?:for|in|on|when|to|with|inside)\s+([^.,;]{3,60})/i.exec(c.text);
          if (scope) { p.x.exception = clip("allowed only " + scope[0].replace(/^only\s+/i, ""), 80); p.x.exceptionN = c.n; c.lifted = true; c.partialLift = true; }
          else { p.x.active = false; p.x.supersededBy = c; c.supersedes.push(p.x); c.lifted = true; }
        } else if (cands.some((x) => x.kind === "prohibition")) ambiguities.push({ text: c.text, n: c.n, why: "says something is now allowed, but no earlier prohibition clearly matches" });
        else { c.lifted = false; c.promote = true; }   // nothing was forbidden, so "you can ..." is just a suggestion/wish: keep it as a requirement
        continue;
      }
      if (!scored.length) {
        // a correction with nothing earlier to attach to: keep it as a requirement of its own and say so
        c.promote = true;
        if (/^(?:no[,.!:]|nope|wait|actually|hold on)\b/i.test(c.text) && c.text.length < 40) ambiguities.push({ text: c.text, n: c.n, why: "a correction with no clear earlier instruction it refers to" });
        continue;
      }
      const best = scored[0];
      const rivals = scored.filter((y) => y !== best && y.s >= best.s - 0.1 && y.x.kind === best.x.kind && y.s < 0.8 && y.spec === best.spec);
      if (rivals.length && best.s < 0.75) {
        ambiguities.push({ text: c.text, n: c.n, why: "could refer to more than one earlier instruction: “" + clip(best.x.text, 60) + "” or “" + clip(rivals[0].x.text, 60) + "” — both kept active" });
        c.promote = true;
        continue;
      }
      for (const y of scored) if (y === best || y.s >= 0.7) { y.x.active = false; y.x.supersededBy = c; c.supersedes.push(y.x); }
      c.promote = true;
    }

    // 2. decisions that contradict an earlier decision on the same topic (e.g. React -> Vue) replace it; plain repeats do not
    const decisions = live.filter((i) => i.kind === "decision");
    for (let a = 0; a < decisions.length; a++) for (let b = a + 1; b < decisions.length; b++) {
      const x = decisions[a], y = decisions[b];
      if (!x.active || x.n === y.n) continue;
      if (x.chosen && y.chosen && sharedCount(topicOf(x.chosen), topicOf(y.rejected || "")) >= 1) { x.active = false; x.supersededBy = y; y.supersedes.push(x); }
    }

    for (const d of live.filter((i) => i.kind === "decision" && i.by === "assistant" && !i.confirmed)) {
      if (live.some((u) => u.idx < d.idx && u.by === "user" && (u.kind === "decision" || u.asDecision) && u.chosen && specificShared(topicOf(u.chosen), d.topic) + sharedCount(topicOf(u.chosen), d.topic) >= 1)) d.confirmed = true;
    }
    // 3. promote: a correction becomes the active instruction (negative -> prohibition, else requirement) unless it only lifted something
    for (const c of live) {
      if (c.kind !== "correction" || !c.promote) continue;
      if (c.lifted) continue;
      if (c.asDecision) { c.promotedKind = "decision"; c.tier = 1; c.confirmed = true; c.by = "user"; continue; }
      if (c.absorbedByRule) continue;
      const asKind = c.negative || RE_PROHIB.test(c.text) ? "prohibition" : "constraint";
      c.promotedKind = asKind; c.tier = 1;
    }

    // 4. what failed: a complaint about the assistant's last approach marks that approach as not working
    live.forEach((c) => {
      if (!(c.kind === "blocker" && c.complaint)) return;
      let prev = null;
      for (let j = c.idx - 1; j >= 0; j--) if (ex.msgs[j].role === "Assistant") { prev = ex.msgs[j]; break; }
      const tried = prev ? gistOf(prev.text, 130) : "";
      if (prev && tried && !/^\[tool use\]$/i.test(tried)) failedAttempts.push({ n: c.n, said: clip(c.text, 110), tried, ofN: (prev.i != null ? prev.i : ex.msgs.indexOf(prev)) + 1 });
    });

    // 5. tasks: a request is done when a later assistant message reports doing it; failed if the user then complains about it
    const tasks = live.filter((i) => i.kind === "task");
    for (const t of tasks) {
      if (t.by !== "user") continue;
      const later = live.filter((x) => x.kind === "task" && x.by === "assistant" && x.idx > t.idx && (x.status === "done" || x.status === "verified") && sharedCount(t.topic, x.topic) >= 2).sort((a, b) => a.idx - b.idx);
      if (later.length) {
        const best = later[later.length - 1];
        t.status = best.status; t.doneAt = best.n;
        const complaint = live.find((x) => x.kind === "blocker" && x.complaint && x.idx > best.idx && sharedCount(t.topic, x.topic) >= 1);
        if (complaint) { t.status = "failed"; t.failedAt = complaint.n; }
        else if (live.some((x) => x.kind === "blocker" && x.complaint && x.idx > best.idx)) { /* later complaint about something else: leave as is */ }
      }
    }
    // assistant-only duplicates of tasks already attached to a user request are not shown twice
    for (const t of tasks) {
      if (t.by !== "assistant") continue;
      if (tasks.some((u) => u.by === "user" && sharedCount(u.topic, t.topic) >= 2 && (u.doneAt === t.n || Math.abs(u.idx - t.idx) <= 2))) t.absorbed = true;
    }
    // an assistant "next step" that a later message reports done is no longer pending
    for (const t of tasks) if (t.by === "assistant" && t.status === "pending") {
      if (tasks.some((x) => x !== t && x.idx > t.idx && (x.status === "done" || x.status === "verified") && sharedCount(t.topic, x.topic) >= 2)) { t.status = "done"; t.doneAt = t.doneAt || null; }
    }

    // 6. errors the assistant later reported fixed
    for (const t of live.filter((i) => i.kind === "task" && i.by === "assistant" && (i.status === "done" || i.status === "verified"))) {
      const nextU = ex.msgs.slice(t.idx + 1).find((m) => m.role === "User");
      if (nextU && (RE_COMPLAINT.test(nextU.text) || /\b(?:i (?:said|told)|that'?s wrong|not what i)\b/i.test(nextU.text))) { t.status = "failed"; t.failedAt = (nextU.i != null ? nextU.i : ex.msgs.indexOf(nextU)) + 1; }
    }
    for (const e of live.filter((i) => i.kind === "blocker" && (i.error || i.complaint))) {
      const fixed = live.find((x) => x.kind === "task" && x.by === "assistant" && x.idx > e.idx && (x.status === "done" || x.status === "verified") && (e.complaint ? /\b(?:fix|resolv|work|now|instead)/i.test(x.text) : /\b(?:fix|resolv|work)/i.test(x.text) && sharedCount(e.topic, x.topic) >= 1));
      if (fixed && !live.some((c) => c.kind === "blocker" && c.complaint && c.idx > fixed.idx)) { e.resolved = true; e.resolvedAt = fixed.n; }
    }
    const fa = new Map();
    for (const f of failedAttempts) { const k = f.ofN; const o = fa.get(k); if (!o) fa.set(k, f); else { if (f.broke && !o.broke) { o.broke = f.broke; o.said = f.said; } } }
    return { items: live, ambiguities, rejectedApproaches, failedAttempts: [...fa.values()].sort((a, b) => a.n - b.n) };
  }

  function gistOf(text, lim) {
    const t = oneLine(stripCode(text || "")).replace(/[*_#>`]+/g, "").trim();
    if (!t) return /`{3}/.test(text || "") ? "[code]" : "";
    const first = t.split(/(?<=[.!?])\s+/).map((x) => x.replace(/^(?:sure|certainly|of course|absolutely|great|okay|ok|yes)[!,.:\s]+/i, "").trim()).find((x) => x.length >= 12) || t;
    return clip(first, lim);
  }

  /* ------------------------------------------------------------------ stage 3: rank */
  function rank(ex, res, options) {
    options = options || {};
    const N = Math.max(1, ex.meta.count);
    const score = (it) => {
      let s = 10 - (it.tier || 5) * 1.5;
      s += (it.idx / N) * 0.8;                              // recent matters more
      if (it.role === "User") s += 0.6;                     // the person's own words outrank the assistant's
      if (it.strong) s += 0.8;
      s += Math.min(2, (it.count - 1) * 0.35);              // said repeatedly
      if (it.kind === "decision" && it.confirmed) s += 0.7;
      if (it.promotedKind) s += 0.6;
      return s;
    };
    const live = res.items.filter((i) => !i.absorbed);
    for (const it of live) it.score = score(it);
    const act = (kinds) => live.filter((i) => kinds.includes(i.kind) && i.active).sort((a, b) => b.score - a.score);
    const asKind = (k) => (i) => (i.promotedKind || (i.kind === "constraint" ? "constraint" : i.kind)) === k;

    const prohibitions = live.filter((i) => i.active && ((i.kind === "prohibition") || (i.kind === "correction" && i.promotedKind === "prohibition"))).sort((a, b) => b.score - a.score);
    const requirements = live.filter((i) => i.active && ((i.kind === "constraint") || (i.kind === "correction" && i.promotedKind === "constraint"))).sort((a, b) => b.score - a.score);
    const decAll = live.filter((i) => i.active && (i.kind === "decision" || (i.kind === "correction" && i.promotedKind === "decision"))).sort((a, b) => b.score - a.score);
    const decisions = decAll.filter((d) => d.confirmed || d.by === "user");
    const proposed = decAll.filter((d) => !d.confirmed && d.by !== "user").slice(0, 3);
    const superseded = live.filter((i) => !i.active && i.supersededBy).sort((a, b) => b.idx - a.idx);
    const goals = live.filter((i) => i.kind === "goal").sort((a, b) => a.idx - b.idx);
    const prefs = act(["preference"]);
    const tasks = live.filter((i) => i.kind === "task");
    const blockers = live.filter((i) => i.kind === "blocker" && !i.resolved).sort((a, b) => b.idx - a.idx);
    const resolvedErrors = live.filter((i) => i.kind === "blocker" && i.resolved).sort((a, b) => b.idx - a.idx);
    const questions = live.filter((i) => i.kind === "question");
    const rationales = live.filter((i) => i.kind === "rationale").sort((a, b) => b.score - a.score);
    const corrections = live.filter((i) => i.kind === "correction").sort((a, b) => b.idx - a.idx);

    const lastReq = (() => { const u = ex.msgs.map((m, i) => ({ m, i })).filter((x) => x.m.role === "User"); if (!u.length) return null; const x = u[u.length - 1]; return { text: clip(stripCode(x.m.text), 320) || "[code]", n: (x.m.i != null ? x.m.i : x.i) + 1 }; })();

    return {
      msgs: ex.msgs,
      goal: goals[0] || null, latest: lastReq, goals, requirements, prohibitions, decisions, proposed, superseded, prefs, tasks, blockers, resolvedErrors, questions, rationales, corrections,
      ambiguities: res.ambiguities, rejectedApproaches: res.rejectedApproaches, failedAttempts: res.failedAttempts,
      refs: ex.refs, tech: ex.tech, meta: ex.meta, options,
    };
  }

  function understand(messages, options) {
    const ex = extract(messages, options);
    const res = resolve(ex);
    const M = rank(ex, res, options);
    // whole-turn pass: "done / failed / in progress" is judged from the turn's reply and my next message, not one sentence
    if (N) { try { M.cutoff = N.refineTasks(M, ex.msgs); } catch (e) { /* keep the sentence-level statuses */ } }
    return M;
  }

  /* ------------------------------------------------------------------ stage 4: generate */
  const approxTokens = (t) => Math.ceil(String(t || "").length / 3.8);   // only used for fitting; capsule.js re-measures with its own estimator
  function refTag(n, last) { return "(#" + n + (last && last !== n ? "+" : "") + ")"; }

  function buildSections(M, opts) {
    const level = opts.level != null ? opts.level : 1;
    const lim = level === 0 ? { t: 130, r: 110 } : level === 1 ? { t: 190, r: 150 } : { t: 240, r: 190 };
    const S = [];
    const add = (id, tier, title, lines, extra) => { lines = lines.filter(Boolean); if (lines.length) S.push(Object.assign({ id, tier, title, lines }, extra || {})); };
    const files = (opts.files || []).map((f) => String(f).toLowerCase());
    const taskLine = (t) => "- " + clip(t.text, lim.t) + " " + refTag(t.n);
    // what I asked for is listed once (WHAT I ASKED FOR, with its status); TASKS then lists only what the assistant reported doing
    const intentCap = level === 0 ? 4 : 8;
    const allMine = M.tasks.filter((t) => t.by === "user" && !t.absorbed);
    const isOpen = (t) => !["done", "verified"].includes(t.status);
    const openMine = allMine.filter(isOpen).slice(-intentCap);
    const intentList = openMine.concat(allMine.filter((t) => !isOpen(t)).slice(-(intentCap - openMine.length))).sort((a, b) => a.idx - b.idx || a.id - b.id);   // what is still open, then the latest finished
    const intentSet = new Set(intentList);
    const tasksBy = (st) => M.tasks.filter((t) => st.includes(t.status) && !t.absorbed && !(N && intentSet.has(t)));

    /* AT A GLANCE: the six questions the next AI needs answered first */
    const doneN = tasksBy(["done", "verified"]).length, pendN = tasksBy(["pending", "attempted", "failed", "inprogress", "unconfirmed"]).length;
    const nextA = nextAction(M);
    let notes = null;
    if (N) { try { notes = N.buildNotes(M, M.msgs || [], { level }); } catch (e) { notes = null; } }
    if (notes && notes.journey.length) {
      /* KEY NOTES: written like hand-over notes — what it is, how far it got, where it stopped, what to do first */
      const kn = N.renderNotes(notes, M, { level, ref: (n) => refTag(n) });
      const lr = M.latest && M.goal && M.latest.n !== M.goal.n && !/^(?:get me|show me)\b/i.test(M.latest.text) ? ["- Latest ask: " + clip(speech(M.latest.text), lim.t) + " " + refTag(M.latest.n)] : [];
      const cnt = [[M.prohibitions.length, "do-not rule(s)"], [M.decisions.length, "final decision(s)"], [M.requirements.length, "requirement(s)"]].filter((x) => x[0]).map((x) => x[0] + " " + x[1]);
      const rules = cnt.length ? ["- Standing: " + cnt.join(", ") + " — listed below; they override anything older."] : [];
      add("glance", 1, "KEY NOTES (read this first)", kn.slice(0, kn.length - 1).concat(lr, rules, kn.slice(-1)), { keepAll: true });
    } else {
      const glance = [];
      glance.push("- Trying to achieve: " + (M.goal ? clip(M.goal.text, lim.t) + " " + refTag(M.goal.n) : "not stated") + (M.latest && M.goal && M.latest.n !== M.goal.n ? " — latest ask: " + clip(M.latest.text, lim.t) + " " + refTag(M.latest.n) : ""));
      glance.push("- Done / remaining: " + doneN + " done, " + pendN + " open" + (M.blockers.length ? ", " + M.blockers.length + " unresolved problem(s)" : ""));
      glance.push("- Final decisions / rejected: " + M.decisions.length + " final, " + (M.superseded.length + M.rejectedApproaches.length) + " replaced or rejected");
      glance.push("- Forbidden / already went wrong: " + M.prohibitions.length + " rule(s), " + M.failedAttempts.length + " failed attempt(s)");
      glance.push("- Do first: " + (nextA ? clip(nextA.text, lim.t) : "re-read the latest ask and confirm understanding"));
      add("glance", 1, "AT A GLANCE", glance);
    }

    /* tier 1 */
    add("prohib", 1, "HARD RULES — DO NOT (still in force)", M.prohibitions.map((p) => "- DON'T: " + clip(p.text, lim.t) + " " + refTag(p.n, p.count > 1 ? p.lastN : null) + (p.restated ? " [restated " + p.restated + "×: it was broken before]" : "") + (p.exception ? " [EXCEPTION: " + p.exception + " " + refTag(p.exceptionN) + "]" : "")), { keepAll: true });
    add("req", 1, "REQUIREMENTS (latest wording; still active)", M.requirements.map((r) => "- " + clip(r.text, lim.t) + " " + refTag(r.n, r.count > 1 ? r.lastN : null) + (r.restated ? " [restated: it was missed before]" : "") + (r.supersedes.length ? " [corrected earlier: “" + clip(r.supersedes[0].text, 50) + "”]" : "")), { cap: 12 });
    add("dec", 1, "FINAL DECISIONS", M.decisions.map((d) => "- " + clip(d.text, lim.t) + (d.reason ? " — why: " + clip(d.reason, lim.r) : "") + " " + refTag(d.n) + (d.supersedes.length ? " [replaces: " + clip(d.supersedes[0].text, 50) + "]" : "")), { cap: 10 });
    add("prop", 3, "PROPOSED BY THE ASSISTANT, NOT YET CONFIRMED", M.proposed.map((d) => "- " + clip(d.text, lim.t) + " " + refTag(d.n)), { cap: 3 });
    /* tier 2 — goal is already in AT A GLANCE; intent / subgoals here */
    const subgoals = intentList.map((t) => "- " + clip(t.text, lim.t) + " " + refTag(t.n) + " — " + statusWord(t));
    add("intent", 2, "WHAT I ASKED FOR (still open first, then the latest finished)", subgoals, { cap: level === 0 ? 4 : 8 });
    /* tier 3 */
    const rej = [];
    for (const s of M.superseded) rej.push("- SUPERSEDED, do not follow: " + clip(s.text, lim.t) + " " + refTag(s.n) + " → replaced by " + refTag(s.supersededBy.n) + (s.supersededBy.chosen ? " (" + clip(s.supersededBy.chosen, 40) + ")" : ""));
    for (const r of M.rejectedApproaches) rej.push("- REJECTED: " + clip(r.what, 60) + (r.instead ? " — use " + clip(r.instead, 60) + " instead" : "") + " " + refTag(r.n));
    add("rej", 3, "REJECTED / ABANDONED / SUPERSEDED (don't revive these)", rej, { cap: 8 });
    add("fail", 3, "WHAT WAS TRIED AND DID NOT WORK", M.failedAttempts.slice(-5).map((f) => "- Tried: " + clip(f.tried, lim.r) + " " + refTag(f.ofN) + " → me: “" + clip(f.said, 90) + "” " + refTag(f.n) + (f.broke ? " — it broke my rule: " + clip(f.broke, 60) : "")), { cap: 5 });
    add("fix", 3, "ERRORS FIXED", M.resolvedErrors.slice(0, 4).map((e) => "- " + clip(e.text, lim.t) + " " + refTag(e.n) + " → fixed " + refTag(e.resolvedAt)), { cap: 4 });
    const open = M.blockers.filter((b) => b.error || b.complaint || b.by === "assistant").slice(0, 5).map((b) => "- " + clip(b.text, lim.t) + " " + refTag(b.n));
    add("state", 3, "CURRENT STATE, BLOCKERS & OPEN QUESTIONS", open.concat(M.questions.map((q) => "- Open question: " + clip(q.text, lim.t) + " " + refTag(q.n))), { cap: 8 });
    add("tasks", 3, "TASKS", []
      .concat(tasksBy(["verified"]).slice(-4).map((t) => "- ✔ verified: " + clip(t.text, lim.t) + " " + refTag(t.n)))
      .concat(tasksBy(["done"]).slice(-5).map((t) => "- ✔ done: " + clip(t.text, lim.t) + " " + refTag(t.n)))
      .concat(tasksBy(["attempted"]).slice(-3).map((t) => "- ◐ attempted: " + clip(t.text, lim.t) + " " + refTag(t.n)))
      .concat(tasksBy(["failed"]).slice(-3).map((t) => "- ✗ failed: " + clip(t.text, lim.t) + " " + refTag(t.n)))
      .concat(tasksBy(["inprogress"]).slice(-3).map((t) => "- ◐ in progress when the session ended: " + clip(t.text, lim.t) + " " + refTag(t.n)))
      .concat(tasksBy(["unconfirmed"]).slice(-3).map((t) => "- ? asked, not clearly finished: " + clip(t.text, lim.t) + " " + refTag(t.n)))
      .concat(tasksBy(["pending"]).slice(-6).map((t) => "- ⏳ pending: " + clip(t.text, lim.t) + " " + refTag(t.n))), { cap: 14 });
    add("amb", 3, "UNCLEAR — NOT GUESSED (ask me)", M.ambiguities.slice(-4).map((a) => "- " + clip(a.text, 100) + " " + refTag(a.n) + " — " + a.why), { cap: 4 });
    if (!(notes && notes.journey.length)) add("next", 3, "NEXT ACTION", nextA ? ["- " + clip(nextA.text, lim.t) + " " + refTag(nextA.n) + (nextA.dep ? " — depends on: " + nextA.dep : "")] : []);   // KEY NOTES already ends with "Do first"
    /* tier 4 */
    const tech = [];
    if (M.tech.versions.size) tech.push("- Environment: " + [...M.tech.versions.entries()].slice(0, 8).map(([k, v]) => k + " " + v).join(", "));
    const cmds = []; const seenC = new Set(); for (const c of M.tech.commands.slice().reverse()) { if (seenC.has(c.t)) continue; seenC.add(c.t); cmds.push("- Command: `" + c.t + "` " + refTag(c.n)); if (cmds.length >= (level === 0 ? 2 : 5)) break; }
    tech.push(...cmds);
    if (M.tech.tests.length) tech.push("- Latest test result: " + M.tech.tests[M.tech.tests.length - 1].t + " " + refTag(M.tech.tests[M.tech.tests.length - 1].n));
    add("tech", 4, "TECHNICAL DETAILS & DEPENDENCIES", tech, { cap: 9 });
    add("pref", 4, "MY PREFERENCES", M.prefs.slice(0, 4).map((p) => "- " + clip(p.text, lim.t) + " " + refTag(p.n)), { cap: 4 });
    /* references with availability */
    const refl = [];
    const inc = (nm) => files.some((f) => f === String(nm).toLowerCase() || f.endsWith("/" + String(nm).toLowerCase()));
    for (const f of [...M.refs.files.values()].slice(0, 10)) refl.push("- file " + f.name + " " + refTag(f.n) + " — " + (inc(f.name) ? "INCLUDED in this capsule" : f.attached ? "attached in the chat, NOT included here (ask me for it)" : "mentioned only, NOT included (ask me for it)"));
    for (const u of [...M.refs.urls.entries()].slice(0, 6)) refl.push("- link " + clip(u[0], 90) + " " + refTag(u[1].n) + " — not opened or included");
    for (const fo of [...M.refs.folders.entries()].slice(0, 4)) refl.push("- folder " + fo[0] + " " + refTag(fo[1].n) + " — " + (files.some((f) => f.startsWith(String(fo[0]).toLowerCase() + "/")) ? "files from it INCLUDED" : "mentioned only, NOT included"));
    for (const s of M.refs.shots.slice(0, 3)) refl.push("- screenshot/image " + (s.attached ? s.name : "(mentioned)") + " " + refTag(s.n) + " — images are NOT included here (ask me to describe it)");
    add("refs", 4, "REFERENCES (what exists and what is included)", refl, { cap: 12 });
    /* tier 5 */
    add("why", 5, "WHY (supporting rationale)", M.rationales.slice(0, 4).map((r) => "- " + clip(r.text, lim.r) + " " + refTag(r.n)), { cap: 4 });
    return S;
  }

  function statusWord(t) { if (t.status === "done" && t.evidence && N && N.EVID_WORD[t.evidence]) return N.EVID_WORD[t.evidence]; if (t.status === "replaced") return "replaced by a later change of plan (#" + (t.replacedAt || "?") + ")"; return { pending: "not done yet", done: "done (reported)", verified: "done and verified", attempted: "attempted", failed: "reported not working afterwards", inprogress: "in progress when the session ended", unconfirmed: "asked; no clear confirmation it was finished" }[t.status] || t.status; }

  function nextAction(M) {
    if (N) { try { const nx = N.nextStep(N.buildNotes(M, M.msgs || [], {}), M); if (nx) return nx; } catch (e) { /* fall through to the older rules */ } }
    // 1) something I asked for that is still open (latest first)  2) an assistant 'next step'  3) a failed/blocked item  4) the latest ask
    const pendUser = M.tasks.filter((t) => t.by === "user" && ["pending", "failed", "attempted"].includes(t.status) && !t.absorbed);
    const myBlockers = M.blockers.filter((b) => b.by === "user");   // only something *I* reported is "what I just reported"
    if (myBlockers.length && M.latest && myBlockers[0].n >= M.latest.n) return { text: "Resolve what I just reported: " + clip(myBlockers[0].text, 160), n: myBlockers[0].n };
    if (pendUser.length) { const t = pendUser[pendUser.length - 1]; return { text: (t.status === "failed" ? "Redo (reported not working): " : "") + t.text, n: t.n }; }
    const pendA = M.tasks.filter((t) => t.by === "assistant" && t.status === "pending");
    if (pendA.length) { const t = pendA[pendA.length - 1]; return { text: t.text, n: t.n }; }
    if (M.questions.length) return { text: "Answer my open question: " + M.questions[M.questions.length - 1].text, n: M.questions[M.questions.length - 1].n };
    return M.latest ? { text: "Continue from my latest message: " + M.latest.text, n: M.latest.n } : null;
  }

  /* Fit sections to a token budget. Lowest tier goes first; tier 1 is trimmed only by shortening, never removed. */
  function generate(M, opts) {
    opts = opts || {};
    const budget = opts.budget || 1200;
    const est = opts.estimate || approxTokens;
    let S = buildSections(M, opts);
    const render = (secs) => secs.map((s) => "## " + s.title + "\n" + s.lines.join("\n")).join("\n\n");
    const dropped = [];
    const cost = (secs) => est(render(secs));
    // 1) apply per-section caps (tier 4+ first, then others when over budget)
    const capAll = (secs, factor) => secs.map((s) => (s.cap && !s.keepAll ? Object.assign({}, s, { lines: s.lines.slice(0, Math.max(1, Math.floor(s.cap * factor))) }) : s));
    S = capAll(S, 1);
    let guard = 0;
    for (const factor of [1, 0.6, 0.35]) {
      S = capAll(S, factor);
      while (cost(S) > budget && guard++ < 60) {
        // drop the lowest-importance, last section that is not protected
        const candidates = S.filter((s) => s.tier >= 4).concat(S.filter((s) => s.tier === 3 && !["next", "state"].includes(s.id)));
        if (!candidates.length) break;
        const victim = candidates.sort((a, b) => b.tier - a.tier)[0];
        dropped.push(victim.id); S = S.filter((s) => s !== victim);
      }
      if (cost(S) <= budget) break;
    }
    // 2) still over: trim lines inside tier-1/3 sections (keep first lines = highest score), but never to zero
    guard = 0;
    while (cost(S) > budget && guard++ < 200) {
      const big = S.filter((s) => s.lines.length > 1 && s.id !== "glance").sort((a, b) => b.tier - a.tier || b.lines.length - a.lines.length)[0];
      if (!big) break;
      const keep = big.keepAll && big.lines.length <= 3 ? null : big;
      if (!keep) break;
      const lost = big.lines.length - 1; big.lines = big.lines.slice(0, big.lines.length - 1);
      dropped.push(big.id + ":" + lost);
    }
    // 3) last resort: shorten the lines of the glance, then stop (tier-1 stays even if slightly over; caller hard-clamps)
    const text = render(S);
    const ver = verify(M, text, S);
    return { text, tokens: est(text), sections: S.map((s) => s.id), dropped, verification: ver };
  }

  /* ------------------------------------------------------------------ verification of the generated text */
  function verify(M, text, sections) {
    const nt = norm(text);
    const has = (it) => it && (nt.includes(norm(clip(it.text, 40)).slice(0, 28)) || text.includes("(#" + it.n));
    const missing = [];
    const critical = [].concat(M.prohibitions.slice(0, 6), M.decisions.filter((d) => d.confirmed || d.by === "user").slice(0, 4), M.goal ? [M.goal] : []);
    for (const it of critical) if (!has(it)) missing.push({ kind: it.kind, n: it.n, text: clip(it.text, 60) });
    // a superseded instruction may appear, but only under an explicit SUPERSEDED / REJECTED label, never in an active section
    const activeText = (sections || []).filter((s) => !["rej"].includes(s.id)).map((s) => s.lines.join("\n")).join("\n").replace(/\[(?:replaces|corrected earlier)[^\]]*\]/g, "");
    const leaked = M.superseded.filter((s) => s.text.length > 20 && norm(activeText).includes(norm(clip(s.text, 60)).slice(0, 40)) && !(s.supersededBy && norm(s.supersededBy.text).includes(norm(clip(s.text, 60)).slice(0, 40)))).map((s) => ({ n: s.n, text: clip(s.text, 60) }));
    return { ok: !missing.length && !leaked.length, missing, outdatedShownAsActive: leaked };
  }

  return { understand, extract, resolve, rank, generate, verify, nextAction, TIERS, topicOf, overlap, hasNotes: !!N, notes: N };
});
