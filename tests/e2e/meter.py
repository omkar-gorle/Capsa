"""Meter + hand-off against a mock claude.ai (run server.py first).  python3 meter.py"""
import asyncio, shutil, os, re, urllib.request, ssl
from playwright.async_api import async_playwright
EXT=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."))
CTX=ssl._create_unverified_context()
def setpct(v): urllib.request.urlopen("https://127.0.0.1:8443/__meter?pct=%s"%v,context=CTX).read()
fails=[]
def check(c,name):
    print(("  ok   " if c else "  FAIL ")+name)
    if not c: fails.append(name)
async def main():
    setpct(0.42)
    async with async_playwright() as p:
        shutil.rmtree("/tmp/capsa-pwprof-m",ignore_errors=True)
        ctx=await p.chromium.launch_persistent_context("/tmp/capsa-pwprof-m",headless=False,executable_path=os.environ.get("CHROME") or None,viewport={"width":1100,"height":760},
            args=["--headless=new","--no-sandbox",f"--disable-extensions-except={EXT}",f"--load-extension={EXT}",
                  "--host-resolver-rules=MAP claude.ai 127.0.0.1:8443, MAP chatgpt.com 127.0.0.1:8443, MAP gemini.google.com 127.0.0.1:8443, MAP grok.com 127.0.0.1:8443","--ignore-certificate-errors","--no-proxy-server"])
        pg=await ctx.new_page(); logs=[]
        pg.on("pageerror",lambda e: logs.append("PAGEERR "+str(e)))
        await pg.goto("https://claude.ai/chat/conv-mock-0001")
        await pg.wait_for_selector("capsa-meter",state="attached",timeout=8000)
        sh=lambda sel: pg.locator("capsa-meter "+sel)
        await pg.wait_for_function("document.querySelector('capsa-meter').shadowRoot.querySelector('[data-p]').textContent.includes('42%')",timeout=8000)
        check(True,"pill shows the session % read from the usage endpoint")
        await sh(".pill").click(); await pg.wait_for_timeout(400)
        t=lambda k: sh('[data-k="%s"]'%k).inner_text()
        s=await t("session"); check("42% used" in s and re.search(r"resets in 2h 1\dm",s) is not None,"session: %%, bar and reset countdown  -> "+s.replace("\n"," | "))
        w=await t("weekly"); check("12% used" in w and "resets in 2d" in w and "opus" in w.lower() and "30%" in w,"weekly: %%, reset countdown, per-model line -> "+w.replace("\n"," | "))
        c=await t("ctx"); check("~3.1k / 200k" in c and "3 messages" in c,"context: ~tokens against 200k, branch message count -> "+c.replace("\n"," | "))
        ca=await t("cache"); check(re.search(r"[34]m \d\ds",ca) is not None and "cheaper" in ca,"cache countdown from the last assistant message -> "+ca.replace("\n"," | "))
        l0=await t("left"); check("—" in l0 and "learning" in l0,"replies left: honest 'learning' before any sample -> "+l0.replace("\n"," | "))
        await pg.screenshot(path="shots/m1-panel.png")
        # four replies: live message_limit moves the numbers and the predictor learns
        for i in range(4):
            await pg.locator("#send").click(); await pg.wait_for_function("document.getElementById('log').textContent.startsWith('done')"); await pg.evaluate("document.getElementById('log').textContent=''"); await pg.wait_for_timeout(400)
        await pg.wait_for_timeout(1800)
        pill=await sh("[data-p]").inner_text(); print("pill:",pill)
        check(pill.startswith("50%"),"live stream event updates the session % without a refresh")
        m=re.search(r"~(\d+) left",pill); check(m is not None and 18<=int(m.group(1))<=30,"pill shows ~replies left learned from 4 replies (expected ~24)  -> "+pill)
        w=await t("weekly"); check("Sonnet 4" in w,"local tally counts replies per model -> "+w.replace("\n"," | "))
        await pg.screenshot(path="shots/m2-learned.png")
        # near the limit: red + advice
        setpct(0.93); await sh('[data-a="refresh"]').click(); await pg.wait_for_timeout(900)
        lv=await sh(".pill").get_attribute("data-l"); adv=await sh("[data-a2]").inner_text()
        check(lv=="red" and "Hand off" in adv or "hand off" in adv.lower(),"90%+ turns the pill red and says what to do -> "+adv)
        bl=await sh('[data-k="session"] .bar').get_attribute("data-l"); check(bl=="red","session bar turns red")
        await pg.screenshot(path="shots/m3-red.png")
        # hand-off to ChatGPT: reads the chat (verified), opens ChatGPT, drops the capsule in the box
        before=len(ctx.pages)
        await sh('[data-h="chatgpt"]').click()
        for _ in range(60):
            await pg.wait_for_timeout(1000)
            tgt=[x for x in ctx.pages if "chatgpt.com" in x.url]
            msg=await sh("[data-msg]").inner_text()
            if tgt and ("Done" in msg or "Opened" in msg or "Couldn't" in msg): break
        print("handoff msg:",msg)
        check(bool(tgt),"hand-off opened ChatGPT in a new tab")
        if tgt:
            await tgt[0].wait_for_timeout(500)
            box=await tgt[0].locator("#prompt-textarea").inner_text()
            check("CONTEXT CAPSULE" in box and "hello" in box.lower(),"the capsule was inserted into ChatGPT's chat box (%d chars)"%len(box))
            check("Done" in msg,"the meter reports it")
        check(not logs,"no page errors: %s"%logs)
        await ctx.close()
    print("FAILED: %s"%fails if fails else "ALL OK"); raise SystemExit(1 if fails else 0)
asyncio.run(main())
