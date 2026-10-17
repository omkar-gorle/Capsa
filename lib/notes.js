/* Capsa — key notes (pure logic, no DOM, no network).

   understand.js answers "what did each person say, and what still stands?".
   This module answers the question a fresh AI actually needs first:

       WHAT is being built · HOW far it got · WHERE it stopped · WHAT to do next

   It reads whole TURNS (one of my messages + everything the assistant did before my next one) instead of single
   sentences, because "done" and "in progress" are things a turn says, not a sentence:

     - the OUTCOME of a turn is the sentence that reports a result, not the sentence that announces a plan
     - a request is DONE when its turn reports a completion and I did not complain or correct afterwards
     - the LAST assistant message is read for "just finished X / was in the middle of Y" — that is the cut-off point,
       which is exactly what is lost when a session runs out of tokens half way through a job
     - if the chat ends on MY message, that message never got an answer and is the first thing to do

   Everything is rule-based on purpose: it runs on the device, costs no tokens, and gives the same answer twice. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsaNotes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Hindi / Hinglish cues (romanised + Devanagari). Kept as plain strings so understand.js can reuse them.
     This is a vocabulary of common phrases, not a translator: unusual wording will still be missed. */
  const HI = {
    request: "\\b(?:kar\\s?do|karo|kar dena|karna (?:hai|h)|banao|bana\\s?do|bana de|chahiye|chahie|dikhao|dikha do|de\\s?do|hatao|hata do|badlo|badal do|jodo|likho|likh do|bhejo|bhej do|chalao|samjhao|batao|theek karo|sahi karo)\\b|कर दो|करो|बनाओ|चाहिए|दिखाओ|हटाओ|बदलो|जोड़ो|ठीक करो|लिखो|बताओ|समझाओ",
    complaint: "\\b(?:kaam nahi+n?|chal nahi+n?|nahi+n? chal|abhi bhi (?:nahi+n?|wahi|same|error)|phir se (?:error|wahi)|galat (?:hai|ho)|ho nahi+n? (?:raha|rha|paya))\\b|काम नहीं|नहीं चल|अभी भी|फिर से|गलत",
    done: "\\b(?:ho gaya|ho gya|kar diya|kar di|kar dia|bana diya|bana di|theek ho gaya|sahi ho gaya|complete ho gaya)\\b|हो गया|कर दिया|बना दिया|ठीक हो गया",
    pending: "\\b(?:baaki hai|baki hai|abhi nahi+n?|nahi hua|pending hai)\\b|बाकी है|अभी नहीं",
    ack: "^(?:haan|han|theek hai|thik hai|sahi hai|badhiya|mast|ek dum sahi|bilkul)\\b|^(?:हाँ|हां|ठीक है|बढ़िया|सही है)",
    req: "\\b(?:hona chahiye|zaroor|jaruri hai|zaruri hai|sirf)\\b|होना चाहिए|ज़रूर|जरूर|सिर्फ",
    corr: "^(?:nahi+n?[, ]|ruko|rukiye|maine (?:bola|kaha)|mujhe (?:ye|yeh) nahi)|^(?:नहीं[, ]|रुको|मैंने (?:कहा|बोला))",
    progress: "\\b(?:kar (?:raha|rha) (?:hoon|hu|hun)|kar rahi (?:hoon|hu)|ab (?:main )?[a-z ]{3,40} (?:karunga|karta hoon|karti hoon))\\b|कर रहा हूँ|कर रहा हूं",
  };
  const NEVER = "(?!)";
  const hiRe = (k, flags) => new RegExp(HI[k] || NEVER, flags || "i");

  /* Which language is this chat in? "en", "hinglish" (Hindi words in Latin letters / Devanagari mixed in) or "other". */
  const EN_WORDS = new Set("the and for with that this you your are was not have but from they will would there what when which can make use new add get one all any more also into then than only just now please want need should must it's i'm don't".split(" "));
  const HING_WORDS = new Set("hai hain nahi nahin kar karo karna chahiye mujhe tumhe aap yeh ye woh kya kyun kaise abhi bhi toh aur lekin par bana banao dikhao theek sahi galat haan matlab wala wali raha rha rahi gaya gaye diya kiya hoga hoon hu".split(" "));
  function langOf(msgs) {
    let latin = 0, deva = 0, other = 0, en = 0, hing = 0, words = 0;
    for (const m of msgs) {
      if (m.role !== "User") continue;                                    // the person's own words decide the language
      const t = String(m.text || "").replace(/(`{3,4})[\s\S]*?\1/g, " ");
      for (const ch of t) { const c = ch.codePointAt(0); if (c < 0x250 && /[A-Za-z]/.test(ch)) latin++; else if (c >= 0x900 && c <= 0x97f) deva++; else if (c > 0x2ff && /\p{L}/u.test(ch)) other++; }
      for (const w of t.toLowerCase().split(/[^a-z']+/)) if (w.length > 1) { words++; if (EN_WORDS.has(w)) en++; if (HING_WORDS.has(w)) hing++; }
    }
    const total = latin + deva + other;
    if (!total) return "en";
    if (other / total > 0.3) return "other";
    if (deva / total > 0.05 || (words >= 8 && hing / words > 0.08)) return "hinglish";
    if (words >= 12 && en / words < 0.06) return "other";                  // Latin letters, but hardly any English (e.g. Spanish, German)
    return "en";
  }

  const oneLine = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const stripCode = (t) => String(t || "").replace(/(`{3,4})[\s\S]*?\1/g, " ").replace(/`{3,4}[\s\S]*$/, " ");
  const clip = (t, n) => { t = oneLine(t); return t.length <= n ? t : t.slice(0, Math.max(1, n - 1)).replace(/\s+\S*$/, "") + "…"; };

  /* My messages are typed fast: "... . . ,," and runs of dots add noise and no meaning. */
  function tidy(t) {
    return oneLine(String(t || "")
      .replace(/(?:\s*\.){2,}/g, " ")          // "...", ". . ", " .. "
      .replace(/\s*,{2,}/g, ",")               // ",,"
      .replace(/\s+\/\/+\s+/g, " ")            // "//" used as a separator
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, ""));
  }

  // a pattern object whose test() also accepts the Hindi / Hinglish alternatives
  const or2 = (re, k) => { const h = hiRe(k); return { test: (t) => re.test(t) || h.test(t), exec: (t) => re.exec(t) || h.exec(t) }; };
  const RE_PLAN = /^(?:i'?ll|i will|let me|i'?m (?:going to|about to)|first,? i|then i'?ll|next,? i'?ll|i'?m (?:now )?(?:going|starting))\b/i;
  const RE_PROGRESS = /\b(?:i'?m|i am|we'?re|we are)\s+(?:now\s+|currently\s+|still\s+)?([a-z][a-z-]*ing)\b([^.!?\n]{0,200})|\b(?:now|next),?\s+i'?ll\s+([^.!?\n]{4,200})|\bi'?ll\s+(?:now\s+)?([^.!?\n]{4,200})\s+next\b|\bnext(?: step)?\s*(?:is|:)\s*([^.!?\n]{4,200})/i;
  const RE_RESULT = or2(/\bi (?:[a-z]{3,}ed|set up|made|put|ran|wrote|took|gave|found|drew|sent|did)\b|\b(?:built|rebuilt|added|fixed|created|wrote|written|updated|implemented|drew|removed|renamed|replaced|passes|passed|passing|works?|working|got all|captured|ran|sent|installed|migrated|finished|completed|resolved|found the (?:root )?cause|root cause|is (?:now )?(?:in|done|ready)|are (?:now )?(?:in|done|ready)|now (?:has|does|works|reads|handles|shows|supports)|it (?:has|does|now))\b/i, "done");
  const RE_COMPLETE = or2(/(?:\bi'?ve\b|\bi have\b|\bwe'?ve\b|\bhas been\b|\bhave been\b)\s+\w+|\bi (?:[a-z]{3,}ed|set up|made|put|got|ran|built|wrote|took|gave|found|drew|sent|did|switched|reverted|converted)\b|\b(?:built|rebuilt|added|fixed|created|wrote|updated|implemented|drew|removed|installed|migrated|finished|completed|resolved|sent|passes|passed|got all|is done|are done|works now|now works|ready|ban gaya|ban gayi|ho gaya)\b/i, "done");
  const RE_BAD_PROGRESS_ONLY = /^(?:i'?ll|i will|let me)\b/i;
  const RE_COMPLAINT = or2(/\b(?:still (?:the same|not|broken|failing|wrong|getting|showing|happening|no)|not working|doesn'?t work|didn'?t work|isn'?t working|same (?:error|problem|issue)|not fixed|it failed|didn'?t fix|wrong again|that'?s wrong|not what i)\b/i, "complaint");
  const RE_CORRECTION = or2(/^(?:no[,.!:\s]|nope\b|wait\b|actually\b|hold on\b|instead\b|i (?:said|meant|told)\b|you (?:missed|forgot|ignored|didn'?t|did not|misunderstood)\b)/i, "corr");
  const RE_PLANCHANGE = /\b(?:instead|go(?:ing)? back to|revert(?:ed)? (?:back )?to|switch(?:ing)? (?:to|back)|forget (?:the|about|it|that)|skip|drop|scrap|ditch|actually,? (?:use|let'?s|make|we|do|forget|skip)|let'?s (?:use|go|switch|make|do)|change of plan|new plan)\b/i;
  const RE_PRAISE = /\b(?:loved?|perfect|great|awesome|nice|good job|works? (?:now|great|well|perfectly)|thanks?|thank you|exactly|looks good|lgtm|badhiya|mast|ek dum sahi)\b|बढ़िया|शुक्रिया|धन्यवाद/i;
  const RE_TESTED = /\b(?:tests? (?:pass|passed|passing|are passing)|all \d+ (?:tests? )?pass|\d+ (?:tests? )?passed|verified|i ran (?:it|them|the tests)|ran (?:it|the tests|them)(?: in| against| and)|in a real (?:chromium|browser|chrome)|works? (?:correctly|as expected)|confirmed)\b/i;

  /* Words that say nothing about WHAT is being built. */
  const GENERIC = new Set(("want make fix improve keep thing things work working right now good great like also please need try using use used make made get got give change changed look looks see seen show shows start started more less only just still even every everything anything something whole means mean kind kinds type types some sort doing done does tell sure okay yeah really actually build built added adding create created update updated file files code chat message messages version real test tests tested testing page pages run running ran line lines text content point points part parts item items way ways time times step steps case cases one two three first second last next previous current latest new old same different able will would could should might must being been have has had that this these those with from into than then when where which while about after before because there their them they what your you our not but and the for are was were its it's i'm i've don't doesn't didn't isn't can't " +
    "hai hain nahi nahin karo karna chahiye kiya diya gaya gaye raha rha rahi hoon hogaya hoga kuch kya aur bhi toh abhi bas koi mujhe mera meri mere hum tum aap apna wala wali").split(/\s+/));

  function create(h) {
    const topicOf = h.topicOf, sharedCount = h.sharedCount;

    /* ---------------------------------------------------------------- turns */
    function turns(msgs) {
      const T = [];
      msgs.forEach((m, idx) => {
        if (m.role === "User") T.push({ u: m, uIdx: idx, n: (m.i != null ? m.i : idx) + 1, as: [], k: T.length });
        else if (m.role === "Assistant" && T.length) T[T.length - 1].as.push(m);
      });
      return T;
    }
    const realText = (m) => { const t = String(m && m.text || "").trim(); return /^\[tool use\]$/i.test(t) ? "" : t; };
    const replyOf = (t) => t.as.map(realText).filter(Boolean).join("\n\n");

    /* Plain sentences of an assistant reply: no headings, no bold labels, no bullets' markers, no "Label:" stubs. */
    function replySentences(text) {
      const out = [];
      for (const raw of stripCode(text).split(/\n+/)) {
        let line = raw.trim();
        if (!line || /^#{1,6}\s/.test(line)) continue;                   // headings are labels, not facts
        const bullet = /^(?:[-*•>]|\d+[.)])\s+/.test(line);
        line = line.replace(/^(?:[-*•>]|\d+[.)])\s+/, "").replace(/\*\*([^*]{1,40}):\*\*\s*/g, "").replace(/\*\*/g, "").replace(/(?<!\w)\*(?=\w)|(?<=\w)\*(?!\w)/g, "").replace(/`/g, "").trim();
        if (!line || /^\|/.test(line)) continue;
        for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)) {
          let x = s.trim();
          const intro = /:\s*$/.test(x) && /^(?:i'?ve|i have|i |we |the )/i.test(x) && RE_RESULT.test(x);   // "I've sent six screenshots, in this order:" is a result, not a label
          if (intro) x = x.replace(/[:\s]+$/, ".").replace(/,?\s*in this order\.$/i, ".");
          if (x.length >= 12 && x.length <= 320 && (intro || !/:\s*$/.test(x)) && x.split(/\s+/).length >= 3) out.push({ s: x, bullet });
        }
      }
      return out;
    }

    /* The sentence(s) of a turn that report a RESULT. `ask` is my message, so the result that matches it wins. */
    function outcomeOf(turn, count) {
      const reply = replyOf(turn);
      if (!reply) return [];
      const askTopic = topicOf(tidy(stripCode(turn.u.text)));
      const sents = replySentences(reply);
      if (!sents.length) return [];
      const scored = sents.map(({ s, bullet }, i) => {
        let sc = bullet ? -1.2 : 0;                                         // list items are details; the sentence above them is the summary
        if (RE_RESULT.test(s)) sc += 3;
        if (/\d/.test(s)) sc += 1.2;
        sc += Math.min(3, sharedCount(askTopic, topicOf(s)) * 1.1);
        if (RE_PLAN.test(s)) sc -= 3.5;
        if (/^i'?m (?:now )?[a-z-]+ing\b/i.test(s)) sc -= 2.5;
        if (/^(?:i (?:couldn'?t|haven'?t|didn'?t)|the screenshots are still)/i.test(s)) sc -= 0.5;
        if (s.length < 30) sc -= 1;
        if (s.length > 220) sc -= 1;
        sc += i / sents.length * 0.6;                                      // conclusions come late
        return { s, i, sc };
      }).sort((a, b) => b.sc - a.sc || b.i - a.i);
      const best = scored.filter((x) => x.sc > -1).slice(0, count || 1).sort((a, b) => a.i - b.i);
      return (best.length ? best : [scored[0]]).map((x) => x.s.replace(/^(?:sure|certainly|of course|great|okay|ok|yes)[!,.:\s]+/i, ""));
    }

    /* The sentence of MY message that carries the request (not the filler around it). */
    function askOf(turn) {
      const parts = stripCode(turn.u.text).split(/\n+/).flatMap((ln) => tidy(ln).split(/(?<=[.!?])\s+/)).map((x) => x.trim()).filter((x) => x.length >= 6);
      const praise = (x) => /^(?:i )?(?:loved|love|liked|like)\b|^(?:great|nice|good|perfect|thanks?|thank you|ok(?:ay)?)\b/i.test(x);
      const body = parts.filter((x) => !praise(x));
      if (!body.length) return clip(tidy(stripCode(turn.u.text)) || "[code]", 100);
      const req = body.find((x) => /^(?:please\s+)?(?:and |also |but |now )?(?:make|add|fix|build|create|get me|give me|keep|change|show|point out|improve|can you|could you)\b|\bi (?:want|need)\b/i.test(x) && !/\?\s*$/.test(x));
      return clip((req || body[0]).replace(/^(?:and|also|but|now|so)\s+/i, ""), 100);
    }

    /* ------------------------------------------------- where the session stopped */
    function lastState(msgs) {
      const last = msgs[msgs.length - 1];
      if (!last) return { kind: "empty" };
      if (last.role === "User") return { kind: "unanswered", n: (last.i != null ? last.i : msgs.length - 1) + 1, text: tidy(stripCode(last.text)) };
      const text = realText(last);
      if (!text) return { kind: "toolonly", n: (last.i != null ? last.i : msgs.length - 1) + 1 };
      const n = (last.i != null ? last.i : msgs.length - 1) + 1;
      const paras = stripCode(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      const lastPara = paras[paras.length - 1] || "";
      const sents = replySentences(lastPara).map((x) => x.s);
      let inProgress = null, justDone = null;
      for (let i = sents.length - 1; i >= 0 && !(inProgress && justDone); i--) {
        const s = sents[i];
        const m = RE_PROGRESS.exec(s);
        if (!inProgress && !m && hiRe("progress").test(s)) { inProgress = clip(s, 170); continue; }
        if (!inProgress && m && !/^i'?m (?:sorry|glad|happy|not sure)/i.test(s)) {
          const verbPhrase = m[1] ? (m[1] + (m[2] || "")) : (m[3] || m[4] || m[5] || "");
          inProgress = clip(verbPhrase.replace(/^(?:now\s+)/i, "").replace(/[,;]?\s*(?:then|and then) i'?ll.*$/i, "").trim(), 170);
        } else if (!justDone && RE_RESULT.test(s) && !RE_PLAN.test(s)) justDone = clip(s, 170);
      }
      const cutMid = !/[.!?)"'`\]*:]\s*$/.test(text.trim()) && text.trim().length > 40;
      return { kind: inProgress ? "inprogress" : "finished", n, inProgress, justDone, cutMid, lastLine: clip(sents[sents.length - 1] || "", 170) };
    }

    /* -------------------------------------------------- statuses from whole turns */
    const EVID_RANK = { tested: 3, accepted: 2, movedon: 1, claimed: 0 };
    function refineTasks(M, msgs) {
      const T = turns(msgs);
      const ls = lastState(msgs);
      T.forEach((turn, k) => {
        const mine = M.tasks.filter((t) => t.by === "user" && t.idx === turn.uIdx);
        if (!mine.length) return;
        const reply = replyOf(turn);
        const next = T[k + 1] || null;
        const nextText = next ? stripCode(next.u.text) : "";
        // "that's broken" means the work failed; "actually use D3 instead" / "forget the mobile app" is a change of plan, not a failure
        const planChange = !!next && !RE_COMPLAINT.test(nextText) && RE_PLANCHANGE.test(nextText.slice(0, 240));
        const complaint = !!next && !planChange && (RE_COMPLAINT.test(nextText) || RE_CORRECTION.test(nextText.trim()));
        const praise = !!next && !complaint && RE_PRAISE.test(nextText.slice(0, 160));
        const completes = RE_COMPLETE.test(stripCode(reply));
        const tested = RE_TESTED.test(stripCode(reply));
        const replyTopic = topicOf(stripCode(reply));
        const single = mine.length === 1;
        const isLast = k === T.length - 1;
        // how do we know it is done? tested > you said so > you moved on without complaint > only the assistant's word
        const evidence = tested ? "tested" : praise ? "accepted" : next && !complaint ? "movedon" : "claimed";
        for (const t of mine) {
          const ov = sharedCount(t.topic, replyTopic);
          if (!reply) { t.status = "pending"; t.why = "no reply yet"; continue; }
          if (complaint && ov >= 1) { t.status = "failed"; t.failedAt = next.n; t.evidence = "failed"; continue; }
          if (planChange && ov >= 1 && completes) { t.status = "replaced"; t.replacedAt = next.n; t.evidence = "movedon"; continue; }
          if (t.status === "verified") { t.evidence = "tested"; continue; }
          if (completes && (ov >= 2 || single || (!isLast && !complaint))) { t.status = "done"; t.doneAt = turn.n; t.by2 = "reported"; t.evidence = evidence; continue; }
          if (isLast && (ls.kind === "inprogress")) { t.status = "inprogress"; continue; }
          if (completes && ov >= 1) { t.status = "done"; t.doneAt = turn.n; t.by2 = "reported"; t.evidence = evidence; continue; }
          t.status = "unconfirmed";
        }
      });
      return ls;
    }
    const EVID_WORD = { tested: "done and tested", accepted: "done, you accepted it", movedon: "done (you moved on; not confirmed)", claimed: "done per the assistant only — verify", failed: "reported not working" };
    const EVID_MARK = { tested: "✔", accepted: "✓", movedon: "~", claimed: "~", failed: "✗" };

    /* ---------------------------------------------------------- what it is about */
    const BRANDS = new Set("Chrome Chromium Claude ChatGPT Gemini Copilot Perplexity Grok DeepSeek Google Microsoft OpenAI Anthropic Python Node Java JavaScript TypeScript React Vue Angular Windows Linux Mac macOS iPhone Android GitHub Docker Excel Word PowerPoint Notion Slack The This That These Those There Here What When Where Which While With Without Please Sure Yes Done Added Fixed Built Created Updated Zip Files Folder Standard Compact Extended Smart Full Copy Insert Save Card Open Close Captured Scanning".split(" "));
    /* A project name needs evidence: "Capsa 6.0", "called/named Foo", or a file stem the chat keeps using (`capsa.zip`).
       A capitalised word that merely recurs ("Nara", "Tokyo") is a topic, not a name. */
    function properName(msgs) {
      const count = new Map();
      const add = (k, w) => { if (k && k.length >= 4 && !BRANDS.has(k)) count.set(k, (count.get(k) || 0) + w); };
      for (const m of msgs) {
        const t = stripCode(m.text);
        for (const x of t.matchAll(/\b([A-Z][a-z]{3,}[A-Za-z]*)\s+v?\d+(?:\.\d+)+\b/g)) add(x[1], 3);
        for (const x of t.matchAll(/\b(?:called|named|titled|name is|project is)\s+[`"“']?([A-Z][A-Za-z0-9]{3,})/g)) add(x[1], 4);
        for (const x of t.matchAll(/`([a-z][a-z0-9-]{3,})\.(?:zip|js|py|json|md|html)`/g)) add(x[1][0].toUpperCase() + x[1].slice(1), 1.5);
      }
      const top = [...count.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1])[0];
      return top ? top[0] : "";
    }
    function subjectWords(msgs, max) {
      const count = new Map();
      const turnsSeen = new Map();
      const canon = h.canon || ((w) => w);
      const bump = (raw, w, ti) => {
        let w0 = canon(raw.toLowerCase().replace(/colour/g, "color"));
        if (w0.length < 4 || GENERIC.has(w0) || /^\d+$/.test(w0)) return;
        const key = w0.replace(/(?:ing|ed|es|s)$/, "");
        const o = count.get(key) || { c: 0, forms: new Map() };
        o.c += w; o.forms.set(w0, (o.forms.get(w0) || 0) + w); count.set(key, o);
        (turnsSeen.get(key) || turnsSeen.set(key, new Set()).get(key)).add(ti);
      };
      let ti = -1;
      for (const m of msgs) {
        if (m.role === "User") ti++;
        const w = m.role === "User" ? 2 : 1;
        for (const x of stripCode(m.text).split(/[^A-Za-z0-9]+/)) if (x) bump(x, w, Math.max(0, ti));
      }
      // a topic recurs across the conversation; a word that shows up in one burst is not the topic
      return [...count.entries()].filter(([k, o]) => o.c >= 3 && turnsSeen.get(k).size >= 2).sort((a, b) => b[1].c - a[1].c).slice(0, max || 6)
        .map(([, o]) => [...o.forms.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
    /* The sentence, among my first few messages, that best says what I set out to do (a complaint or an error paste is not it). */
    function startedWith(msgs, M) {
      const users = msgs.filter((m) => m.role === "User").slice(0, 3);
      let best = null;
      users.forEach((m, ui) => {
        for (const raw of stripCode(m.text).split(/\n+/)) {
          // a whole line that is an error message or a complaint is never "what I set out to do" ("Chrome does not allow ... Open a normal website and try again.")
          if (/\b(?:error|exception|traceback|not allowed|does not allow|doesn'?t allow|cannot|can'?t|failed|undefined|not working|doesn'?t work)\b/i.test(raw) || RE_COMPLAINT.test(raw)) continue;
          for (const x of tidy(raw).split(/(?<=[.!?।])\s+/)) {
          const sx = x.trim(); if (sx.length < 15 || sx.length > 220) continue;
          let sc = 0;
          if (/^(?:i want you to|please|kindly)\b/i.test(sx)) sc += 3;
          if (/^(?:i want to|i'?d like to|i would like to|i(?:'m| am) (?:trying|building|making|working)|help me|we need to (?:build|make|create)|build me|create a|make a|can you (?:build|make|create|help))\b/i.test(sx)) sc += 4;
          if (/\b(?:build|create|make|design|write|develop|app|extension|website|tool|project|script|plan|report|essay)\b/i.test(sx)) sc += 1.5;
          if (hiRe("request").test(sx)) sc += 1.5;
          if (RE_COMPLAINT.test(sx) || /\b(?:error|exception|traceback|not working|does not allow|doesn'?t allow)\b/i.test(sx)) sc -= 4;
          if (/\?\s*$/.test(sx)) sc -= 1;
          if (/^(?:ok|okay|hi|hello|hey|thanks|thank you)\b/i.test(sx)) sc -= 3;
          sc -= ui * 0.4;
          if (!best || sc > best.sc) best = { s: sx, sc, n: (m.i != null ? m.i : msgs.indexOf(m)) + 1 };
          }
        }
      });
      return best;
    }
    function aboutOf(msgs, M, title, subject) {
      return { name: title || properName(msgs), topics: subject, started: startedWith(msgs, M) };
    }

    /* ------------------------------------------------------------------ notes */
    function buildNotes(M, msgs, opts) {
      opts = opts || {};
      const T = turns(msgs);
      const ls = lastState(msgs);
      const journey = T.map((turn, k) => {
        let out = outcomeOf(turn, opts.level >= 2 ? 2 : 1);
        if (k === T.length - 1 && ls.kind !== "unanswered" && ls.justDone) out = [ls.justDone];   // the last reply's own conclusion beats a keyword guess
        const mine = M.tasks.filter((t) => t.by === "user" && t.idx === turn.uIdx && !t.absorbed);
        let mark = "";
        if (mine.some((t) => t.status === "failed")) mark = "failed";
        else {
          const done = mine.filter((t) => t.status === "done" || t.status === "verified");
          if (done.length) mark = done.map((t) => t.evidence || "claimed").sort((a, b) => EVID_RANK[a] - EVID_RANK[b])[0];   // weakest evidence among the finished asks
        }
        return { n: turn.n, ask: askOf(turn), result: out.join(" "), replied: out.length > 0, mark };
      });
      const open = M.tasks.filter((t) => t.by === "user" && ["pending", "failed", "unconfirmed", "inprogress"].includes(t.status) && !t.absorbed);
      const subject = subjectWords(msgs, 6);
      const toolSteps = msgs.filter((m) => m.role === "Assistant" && /^\s*\[tool use\]\s*$/i.test(String(m.text || ""))).length;
      const claimed = M.tasks.filter((t) => t.by === "user" && t.status === "done" && (t.evidence === "claimed" || t.evidence === "movedon") && !t.absorbed && !/^(?:please\s+)?(?:get me|show me|send me|give me|explain|tell me|find|list|summari[sz]e)\b/i.test(t.text)).slice(-2);   // asking to be shown something makes no claim to verify
      return { subject, about: aboutOf(msgs, M, opts.title || "", subject), title: opts.title || "", journey, last: ls, open, claimed, toolSteps, lang: langOf(msgs), turns: T.length, msgs: msgs.length };
    }

    /* The "do this first" line: the thing that was interrupted beats everything else. */
    function nextStep(notes, M) {
      const ls = notes.last;
      if (ls.kind === "unanswered") return { text: "My last message (#" + ls.n + ") never got an answer — answer it first: " + clip(ls.text, 170), n: ls.n };
      if (ls.kind === "inprogress" && ls.inProgress) return { text: "Finish what was in progress when the last session ended: " + ls.inProgress, n: ls.n };
      if (ls.kind === "toolonly") return { text: "The last assistant step was cut off before it said anything — re-check the latest ask below and continue from there.", n: ls.n };
      const failed = notes.open.filter((t) => t.status === "failed");
      if (failed.length) return { text: "Redo (I reported it did not work): " + clip(failed[failed.length - 1].text, 170), n: failed[failed.length - 1].n };
      const pend = notes.open.filter((t) => t.status === "pending");
      if (pend.length) return { text: clip(pend[pend.length - 1].text, 170), n: pend[pend.length - 1].n };
      return null;
    }

    function renderNotes(notes, M, opts) {
      opts = opts || {};
      const L = opts.level === 0 ? { a: 80, r: 120, w: 5 } : opts.level >= 2 ? { a: 120, r: 200, w: 8 } : { a: 100, r: 160, w: 6 };
      const ref = opts.ref || ((n) => "(#" + n + ")");
      const lines = [];
      const ab = notes.about || {};
      const head = [ab.name, notes.subject.length ? notes.subject.slice(0, L.w).join(", ") : ""].filter(Boolean).join(" — ");
      const st = ab.started || (M.goal ? { s: M.goal.text, n: M.goal.n } : null);
      lines.push("- About: " + (head || "topic not clear") + (st ? ". Started with: " + clip(tidy(st.s), L.r) + " " + ref(st.n) : ""));
      if (notes.lang !== "en") lines.push("- Language: " + (notes.lang === "hinglish" ? "mixed Hindi/English — partly interpreted; the wording below is copied from the chat, check it against the numbered messages" : "not mainly English — this capsule is structural (order of events, results, files); the wording was copied, not interpreted"));

      // the story, one line per exchange: what I wanted → what came out of it
      const J = notes.journey.filter((j) => j.replied);
      const maxJ = opts.level === 0 ? 4 : opts.level >= 2 ? 12 : 7;
      let shown = J;
      if (J.length > maxJ) shown = J.slice(0, 1).concat(J.slice(-(maxJ - 1)));
      if (shown.length) {
        const legend = shown.some((j) => j.mark) ? " [✔ tested · ✓ you accepted · ~ not confirmed · ✗ you said it failed]" : "";
        lines.push("- Progress so far (" + notes.turns + " exchanges)" + legend + ":");
        let prev = null;
        for (const j of shown) {
          if (prev && j.n - prev > 2 && J.length > maxJ && shown.indexOf(j) === 1) lines.push("  · […" + (J.length - shown.length) + " earlier steps omitted…]");
          lines.push("  " + ref(j.n) + (j.mark ? " " + EVID_MARK[j.mark] : "") + " " + clip(j.ask, L.a) + " → " + clip(j.result, L.r));
          prev = j.n;
        }
      }

      const ls = notes.last;
      if (ls.kind === "unanswered") lines.push("- Where it stopped: the chat ends on MY message " + ref(ls.n) + " — it was never answered.");
      else if (ls.kind === "inprogress") lines.push("- Where it stopped: " + (ls.justDone ? "just finished — " + clip(ls.justDone, L.r).replace(/[.;]+$/, "") + "; " : "") + "was in the middle of — " + ls.inProgress + " " + ref(ls.n) + (ls.cutMid ? " [the reply itself was cut off mid-sentence]" : ""));
      else if (ls.kind === "toolonly") lines.push("- Where it stopped: inside a tool step, before the assistant reported anything " + ref(ls.n));
      else if (ls.kind === "finished") lines.push("- Where it stopped: the last reply was a finished report" + (ls.justDone ? " — " + clip(ls.justDone, L.r).replace(/[.;]+$/, "") : "") + " " + ref(ls.n) + (ls.cutMid ? " [cut off mid-sentence]" : ""));

      const stale = notes.open.filter((t) => t.status === "unconfirmed");
      const trulyOpen = notes.open.filter((t) => t.status !== "unconfirmed");
      if (trulyOpen.length) lines.push("- Still open: " + trulyOpen.slice(-3).map((t) => clip(tidy(t.text), 90) + " " + ref(t.n)).join(" · "));
      if (stale.length) lines.push("- Asked, but no clear confirmation it was finished (check before assuming): " + stale.slice(-3).map((t) => clip(tidy(t.text), 80) + " " + ref(t.n)).join(" · "));
      if (notes.claimed && notes.claimed.length) lines.push("- Verify before relying on (reported done, never tested or confirmed): " + notes.claimed.map((t) => clip(tidy(t.text), 70) + " " + ref(t.n)).join(" · "));
      if (notes.toolSteps) lines.push("- Hidden work: " + notes.toolSteps + " assistant tool step(s) had no readable text (commands run, files read/written) — their results are NOT in this capsule.");
      const nx = nextStep(notes, M);
      lines.push("- Do first: " + (nx ? nx.text : "re-read the latest ask below and confirm understanding"));
      return lines;
    }

    return { turns, outcomeOf, askOf, lastState, refineTasks, subjectWords, buildNotes, nextStep, renderNotes, tidy, aboutOf, EVID_WORD };
  }

  return { create, tidy, HI, langOf };
});
