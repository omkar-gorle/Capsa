"""The card must survive being closed, reopened, or having its background worker killed mid-capture.

  python3 survive.py          # all     |     python3 survive.py hole   # matching scenarios

The toolbar popup is an extension page, so we open it as a tab, close it mid-capture (what Chrome does when focus
moves to another window) and open it again. Whatever the capture produced — a verified capsule, a
"not verified" panel, an error — must be on the card when it comes back, never an empty screen."""
import asyncio, shutil, os, re, sys, time
from playwright.async_api import async_playwright
EXT=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."))
want=sys.argv[1:]
LINK=lambda q: f"https://claude.ai/chat/virt?{q}"

async def state(pp):
    g=lambda sel: pp.locator(sel)
    return {
      "title": await g("[data-r=title]").inner_text(),
      "status": await g("[data-r=st]").inner_text(),
      "unverified": await g("[data-r=vbar]").is_visible(),
      "vt": (await g("[data-r=vt]").inner_text()) if await g("[data-r=vbar]").is_visible() else "",
      "out": await g("[data-r=out]").is_visible(),
      "busy": await g("[data-r=orb]").is_disabled(),
      "preview": (await g("[data-r=pv]").input_value()) if await g("[data-r=out]").is_visible() else "",
    }

async def main():
    async with async_playwright() as p:
        shutil.rmtree("/tmp/capsa-pwprof-surv",ignore_errors=True)
        ctx=await p.chromium.launch_persistent_context("/tmp/capsa-pwprof-surv",headless=False,executable_path=os.environ.get("CHROME") or None,viewport={"width":1000,"height":760},
          args=["--headless=new","--no-sandbox",f"--disable-extensions-except={EXT}",f"--load-extension={EXT}",
                "--host-resolver-rules=MAP claude.ai 127.0.0.1:8443, MAP chatgpt.com 127.0.0.1:8443","--ignore-certificate-errors","--no-proxy-server"])
        sw=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        eid=sw.url.split("/")[2]
        home=await ctx.new_page(); await home.goto("https://claude.ai/chat/abc")   # the tab the user is "on"
        browser_cdp=await ctx.new_cdp_session(home)
        allok=True
        async def popup():
            pp=await ctx.new_page(); await pp.set_viewport_size({"width":340,"height":700})
            await pp.goto(f"chrome-extension://{eid}/ui/popup.html"); await pp.wait_for_timeout(900); return pp
        async def settled(timeout=240):
            t0=time.time()
            while time.time()-t0<timeout:
                s=await sw.evaluate("chrome.storage.local.get(['job','last','pending']).then(x=>({job:x.job&&x.job.state,last:!!x.last,pending:!!x.pending}))") if True else {}
                if s["job"] in ("done","failed") or (s["job"] is None and (s["last"] or s["pending"])): return s
                await asyncio.sleep(1)
            return None
        def report(name,ok,detail):
            nonlocal allok; allok&=ok; print(("PASS " if ok else "FAIL ")+f"{name:44s} {detail}")

        scen=[
         ("closed mid-read, chat has a HOLE",  LINK("n=200&hole=90-96"), 5, "unverified"),
         ("closed mid-read, chat verifies",    LINK("n=120"),            5, "verified"),
         ("visible-window fallback, popup closed", LINK("n=200&needvis=1"), 4, "verified"),
         ("background worker killed mid-read", LINK("n=240"),            9, "killed"),
         ("reopened WHILE still reading",      LINK("n=240"),            4, "live"),
        ]
        for name,url,closeafter,kind in scen:
            if want and not any(w.lower() in name.lower() for w in want): continue
            # after a killed worker the old handle is dead: wake the worker (opening the popup talks to it) and use the current one
            for _try in range(6):
                try:
                    cur=[w for w in ctx.service_workers if eid in w.url]
                    await cur[-1].evaluate("chrome.storage.local.clear()"); break
                except Exception:
                    wk=await popup(); await wk.close(); await home.wait_for_timeout(800)
            pp=await popup()
            await pp.locator("[data-r=link]").fill(url); await pp.locator("[data-r=link]").press("Enter")
            await pp.wait_for_timeout(closeafter*1000)
            if kind=="killed":
                await browser_cdp.send("ServiceWorker.enable")
                try: await browser_cdp.send("ServiceWorker.stopAllWorkers")
                except Exception as e: print("   (stopAllWorkers:",e,")")
            await pp.close()                                    # <- Chrome closes the popup when focus moves away
            if kind=="live":
                pp=await popup(); s=await state(pp)
                live_ok = s["busy"] and ("Pass" in s["status"] or "Loading" in s["status"] or "Reading" in s["status"] or "Opening" in s["status"])
                report(name+" [still busy]",live_ok,f"busy={s['busy']} status={s['status'][:70]!r}")
                for _ in range(120):
                    await pp.wait_for_timeout(1500)
                    s=await state(pp)
                    if not s["busy"]: break
                ok=live_ok and s["out"] and not s["unverified"] and "verified" in s["title"] and len(s["preview"])>1000
                report(name+" [auto-finishes]",ok,f"title={s['title']!r} preview={len(s['preview'])} chars (no click needed)")
                await pp.close(); continue
            if kind!="killed": await settled()
            else: await asyncio.sleep(3)   # the old worker handle is dead; the reopened card wakes a new one
            sw_alive=True
            await asyncio.sleep(1)
            pp=await popup(); s=await state(pp)
            if kind=="unverified":
                ok=s["unverified"] and "Not verified" in s["vt"] and not s["out"]
                report(name+" [panel back]",ok,f"unverified panel={s['unverified']} title={s['vt']!r}")
                await pp.locator("[data-r=vuse]").click(); await pp.wait_for_timeout(2500); s=await state(pp)
                ok=s["out"] and len(s["preview"])>1000 and "NOT verified" in s["title"] and "NOT" in s["preview"]
                report(name+" [use anyway -> text]",ok,f"title={s['title']!r} preview={len(s['preview'])} chars marked-unverified={'NOT' in s['preview']}")
            elif kind=="verified":
                ok=s["out"] and "verified" in s["title"] and not s["unverified"] and len(s["preview"])>1000
                report(name,ok,f"title={s['title']!r} preview={len(s['preview'])} chars")
            elif kind=="killed":
                # the worker died mid-read: Capsa must start that link read again by itself, and finish it
                for _ in range(200):
                    await pp.wait_for_timeout(1500); s=await state(pp)
                    if not s["busy"] and (s["out"] or s["unverified"]): break
                ok=s["out"] and "verified" in s["title"] and not s["unverified"] and len(s["preview"])>1000
                report(name+" [restarted itself, finished]",ok,f"title={s['title']!r} status={s['status'][:60]!r} preview={len(s['preview'])} chars")
            await pp.close()
        n=len(ctx.pages)
        print("open tabs at end:",n)
        await ctx.close()
        print("\nALL PASSED" if allok else "\nSOME FAILED"); sys.exit(0 if allok else 1)
asyncio.run(main())
