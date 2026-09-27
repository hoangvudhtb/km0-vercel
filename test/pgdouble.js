/* ===== KM0 · pgdouble.js — "Supabase giả" để kiểm thử trên máy (Postgres 16 thật + máy chủ HTTP nhỏ) =====
 * Bắt chước đúng phần Supabase mà bộ đổi điện dùng: POST /rest/v1/rpc/<hàm> và Storage /storage/v1/object/...
 * Mỗi bộ test có 1 database riêng (tạo nhanh từ khuôn km0_tpl đã chạy base.sql), gọi hàm với vai trò service_role
 * → kiểm luôn cả phân quyền. Chạy: node pgdouble.js <cổng> */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { spawn, execFileSync } = require('child_process');
const PORT = +process.argv[2] || 18600, TPL = 'km0_tpl', KEY = 'test-key';
const STORE = path.join(os.tmpdir(), 'km0dbl');
const sql = (db, q) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function lamKhuon() {
  ['anon', 'authenticated', 'service_role'].forEach(r => sql('postgres', `do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin; end if; end $$;`));
  try { execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `update pg_database set datistemplate=false where datname='${TPL}'`], { stdio: 'ignore' }); } catch (e) { /* chưa có */ }
  execFileSync('dropdb', ['--if-exists', TPL], { stdio: 'ignore' });
  execFileSync('createdb', [TPL]);
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', TPL, '-f', path.join(__dirname, '..', 'sql', 'base.sql')], { stdio: ['ignore', 'ignore', 'pipe'] });
  sql(TPL, `create or replace function public.test_call(q text) returns text language plpgsql as $f$
    declare r jsonb; begin execute q into r; return coalesce(r::text, 'null');
    exception when others then return 'ERR:' || replace(sqlerrm, E'\\n', ' '); end $f$;
    grant execute on function public.test_call(text) to service_role;`);
}
let VOID = new Set();
function docKieuTraVe() {
  const out = execFileSync('psql', ['-X', '-At', '-d', TPL, '-c', "select proname from pg_proc where proname like 'km0\\_%' and prorettype = 'void'::regtype"], { encoding: 'utf8' });
  VOID = new Set(out.split('\n').filter(Boolean));
}

/* 1 phiên psql chạy liên tục cho mỗi database (nhanh hơn mở mới mỗi lần), xếp hàng từng câu lệnh */
const PHIEN = {};
function phien(db) {
  if (PHIEN[db]) return PHIEN[db];
  const p = spawn('psql', ['-X', '-q', '-At', '-d', db], { env: Object.assign({}, process.env, { PGOPTIONS: '-c role=service_role' }), stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { p: p, q: [], buf: '' };
  p.stdout.on('data', d => { s.buf += d; let i; while ((i = s.buf.indexOf('\n')) >= 0) { const line = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1); const cb = s.q.shift(); if (cb) cb(line); } });
  p.stderr.on('data', d => process.stderr.write('[psql ' + db + '] ' + d));
  return (PHIEN[db] = s);
}
function goi(db, q) {
  return new Promise(res => { const s = phien(db); let tag = 'q' + Math.random().toString(36).slice(2, 8); while (q.indexOf('$' + tag + '$') >= 0) tag += 'x'; s.q.push(res); s.p.stdin.write('select public.test_call($' + tag + '$' + q + '$' + tag + '$);\n'); });
}
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = typeof v === 'string' ? v : JSON.stringify(v); let tag = 'v'; while (s.indexOf('$' + tag + '$') >= 0) tag += 'v';
  return '$' + tag + '$' + s + '$' + tag + '$' + (typeof v === 'string' ? '' : '::jsonb');
}
const doc = req => new Promise(r => { const a = []; req.on('data', d => a.push(d)); req.on('end', () => r(Buffer.concat(a))); });

lamKhuon(); docKieuTraVe();
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), parts = u.pathname.split('/').filter(Boolean), body = await doc(req);
  const send = (st, obj, type) => { res.writeHead(st, { 'Content-Type': type || 'application/json' }); res.end(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
  try {
    if (u.pathname === '/health') return send(200, { ok: true });
    if (u.pathname === '/newdb') {
      const name = JSON.parse(body.toString()).name; if (!/^[a-z0-9_]+$/.test(name)) return send(400, { message: 'tên db' });
      if (PHIEN[name]) { PHIEN[name].p.kill(); delete PHIEN[name]; }
      execFileSync('dropdb', ['--if-exists', '--force', name], { stdio: 'ignore' }); execFileSync('createdb', ['-T', TPL, name]);
      fs.rmSync(path.join(STORE, name), { recursive: true, force: true });
      return send(200, { ok: true });
    }
    if (u.pathname === '/dropdb') { const name = JSON.parse(body.toString()).name; if (PHIEN[name]) { PHIEN[name].p.kill(); delete PHIEN[name]; } execFileSync('dropdb', ['--if-exists', '--force', name], { stdio: 'ignore' }); return send(200, { ok: true }); }
    const db = parts[0];
    if (req.headers.apikey !== KEY) return send(401, { message: 'Invalid API key' });
    if (parts[1] === 'rest' && parts[3] === 'rpc') {
      const fn = parts[4]; if (!/^km0_[a-z_]+$/.test(fn)) return send(404, { message: 'Could not find the function ' + fn });
      const args = body.length ? JSON.parse(body.toString()) : {};
      const call = 'public.' + fn + '(' + Object.keys(args).map(k => k + ' => ' + lit(args[k])).join(', ') + ')';
      const q = VOID.has(fn) ? "select 'null'::jsonb from (select " + call + ') z' : 'select to_jsonb(' + call + ')';
      const out = await goi(db, q);
      if (out.indexOf('ERR:') === 0) return send(400, { code: 'P0001', message: out.slice(4) });
      return send(200, Buffer.from(out), 'application/json');
    }
    if (parts[1] === 'storage' && parts[3] === 'object') {
      const pub = parts[4] === 'public', rest = parts.slice(pub ? 5 : 4).map(decodeURIComponent), file = path.join(STORE, db, ...rest);
      if (req.method === 'POST' || req.method === 'PUT') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return send(200, { Key: rest.join('/') }); }
      if (!fs.existsSync(file)) return send(404, { message: 'Object not found' });
      return send(200, fs.readFileSync(file), 'application/octet-stream');
    }
    send(404, { message: 'không hỗ trợ ' + u.pathname });
  } catch (e) { send(500, { message: String(e.message || e) }); }
}).listen(PORT, '127.0.0.1', () => console.log('READY ' + PORT));
