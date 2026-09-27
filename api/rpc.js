/* ===== POST /api/rpc — thay google.script.run =====
 * Trình duyệt gửi {fn:'apiGetList', args:[token,'ct']} → chạy đúng hàm đó trong Code.gs → trả {ok, result} hoặc {ok:false, error}.
 * Giống Apps Script: chỉ gọi được hàm "công khai" (tên KHÔNG kết thúc bằng dấu _). Hàm hẹn giờ chỉ /api/cron được chạy. */
'use strict';
const { run } = require('../lib/runtime');
const { json, body, baseUrl } = require('../lib/http');
const CAM = /^(doGet|doPost|onOpen|onEdit|onInstall|include|dailyBackup|tuDong[A-Za-z]*)$/;

module.exports = (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Chỉ nhận POST' });
  const b = body(req), fn = String(b.fn || ''), args = Array.isArray(b.args) ? b.args : [];
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(fn) || CAM.test(fn)) return json(res, 400, { ok: false, error: 'Không gọi được hàm "' + fn + '" từ trình duyệt.' });
  const out = run(fn, args, { baseUrl: baseUrl(req) });
  res.setHeader('Server-Timing', 'km0;dur=' + (out.ms || 0) + ';desc="rpc ' + (out.rpc || 0) + '"');
  delete out.alerts; delete out.rpc;
  json(res, 200, out);
};
