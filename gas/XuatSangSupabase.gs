/** =====================================================================================
 * KM0 · CHUYỂN NHÀ: Google Sheet → Supabase
 * Dán file này vào dự án Apps Script CŨ (dấu + → Tập lệnh → đặt tên XuatSangSupabase), KHÔNG cần sửa Code.gs.
 *
 * B1. Supabase đã chạy sql/schema.sql.
 * B2. Apps Script cũ → ⚙ Cài đặt dự án → Thuộc tính tập lệnh → thêm:
 *       SUPABASE_URL               = https://xxxx.supabase.co
 *       SUPABASE_SERVICE_ROLE_KEY  = khoá secret / service_role (Supabase → Project Settings → API Keys)
 * B3. Chọn hàm xuatSangSupabase → ▶ Chạy. Mỗi lần chạy tối đa ~4,5 phút; nếu nhật ký báo "CHƯA XONG" → bấm Chạy lại,
 *     nó tự làm tiếp đúng chỗ dở (khúc nào đang gửi dở sẽ được gửi lại, không sinh dòng trùng).
 * B4. Chọn hàm doiChieuSupabase → ▶ Chạy: so số dòng từng bảng Sheet ↔ Supabase. Phải khớp 100%.
 * B5. XOÁ 2 thuộc tính SUPABASE_* khỏi dự án cũ (không để chìa khoá kho nằm lung tung).
 * Muốn chuyển lại từ đầu (vd sau khi sửa dữ liệu trên Sheet): chạy xuatLamLaiTuDau rồi xuatSangSupabase.
 * ===================================================================================== */
const XUAT_KHUC_ = 400;                              // số dòng mỗi lần gửi
const XUAT_GIOI_HAN_MS_ = 270000;                    // 4,5 phút (Apps Script cắt ở 6 phút)
const XUAT_BO_PROPS_ = /^(SUPABASE_|KM0_XUAT_|ROOT_FOLDER_ID$|SPREADSHEET_ID$|LAST_BACKUP_MS$)/;

function xuatRpc_(fn, args) {
  const p = PropertiesService.getScriptProperties();
  const url = String(p.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, ''), key = String(p.getProperty('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
  if (!url || !key) throw new Error('Thiếu thuộc tính SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (Cài đặt dự án → Thuộc tính tập lệnh).');
  const h = { apikey: key }; if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  const r = UrlFetchApp.fetch(url + '/rest/v1/rpc/' + fn, { method: 'post', contentType: 'application/json', headers: h, payload: JSON.stringify(args || {}), muteHttpExceptions: true });
  const t = r.getContentText();
  if (r.getResponseCode() >= 300) throw new Error('Supabase ' + fn + ' lỗi ' + r.getResponseCode() + ': ' + String(t).slice(0, 400));
  return t ? JSON.parse(t) : null;
}
function xuatKieu_(f) { if (!f) return 'text'; if (f.type === 'number' || f.type === 'currency') return 'numeric'; if (f.type === 'date') return 'date'; return 'text'; }
function xuatCot_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
/** 1 ô Sheet → giá trị cho Postgres. Ô sai kiểu (chữ trong cột số...) → để trống + ghi vào danh sách lỗi để anh xem lại. */
function xuatGiaTri_(v, kieu, loi, viTri) {
  if (v === '' || v === null || v === undefined) return null;
  const laNgay = Object.prototype.toString.call(v) === '[object Date]';
  if (kieu === 'numeric') {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    let s = String(v).trim().replace(/\s/g, ''); if (!s) return null;
    if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
    loi.push(viTri + ' "' + String(v).slice(0, 30) + '" không phải số → để trống'); return null;
  }
  if (kieu === 'date') {
    if (laNgay) return isNaN(v.getTime()) ? null : Utilities.formatDate(v, TZ_, 'yyyy-MM-dd');
    const s = String(v).trim(), m = s.match(/^(\d{4})-(\d{2})-(\d{2})/), m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    if (m2) return m2[3] + '-' + ('0' + m2[2]).slice(-2) + '-' + ('0' + m2[1]).slice(-2);
    loi.push(viTri + ' "' + s.slice(0, 30) + '" không phải ngày → để trống'); return null;
  }
  const x = normalizeCell_(v);                                     // đúng cách app cũ đọc ô (ngày → yyyy-MM-dd, giờ → HH:mm)
  if (typeof x === 'boolean') return x ? 'TRUE' : 'FALSE';
  return String(x);
}
function xuatGhiNhat_(td, loi) {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('KM0_XUAT_TIEN_DO', JSON.stringify(td));
  let cu = []; try { cu = JSON.parse(p.getProperty('KM0_XUAT_LOI') || '[]'); } catch (e) { cu = []; }
  const all = cu.concat(loi); let s = JSON.stringify(all);
  while (s.length > 8500 && all.length) { all.pop(); s = JSON.stringify(all.concat(['… (còn nữa, xem Nhật ký thực thi)'])); }
  p.setProperty('KM0_XUAT_LOI', s);
}

function xuatSangSupabase() {
  const t0 = Date.now(), p = PropertiesService.getScriptProperties(), ss = getSS_(), defs = getSchemaDefinitions_(), loi = [];
  let td = {}; try { td = JSON.parse(p.getProperty('KM0_XUAT_TIEN_DO') || '{}'); } catch (e) { td = {}; }
  xuatRpc_('km0_count', { p_sheets: [] });                          // thử kết nối + đã chạy schema.sql chưa
  const log = [];
  const names = Object.keys(defs);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (td[name] === 'xong') continue;
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 1) { td[name] = 'xong'; continue; }
    const values = sh.getDataRange().getValues(), hdr = values[0].map(h => String(h).trim()), fm = fieldMap_(name), cols = [], idx = [];
    hdr.forEach((h, j) => { if (h && !cols.some(c => c.name === h)) { cols.push({ name: h, type: xuatKieu_(fm[h]) }); idx.push(j); } });
    xuatRpc_('km0_create_sheet', { p_sheet: name, p_columns: cols });   // cột người dùng tự thêm trên Sheet cũng được tạo (kiểu chữ)
    let tu = typeof td[name] === 'number' ? td[name] : 2, n = 0;
    if (values.length < 2) xuatRpc_('km0_import', { p_sheet: name, p_cols: cols.map(c => c.name), p_from_ord: 2, p_rows: [] });
    while (tu <= values.length) {
      if (Date.now() - t0 > XUAT_GIOI_HAN_MS_) {
        xuatGhiNhat_(td, loi);
        const msg = 'CHƯA XONG — đã chuyển tới ' + name + ' dòng ' + (tu - 1) + '. Bấm ▶ Chạy lại xuatSangSupabase để làm tiếp.';
        Logger.log(log.concat([msg]).join('\n')); return msg;
      }
      const den = Math.min(values.length, tu + XUAT_KHUC_ - 1), rows = [];
      for (let r = tu; r <= den; r++) {
        const row = values[r - 1];
        if (row.every(c => c === '' || c === null)) continue;
        rows.push([r].concat(idx.map((j, k) => xuatGiaTri_(row[j], cols[k].type, loi, name + '!' + xuatCot_(j + 1) + r))));
      }
      xuatRpc_('km0_import', { p_sheet: name, p_cols: cols.map(c => c.name), p_from_ord: tu, p_rows: rows });
      n += rows.length; tu = den + 1; td[name] = tu;
      p.setProperty('KM0_XUAT_TIEN_DO', JSON.stringify(td));
    }
    td[name] = 'xong'; log.push('✓ ' + name + ': ' + n + ' dòng');
  }
  // cấu hình script (Script Properties) — trừ các khoá gắn với Google / chìa khoá Supabase
  const pr = p.getProperties(); let nP = 0;
  Object.keys(pr).forEach(k => { if (!XUAT_BO_PROPS_.test(k)) { xuatRpc_('km0_prop_set', { p_k: k, p_v: String(pr[k]) }); nP++; } });
  td.__props = nP; xuatGhiNhat_(td, loi);
  const msg = 'XONG. ' + log.length + ' bảng chuyển trong lần chạy này, ' + nP + ' thuộc tính cấu hình.' +
    (loi.length ? '\n⚠ ' + loi.length + ' ô sai kiểu đã để trống (xem thuộc tính KM0_XUAT_LOI):\n- ' + loi.slice(0, 20).join('\n- ') : '\nKhông có ô sai kiểu.') +
    '\nTiếp theo: chạy doiChieuSupabase để đối chiếu số dòng.';
  Logger.log(log.join('\n') + '\n' + msg);
  return msg;
}

/** Đối chiếu số dòng dữ liệu từng bảng: Sheet (bỏ dòng trống) ↔ Supabase. */
function doiChieuSupabase() {
  const ss = getSS_(), defs = getSchemaDefinitions_(), names = Object.keys(defs), dem = xuatRpc_('km0_count', { p_sheets: names }) || {}, lech = [];
  let tong = 0;
  names.forEach(name => {
    const sh = ss.getSheetByName(name); let n = 0;
    if (sh && sh.getLastRow() >= 2) sh.getDataRange().getValues().slice(1).forEach(r => { if (!r.every(c => c === '' || c === null)) n++; });
    tong += n;
    if ((dem[name] || 0) !== n) lech.push(name + ': Sheet ' + n + ' dòng ↔ Supabase ' + (dem[name] === null || dem[name] === undefined ? '(chưa có bảng)' : dem[name]));
  });
  const msg = lech.length ? '✗ LỆCH ' + lech.length + ' bảng:\n- ' + lech.join('\n- ') + '\n→ chạy xuatLamLaiTuDau rồi xuatSangSupabase.' : '✓ KHỚP: ' + names.length + ' bảng, ' + tong + ' dòng — Sheet và Supabase bằng nhau.';
  Logger.log(msg); return msg;
}
function xuatLamLaiTuDau() {
  const p = PropertiesService.getScriptProperties(); p.deleteProperty('KM0_XUAT_TIEN_DO'); p.deleteProperty('KM0_XUAT_LOI');
  Logger.log('Đã xoá tiến độ. Chạy xuatSangSupabase để chuyển lại từ đầu (dữ liệu trên Supabase sẽ được ghi đè theo Sheet).');
}
