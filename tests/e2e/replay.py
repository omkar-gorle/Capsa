"""Page opened BEFORE the extension could listen: the reader must re-request the page's own data."""
import asyncio,os,json
from playwright.async_api import async_playwright
R=os.path.abspath("../..")
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch_persistent_context("/tmp/capsa-replay",headless=False,viewport={"width":1000,"height":760},args=["--headless=new","--no-sandbox","--host-resolver-rules=MAP chatgpt.com 127.0.0.1:8443","--ignore-certificate-errors","--no-proxy-server"])
        pg=await b.new_page()
        await pg.goto("https://chatgpt.com/share/abcdef01-2345-6789-abcd-ef0123456789?n=150&net=1")
        await pg.wait_for_timeout(1500)
        for f in ["lib/verify.js","lib/share-rsc.js","content/capture-runtime.js"]:
            await pg.add_script_tag(path=os.path.join(R,f))
        r=await pg.evaluate("__chatCapsule.capture({deep:true,verify:true}).then(r=>({m:r.messages&&r.messages.length,meth:r.method,v:r.verification&&r.verification.verified,rep:JSON.parse(__chatCapsule.diagnose()).shareData.tried}))")
        print(json.dumps(r)); ok=r["meth"]=="share-rsc" and r["m"]==150 and r["v"]
        print("PASS replay" if ok else "FAIL replay"); await b.close()
asyncio.run(main())
