/* ===== GET /api/cron — thay trigger hẹn giờ của Apps Script =====
 * Supabase (pg_cron, xem sql/cron.sql) gọi địa chỉ này MỖI GIỜ kèm header Authorization: Bearer CRON_SECRET.
 * Mỗi lần: đọc danh sách trigger Code.gs đã đăng ký (ScriptApp.newTrigger... lưu trong km0_props) → chạy cái đến giờ.
 * ?fn=tuDongBaoCaoNgay  → chạy ngay 1 hàm (để thử). */
'use strict';
const { run, db } = require('../lib/runtime');
const { json, baseUrl, sameSecret } = require('../lib/http');
const THU = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

function denGio(t, gio, thu) {
  if (t.everyHours) return gio % t.everyHours === 0;
  if (t.weekDay) return t.weekDay === thu && gio === (t.atHour || 0);
  if (t.atHour !== undefined) return gio === t.atHour;
  return false;
}
module.exports = (req, res) => {
  const bi = process.env.CRON_SECRET || '';
  if (bi.length < 12) return json(res, 500, { ok: false, error: 'Chưa đặt CRON_SECRET (ít nhất 12 ký tự) trên Vercel.' });
  if (!sameSecret(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), bi)) return json(res, 401, { ok: false, error: 'unauthorized' });
  const now = new Date(Date.now() + 7 * 3600 * 1000), gio = now.getUTCHours(), thu = THU[now.getUTCDay()];
  const q = new URL(req.url, 'http://x').searchParams, ep = q.get('fn');
  let ds;
  if (ep) ds = [ep];
  else {
    const props = (db().rpc('km0_boot', { p_sheets: [], p_cache: [] }) || {}).props || {};
    let tr = []; try { tr = JSON.parse(props.__KM0_TRIGGERS || '[]'); } catch (e) { tr = []; }
    ds = tr.filter(t => denGio(t, gio, thu)).map(t => t.fn).filter((x, i, a) => a.indexOf(x) === i);
  }
  const kq = {};
  ds.forEach(fn => {
    if (!/^(tuDong[A-Za-z]*|dailyBackup)$/.test(fn)) { kq[fn] = { ok: false, error: 'không phải hàm hẹn giờ' }; return; }
    const r = run(fn, [], { trigger: true, baseUrl: baseUrl(req) }); kq[fn] = { ok: r.ok, error: r.error, ms: r.ms };
  });
  json(res, 200, { ok: true, gioVN: gio, thu: thu, chay: kq });
};
