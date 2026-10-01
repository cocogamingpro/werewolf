// Werewolf room server. No dependencies, Node 18+. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_AGE = 48 * 3600 * 1000; // rooms are deleted after 48h

let store = {};
try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
let dirty = false;
const watchers = new Map(); // room code -> Set of open SSE responses

const CODE = /^[A-HJ-NP-Z2-9]{4}$/;
const PATH = /^games\/[A-HJ-NP-Z2-9]{4}(\/(players|actions)(\/[\w-]{1,40})?)?$/;

const room = code => {
  const pre = 'games/' + code, out = {};
  for (const k in store) if (k === pre || k.startsWith(pre + '/')) out[k] = store[k];
  return out;
};
const push = code => {
  const s = watchers.get(code); if (!s) return;
  const msg = `data: ${JSON.stringify(room(code))}\n\n`;
  for (const r of s) r.write(msg);
};

// Light rules: only the host controls the game, you only write as yourself.
function allowed(op, p, uid, d) {
  const [, code, sub, id] = p.split('/');
  const g = store['games/' + code];
  if (!sub) return op === 'set' ? !g && d.hostId === uid : !!g && g.hostId === uid;
  if (!g) return false;
  if (sub === 'actions') return op === 'add' && d.actor === uid;
  if (op === 'set' && g.status === 'started' && !(g.roles && g.roles[id])) return false;
  return id === uid || g.hostId === uid;
}

function api(req, res, body) {
  const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  let m; try { m = JSON.parse(body); } catch (e) { return send(400, { code: 'invalid_argument' }); }
  const { op, path: p, data } = m, uid = String(req.headers['x-uid'] || '');
  if (!uid || typeof p !== 'string' || !PATH.test(p) || !['get', 'set', 'update', 'delete', 'add'].includes(op))
    return send(400, { code: 'invalid_argument' });
  if (op === 'get') return send(200, { exists: p in store, data: store[p] });
  if (op !== 'delete' && (!data || typeof data !== 'object')) return send(400, { code: 'invalid_argument' });

  let target = p, d = data;
  if (op === 'add') { target = p + '/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); d = { ...data, at: Date.now() }; } // server clock orders actions
  if (!allowed(op, target, uid, d)) return send(403, { code: 'forbidden' });
  if (op === 'update') { if (!(target in store)) return send(404, { code: 'not_found' }); store[target] = { ...store[target], ...d }; }
  else if (op === 'delete') delete store[target];
  else store[target] = d;
  dirty = true; push(p.split('/')[1]);
  send(200, { ok: true });
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/api/stream') {
    const code = u.searchParams.get('code') || '';
    if (!CODE.test(code)) return res.writeHead(400).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify(room(code))}\n\n`);
    if (!watchers.has(code)) watchers.set(code, new Set());
    watchers.get(code).add(res);
    req.on('close', () => { const s = watchers.get(code); if (s) { s.delete(res); if (!s.size) watchers.delete(code); } });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => api(req, res, body));
    return;
  }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html'))
    return fs.readFile(path.join(__dirname, 'index.html'), (e, buf) => {
      if (e) return res.writeHead(500).end('index.html missing');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf);
    });
  res.writeHead(404).end('Not found');
}).listen(PORT, () => console.log('Werewolf running on http://localhost:' + PORT));

setInterval(() => { for (const s of watchers.values()) for (const r of s) r.write(': ping\n\n'); }, 25000);
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(store)) {
    if (!/^games\/\w{4}$/.test(k) || now - (store[k].createdAt || 0) < MAX_AGE) continue;
    for (const j of Object.keys(store)) if (j === k || j.startsWith(k + '/')) delete store[j];
    dirty = true;
  }
  if (dirty) { dirty = false; fs.writeFile(FILE, JSON.stringify(store), () => {}); }
}, 2000);
