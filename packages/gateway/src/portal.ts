import type { ServerResponse } from 'node:http';
import type { GatewayConfig } from './config.js';
import type { Identity } from './server.js';
import { MODEL_CATALOG } from './catalog.js';

export interface PortalStats {
  name: string;
  plan: 'free' | 'paid' | 'unlimited';
  quota: number | null;
  monthTokens: number;
  monthCostUsd: number;
  requests: number;
  remaining: number | null;
  percentUsed: number | null;
  freeModels: string[];
}

export function buildPortalStats(identity: Identity, monthTokens: number, monthCostUsd: number, requests: number): PortalStats {
  const quota = identity.quota ?? null;
  const plan = quota === undefined || quota === null ? 'unlimited' : quota <= 0 ? 'free' : 'paid';
  const remaining = quota === null ? null : Math.max(0, quota - monthTokens);
  const percentUsed = quota === null || quota <= 0 ? null : Math.min(100, Math.round((monthTokens / quota) * 100));
  const freeModels = MODEL_CATALOG.filter((m) => m.free).map((m) => m.id);
  return {
    name: identity.name,
    plan,
    quota,
    monthTokens,
    monthCostUsd,
    requests,
    remaining,
    percentUsed,
    freeModels,
  };
}

export function handlePortalMe(
  cfg: GatewayConfig,
  identity: Identity | undefined,
  stats: (token: string) => PortalStats,
  res: ServerResponse,
): void {
  if (!identity || identity.admin) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'valid user API key required' }));
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(stats(identity.token)));
}

const PORTAL_STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1117;color:#e6e6e6;margin:0;padding:24px;max-width:720px;margin:0 auto;padding-bottom:64px}h1{font-size:22px}.card{background:#161a24;border:1px solid #262b3a;border-radius:12px;padding:18px;margin-top:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat{background:#10131c;border:1px solid #262b3a;border-radius:10px;padding:14px}.stat .v{font-size:22px;font-weight:700;margin-top:4px}.stat .k{color:#9aa4b5;font-size:12px;text-transform:uppercase;letter-spacing:.5px}.muted{color:#9aa4b5}.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;margin-left:8px}.free{background:#1a3d2b;color:#5ee08b}.paid{background:#233a63;color:#7aa2ff}.unlimited{background:#3a2f23;color:#ffb86b}input,button,pre,code{font:inherit}button{cursor:pointer;background:#2b6cff;border:1px solid #2b6cff;color:#fff;padding:9px 14px;border-radius:8px;font-weight:600;margin-top:14px}input{width:100%;padding:10px;border-radius:8px;border:1px solid #2a2f3d;background:#171a22;color:#e6e6e6}.bar{height:8px;background:#22262f;border-radius:20px;overflow:hidden;margin-top:10px}.bar>div{height:100%;background:#2b6cff}code{background:#10131c;padding:2px 6px;border-radius:6px;font-size:12px}pre{background:#10131c;border:1px solid #262b3a;border-radius:10px;padding:14px;overflow-x:auto;font-size:12px;line-height:1.6}ul{padding-left:18px;line-height:1.8}li code{font-size:12px}.tag{margin:2px 4px 2px 0;display:inline-block;background:#1c2130;border:1px solid #2a2f3d;color:#9aa4b5;padding:3px 8px;border-radius:14px;font-size:11px}`;

export function handlePortal(host: string | undefined, res: ServerResponse): void {
  const base = host ? `http://${host}` : '(your gateway URL)';
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DAYA Gateway &middot; your account</title>
  <style>${PORTAL_STYLE}</style>
</head>
<body>
  <h1>&#10022; DAYA Gateway <span class="muted">your account</span></h1>
  <div class="card" id="login">
    <p class="muted">Paste your API key (the <code>daya_...</code> token your admin gave you) to see your usage and setup.</p>
    <input id="key" type="password" placeholder="daya_..." autocomplete="off" />
    <button id="go">View my account</button>
  </div>

  <div id="dash" style="display:none">
    <div class="grid">
      <div class="stat"><div class="k">User</div><div class="v" id="s-name">&mdash;</div></div>
      <div class="stat"><div class="k">Plan</div><div class="v"><span class="badge" id="s-plan">...</span></div></div>
      <div class="stat"><div class="k">Tokens this month</div><div class="v" id="s-tok">0</div></div>
      <div class="stat"><div class="k">Requests</div><div class="v" id="s-req">0</div></div>
      <div class="stat"><div class="k">Est. cost (USD)</div><div class="v" id="s-cost">$0.00</div></div>
    </div>

    <div class="card" id="quota-card" style="display:none">
      <div class="muted">Monthly quota</div>
      <div style="font-size:14px" id="s-quota"></div>
      <div class="bar"><div id="s-bar" style="width:0%"></div></div>
    </div>

    <div class="card">
      <div class="muted">Buy more tokens (manual/cripto)</div>
      <div class="row" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
        <label class="muted" style="margin:0">USD $</label>
        <input id="t-usd" type="number" min="5" max="500" value="10" style="width:100px" />
        <button id="t-go" style="margin:0">Generate top-up</button>
      </div>
      <div id="t-res" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <div class="muted">Free models available on this gateway</div>
      <div style="margin-top:12px" id="s-models"></div>
    </div>

    <div class="card">
      <div class="muted">Connect DAYA Code</div>
      <pre>set OPENAI_BASE_URL=${base}/v1&#10;set OPENAI_API_KEY=&#60;your daya_... key&#62;&#10;set DAYA_MODEL=free&#10;daya</pre>
    </div>
  </div>

  <script>
    const KEY='dayaPortalKey';
    let token=localStorage.getItem(KEY)||'';
    if(token){document.getElementById('go').textContent='Refresh';}
    const $=id=>document.getElementById(id);
    async function load(t){
      $('dash').style.display='';
      $('login').style.display='none';
      const r=await fetch('/portal/api/me',{headers:{authorization:'Bearer '+t}});
      if(!r.ok){localStorage.removeItem(KEY);$('dash').style.display='none';$('login').style.display='';alert('Invalid API key');return;}
      const d=await r.json();
      $('s-name').textContent=d.name;
      const p=$('s-plan');
      p.textContent=d.plan;
      p.className='badge '+d.plan;
      $('s-tok').textContent=(d.monthTokens||0).toLocaleString();
      $('s-req').textContent=(d.requests||0).toLocaleString();
      $('s-cost').textContent='$'+(d.monthCostUsd||0).toFixed(4);
      if(d.quota===null){$('quota-card').style.display='none';}
      else{
        $('quota-card').style.display='';
        $('s-quota').textContent=(d.monthTokens||0).toLocaleString()+' / '+(d.quota||0).toLocaleString()+' tokens'+(d.remaining!=null?' &middot; '+d.remaining.toLocaleString()+' left':'');
        $('s-bar').style.width=(d.percentUsed||0)+'%';
      }
      $('s-models').innerHTML=(d.freeModels||[]).map(m=>'<span class="tag">'+m+'</span>').join('')||'<span class="muted">none</span>';
    }
    $('t-go').onclick=async()=>{
      const usd=Number(document.getElementById('t-usd').value);
      if(!usd||usd<5){alert('Minimum $5');return;}
      const r=await fetch('/portal/api/checkout',{method:'POST',headers:{authorization:'Bearer '+localStorage.getItem(KEY),'content-type':'application/json'},body:JSON.stringify({usd})});
      const d=await r.json();
      if(!r.ok){document.getElementById('t-res').innerHTML='<span class="muted" style="color:#ff8aa0">'+ (d.error||'error') +'</span>';return;}
      if(d.mode==='stripe'&&d.checkoutUrl){window.location.href=d.checkoutUrl;return;}
      if(d.mode==='manual'){
        document.getElementById('t-res').innerHTML='<p>Send <b>$'+usd+'</b> and give this code to your admin:</p>'+
          '<pre style="user-select:all">'+d.topup.code+'</pre>'+
          '<p class="muted">Credits '+d.tokens.toLocaleString()+' tokens at '+(d.rate||'250k/$1')+'.</p>';
        return;
      }
      document.getElementById('t-res').innerHTML='<span class="muted">'+JSON.stringify(d)+'</span>';
    };
    $('go').onclick=()=>{token=$('key').value.trim()||localStorage.getItem(KEY)||'';if(!token){alert('Paste your API key');return;}localStorage.setItem(KEY,token);load(token);};
    if(token)load(token);
  </script>
</body>
</html>`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}
