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
