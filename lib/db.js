/* ===== KM0 · db.js — "người đưa thư" tới Supabase (REST, không cần thư viện) =====
 * rpc('km0_read', {...})  → POST {SUPABASE_URL}/rest/v1/rpc/km0_read  (PostgREST gọi hàm SQL, trả JSON)
 * storagePut / storageGet → Supabase Storage (kho file thay Google Drive) */
'use strict';
const { syncFetch } = require('./sync');

/** Kiểu cột Postgres theo field trong ENTITY_CONFIG: số/tiền → numeric, ngày → date, còn lại → text. */
function kieuCot(f) {
  if (!f) return 'text';
  if (f.type === 'number' || f.type === 'currency') return 'numeric';
  if (f.type === 'date') return 'date';
  return 'text';
}

function makeDb(cfg) {
  const base = String(cfg.url || '').replace(/\/+$/, ''), key = String(cfg.key || '');
  if (!base || !key) throw new Error('Thiếu biến môi trường SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trên Vercel.');
  const stats = { rpc: 0, ms: 0, bytes: 0, calls: [] };
  function hdr(extra) {
    const h = Object.assign({ apikey: key }, extra || {});
    if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;   // khoá kiểu cũ (JWT); khoá mới sb_secret_… chỉ cần header apikey
    return h;
  }
  function rpc(fn, args) {
    const t = Date.now();
    const r = syncFetch({ url: base + '/rest/v1/rpc/' + fn, method: 'POST', headers: hdr({ 'Content-Type': 'application/json', Accept: 'application/json' }), body: JSON.stringify(args || {}), timeout: 25000 });
    const txt = r.body.toString('utf8');
    stats.rpc++; stats.ms += Date.now() - t; stats.bytes += r.body.length; if (stats.calls.length < 60) stats.calls.push(fn);
    if (r.status >= 300) {
      let m = txt; try { const j = JSON.parse(txt); m = j.message || j.error || j.hint || txt; } catch (e) { /* giữ nguyên */ }
      if (r.status === 404 && /km0_/.test(fn)) m = 'Chưa chạy schema.sql trên Supabase (không thấy hàm ' + fn + '). ' + m;
      throw new Error(String(m).replace(/^KM0: /, ''));
    }
    return txt ? JSON.parse(txt) : null;
  }
  const encPath = p => String(p).split('/').map(encodeURIComponent).join('/');
  function storagePut(bucket, path, bytes, mime) {
    const r = syncFetch({ url: base + '/storage/v1/object/' + bucket + '/' + encPath(path), method: 'POST', headers: hdr({ 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' }), body: bytes, timeout: 55000 });
    if (r.status >= 300) throw new Error('Tải file lên Supabase Storage lỗi ' + r.status + ': ' + r.body.toString('utf8').slice(0, 300));
    return true;
  }
  function storageGet(bucket, path) {
    const r = syncFetch({ url: base + '/storage/v1/object/' + bucket + '/' + encPath(path), method: 'GET', headers: hdr(), timeout: 25000 });
    if (r.status >= 300) throw new Error('Đọc file từ Supabase Storage lỗi ' + r.status);
    return r.body;
  }
  function publicUrl(bucket, path) { return base + '/storage/v1/object/public/' + bucket + '/' + encPath(path); }
  return { rpc, storagePut, storageGet, publicUrl, stats, base };
}
module.exports = { makeDb, kieuCot };
