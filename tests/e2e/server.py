import http.server, ssl, sys
MSGS=[("user","Help me build a CSV parser in Python. It must stream large files and never load all rows."),
("assistant","Sure. Use the csv module with a generator.\n\n```python\nimport csv\ndef rows(path):\n    with open(path, newline='') as f:\n        yield from csv.DictReader(f)\n```\nThis streams one row at a time."),
("user","Great. Decision: we will use pandas chunks instead, because we need type inference. Please add that."),
("assistant","Done. Switching to pandas.read_csv(path, chunksize=10000) keeps memory flat and infers types.")]
def chatgpt():
    body="".join(f'<div data-message-author-role="{r}"><div class="markdown"><p>{t.replace(chr(10),"<br>")}</p></div></div>' for r,t in MSGS)
    return f'<html><head><title>CSV parser - ChatGPT</title></head><body><main><div style="height:300px;overflow:auto">{body}</div><div id="prompt-textarea" contenteditable="true" style="border:1px solid #888;min-height:40px"></div></main></body></html>'
def claude():
    body="".join((f'<div data-testid="user-message"><p>{t}</p></div>' if r=="user" else f'<div class="font-claude-response"><p>{t.replace(chr(10),"<br>")}</p></div>') for r,t in MSGS)
    return f'<html><head><title>CSV parser - Claude</title></head><body style="background:#222;color:#eee"><main>{body}<div class="ProseMirror" contenteditable="true" style="border:1px solid #888;min-height:40px"></div></main></body></html>'

VIRT = r"""<html><head><title>Long chat</title></head><body style="background:#222;color:#eee;font:14px sans-serif">
<nav id="side" hidden style="position:fixed;left:0;top:0;width:200px;height:100vh;background:#111;border-right:1px solid #333;padding:8px;box-sizing:border-box;z-index:5"><div class="loading-skeleton" style="height:14px;margin:8px 0;background:#333"></div><div role="progressbar" aria-busy="true" style="height:10px;margin:8px 0;background:#444"></div><div class="spinner" style="height:12px;margin:8px 0;background:#333"></div><button style="display:block;margin:6px 0">View all</button><button style="display:block;margin:6px 0">Show more</button><button style="display:block;margin:6px 0">See previous chats</button></nav>
<header id="hdr" hidden style="height:56px;background:#181818;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center;padding:0 12px"><b>Shared conversation</b><button>Log in</button><button>Sign up</button></header>
<main id="mn"><div id="sc" style="height:520px;overflow:auto;position:relative;margin:10px;border:1px solid #444"><div id="spin" role="progressbar" style="display:none;position:sticky;top:0;z-index:2;background:#444;padding:4px">Loading earlier messages…</div><div id="spacer" style="position:relative"></div></div>
<div class="ProseMirror" id="prompt-textarea" contenteditable="true" style="border:1px solid #888;min-height:30px;margin:10px"></div></main>
<script>
/* A configurable hard case.  ?n=TOTAL  ?mode=virt|virtall|lazy|dom  ?lat=ms per history chunk  ?hole=a-b  ?spinner=1  ?needvis=1 (ignores scrolling while the tab is hidden, like sites that only render on screen)
   virt    : only a window is in the DOM (virtualized) AND older history loads lazily when you reach the top
   virtall : virtualized, all history already present
   lazy    : everything loaded is in the DOM, older history loads lazily at the top
   dom     : the whole chat is in the DOM
   hole    : messages a..b-1 never render (their space stays) -> a gap a reader must NOT miss silently
   Many messages are identical ("continue") on purpose. */
const P=new URLSearchParams(location.search);
const TOTAL=+(P.get('n')||160), MODE=P.get('mode')||'virt', INITIAL=+(P.get('initial')||40), CHUNK=+(P.get('chunk')||40), LAT=+(P.get('lat')||1300);
const HOLE=(P.get('hole')||'').split('-').map(Number), SPIN=P.get('spinner')==='1';
const DOC=P.get('doc')==='1', SIDE=P.get('sidebar')==='1';
if(SIDE){document.getElementById('side').hidden=false;document.getElementById('mn').style.marginLeft='220px'}
if(DOC){document.getElementById('hdr').hidden=false;const s0=document.getElementById('sc');s0.style.height='auto';s0.style.overflow='visible'}
const H0=location.hostname;const SITE=H0.indexOf('chatgpt')>=0?'chatgpt':H0.indexOf('perplexity')>=0?'perplexity':H0.indexOf('grok')>=0?'grok':H0.indexOf('deepseek')>=0?'deepseek':H0.indexOf('copilot')>=0?'copilot':'claude';
const VIRT=MODE==='virt'||MODE==='virtall', LAZY=MODE==='virt'||MODE==='lazy';
const OFF=P.get('first')==='assistant'?1:0;
function mk(i){const u=(i+OFF)%2===0;const text=u?((i%14===0)?"continue":"Question "+i+": "+"lorem ipsum ".repeat(1+(i*7)%9)):"Answer "+i+": "+"detail ".repeat(10+((i*13)%80));return {i,u,text,h:u?60+((i*5)%40):80+((i*37)%260)}}
let first=LAZY?Math.max(0,TOTAL-INITIAL):0, loading=false;
const sc=document.getElementById('sc'), sp=document.getElementById('spacer'), spin=document.getElementById('spin');
function offs(){const o=[];let y=0;for(let i=first;i<TOTAL;i++){o.push(y);y+=mk(i).h+10}return {o,total:y}}
function el(m,y){const d=document.createElement('div');d.style.cssText='position:absolute;left:8px;right:8px;top:'+y+'px;height:'+m.h+'px;overflow:hidden';
 if(SITE==='chatgpt'){const a=document.createElement('article');a.setAttribute('data-testid','conversation-turn-'+(m.i+1));a.style.cssText=d.style.cssText;
   a.innerHTML='<div data-message-author-role="'+(m.u?'user':'assistant')+'"><p>'+m.text+'</p></div>';return a}
 if(P.get('flavor')==='generic'){d.setAttribute('data-role',m.u?'user':'assistant');}
 else if(SITE==='perplexity'){if(m.u)d.setAttribute('data-testid','user-message-text');else d.className='prose';}
 else if(SITE==='grok'){d.setAttribute('data-testid',m.u?'user-query':'response');}
 else if(SITE==='deepseek'){d.className=m.u?'human_question':'ds-message-container';}
 else if(SITE==='copilot'){d.setAttribute('data-testid',m.u?'user-message':'bot-message');}
 else if(m.u&&P.get('flavor')==='assistantonly')d.className='zz-q';else if(m.u)d.setAttribute('data-testid','user-message');else d.className='font-claude-response';d.innerHTML='<p>'+m.text+'</p>';return d}
const SCR=DOC?document.scrollingElement:sc;
const base=()=>DOC?sp.getBoundingClientRect().top+SCR.scrollTop:0;
function render(){const {o,total}=offs();sp.style.height=total+'px';const top=SCR.scrollTop-base(),bot=top+SCR.clientHeight;sp.textContent='';
 for(let k=0;k<o.length;k++){const m=mk(first+k),y=o[k];if(m.i>=HOLE[0]&&m.i<HOLE[1])continue;
  if(VIRT&&(y+m.h<top-250||y>bot+250))continue;sp.appendChild(el(m,y))}}
const NEEDVIS=P.get('needvis')==='1';
const offscreen=()=>NEEDVIS&&document.documentElement.hasAttribute('data-capsa-test-offscreen');
if(NEEDVIS){document.documentElement.setAttribute('data-capsa-test-offscreen','1');new MutationObserver(()=>{if(document.getElementById('capsa-reading'))document.documentElement.removeAttribute('data-capsa-test-offscreen')}).observe(document.documentElement,{childList:true})}
(DOC?window:sc).addEventListener('scroll',()=>{if(offscreen())return;render();
 if(LAZY&&SCR.scrollTop<40&&first>0&&!loading){loading=true;if(SPIN)spin.style.display='block';
  setTimeout(()=>{const b=offs().total;first=Math.max(0,first-CHUNK);const a=offs().total;SCR.scrollTop+=a-b;loading=false;spin.style.display='none';render()},LAT)}});
render();SCR.scrollTop=1e9;render();
document.title='Long chat - '+SITE;
</script></body></html>"""


import json, re as _re, urllib.parse as _up
GPT = {}
SHARE_N = {"n": 60}
def _mk_text(i, off=0):
    u = (i + off) % 2 == 0
    if u: return "continue" if i % 14 == 0 else "Question %d: %s" % (i, "lorem ipsum " * (1 + (i * 7) % 9))
    return "Answer %d: %s" % (i, "detail " * (10 + ((i * 13) % 80)))
SHARE = r"""<html><head><title>Shared chat</title></head><body style="background:#222;color:#eee;font:14px sans-serif">
<div id="root"><div><div><span>Loading…</span></div></div></div>
<script>
const P=new URLSearchParams(location.search);const OFF=P.get('first')==='assistant'?1:0;
const TOTAL=+(P.get('n')||60);
function mk(i){const u=(i+OFF)%2===0;const text=u?((i%14===0)?"continue":"Question "+i+": "+"lorem ipsum ".repeat(1+(i*7)%9)):"Answer "+i+": "+"detail ".repeat(10+((i*13)%80));return {i,u,text}}
fetch('/api/chat_snapshots/x?rendering_mode=messages').then(r=>r.ok?r.json():null).then(d=>{const root=document.getElementById('root');root.textContent='';if(!d)return;for(const m of d.chat_messages){const a=document.createElement('div');const b=document.createElement('div');b.textContent=m.text;a.appendChild(b);root.appendChild(a)}}).catch(()=>{});
</script></body></html>"""


GPTSHARE = r"""<html><head><title>Shared - ChatGPT</title><style>
html,body{margin:0;height:100%;background:#111;color:#eee;font:14px sans-serif}
.sb{position:fixed;left:0;top:0;width:200px;height:100%;background:#222}
.thread-scroll-container{position:absolute;left:210px;right:0;top:0;bottom:60px;overflow-y:auto}
.row{padding:8px 16px;box-sizing:border-box}
.MarkdownRoot-x p{margin:0}
</style></head><body><div class="sb">sidebar</div>
<div class="thread-scroll-container" id="S"><div id="top"></div><div id="rows"></div><div id="bot"></div></div>
<script>
const P=new URLSearchParams(location.search);const TOTAL=+(P.get('n')||60);const OFF=P.get('first')==='assistant'?1:0;
function mk(i){const u=(i+OFF)%2===0;const text=u?((i%14===0)?"continue":"Question "+i+": "+"lorem ipsum ".repeat(1+(i*7)%9)):"Answer "+i+": "+"detail ".repeat(10+((i*13)%80));return {i,u,text}}
const EST=300, H={}; const S=document.getElementById('S');
function hOf(i){return H[i]!==undefined?H[i]:EST}
function render(){const vh=S.clientHeight,st=S.scrollTop;let y=0,a=0;while(a<TOTAL&&y+hOf(a)<st-100){y+=hOf(a);a++}
 let b=a,yy=y;while(b<TOTAL&&yy<st+vh+100){yy+=hOf(b);b++}
 let tail=0;for(let i=b;i<TOTAL;i++)tail+=hOf(i);
 document.getElementById('top').style.height=y+'px';document.getElementById('bot').style.height=tail+'px';
 const R=document.getElementById('rows');R.textContent='';
 for(let i=a;i<b;i++){const m=mk(i);const d=document.createElement('div');d.className='row';const c=document.createElement('div');
  if(m.u){c.className='text-size-chat whitespace-pre-wrap';c.textContent=m.text}else{c.setAttribute('data-markdown-text-style','x');c.className='MarkdownRoot-x';const p=document.createElement('p');p.textContent=m.text;c.appendChild(p)}
  d.appendChild(c);R.appendChild(d)}
 for(const d of R.children){}
 let k=a;for(const d of R.children){H[k]=d.getBoundingClientRect().height;k++}}
S.addEventListener('scroll',()=>{let last='';for(let k=0;k<6;k++){render();const sig=Object.keys(H).length+':'+document.getElementById('top').style.height;if(sig===last)break;last=sig}});
render();
</script>%EMB%%NET%</body></html>"""

def _turbo(value):
    pool=[]; seen={}
    def add(v):
        if isinstance(v,(str,int,float,bool)):
            k=(type(v).__name__,v)
            if k in seen: return seen[k]
            pool.append(v); seen[k]=len(pool)-1; return seen[k]
        if v is None: return -7
        slot=len(pool); pool.append(None)
        if isinstance(v,list): pool[slot]=[add(x) for x in v]
        else:
            o={}
            for k,x in v.items(): o["_%d"%add(k)]=add(x)
            pool[slot]=o
        return slot
    add(value); return pool

def gpt_share_embed(n, off):
    nodes=[{"id":"sys","message":{"id":"sys","author":{"role":"system"},"content":{"content_type":"text","parts":[""]},"metadata":{"is_visually_hidden_from_conversation":True}}}]
    for i in range(n):
        role="user" if (i+off)%2==0 else "assistant"
        nodes.append({"id":"n%d"%i,"message":{"id":"n%d"%i,"author":{"role":role},"content":{"content_type":"text","parts":[_mk_text(i,off)]},"metadata":{}}})
    tree={"loaderData":{"routes/share.$shareId.($action)":{"sharedConversationId":"abc","serverResponse":{"type":"data","data":{"title":"T","linear_conversation":nodes,"current_node":"n%d"%(n-1)}}}}}
    return nodes,tree

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        host=self.headers.get("Host","").split(":")[0]; p=self.path
        if "chatgpt" in host and p.startswith("/backend-api/thread/"):
            n=GPT["n"]; off=GPT["off"]; items=[]
            for i in range(n):
                role="user" if (i+off)%2==0 else "assistant"
                items.append({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":"input_text" if role=="user" else "output_text","text":_mk_text(i,off)}]}})
                if i%9==4: items.append({"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}})
            if GPT.get("partial"): items=items[:len(items)//2]
            d={"items":items}
            if GPT.get("partial"): d["has_more"]=True
            b=json.dumps(d).encode(); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
        if "chatgpt" in host and p.startswith("/backend-api/share/"):
            if GPT.get("api")!=1:
                b=b'{"detail":"nope"}'; self.send_response(403); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
            nodes,_=gpt_share_embed(GPT["n"],GPT["off"])
            b=json.dumps({"title":"T","mapping":{},"linear_conversation":nodes}).encode(); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
        if "chatgpt" in host and p.startswith("/share/"):
            q=_up.parse_qs(_up.urlparse(p).query)
            GPT["n"]=int((q.get("n") or ["60"])[0]); GPT["off"]=1 if (q.get("first") or [""])[0]=="assistant" else 0
            GPT["api"]=1 if (q.get("api") or ["0"])[0]=="1" else 0
            emb=""
            if (q.get("emb") or ["0"])[0]=="1":
                _,tree=gpt_share_embed(GPT["n"],GPT["off"])
                emb="<script>window.__reactRouterContext={};window.__reactRouterContext.streamController.enqueue("+json.dumps(json.dumps(_turbo(tree)))+");</script>"
                emb=emb.replace("window.__reactRouterContext={};","window.__reactRouterContext=window.__reactRouterContext||{streamController:{enqueue(){}}};")
            GPT["partial"]=1 if (q.get("partial") or ["0"])[0]=="1" else 0
            net="<script>fetch('/backend-api/thread/t1').then(r=>r.json()).then(d=>{window.__d=d}).catch(()=>{})</script>" if (q.get("net") or ["0"])[0]=="1" else ""
            html=GPTSHARE.replace("%EMB%",emb).replace("%NET%",net)
            b=html.encode(); self.send_response(200); self.send_header("Content-Type","text/html"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
        if "claude" in host and p.startswith("/api/chat_snapshots/"):
            q=_up.parse_qs(_up.urlparse(p).query)
            if SHARE_N.get("api")==0:
                b=b'{"error":"nope"}'; self.send_response(404); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
            off=SHARE_N.get("off",0)
            msgs=[{"uuid":"m%d"%i,"index":i,"sender":"human" if (i+off)%2==0 else "assistant","text":_mk_text(i,off),"content":[{"type":"text","text":_mk_text(i,off)}],"created_at":"2026-01-01T00:00:00Z"} for i in range(SHARE_N["n"])]
            b=json.dumps({"snapshot_name":"x","chat_messages":msgs}).encode(); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
        if "claude" in host and p.startswith("/share/"):
            q=_up.parse_qs(_up.urlparse(p).query)
            SHARE_N["n"]=int((q.get("n") or ["60"])[0]); SHARE_N["off"]=1 if (q.get("first") or [""])[0]=="assistant" else 0
            SHARE_N["api"]=0 if (q.get("api") or ["1"])[0]=="0" else 1
            html = VIRT if (SHARE_N["api"]==0 and (q.get("opaque") or ["0"])[0]!="1") else SHARE
        elif "/login" in p: html="<html><body><h1>Sign in</h1></body></html>"
        elif p.startswith("/slow"): 
            import time; time.sleep(1); html=chatgpt()
        elif ("claude" in host and p.startswith("/chat/virt")) or ("chatgpt" in host and p.startswith("/c/virt")): html=VIRT
        elif any(k in host for k in ("perplexity","grok","deepseek","copilot")): html=VIRT
        elif "chatgpt" in host: html=chatgpt()
        elif "claude" in host: html=claude() if "/chat/" in p else "<html><head><title>Home - Claude</title></head><body><main><h2>Welcome</h2><div class='ProseMirror' contenteditable='true'></div></main></body></html>"
        else: html="<html><body>other</body></html>"
        b=html.encode(); self.send_response(200); self.send_header("Content-Type","text/html"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
s=http.server.ThreadingHTTPServer(("127.0.0.1",8443),H)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain("c.pem","k.pem"); s.socket=c.wrap_socket(s.socket,server_side=True)
s.serve_forever()
