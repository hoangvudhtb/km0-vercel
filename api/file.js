/* ===== GET /api/file/d/<id>/view — mở file đã tải lên (thay link Google Drive) =====
 * Tra km0_files → chuyển hướng tới Supabase Storage. ?download=1 → tải về đúng tên gốc. */
'use strict';
const { db } = require('../lib/runtime');
const { BUCKET } = require('../lib/services');

module.exports = (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams, id = String(q.get('id') || '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) { res.statusCode = 400; return res.end('Mã file không hợp lệ'); }
  let f = null;
  try { f = db().rpc('km0_file_get', { p_id: id }); } catch (e) { res.statusCode = 500; return res.end('Lỗi: ' + e.message); }
  if (!f) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Không tìm thấy file ' + id); }
  let url = db().publicUrl(BUCKET, f.path);
  if (q.get('download')) url += '?download=' + encodeURIComponent(f.name || id);
  res.statusCode = 302; res.setHeader('Location', url); res.setHeader('Cache-Control', 'private, max-age=300'); res.end();
};
