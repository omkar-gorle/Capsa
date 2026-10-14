Real-browser check (needs Python + Playwright + Chromium):

    cd tests/e2e
    openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 2 -subj "/CN=mock" -addext "subjectAltName=DNS:claude.ai,DNS:chatgpt.com"
    python3 server.py &        # mock Claude / ChatGPT pages on https://127.0.0.1:8443
    python3 run.py             # loads the extension, drives the scroll, link capture, zip upload, insert

Set `CHROME=/path/to/chrome` if Chromium isn't at the default Playwright location.

Long chats (120 / 240 / 520 messages, virtualized, lazy, slow, with holes, via pasted link):

    python3 long.py            # ~15 minutes; `python3 long.py 520` runs matching scenarios only

Each scenario compares the capsule to the mock page's own message list exactly. Scenarios with a deliberately
missing chunk must produce NO capsule. For true hidden-tab behaviour use real Chrome; the suite's off-screen
scenario uses a test hook (`data-capsa-test-offscreen`) because Playwright treats every tab as visible.

`survive.py` closes the popup mid-capture, reopens it, kills the service worker, and checks the result is always
on the card (capsule, unverified panel with Use anyway, or interrupted + Retry).
