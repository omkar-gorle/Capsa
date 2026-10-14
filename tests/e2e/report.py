"""A link that opens but whose layout nothing recognises must end with a reason AND a copyable page report
(text-free), never a blank card.   python3 report.py"""
import asyncio, os, shutil, sys, json
from playwright.async_api import async_playwright
EXT=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."))
async def main():
    async with async_playwright() as p:
        shutil.rmtree("/tmp/capsa-pwprof-rep",ignore_errors=True)
        ctx=await p.chromium.launch_persistent_context("/tmp/capsa-pwprof-rep",headless=False,viewport={"width":1000,"height":760},
          args=["--headless=new","--no-sandbox",f"--disable-extensions-except={EXT}",f"--load-extension={EXT}",
                "--host-resolver-rules=MAP claude.ai 127.0.0.1:8443","--ignore-certificate-errors","--no-proxy-server"])
        sw=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        eid=sw.url.split("/")[2]
        home=await ctx.new_page(); await home.goto("https://claude.ai/chat/abc")
        pp=await ctx.new_page(); await pp.set_viewport_size({"width":340,"height":700})
        await pp.goto(f"chrome-extension://{eid}/ui/popup.html"); await pp.wait_for_timeout(900)
        await pp.evaluate("navigator.clipboard.writeText=async(t)=>{window.__clip=t}")
        await pp.locator("[data-r=link]").fill("https://claude.ai/share/abcdef01-2345-6789-abcd-ef0123456789?n=20&api=0&opaque=1"); await pp.locator("[data-r=link]").press("Enter")
        ok=False
        for _ in range(60):
            await pp.wait_for_timeout(1500)
            if await pp.locator("[data-r=vbar]").is_visible(): ok=True; break
        title=await pp.locator("[data-r=vt]").inner_text() if ok else ""
        rep_visible=await pp.locator("[data-r=vrep]").is_visible() if ok else False
        text=""
        if rep_visible:
            await pp.locator("[data-r=vrep]").click(); await pp.wait_for_timeout(500)
            text=await pp.evaluate("window.__clip||''")
        data=json.loads(text) if text.startswith("{") else {}
        leaked=any(w in text for w in ("Question ","Answer ","lorem"))
        good=ok and "read the chat" in title and rep_visible and data.get("capsaReport")==1 and not leaked
        print(("PASS" if good else "FAIL"),"unreadable layout -> reason + page report", f"panel={ok} title={title!r} report={len(text)} chars no-message-text={not leaked} keys={list(data)[:6]}")
        await ctx.close(); sys.exit(0 if good else 1)
asyncio.run(main())
