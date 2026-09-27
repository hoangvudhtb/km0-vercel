/* ===== POST /api/admin — thay menu "KM0" trong Google Sheet (chỉ chủ sở hữu) =====
 * Cần header x-km0-admin = ADMIN_SECRET (đặt ở Vercel → Settings → Environment Variables). Trang /admin.html gọi vào đây.
 * Chạy như "chủ sở hữu bấm menu trong Sheet": Session là chủ sở hữu, uiAlert_ được gom lại trả về. */
'use strict';
const { run } = require('../lib/runtime');
const { json, body, baseUrl, sameSecret } = require('../lib/http');
const CHO_PHEP = ['initializeDatabase', 'checkDatabaseVersion', 'chanDoanKetNoi', 'seedDemoData', 'seedMinhChauPQ', 'napSoLieuMinhChauPQ', 'caiTuDongBaoCao'];

module.exports = (req, res) => {
  const bi = process.env.ADMIN_SECRET || '';
  if (bi.length < 12) return json(res, 500, { ok: false, error: 'Chưa đặt ADMIN_SECRET (ít nhất 12 ký tự) trên Vercel.' });
  if (!sameSecret(req.headers['x-km0-admin'], bi)) return json(res, 401, { ok: false, error: 'Sai mật khẩu quản trị.' });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Chỉ nhận POST' });
  const b = body(req), fn = String(b.fn || '');
  if (CHO_PHEP.indexOf(fn) < 0) return json(res, 400, { ok: false, error: 'Không có lệnh quản trị ' + fn });
  json(res, 200, run(fn, Array.isArray(b.args) ? b.args : [], { admin: true, baseUrl: baseUrl(req) }));
};
