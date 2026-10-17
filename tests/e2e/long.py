"""Whole-chat verification scenarios (real Chromium + the real extension).

  python3 long.py            # all scenarios
  python3 long.py 120 slow   # only scenarios whose name contains any of the words

Each scenario loads a mock chat (server.py), runs a capture, and checks the capsule against the
page's own list of messages EXACTLY (every message, in order, identical ones included).
Scenarios marked `expect=unverified` must NOT produce a capsule."""
import asyncio, shutil, os, re, sys, time, json
from playwright.async_api import async_playwright
EXT=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."))
norm=lambda t: re.sub(r"\s+"," ",t).strip()

# name, host, params, via ("direct"|"link"), expect ("verified"|"unverified")
S=[
 ("120 msgs virtualized+lazy",   "claude.ai/chat/virt",  "n=120",                       "direct","verified"),
 ("240 msgs virtualized+lazy",   "claude.ai/chat/virt",  "n=240",                       "direct","verified"),
 ("520 msgs virtualized+lazy",   "claude.ai/chat/virt",  "n=520",                       "direct","verified"),
 ("520 msgs all in DOM",         "claude.ai/chat/virt",  "n=520&mode=dom",              "direct","verified"),
 ("240 msgs lazy + spinner",     "claude.ai/chat/virt",  "n=240&mode=lazy&spinner=1",   "direct","verified"),
 ("150 msgs very slow loader",   "claude.ai/chat/virt",  "n=150&lat=3800",              "direct","verified"),
 ("130 msgs chatgpt numbering",  "chatgpt.com/c/virt",   "n=130",                       "direct","verified"),
 ("200 msgs with HOLE (90-96)",  "claude.ai/chat/virt",  "n=200&hole=90-96",            "direct","unverified"),
 ("130 chatgpt HOLE (numbering)","chatgpt.com/c/virt",   "n=130&hole=60-63",            "direct","unverified"),
 ("240 real-site layout (sidebar)","claude.ai/chat/virt",  "n=240&sidebar=1",             "direct","verified"),
 ("240 shared page (doc scroll)","chatgpt.com/c/virt",   "n=240&doc=1&sidebar=1",       "direct","verified"),
 ("240 shared page via link",   "chatgpt.com/c/virt",   "n=240&doc=1&sidebar=1",       "link",  "verified"),
 ("site Perplexity 150",         "www.perplexity.ai/search/virt", "n=150",             "direct","verified"),
 ("site Grok 150",               "grok.com/c/virt",      "n=150",                       "direct","verified"),
 ("site DeepSeek 150",           "chat.deepseek.com/a/chat/s/virt", "n=150",            "direct","verified"),
 ("site Copilot 150",            "copilot.microsoft.com/chats/virt", "n=150",           "direct","verified"),
 ("site Perplexity 150 via link","www.perplexity.ai/search/virt", "n=150",             "link",  "verified"),
 ("site Grok 240 via link",      "grok.com/c/virt",      "n=240",                       "link",  "verified"),
 ("site DeepSeek HOLE",          "chat.deepseek.com/a/chat/s/virt", "n=150&hole=70-74", "direct","unverified"),
 ("generic reader 150 (markup changed)","claude.ai/chat/virt","n=150&flavor=generic",    "direct","verified"),
 ("120 chat that opens with the assistant","claude.ai/chat/virt","n=120&first=assistant",  "direct","verified"),
 ("9 msgs, opens with the assistant","claude.ai/chat/virt", "n=9&first=assistant&mode=dom", "direct","verified"),
 ("150 opens with assistant via link","chatgpt.com/c/virt", "n=150&first=assistant",       "link",  "verified"),
 ("chatgpt share, embedded data 150","chatgpt.com/share/abcdef01-2345-6789-abcd-ef0123456789","n=150&emb=1","link","verified"),
 ("chatgpt share, data service 150","chatgpt.com/share/abcdef01-2345-6789-abcd-ef0123456789","n=150&api=1","link","verified"),
 ("chatgpt share, page-downloaded data 150","chatgpt.com/share/abcdef01-2345-6789-abcd-ef0123456789","n=150&net=1","link","verified"),
 ("chatgpt share, data says more (page reader finishes)","chatgpt.com/share/abcdef01-2345-6789-abcd-ef0123456789","n=150&net=1&partial=1","link","verified"),
 ("chatgpt share, page only (drifting rows) 150","chatgpt.com/share/abcdef01-2345-6789-abcd-ef0123456789","n=150","link","verified"),
 ("chatgpt share, page only 60 opens with assistant","chatgpt.com/share/abcdef01-2345-6789-abcd-ef0123456789","n=60&first=assistant","link","verified"),
 ("claude share, non-consecutive indices","claude.ai/share/abcdef01-2345-6789-abcd-ef0123456789","n=80&variant=gappy-index","link","verified"),
 ("claude share, tool entries between","claude.ai/share/abcdef01-2345-6789-abcd-ef0123456789","n=80&variant=tools","link","verified"),
 ("claude share, a message is missing","claude.ai/share/abcdef01-2345-6789-abcd-ef0123456789","n=80&variant=missing&opaque=1","link","unverified"),
 ("share link, site data 150",   "claude.ai/share/abcdef01-2345-6789-abcd-ef0123456789", "n=150",                 "link",  "verified"),
 ("share link, opens with assistant","claude.ai/share/abcdef01-2345-6789-abcd-ef0123456789", "n=150&first=assistant", "link",  "verified"),
 ("share link, data blocked -> page reader","claude.ai/share/abcdef01-2345-6789-abcd-ef0123456789", "n=150&api=0", "link",  "verified"),
 ("one-sided layout (replies only)","claude.ai/chat/virt", "n=120&flavor=assistantonly",   "direct","unverified"),
 ("120 msgs via pasted link",    "claude.ai/chat/virt",  "n=120",                       "link",  "verified"),
 ("520 msgs via pasted link",    "claude.ai/chat/virt",  "n=520",                       "link",  "verified"),
 ("240 link, site needs screen", "claude.ai/chat/virt",  "n=240&needvis=1",             "link",  "verified"),
]
MUST={"240 link, site needs screen":"visible window"}
want=sys.argv[1:]
if want: S=[s for s in S if any(w.lower() in s[0].lower() for w in want)]

async def main():
    async with async_playwright() as p:
        shutil.rmtree("/tmp/capsa-pwprof-long",ignore_errors=True)
        ctx=await p.chromium.launch_persistent_context("/tmp/capsa-pwprof-long",headless=False,executable_path=os.environ.get("CHROME") or None,viewport={"width":1000,"height":760},
          args=([] if os.environ.get("HEADED") else ["--headless=new"])+["--no-sandbox",f"--disable-extensions-except={EXT}",f"--load-extension={EXT}",
                "--host-resolver-rules=MAP claude.ai 127.0.0.1:8443, MAP chatgpt.com 127.0.0.1:8443, MAP www.perplexity.ai 127.0.0.1:8443, MAP grok.com 127.0.0.1:8443, MAP chat.deepseek.com 127.0.0.1:8443, MAP copilot.microsoft.com 127.0.0.1:8443","--ignore-certificate-errors","--no-proxy-server"])
        sw=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        allok=True
        for name,path,params,via,expect in S:
            await sw.evaluate("chrome.storage.local.clear(); self.__wc=0; if(!self.__wl){self.__wl=1;chrome.windows.onCreated.addListener(()=>{self.__wc++})}")
            t0=time.time()
            home="chatgpt.com/c/abc" if "chatgpt" in path else "claude.ai/chat/abc"
            url=f"https://{path}?{params}"
            pg=await ctx.new_page()
            await pg.goto("https://"+home if via=="link" else url); await pg.wait_for_selector("capsa-orb",state="attached")
            await pg.locator("capsa-orb .bubble").click(force=True); await pg.wait_for_timeout(400); await pg.mouse.move(5,5)
            if via=="link":
                await pg.locator("capsa-orb input[data-r=link]").fill(url); await pg.locator("capsa-orb input[data-r=link]").press("Enter")
            else:
                await pg.locator("capsa-orb .orb").click()
            seen=[]; shots=0
            while time.time()-t0<600:
                await pg.wait_for_timeout(700)
                st=await pg.locator("capsa-orb [data-r=st]").inner_text()
                key=re.sub(r"\d+","#",st)
                if key not in [re.sub(r"\d+","#",x) for x in seen]: seen.append(st)
                if not await pg.locator("capsa-orb [data-r=orb]").is_disabled(): break
            secs=time.time()-t0
            res=await sw.evaluate("chrome.storage.local.get(['last','pending','job']).then(x=>({job:x.job&&x.job.result&&JSON.stringify(x.job.result).slice(0,400),last:x.last?x.last.content.transcript.map(m=>m.text):null,ver:x.last&&x.last.verification,pending:x.pending?x.pending.messages.length:null}))")
            vbar=await pg.locator("capsa-orb [data-r=vbar]").is_visible()
            reasons=await pg.locator("capsa-orb [data-r=vl]").inner_text() if vbar else ""
            title=await pg.locator("capsa-orb [data-r=title]").inner_text()
            ok=False; detail=""
            if expect=="verified":
                if via=="link": tgt=await ctx.new_page(); 
                # expected texts come from the mock's own generator (open it once, plain, to read mk())
                chk=await ctx.new_page(); await chk.goto(url); n=await chk.evaluate("TOTAL"); exp=await chk.evaluate("Array.from({length:TOTAL},(_,i)=>mk(i).text)"); await chk.close()
                if via=="link":
                    try: await tgt.close()
                    except Exception: pass
                got=[norm(t) for t in (res["last"] or []) if not re.fullmatch(r"\[(?:tool use|thinking|image|message)\]", norm(t))]; e=[norm(t) for t in exp]   # placeholder lines mark non-text turns; they are not part of the text comparison
                missing=[i for i,t in enumerate(e) if t not in got]
                ok = got==e and bool(res["ver"] and res["ver"]["verified"]) and not vbar
                detail=f"captured {len(got)}/{len(e)} exact={got==e} missing={missing[:8]} verified={res['ver'] and res['ver']['verified']} passes={res['ver'] and res['ver']['passes']}"
            else:
                ok = res["last"] is None and vbar and res["pending"] is not None
                detail=f"capsule made={res['last'] is not None} (must be False) | pending read={res['pending']} | panel shown={vbar} | reasons={reasons.replace(chr(10),' / ')}"
            if res.get("job") and not (res["last"]): detail+=" | JOB="+str(res["job"])
            wc=await sw.evaluate("self.__wc")
            detail+=f" | windows opened={wc}"
            if name in MUST and (wc<1 or not any(MUST[name] in x for x in seen)):
                ok=False; detail+=f" | expected the visible-window fallback (a window + a status mentioning '{MUST[name]}')"
            allok &= ok
            print(("PASS " if ok else "FAIL ")+f"{name:32s} {secs:5.0f}s  {detail}")
            for x in seen: print("       status:",x[:150])
            extra=len(ctx.pages)
            print("       open tabs after:",extra)
            await pg.close()
        await ctx.close()
        print("\nALL PASSED" if allok else "\nSOME FAILED")
        sys.exit(0 if allok else 1)
asyncio.run(main())
