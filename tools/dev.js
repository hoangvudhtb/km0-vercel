#!/usr/bin/env node
/* ===== KM0 · tools/dev.js — chạy thử bản Vercel ngay trên máy (thay "vercel dev", không cần cài gì) =====
 * 1) Tạo file .env.local (chép từ .env.example, điền SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY...)
 * 2) node tools/dev.js   → mở http://localhost:3000
 * Phục vụ public/ như Vercel và chuyển /api/* vào đúng các hàm trong api/. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); });
const PORT = +process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  const mf = p.match(/^\/api\/file\/d\/([A-Za-z0-9_-]+)\/view$/);            // giống "rewrites" trong vercel.json
  if (mf) { req.url = '/api/file?id=' + mf[1] + (u.searchParams.get('download') ? '&download=1' : ''); p = '/api/file'; }
  const ma = p.match(/^\/api\/([a-z]+)$/);
  if (ma && fs.existsSync(path.join(ROOT, 'api', ma[1] + '.js'))) {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length > 4.5 * 1024 * 1024) { res.statusCode = 413; return res.end('FUNCTION_PAYLOAD_TOO_LARGE'); }   // như giới hạn Vercel
      try { req.body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw; } catch (e) { req.body = raw; }
      const t = Date.now();
      try { require(path.join(ROOT, 'api', ma[1] + '.js'))(req, res); } catch (e) { res.statusCode = 500; res.end(String(e.stack || e)); }
      if (process.env.DEV_LOG !== '0') console.log(req.method + ' ' + req.url + ' ' + (Date.now() - t) + 'ms' + (req.body && req.body.fn ? ' ' + req.body.fn : ''));
    });
    return;
  }
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('404'); }
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('KM0 chạy thử: http://localhost:' + PORT + '  (Supabase: ' + (process.env.SUPABASE_URL || 'CHƯA ĐẶT') + ')'));
