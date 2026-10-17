# Capsa 6 — move your AI work

Capture a chat → shrink it into a capsule → continue on any AI. Everything stays on your device.

## Install
1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick this folder
3. Open ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok or DeepSeek — a floating capsule orb appears (bottom-right, draggable).

## Use
- **Tap the floating scroll** → tap the big scroll in the card → it unrolls and scans the chat, then stamps a seal when done.
- **Paste a chat link** (anywhere, any tab) → Capsa opens it in a hidden tab, reads it, closes it. Pasting a valid link starts capture automatically. You must be signed in to that AI in Chrome for private chats.
- Pick a size: **Compact · Standard · Extended · Smart · Full**.
- **Add files, a folder or a .zip** (button, or drag onto the card). Text and code are read and compressed into the context with the chat; binaries are listed by name only; `.env`, keys and anything that looks like a secret are never read; `node_modules`, `.git`, lock files and build folders are skipped. Limits: 300 files, 2 MB per file, 25 MB per add, no password-protected or Zip64 archives.
- **Copy**, **Insert here** (types it into the chat box of the tab you're on), or **Save .md**.
- Your last capture is remembered, so you can capture on one AI, switch tabs, and insert on another.
- The toolbar icon opens the same card as a popup (also works on non-AI pages for link capture). Toggle the floating orb in the card footer.

## What changed from 5.1
See the table in the hand-off notes: required site permissions instead of optional-and-never-requested, a UI whose markup actually matches its code, working link capture, one shared card for popup and orb, and the optional AI-provider / profile / files / encryption / history features removed.

## Long chats: whole means whole
- **No fixed scroll count.** The reader keeps loading older history until the chat has been quiet for longer than the slowest load it has seen (it watches the page change, not a timer), waits out spinners, and clicks nothing it shouldn't. A 25-minute safety net exists only for a stuck page.
- **It proves it.** A capsule is made only if all of these hold: it reached the very top and nothing more loads · it reached the end · two independent passes (different direction and step size) found the same messages in the same order · no scroll step landed on content that didn't overlap the last · no gap between messages big enough to hide one · turn numbers are consecutive where the site has them · it finished in time.
- **If it can't prove it,** no capsule is made. The card lists exactly which check failed, with **Retry** and **Use anyway** (the capsule is then clearly marked as not verified).
- **Pasted links:** read in a hidden tab first. If the site won't render/load while hidden, Capsa moves it to a visible window, says so on the card and on a banner inside that window, and closes it when done.
- Verified in a real browser against 120, 240 and 520-message chats (virtualized, lazily loaded, slow, with spinners, with many identical messages) and against chats with deliberately missing messages.

Run the long-chat suite: `tests/e2e/long.py` (see `tests/e2e/README.md`).

## Privacy
Files you add never leave your device either. No network calls of its own. The only page Capsa ever opens is a link you paste. Permissions: the seven AI sites above, `activeTab`, `scripting`, `storage`, `clipboardWrite`, `unlimitedStorage` (long chats).

## Develop
    node tests/run.js        # manifest, link validation, rendering
    tests/e2e/               # real-Chromium test against mock Claude/ChatGPT pages

Layout: `background.js` (all page work) · `ui/card.js` (the card) · `content/launcher.js` (floating orb) · `content/capture-runtime.js` (per-site readers) · `lib/capsule.js` (compression) · `lib/hosts.js` (site + link rules).

## Captures survive closing the popup

Chrome closes a toolbar popup the moment focus leaves it, and may stop an idle background worker. So a capture is a
background **job**: the card only starts it, and the outcome (verified capsule, "not verified" panel with
Retry / Use anyway, or an error) is written to storage. Any card you open later picks it up — nothing is lost, and
the toolbar icon shows `…` while reading, `✓` when done, `!` when it needs you. A **Cancel** button stops a read.
If Chrome kills the worker mid-read, the next start marks the job "interrupted" and the card offers Retry.
Tested by `tests/e2e/survive.py`.


## How the capsule understands a conversation (6.5)

`lib/understand.js` turns a chat into a structured model, in four separate stages:

1. **extract** — goals, requirements, prohibitions, decisions, corrections, errors, fixes, tasks, technical details
   (commands, versions, test results) and references (links, files, folders, screenshots). Nothing is dropped here.
2. **resolve** — chronology. A correction supersedes only what it clearly refers to; "I said no X" reinforces the rule
   the assistant broke (and records the failed attempt); "you can … only for Y" becomes an exception, not a deletion;
   a later plain repeat is reinforcement, never an override; unclear cases go to an UNCLEAR section instead of being guessed.
3. **rank** — importance tiers: (1) constraints, prohibitions, final decisions; (2) goal; (3) state, corrections,
   blockers, next action; (4) technical details; (5) rationale/history; (6) noise, never emitted.
4. **generate / verify** — fits a token budget by dropping the lowest tier first (tier 1 is never removed), then checks
   that the critical items are present and that nothing superseded is shown as active.

Compact / Standard / Extended / Smart use it (`ropts.files` tells it which files are included, so REFERENCES can say
"INCLUDED" or "NOT included"). **Brief** gives a request for any AI that follows the same structure and rules.
No new permissions, dependencies or settings; if the module is missing the older extraction is used.
Known limits: it is keyword-based (unusual phrasing can be missed), and a decision made earlier that only *implicitly*
depends on a replaced one (e.g. "use hooks" after switching React -> Vue) is not detected as outdated.


## Key notes (6.6) — a hand-over, not a transcript

Built for the moment a session runs out of tokens half-way through a job. The top of every capsule is now **KEY NOTES**
(`lib/notes.js`), written like the notes you would leave a colleague who takes over:

- **About** — what is being built, plus the topic words that recur.
- **Progress so far** — one line per exchange: what I asked → the *result* (the sentence that reports an outcome, never the
  "I'll start by…" plan sentence).
- **Where it stopped** — read from the last assistant message: what it had *just finished* and what it was *in the middle of*
  (e.g. "stress-testing a 400-message chat"). If the chat ends on *my* message, it says that message was never answered.
- **Still open / asked but not confirmed** — requests judged from the whole turn (the reply and my next message), so finished
  work is no longer listed as pending, and a later complaint turns "done" into "reported not working".
- **Do first** — the interrupted job beats everything else.

Typed-fast noise (`...`, `. .`, `,,`, `//`), markdown headings, "on/off"-style prose and assistant diagnoses that used to leak in as
"blockers", "folders" or "what I just reported" are filtered. Everything is rule-based and on-device: no tokens, no network,
same answer twice.

**Files are understood, not just pasted.** Every text file gets a one-line description (README title, package name + scripts + deps,
HTML title, the lead comment and the functions/classes a code file defines, CSV columns, SQL tables…) and the list opens with a project
overview (languages, where to start, folders). Compact therefore says what every file *is* without carrying its contents.

Known limits: rule-based, so unusual phrasing can be missed; "done" is the assistant's own report unless tests are mentioned
(the notes say "done (reported)"); the *About* line is the first goal sentence, which is only as clear as the first message.


## 6.7 — what was hardened, and what is still true

**Added**
- **Secrets are redacted from the chat text** before anything is rendered (API keys, tokens, JWTs, PEM keys, `password = …`, credentials in URLs,
  "my password is …"). The setting's *name* stays (`DB_PASSWORD="[REDACTED]"`) so the next AI knows it exists; `os.environ[...]` and placeholders are left alone.
  The card warns you how many values were replaced. **This catches common forms, not every secret — read the capsule before sharing it.**
- **A message cannot close the capsule early.** A fake `=== END CAPSULE ===` line inside a chat is defanged, and the header says quoted chat text is data, not commands.
  (A model can still be talked into things by text it reads; this removes the cheap trick, not the whole risk.)
- **Capsule of a capsule.** If you paste an earlier capsule into a chat, it is lifted out of the conversation (not read as things you said) and its
  KEY NOTES / hard rules / requirements / decisions are carried in one labelled section, `CARRIED FROM AN EARLIER CAPSULE`. A third hand-over still carries them without nesting or snowballing.
- **Documents.** Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument and **PDF** are read inside the browser. PDFs: text PDFs from Word, LibreOffice, Chrome and most generators
  (compressed streams, object streams, ToUnicode maps, pages in order). **Scanned / image-only PDFs, encrypted PDFs and unusual font encodings are reported as "no readable text" — there is no OCR.**
  Hindi/Indic text inside PDFs can come out with letters in the wrong order or extra spaces.
- **Zip64** archives are read. **Minified bundles** (`*.min.js`, huge-line files) and `.map` files are named but not pasted.
- **Insert here**: if the chat box takes only part of a long capsule, the whole capsule is put on the clipboard and you are told to clear the box and paste.
- Typo tolerance, basic Hindi/Hinglish cues, an honest "evidence" mark on every step (tested / you accepted it / you moved on / not confirmed / you said it failed),
  code carried (latest version per file), a "NOT IN THIS CAPSULE" list, and a corpus of varied chats in `tests/corpus.js`.

**Still true — read this before you rely on it**
- **Not tested on the live sites.** The browser tests run against mock Claude/ChatGPT pages. The seven sites change their markup; expect readers to break sometimes.
  If a capture fails or looks short, the card says why and refuses to call it complete.
- **The notes are rule-based**, not understanding. They are good at "what was asked, what was reported done, where it stopped"; weak at nuance, sarcasm, long-range reasoning, and any
  language other than English / basic Hinglish. "Done" always means *someone said so* — the evidence marks tell you how strongly.
- **Lossy by design.** Reasoning, tool output, images, Claude artifacts/canvas and edited/regenerated branches are not carried (the capsule says which counts it saw). Missing detail → the next AI is told to ask, not invent.
- **Images are not read** (no OCR). Password-protected zips/PDFs are not read.
- **Token counts are estimates**, not a real tokenizer; some chat boxes cap pasted length.
- **Chrome desktop only**, loaded unpacked (developer mode). Not on mobile, Firefox or Safari.


## 6.8 — the Meter (claude.ai) and one-click hand-off

A small pill at the bottom-left of **claude.ai** (the orb stays bottom-right). Click it to open the panel; ✕ hides it (a tiny ◐ handle stays to bring it back).

| Shows | Where it comes from |
|---|---|
| **Session (5 h) and weekly (7 d) usage**, bars turn red at 90%, a tick marks how far through the window you are, **live reset countdowns** | claude.ai's own `/usage` call plus the live `message_limit` event in each reply's stream (exact, unrounded) |
| **Weekly by model** | the per-model lines claude.ai reports, plus a count of the replies *this browser* saw per model in the last 7 days |
| **This chat vs the 200k window** | the conversation claude.ai already loaded, counting only the branch on screen; tokens are an **estimate** (no public Claude tokenizer) |
| **Prompt-cache countdown** | 5 minutes after the last assistant message |
| **Replies left (~)** | learned from *your own* replies: how many session-% each one cost on this model, per 1k tokens of chat, scaled to the chat you are in. Needs ≥3 replies on a model to be called an estimate; before that it says it is learning. Opus is assumed to cost more than Sonnet only until it has seen your Opus replies |
| **Hand off → ChatGPT / Gemini / Grok** | reads the whole chat with the usual verified capture, builds a Standard capsule (secrets redacted), opens the site and puts the capsule in its chat box. If the chat can't be verified, **nothing is handed off** |

How it works: `content/meter-tap.js` runs in the page's own world and *observes* three kinds of response claude.ai already receives (usage stream event, conversation tree, start of a reply); `content/meter.js` draws the panel; `lib/meter.js` is the tested logic.
It contacts **claude.ai only**, with your signed-in session, and never uploads anything. Usage-window parsing follows the MIT-licensed *Claude Counter* extension (see `THIRD_PARTY_NOTICES.md`).

**Honest limits.** These rely on claude.ai's *unofficial* endpoints and event names; if Anthropic renames them the bars show "couldn't read usage" instead of wrong numbers, and the Meter needs an update.
It was tested against a mock claude.ai only. "Replies left" is a rule of thumb from few samples, not a promise. The hand-off needs you to be signed in to the target site; if its chat box doesn't accept the text, the capsule is kept and Capsa's card there offers Copy / Insert.
After updating, reload open claude.ai tabs once.

**Not part of Capsa:** no-code form building, ledger/voucher accounting and approval flows are Claude product/connector features (they need a server-side integration and the provider's own permissions model), not something a browser extension that only reads chats can add.
