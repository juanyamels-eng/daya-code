import type { ServerResponse } from 'node:http';
import type { GatewayConfig, GatewayUser } from './config.js';
import {
  configFilePath,
  readConfigFile,
  writeConfigFile,
  upsertUser,
  removeUser,
  rotateUserToken,
} from './config.js';
import type { Identity } from './server.js';

export interface AdminSummary {
  users: Array<GatewayUser & { monthTokens: number }>;
  modelCount: number;
  adminKeySet: boolean;
  usageFile: string;
}

export function buildAdminSummary(cfg: GatewayConfig, monthTokens: (token: string) => number): AdminSummary {
  return {
    users: cfg.users
      .map((u) => ({ ...u, monthTokens: monthTokens(u.token) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    modelCount: cfg.upstreams ? Object.keys(cfg.upstreams).length : 0,
    adminKeySet: Boolean(cfg.adminKey),
    usageFile: cfg.usageFile,
  };
}

function isAdmin(identity: Identity | undefined): boolean {
  return Boolean(identity?.admin);
}

export function handleAdminList(cfg: GatewayConfig, identity: Identity | undefined, monthTokens: (t: string) => number, res: ServerResponse): void {
  if (!isAdmin(identity)) {
    res.statusCode = 401;
    res.end('admin key required');
    return;
  }
  const summary = buildAdminSummary(cfg, monthTokens);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(summary));
}

export function handleAdminUpsert(cfg: GatewayConfig, identity: Identity | undefined, body: unknown, res: ServerResponse): void {
  if (!isAdmin(identity)) {
    res.statusCode = 401;
    res.end('admin key required');
    return;
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b['name'] === 'string' && b['name'].trim() ? (b['name'] as string).trim() : null;
  if (!name) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'name is required' }));
    return;
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const saved = upsertUser(raw, {
    name,
    token: typeof b['token'] === 'string' && b['token'].trim() ? (b['token'] as string).trim() : undefined,
    enabled: typeof b['enabled'] === 'boolean' ? b['enabled'] : undefined,
    quota: typeof b['quota'] === 'number' ? b['quota'] : undefined,
    rpm: typeof b['rpm'] === 'number' ? b['rpm'] : undefined,
  });
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ user: saved, file }));
}

export function handleAdminDelete(cfg: GatewayConfig, identity: Identity | undefined, name: string, res: ServerResponse): void {
  if (!isAdmin(identity)) {
    res.statusCode = 401;
    res.end('admin key required');
    return;
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const removed = removeUser(raw, name);
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];
  res.statusCode = removed ? 200 : 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ removed, name }));
}

export function handleAdminRotateToken(cfg: GatewayConfig, identity: Identity | undefined, name: string, res: ServerResponse): void {
  if (!isAdmin(identity)) {
    res.statusCode = 401;
    res.end('admin key required');
    return;
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const user = rotateUserToken(raw, name);
  if (!user) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `user ${name} not found` }));
    return;
  }
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ user, rotated: true }));
}

export function handleAdminDashboard(identity: Identity | undefined, res: ServerResponse): void {
  if (!identity?.admin) {
    res.statusCode = 401;
    res.end('admin key required (set Authorization: Bearer <adminKey>)');
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(dashboardHtml(identity.token));
}

export function handleAdminPatch(cfg: GatewayConfig, identity: Identity | undefined, name: string, body: unknown, res: ServerResponse): void {
  if (!identity?.admin) {
    res.statusCode = 401;
    res.end('admin key required');
    return;
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Object.keys(b).some((k) => ['enabled', 'quota', 'rpm', 'token'].includes(k))) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'nothing to update (use enabled, quota, rpm or token)' }));
    return;
  }
  const file = configFilePath(cfg);
  const raw = readConfigFile(file);
  const saved = upsertUser(raw, {
    name,
    token: typeof b['token'] === 'string' && b['token'].trim() ? (b['token'] as string).trim() : undefined,
    enabled: typeof b['enabled'] === 'boolean' ? b['enabled'] : undefined,
    quota: typeof b['quota'] === 'number' ? b['quota'] : undefined,
    rpm: typeof b['rpm'] === 'number' ? b['rpm'] : undefined,
  });
  writeConfigFile(file, raw);
  cfg.users = raw.users as GatewayUser[];
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ user: saved, file }));
}

const DASH_STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1117;color:#e6e6e6;margin:0;padding:24px;max-width:860px;margin:0 auto}input,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #2a2f3d;background:#171a22;color:#e6e6e6}button{cursor:pointer;background:#2b6cff;border-color:#2b6cff;font-weight:600}button.ghost{background:transparent}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #22262f}th{color:#9aa4b5;font-size:12px;text-transform:uppercase}.muted{color:#9aa4b5}.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:12px}    .ok{background:#1a3d2b;color:#5ee08b}.off{background:#3a2330;color:#ff8aa0}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input.flex{flex:1;min-width:160px}.topup{padding:10px 0;border-bottom:1px solid #22262f;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
`;

function dashboardHtml(adminToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DAYA Gateway · admin</title>
  <style>${DASH_STYLE}</style>
</head>
<body>
  <h1>&#10022; DAYA Gateway</h1>
  <p class="muted">API keys per user. Paste a bearer key or leave blank to auto-generate one.</p>
  <form id="add">
    <div class="row">
      <input class="flex" id="name" placeholder="user name" required />
      <input class="flex" id="token" placeholder="token (blank = auto)" />
      <input style="width:110px" id="quota" type="number" placeholder="quota tok" />
      <button type="submit">Add user</button>
    </div>
  </form>
  <button class="ghost" id="reload" style="margin-top:16px">Refresh</button>
  <table>
    <thead><tr><th>Name</th><th>Enabled</th><th>Token</th><th>Quota</th><th>RPM</th><th>Used</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="card" style="margin-top:20px">
    <h2 style="font-size:16px;margin:0 0 8px">Pending top-ups</h2>
    <div id="topups"></div>
    <p class="muted" style="font-size:12px;margin-top:8px">User pays (cripto/transfer), then approve the code to credit their quota. ~250k tokens &dollar;1.</p>
  </div>
  <script>
    const ADMIN_TOKEN = ${JSON.stringify(adminToken)};
    const authHeaders = { 'authorization': 'Bearer ' + ADMIN_TOKEN };
    const rows = document.getElementById('rows');
    async function json(method, url, body) {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...authHeaders }, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) throw new Error((await r.text()) || r.status);
      return r.json();
    }
    async function get(url) {
      const r = await fetch(url, { headers: authHeaders });
      if (!r.ok) throw new Error((await r.text()) || r.status);
      return r.json();
    }
    async function loadTopups() {
      const d = await get('/admin/api/topups');
      const pending = (d.topups||[]).filter(t=>t.status==='pending');
      const el = document.getElementById('topups');
      if(!pending.length){ el.innerHTML='<span class="muted">No pending top-ups.</span>'; return; }
      el.innerHTML = pending.map(t=>'<div class="topup">'+
        '<code>'+t.code+'</code>'+
        '<span>'+t.user+'</span>'+
        '<span class="muted">$'+t.amountUsd+' &rarr; '+t.amountTokens.toLocaleString()+' tok</span>'+
        '<button class="ghost" data-approve="'+t.code+'">approve</button>'+
        '<button class="ghost" data-cancel="'+t.code+'">cancel</button>'+
      '</div>').join('');
      for(const b of document.querySelectorAll('[data-approve]')) b.onclick=()=>approve(b.dataset.approve);
      for(const b of document.querySelectorAll('[data-cancel]')) b.onclick=()=>cancel(b.dataset.cancel);
    }
    async function approve(code){ await json('POST','/admin/api/topups/'+code+'/approve'); load(); loadTopups(); }
    async function cancel(code){ await json('POST','/admin/api/topups/'+code+'/cancel'); loadTopups(); }
    async function load() {
      const d = await get('/admin/api/users');
      document.getElementById('rows').innerHTML = d.users.map(u => \`<tr>
        <td>\${u.name}</td>
        <td><span class="badge \${u.enabled ? 'ok' : 'off'}">\${u.enabled ? 'on' : 'off'}</span></td>
        <td class="muted">\${u.token || '—'}</td>
        <td>\${u.quota ?? '∞'}</td>
        <td>\${u.rpm ?? '∞'}</td>
        <td>\${(u.monthTokens || 0).toLocaleString()} tok</td>
        <td><button class="ghost" data-toggle="\${u.name}">\${u.enabled ? 'off' : 'on'}</button>
            <button class="ghost" data-rotate="\${u.name}">rotate</button>
            <button class="ghost" data-del="\${u.name}">delete</button></td>
      </tr>\`).join('') || '<tr><td colspan="7" class="muted">No users yet.</td></tr>';
      for (const b of document.querySelectorAll('[data-toggle]')) b.onclick = () => toggle(b.dataset.toggle);
      for (const b of document.querySelectorAll('[data-del]')) b.onclick = () => del(b.dataset.del);
      for (const b of document.querySelectorAll('[data-rotate]')) b.onclick = () => rotate(b.dataset.rotate);
    }
    async function rotate(name) {
      if (!confirm('Generate a NEW API key for ' + name + '? The old one stops working.')) return;
      const d = await json('POST', '/admin/api/users/' + encodeURIComponent(name) + '/rotate-token');
      alert('New key for ' + name + ':\n' + d.user.token);
      load();
    }
    async function toggle(name) {
      const d = await get('/admin/api/users');
      const u = d.users.find(x => x.name === name);
      if (!u) return;
      await json('PUT', '/admin/api/users/' + encodeURIComponent(name), { enabled: !u.enabled });
      load();
    }
    async function del(name) {
      if (!confirm('Delete ' + name + '?')) return;
      await json('DELETE', '/admin/api/users/' + encodeURIComponent(name));
      load();
    }
    document.getElementById('add').onsubmit = async e => {
      e.preventDefault();
      const body = {
        name: document.getElementById('name').value,
        enabled: true,
      };
      const tok = document.getElementById('token').value.trim();
      if (tok) body.token = tok;
      const q = document.getElementById('quota').value;
      if (q !== '') body.quota = Number(q);
      await json('POST', '/admin/api/users', body);
      document.getElementById('name').value = ''; document.getElementById('token').value = ''; document.getElementById('quota').value = '';
      load();
    };
    document.getElementById('reload').onclick = () => { load(); loadTopups(); };
    load();
    loadTopups();
  </script>
</body>
</html>`;
}
