/* KM0 · t_chuyennha.js — kiểm thử TOÀN BỘ đường chuyển nhà trên máy (Postgres 16 thật + Supabase giả):
 *  A. App cũ (Google Sheet giả) có dữ liệu demo + Minh Châu → chạy XuatSangSupabase.gs (cố tình cắt ngang nhiều lần) → đối chiếu số dòng.
 *  B. Bản Vercel (lib/runtime.js, đúng code chạy trên Vercel) đọc lại: MỌI danh sách của Admin phải giống hệt app cũ.
 *  C. Ghi qua bản Vercel → đọc lại đúng; khoá chống ghi trùng; hàm cấm gọi; /api/admin, /api/cron, /api/file. */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { spawn, execFileSync } = require('child_process');
const assert = require('assert');
const M = require('../../test/mock');
const { syncFetch, sleepSync } = require('../lib/sync');
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const J = x => JSON.parse(JSON.stringify(x));

// ---------- Supabase giả ----------
const PORT = 18950 + (process.pid % 40), DB = 'km0_mig' + process.pid, BASE = 'http://127.0.0.1:' + PORT + '/' + DB;
const child = spawn(process.execPath, [path.join(__dirname, 'pgdouble.js'), String(PORT)], { stdio: ['ignore', 'ignore', 'inherit'] }); child.unref();
process.on('exit', () => { try { child.kill(); } catch (e) { /* */ } });
for (let t = Date.now(); ;) { try { if (syncFetch({ url: 'http://127.0.0.1:' + PORT + '/health', timeout: 1000 }).status === 200) break; } catch (e) { /* */ } if (Date.now() - t > 20000) throw new Error('double'); sleepSync(100); }
syncFetch({ url: 'http://127.0.0.1:' + PORT + '/newdb', method: 'POST', body: JSON.stringify({ name: DB }) });

console.log('# 0. Supabase: chạy schema.sql như dán vào SQL Editor');
execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', path.join(__dirname, '..', 'sql', 'schema.sql')], { stdio: ['ignore', 'ignore', 'pipe'] });
const soBang = +execFileSync('psql', ['-X', '-At', '-d', DB, '-c', 'select count(*) from km0_sheets'], { encoding: 'utf8' });
ok(soBang === 68, 'schema.sql tạo ' + soBang + ' bảng');

console.log('# A. App cũ → Supabase');
const tmp = path.join(os.tmpdir(), 'km0_code_xuat.gs');
fs.writeFileSync(tmp, fs.readFileSync(path.join(__dirname, '..', '..', 'out', 'Code.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'gas', 'XuatSangSupabase.gs'), 'utf8'));
const env = M.createEnv(), G = M.loadCode(env, tmp);
const sp = env.PropertiesService.getScriptProperties();                  // mock thiếu 2 hàm này (Apps Script thật có)
env.PropertiesService.getScriptProperties = () => Object.assign(sp, { getProperties: () => Object.assign({}, env.props), deleteProperty: k => { delete env.props[k]; } });
G.initializeDatabase(); G.seedDemoData();
try { G.seedMinhChauPQ(); G.napSoLieuMinhChauPQ(); } catch (e) { console.log('   (bỏ qua MC: ' + e.message + ')'); }
env.props.SUPABASE_URL = BASE; env.props.SUPABASE_SERVICE_ROLE_KEY = 'test-key'; env.props.tudong_log = '[{"t":"x"}]';
env.fetchHook = (url, o) => {
  if (url.indexOf('http://127.0.0.1:' + PORT) !== 0) return null;
  const r = syncFetch({ url: url, method: String(o.method || 'get').toUpperCase(), headers: Object.assign({ 'Content-Type': o.contentType }, o.headers || {}), body: o.payload });
  return { getResponseCode: () => r.status, getContentText: () => r.body.toString('utf8') };
};
// cố tình "hết giờ" sau ~0,3s mỗi lần chạy để kiểm tra chạy tiếp chỗ dở
G.XUAT_GIOI_HAN_MS_ = 300; let lan = 0, kq = '';
do { kq = G.xuatSangSupabase(); lan++; } while (/^CHƯA XONG/.test(kq) && lan < 400);
ok(/^XONG/.test(kq) && lan > 1, 'xuatSangSupabase xong sau ' + lan + ' lần chạy (tự làm tiếp chỗ dở): ' + kq.split('\n')[0]);
const dc = G.doiChieuSupabase(); ok(/^✓ KHỚP/.test(dc), 'đối chiếu: ' + dc.split('\n')[0]);
// chạy lại từ đầu lần nữa: không sinh dòng trùng
G.xuatLamLaiTuDau(); G.XUAT_GIOI_HAN_MS_ = 1e9; G.xuatSangSupabase();
ok(/^✓ KHỚP/.test(G.doiChieuSupabase()), 'chuyển lại từ đầu lần 2: vẫn khớp, không trùng dòng');

console.log('# B. Bản Vercel đọc lại = app cũ');
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'; process.env.APP_URL = 'https://km0.test';
process.env.ADMIN_SECRET = 'admin-secret-123'; process.env.CRON_SECRET = 'cron-secret-123';
const R = require('../lib/runtime');
const lg = R.run('apiLogin', ['admin', 'admin123']);
ok(lg.ok && lg.result.token, 'đăng nhập admin trên bản Vercel' + (lg.ok ? '' : ': ' + lg.error));
const T = lg.result.token, Tm = G.apiLogin('admin', 'admin123').token;
const keys = Object.keys(G.ENTITY_CONFIG).filter(k => k !== 'log').filter(k => { try { G.apiGetList(Tm, k); return true; } catch (e) { return false; } });
let khac = [];
keys.forEach(k => {
  const a = J(G.apiGetList(Tm, k)), r = R.run('apiGetList', [T, k]);
  if (!r.ok) { khac.push(k + ': ' + r.error); return; }
  try { assert.deepStrictEqual(r.result, a); } catch (e) {
    const i = a.findIndex((x, j) => JSON.stringify(x) !== JSON.stringify(r.result[j]));
    const x = a[i] || {}, y = r.result[i] || {}; const f = Object.keys(Object.assign({}, x, y)).filter(c => JSON.stringify(x[c]) !== JSON.stringify(y[c])).slice(0, 3);
    khac.push(k + ' (' + a.length + '/' + r.result.length + ' dòng) lệch dòng ' + i + ': ' + f.map(c => c + ' cũ=' + JSON.stringify(x[c]) + ' mới=' + JSON.stringify(y[c])).join('; '));
  }
});
ok(!khac.length, keys.length + ' danh sách (' + keys.reduce((s, k) => s + G.apiGetList(Tm, k).length, 0) + ' dòng) giống hệt app cũ' + (khac.length ? ':\n     ' + khac.slice(0, 12).join('\n     ') : ''));
const dbM = J(G.apiDashboard ? G.apiDashboard(Tm) : null), dbV = R.run('apiDashboard', [T]);
if (dbM) { let same = true; try { assert.deepStrictEqual(dbV.result, dbM); } catch (e) { same = false; } ok(dbV.ok && same, 'dashboard giống hệt app cũ'); }

console.log('# C. Ghi qua bản Vercel');
const ct0 = R.run('apiGetList', [T, 'ct']).result[0];
const sv = R.run('apiSaveEntity', [T, 'ct', Object.assign({}, ct0, { DiaChi: 'Sửa từ Vercel ✓ Phú Quốc', GiaTriHD: 123456789.5 }), false]);
const ct1 = R.run('apiGetList', [T, 'ct']).result.find(x => x.MaCT === ct0.MaCT);
ok(sv.ok && ct1.DiaChi === 'Sửa từ Vercel ✓ Phú Quốc' && ct1.GiaTriHD === 123456789.5, 'sửa công trình → đọc lại đúng (chữ có dấu, số lẻ)' + (sv.ok ? '' : ': ' + sv.error));
const n0 = R.run('apiGetList', [T, 'dxvt']).result.length;
const vt0 = R.run('apiGetList', [T, 'vt']).result[0];
const them = R.run('apiSaveEntity', [T, 'dxvt', { MaCT: ct0.MaCT, NgayDeXuat: '2026-09-27', MaVT: vt0.MaVT, SLYeuCau: 12.5, MucDich: 'Thử ghi từ bản Vercel' }, true]);
const ds = R.run('apiGetList', [T, 'dxvt']).result, moi = ds.find(x => x.MucDich === 'Thử ghi từ bản Vercel');
ok(them.ok && ds.length === n0 + 1 && moi && moi.NgayDeXuat === '2026-09-27' && moi.SLYeuCau === 12.5, 'thêm đề xuất vật tư → có mã mới ' + (moi && moi.MaDX) + ', ngày/số đúng' + (them.ok ? '' : ': ' + them.error));
const xoa = R.run('apiDeleteEntity', [T, 'dxvt', moi && moi.MaDX]);
ok(xoa.ok && R.run('apiGetList', [T, 'dxvt']).result.length === n0, 'xoá lại → về đúng số dòng' + (xoa.ok ? '' : ': ' + xoa.error));
const sai = R.run('apiSaveEntity', [T, 'ct', Object.assign({}, ct0, { GiaTriHD: 'abc' }), false]);
ok(!sai.ok && /số/.test(sai.error), 'nhập chữ vào cột số → báo lỗi tiếng Việt: ' + sai.error);
ok(!R.run('initializeDatabase', []).ok && /chủ sở hữu/.test(R.run('initializeDatabase', []).error), 'người dùng web không chạy được hàm quản trị');
ok(!R.run('memoReset_', []).ok, 'không gọi được hàm nội bộ (tên kết thúc bằng _)');
ok(!R.run('apiGetList', ['token-gia-mao-1234567890', 'ct']).ok, 'token giả bị chặn');

// khoá: 1 lần thực thi khác đang giữ khoá → lần ghi này phải chờ rồi báo bận
const db = R.db(); db.rpc('km0_lock_acquire', { p_name: 'script', p_owner: 'nguoi-khac', p_ttl_ms: 60000, p_wait_ms: 0 });
const t1 = Date.now(), ban = R.run('apiSaveEntity', [T, 'ct', Object.assign({}, ct0, { DiaChi: 'x' }), false]);
db.rpc('km0_lock_release', { p_name: 'script', p_owner: 'nguoi-khac' });
ok(!ban.ok && /bận|Lock/.test(ban.error) && Date.now() - t1 > 15000, 'đang có người khác giữ khoá → chờ ~20s rồi báo bận (' + Math.round((Date.now() - t1) / 1000) + 's)');
ok(R.run('apiSaveEntity', [T, 'ct', Object.assign({}, ct1, { DiaChi: 'sau khi nhả khoá' }), false]).ok, 'nhả khoá → ghi được ngay');

console.log('# D. Các cổng /api');
const fake = (method, url, headers, body) => new Promise(res => { const r = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(b) { res({ status: this.statusCode, h: this.h, body: b ? String(b) : '' }); } }; require('../api/' + url.split('?')[0].replace(/^\/api\//, ''))({ method: method, url: url, headers: headers || {}, body: body }, r); });
(async () => {
  let r = await fake('POST', '/api/rpc', { host: 'km0.test' }, { fn: 'apiLogin', args: ['admin', 'admin123'] }); let j = JSON.parse(r.body);
  ok(r.status === 200 && j.ok && j.result.token, '/api/rpc apiLogin');
  r = await fake('POST', '/api/rpc', {}, { fn: 'tuDongBaoCaoNgay', args: [] }); ok(r.status === 400, '/api/rpc chặn gọi hàm hẹn giờ từ trình duyệt');
  r = await fake('POST', '/api/rpc', {}, { fn: 'getSS_', args: [] }); ok(r.status === 400, '/api/rpc chặn hàm nội bộ');
  r = await fake('POST', '/api/admin', { 'x-km0-admin': 'sai' }, { fn: 'checkDatabaseVersion' }); ok(r.status === 401, '/api/admin sai mật khẩu → 401');
  r = await fake('POST', '/api/admin', { 'x-km0-admin': 'admin-secret-123' }, { fn: 'checkDatabaseVersion' }); j = JSON.parse(r.body);
  ok(j.ok && /khớp/.test(j.result), '/api/admin checkDatabaseVersion: ' + String(j.result || j.error).split('\n').pop());
  r = await fake('POST', '/api/admin', { 'x-km0-admin': 'admin-secret-123' }, { fn: 'caiTuDongBaoCao' }); j = JSON.parse(r.body);
  ok(j.ok && j.alerts.length && /Đã bật tự động/.test(j.alerts[0]), '/api/admin bật tự động báo cáo → trigger lưu vào km0_props');
  r = await fake('GET', '/api/cron', { authorization: 'Bearer sai' }); ok(r.status === 401, '/api/cron sai bí mật → 401');
  r = await fake('GET', '/api/cron?fn=tuDongNhacNhatKy', { authorization: 'Bearer cron-secret-123' }); j = JSON.parse(r.body);
  ok(j.ok && j.chay.tuDongNhacNhatKy && j.chay.tuDongNhacNhatKy.ok, '/api/cron chạy tuDongNhacNhatKy: ' + JSON.stringify(j.chay));
  r = await fake('GET', '/api/cron', { authorization: 'Bearer cron-secret-123' }); j = JSON.parse(r.body); ok(j.ok, '/api/cron theo giờ (' + j.gioVN + 'h ' + j.thu + '): chạy ' + JSON.stringify(Object.keys(j.chay)));
  // tải file lên (thay Google Drive) → link /api/file → chuyển tới Storage
  const up = R.run('apiUploadFile', [T, 'hsct', 'Biên bản nghiệm thu số 1.pdf', 'application/pdf', Buffer.from('%PDF-1.4 KM0 test').toString('base64')]);
  ok(up.ok && /^https:\/\/km0\.test\/api\/file\/d\/k[A-Za-z0-9]{24}\/view$/.test(up.result.url), 'tải file → link ' + (up.ok ? up.result.url : up.error));
  if (up.ok) {
    const id = up.result.url.split('/d/')[1].split('/')[0];
    r = await fake('GET', '/api/file?id=' + id + '&download=1', {}); ok(r.status === 302 && /\/storage\/v1\/object\/public\/km0-files\/.+\.pdf\?download=\d{8}_\d{6}_Bi/.test(r.h.location), '/api/file → 302 tới Supabase Storage, tải về đúng tên gốc: ' + r.h.location);
    const got = syncFetch({ url: r.h.location.replace(/\?.*$/, ''), headers: { apikey: 'test-key' } }); ok(got.body.toString() === '%PDF-1.4 KM0 test', 'nội dung file trong Storage đúng từng byte');
  }
  const t2 = Date.now(); for (let i = 0; i < 5; i++) R.run('apiGetList', [T, 'nktc']); const st = R.run('apiGetList', [T, 'nktc']);
  console.log('     hiệu năng (máy thử): apiGetList nktc ~' + Math.round((Date.now() - t2) / 6) + 'ms/lần, ' + st.rpc + ' lần gọi Supabase (đã "nhớ đường")');
  syncFetch({ url: 'http://127.0.0.1:' + PORT + '/dropdb', method: 'POST', body: JSON.stringify({ name: DB }) });
  console.log(bad ? '\n✗ ' + bad + ' lỗi' : '\n✓ t_chuyennha: tất cả đạt');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
