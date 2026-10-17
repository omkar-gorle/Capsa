import asyncio, sys, shutil, json, os
from playwright.async_api import async_playwright
EXT=os.path.abspath(os.path.join(os.path.dirname(__file__),"..","..")); SH=os.path.join(os.path.dirname(__file__),"shots")
import os; os.makedirs(SH,exist_ok=True)
async def main():
    async with async_playwright() as p:
        shutil.rmtree("/tmp/capsa-pwprof",ignore_errors=True)
        ctx=await p.chromium.launch_persistent_context("/tmp/capsa-pwprof",headless=False,
            executable_path=os.environ.get("CHROME") or None,
            viewport={"width":1100,"height":760},
            args=["--headless=new","--no-sandbox",f"--disable-extensions-except={EXT}",f"--load-extension={EXT}",
                  "--host-resolver-rules=MAP claude.ai 127.0.0.1:8443, MAP chatgpt.com 127.0.0.1:8443","--ignore-certificate-errors","--no-proxy-server"])
        sw=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        eid=sw.url.split("/")[2]; print("ext id",eid)
        pg=await ctx.new_page()
        logs=[]
        pg.on("console",lambda m: logs.append(m.text)); pg.on("pageerror",lambda e: logs.append("PAGEERR "+str(e)))
        await pg.goto("https://claude.ai/chat/abc"); 
        await pg.wait_for_selector("capsa-orb",state="attached",timeout=8000)
        print("orb injected")
        await pg.screenshot(path=f"{SH}/1-orb.png")
        await pg.locator("capsa-orb .bubble").click(force=True)
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=f"{SH}/2-open.png")
        await pg.locator("capsa-orb .orb").click()
        await pg.wait_for_selector("capsa-orb .out:not([hidden])",timeout=15000)
        await pg.wait_for_timeout(700)
        print("status:",await pg.locator("capsa-orb [data-r=st]").inner_text())
        print("chip:",await pg.locator("capsa-orb [data-r=chip]").inner_text(),"| title:",await pg.locator("capsa-orb [data-r=title]").inner_text())
        pv=await pg.locator("capsa-orb textarea").input_value(); print("preview len",len(pv)); print(pv[:500])
        await pg.screenshot(path=f"{SH}/3-captured.png")
        # switch level
        await pg.locator("capsa-orb .seg button[data-m=l2]").click(); await pg.wait_for_timeout(500)
        print("extended tokens:",await pg.locator("capsa-orb [data-r=tok]").inner_text())
        await pg.locator("capsa-orb .seg button[data-m=full]").click(); await pg.wait_for_timeout(500)
        print("full tokens:",await pg.locator("capsa-orb [data-r=tok]").inner_text(), len(await pg.locator("capsa-orb textarea").input_value()))
        await pg.locator("capsa-orb .seg button[data-m=brief]").click(); await pg.wait_for_timeout(500)
        bv=await pg.locator("capsa-orb textarea").input_value()
        print("brief tokens:",await pg.locator("capsa-orb [data-r=tok]").inner_text(), len(bv))
        assert "HARD RULES — DO NOT" in bv and "AT A GLANCE" in bv and "=== CONVERSATION START ===" in bv and "=== END CAPSULE ===" in bv, "brief request malformed"
        await pg.screenshot(path=f"{SH}/4-brief.png")
        await pg.locator("capsa-orb .seg button[data-m=smart]").click(); await pg.wait_for_timeout(300)
        print("smart tokens:",await pg.locator("capsa-orb [data-r=tok]").inner_text())
        await pg.locator("capsa-orb .seg button[data-m=l1]").click(); await pg.wait_for_timeout(300)
        # insert
        await pg.locator("capsa-orb [data-r=insert]").click(); await pg.wait_for_timeout(1500)
        print("insert status:",await pg.locator("capsa-orb [data-r=st]").inner_text())
        comp=await pg.locator(".ProseMirror").inner_text(); print("composer len",len(comp))
        await pg.screenshot(path=f"{SH}/4-inserted.png")
        # copy
        await ctx.grant_permissions(["clipboard-read","clipboard-write"],origin="https://claude.ai")
        await pg.locator("capsa-orb [data-r=copy]").click(); await pg.wait_for_timeout(400)
        print("copy status:",await pg.locator("capsa-orb [data-r=st]").inner_text())
        await pg.screenshot(path=f"{SH}/5-copied.png")
        # --- files: a zip with code, a secret, node_modules and a binary ---
        import zipfile, io
        zp=os.path.join(os.path.dirname(os.path.abspath(__file__)),"sample-project.zip")
        with zipfile.ZipFile(zp,"w",zipfile.ZIP_DEFLATED) as z:
            z.writestr("proj/README.md","# Demo\nA tiny CSV tool.\n")
            z.writestr("proj/src/parse.py","import pandas as pd\n\ndef load(p):\n    return pd.read_csv(p, chunksize=10000)\n")
            z.writestr("proj/.env","API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n")
            z.writestr("proj/node_modules/x/index.js","module.exports=1")
            z.writestr("proj/logo.png",bytes([137,80,78,71,0,0,0,13])*50)
        await pg.locator("capsa-orb input[data-r=fin]").set_input_files(zp)
        await pg.wait_for_timeout(1200)
        print("zip status:",await pg.locator("capsa-orb [data-r=st]").inner_text())
        pv=await pg.locator("capsa-orb textarea").input_value()
        print("zip in preview:", "proj/src/parse.py" in pv, "| secret leaked:", "sk-abcdef" in pv, "| node_modules listed:", "node_modules" in pv)
        await pg.locator("capsa-orb .seg button[data-m=l2]").click(); await pg.wait_for_timeout(400)
        pv=await pg.locator("capsa-orb textarea").input_value(); print("extended has file body:", "read_csv" in pv)
        await pg.screenshot(path=f"{SH}/10-files.png")
        os.remove(zp)
        # --- documents made by real tools: Word, Excel, PowerPoint, PDF (read inside the browser) ---
        fx=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","fixtures")
        await pg.locator("capsa-orb input[data-r=fin]").set_input_files([os.path.join(fx,n) for n in ["plan.docx","costs.xlsx","review.pptx","report.pdf","libreoffice.pdf","scanned.pdf"]])
        await pg.wait_for_timeout(2500)
        await pg.locator("capsa-orb .seg button[data-m=full]").click(); await pg.wait_for_timeout(600)
        pv=await pg.locator("capsa-orb textarea").input_value()
        print("docs: word", "Budget is 4,000 USD" in pv, "| excel", "Server | 120" in pv, "| pptx", "Churn: 3%" in pv, "| pdf", "expired certificate" in pv, "| libreoffice pdf", "Write tests" in pv, "| scanned flagged", "no readable text" in pv)
        await pg.screenshot(path=f"{SH}/11-docs.png")
        await pg.locator("capsa-orb .seg button[data-m=l2]").click(); await pg.wait_for_timeout(400)
        # link capture (chatgpt) from claude page
        await pg.locator("capsa-orb input[data-r=link]").fill("https://chatgpt.com/c/zzz")
        await pg.locator("capsa-orb input[data-r=link]").press("Enter")
        await pg.wait_for_timeout(500)
        await pg.wait_for_timeout(500); await pg.screenshot(path=f"{SH}/6-linkbusy.png")
        for i in range(40):
            await pg.wait_for_timeout(500)
            st=await pg.locator("capsa-orb [data-r=st]").inner_text()
            if "Captured" in st or "Verified" in st or "Couldn" in st or "sign" in st.lower(): break
        print("link status:",st, "| chip:",await pg.locator("capsa-orb [data-r=chip]").inner_text())
        print("tabs open:",len(ctx.pages))
        await pg.screenshot(path=f"{SH}/7-linkdone.png")
        # popup page in a tab (restricted active tab -> friendly message)
        pp=await ctx.new_page(); await pp.goto(f"chrome-extension://{eid}/ui/popup.html"); await pp.wait_for_timeout(800)
        await pp.screenshot(path=f"{SH}/8-popup.png")
        await pp.evaluate("chrome.storage.local.remove('last')"); await pp.wait_for_timeout(500)
        await pp.screenshot(path=f"{SH}/9-popup-empty.png")
        await pp.locator(".orb").click(); await pp.wait_for_timeout(800)
        print("popup capture on restricted:",await pp.locator("[data-r=st]").inner_text())
        # bad links
        await pp.locator("input[data-r=link]").fill("https://example.com/x"); await pp.locator("input[data-r=link]").press("Enter")
        print("bad link:",await pp.locator("[data-r=st]").inner_text())
        t0=__import__("time").time()
        await pp.locator("input[data-r=link]").fill("https://chatgpt.com/login"); await pp.locator("input[data-r=link]").press("Enter")
        for i in range(120):
            await pp.wait_for_timeout(500)
            st=await pp.locator("[data-r=st]").inner_text()
            if "Reading" not in st and "Opening" not in st: break
        print("login-wall result after %.0fs:"%(__import__("time").time()-t0), st, "| tabs:",len(ctx.pages))
        # orb toggle
        await pp.locator(".sw").click(); await pp.wait_for_timeout(500)
        print("orb hidden after toggle:", await pg.evaluate("getComputedStyle(document.querySelector('capsa-orb')).display"))
        print("LOGS",[l for l in logs if 'capsa' in l.lower() or 'PAGEERR' in l][:10])
        await ctx.close()
asyncio.run(main())
