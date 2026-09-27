/* ===== KM0 · pgsheet.js — "Google Sheet giả" chạy trên Postgres =====
 * Code.gs vẫn gọi getSheetByName / getRange / getValues / setValues / deleteRow như cũ.
 * Bên dưới: mỗi sheet = 1 bảng Postgres; dòng 1 (tiêu đề) = danh sách cột; dòng 2.. = các bản ghi xếp theo _ord.
 *  - ĐỌC: lần đầu chạm vào 1 sheet thì tải cả bảng về bộ nhớ (1 lần gọi km0_read), sau đó đọc trong bộ nhớ (rất nhanh).
 *  - GHI: ghi vào bộ nhớ và ĐÁNH DẤU; tới lúc nhả khoá (releaseLock) / SpreadsheetApp.flush() / hết yêu cầu thì gom
 *    mọi thay đổi của mọi bảng gửi 1 lần km0_apply (1 giao dịch: hoặc ghi hết, hoặc không ghi gì).
 *  - Kiểu dữ liệu giống Google Sheet: cột ngày trả về Date, cột số trả về số, ô trống trả về ''. */
'use strict';
const { kieuCot } = require('./db');

/* Lưu ý: Code.gs chạy trong 1 "vùng" (vm context) riêng có hàm Date riêng → Date phải tạo bằng Date CỦA vùng đó (rt.Date),
 * và nhận biết Date bằng toString (instanceof không đúng khi khác vùng). */
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';
const pad = n => (n < 10 ? '0' : '') + n;
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function dateText(d) {
  if (d.getFullYear() <= 1900) return pad(d.getHours()) + ':' + pad(d.getMinutes());                    // ô giờ kiểu Sheets (ngày 1899-12-30)
  if (!d.getHours() && !d.getMinutes() && !d.getSeconds()) return ymd(d);
  return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
/** Giá trị từ Postgres (JSON) → giá trị "như Google Sheet". */
function decode(type, v, D) {
  if (v === null || v === undefined) return '';
  if (type === 'date') { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new (D || Date)(+m[1], +m[2] - 1, +m[3]) : String(v); }
  if (type === 'numeric') return typeof v === 'number' ? v : Number(v);
  return v;
}
/** Giá trị trong bộ nhớ → giá trị ghi Postgres (null = ô trống). Sai kiểu thì báo lỗi rõ ràng bằng tiếng Việt. */
function encode(type, v, sheet, col) {
  if (v === '' || v === null || v === undefined) return null;
  if (type === 'numeric') {
    if (typeof v === 'number') { if (isFinite(v)) return v; throw new Error('Cột "' + col + '" (' + sheet + ') nhận số không hợp lệ: ' + v); }
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = String(v).trim();
    if (s === '') return null;
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
    throw new Error('Cột "' + col + '" (' + sheet + ') phải là số, nhận được: "' + s.slice(0, 40) + '"');
  }
  if (type === 'date') {
    if (isDate(v)) { if (isNaN(v.getTime())) throw new Error('Cột "' + col + '" (' + sheet + ') nhận ngày không hợp lệ'); return ymd(v); }
    const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    if (String(v).trim() === '') return null;
    throw new Error('Cột "' + col + '" (' + sheet + ') phải là ngày yyyy-MM-dd, nhận được: "' + String(v).slice(0, 40) + '"');
  }
  if (isDate(v)) return dateText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
/** Giá trị người gọi ghi vào ô → giá trị giữ trong bộ nhớ (Sheets tự nhận dạng: chuỗi ngày ở cột ngày → Date, chuỗi số ở cột số → số). */
function toCellMem(type, v, sheet, col, D) {
  const e = encode(type, v, sheet, col);          // kiểm tra kiểu ngay khi ghi (lỗi báo đúng chỗ)
  if (e === null) return '';
  if (type === 'date') return decode('date', e, D);
  if (type === 'numeric') return e;
  return isDate(v) ? new v.constructor(v.getTime()) : v;
}
const cloneVal = v => (isDate(v) ? new v.constructor(v.getTime()) : v);
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

class PgBook {
  constructor(rt) { this.rt = rt; this.reg = null; this.data = {}; this.used = new Set(); }
  /** Nhận kết quả km0_boot: sổ đăng ký + dữ liệu các bảng tải trước. */
  applyBoot(b) {
    this.reg = new Map(); (b.reg || []).forEach(x => this.reg.set(x.s, { t: x.t, c: x.c || [] }));
    Object.keys(b.data || {}).forEach(n => this._ingest(n, b.data[n]));
  }
  _regMap() {
    if (!this.reg) this.applyBoot(this.rt.db.rpc('km0_boot', { p_sheets: [], p_cache: [] }));
    return this.reg;
  }
  _ingest(name, d) {
    const cols = d.c || [], types = cols.map(c => c.type), rows = [], orig = new Map(); let maxOrd = 0;
    (d.r || []).forEach(a => {
      const id = a[0], ord = Number(a[1]) || 0, raw = a.slice(2);
      rows.push({ id: id, ord: ord, v: raw.map((x, j) => decode(types[j], x, this.rt.Date)) });
      orig.set(id, raw.map(x => (x === undefined ? null : x)));
      if (ord > maxOrd) maxOrd = ord;
    });
    this.data[name] = { hdr: cols.map(c => c.name), types: types, rows: rows, orig: orig, maxOrd: maxOrd, add: [] };
    this.used.add(name);
  }
  /** Dữ liệu 1 sheet (tải lười: lần đầu mới gọi mạng). */
  _d(name) {
    if (!this.data[name]) {
      const r = this.rt.db.rpc('km0_read', { p_sheets: [name] });
      if (!r[name]) throw new Error('Không có bảng cho sheet ' + name);
      this._ingest(name, r[name]);
    }
    return this.data[name];
  }
  /** Tải trước nhiều bảng trong 1 lần gọi. */
  prefetch(names) {
    const reg = this._regMap(), need = (names || []).filter(n => reg.has(n) && !this.data[n]);
    if (!need.length) return;
    const r = this.rt.db.rpc('km0_read', { p_sheets: need });
    need.forEach(n => { if (r[n]) this._ingest(n, r[n]); });
  }
  /** Bỏ bộ nhớ tạm (sau khi xin được khoá: phải đọc lại dữ liệu mới nhất người khác vừa ghi). */
  invalidate() { this.data = {}; this.reg = null; }
  hasPending() { return Object.keys(this.data).some(n => this._ops(n, true)); }
  /** Gom thay đổi của 1 sheet thành 1 "lệnh" cho km0_apply. */
  _ops(name, probe) {
    const d = this.data[name]; if (!d) return null;
    const hdr = d.hdr, n = hdr.length, del = [], upd = [], ins = [], insRows = [], seen = new Set();
    let lastOrd = -Infinity, reorder = false;
    d.rows.forEach(row => { if (row.id !== null) { if (row.ord <= lastOrd) reorder = true; lastOrd = row.ord; } });
    let nextOrd = reorder ? 0 : d.maxOrd;
    d.rows.forEach(row => {
      const enc = []; for (let j = 0; j < n; j++) enc.push(encode(d.types[j], row.v[j], name, hdr[j]));
      if (row.id === null) {
        if (enc.every(x => x === null)) return;                       // dòng trống: không lưu (Sheet cũng bỏ qua khi đọc)
        const ord = ++nextOrd; ins.push([ord].concat(enc)); insRows.push({ row: row, ord: ord, enc: enc }); return;
      }
      seen.add(row.id);
      const o = d.orig.get(row.id) || [], ord = reorder ? ++nextOrd : row.ord;
      let changed = ord !== row.ord;
      for (let j = 0; j < n && !changed; j++) if ((o[j] === undefined ? null : o[j]) !== enc[j]) changed = true;
      if (changed) upd.push([row.id, ord].concat(enc));
    });
    d.orig.forEach((v, id) => { if (!seen.has(id)) del.push(id); });
    const has = del.length || upd.length || ins.length || d.add.length;
    if (probe) return !!has;
    if (!has) return null;
    return { op: { sheet: name, add: d.add.slice(), cols: hdr.slice(), del: del, upd: upd, ins: ins }, insRows: insRows, reorder: reorder };
  }
  /** GHI THẬT xuống Postgres: mọi bảng trong 1 lần gọi (1 giao dịch). */
  flush() {
    if (!this.data) return;
    const packs = []; Object.keys(this.data).forEach(n => { const p = this._ops(n); if (p) packs.push(p); });
    if (!packs.length) return;
    const res = this.rt.db.rpc('km0_apply', { p_ops: packs.map(p => p.op) }) || {};
    packs.forEach(p => {
      const name = p.op.sheet, d = this.data[name], ids = {}; (res[name] || []).forEach(x => { ids[x[0]] = x[1]; });
      p.op.upd.forEach(u => { d.orig.set(u[0], u.slice(2)); });
      if (p.reorder) { let k = 0; d.rows.forEach(r => { if (r.id !== null) r.ord = ++k; }); }
      p.insRows.forEach(x => { x.row.id = ids[x.ord]; x.row.ord = x.ord; d.orig.set(x.row.id, x.enc); if (x.ord > d.maxOrd) d.maxOrd = x.ord; });
      p.op.del.forEach(id => d.orig.delete(id));
      d.rows.forEach(r => { if (r.ord > d.maxOrd) d.maxOrd = r.ord; });
      if (d.add.length && this.reg && this.reg.has(name)) this.reg.get(name).c = this.reg.get(name).c.concat(d.add);
      d.add = [];
    });
    this.rt.flushes = (this.rt.flushes || 0) + 1;
  }
  // ----- giao diện giống Spreadsheet của Google -----
  getSheetByName(n) { return this._regMap().has(String(n)) ? new PgSheet(this, String(n)) : null; }
  getSheets() { return Array.from(this._regMap().keys()).map(n => new PgSheet(this, n)); }
  insertSheet(n) {
    n = String(n || ('Sheet' + (this._regMap().size + 1)));
    if (this._regMap().has(n)) throw new Error('A sheet with the name "' + n + '" already exists. Please enter another name.');
    const r = this.rt.db.rpc('km0_create_sheet', { p_sheet: n, p_columns: [] });
    this.reg.set(n, { t: r.t, c: r.c || [] });
    this.data[n] = { hdr: [], types: [], rows: [], orig: new Map(), maxOrd: 0, add: [] };
    return new PgSheet(this, n);
  }
  deleteSheet(sh) { this.flush(); this.rt.db.rpc('km0_drop_sheet', { p_sheet: sh.getName() }); this._regMap().delete(sh.getName()); delete this.data[sh.getName()]; }
  getId() { return 'SUPABASE'; } getName() { return 'KM0 (Supabase)'; } getUrl() { return this.rt.db.base; }
  getSpreadsheetTimeZone() { return 'Asia/Ho_Chi_Minh'; } setSpreadsheetTimeZone() { return this; }
  getActiveSheet() { return this.getSheets()[0] || null; }
  /** Kiểu cột mới: tra ENTITY_CONFIG của chính Code.gs. */
  kieuCotMoi(sheet, col) {
    const ctx = this.rt.ctx; let f = null;
    try { f = ctx && typeof ctx.fieldMap_ === 'function' ? ctx.fieldMap_(sheet)[col] : null; } catch (e) { f = null; }
    return kieuCot(f);
  }
}

class PgSheet {
  constructor(book, name) { this.book = book; this.name = name; }
  get d() { return this.book._d(this.name); }
  getName() { return this.name; } getParent() { return this.book; } getSheetId() { return this.name; }
  setName(n) { if (String(n) !== this.name) throw new Error('Bản Supabase chưa hỗ trợ đổi tên sheet.'); return this; }
  _lastDataIdx() { const rows = this.d.rows; for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].v.some(x => x !== '' && x !== null && x !== undefined)) return i; } return -1; }
  getLastRow() { const d = this.d; const i = this._lastDataIdx(); if (i >= 0) return i + 2; return d.hdr.length ? 1 : 0; }
  getLastColumn() { return this.d.hdr.length; }
  getMaxRows() { return this.d.rows.length + 1000; }
  getMaxColumns() { return Math.max(26, this.d.hdr.length); }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') return this._a1(r);
    return new PgRange(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
  }
  _a1(a) {
    const m = String(a).replace(/^.*!/, '').match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i); if (!m) throw new Error('A1 không hỗ trợ: ' + a);
    const cn = s => s.toUpperCase().split('').reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0);
    const c1 = cn(m[1]), r1 = +m[2], c2 = m[3] ? cn(m[3]) : c1, r2 = m[4] ? +m[4] : r1;
    return new PgRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
  }
  getDataRange() { return new PgRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getRangeList(list) { const self = this; const noop = function () { return o; }; const o = { setNumberFormat: noop, setFontWeight: noop, setBackground: noop, getRanges: () => list.map(a => self._a1(a)) }; return o; }
  deleteRow(r) { return this.deleteRows(r, 1); }
  deleteRows(r, n) {
    if (r < 2) throw new Error('Không xoá được dòng tiêu đề.');
    const rows = this.d.rows; if (r - 2 < rows.length) rows.splice(r - 2, n);
    this.nDeleteRows = (this.nDeleteRows || 0) + 1; return this;
  }
  appendRow(vals) { this.getRange(this.getLastRow() + 1, 1, 1, vals.length).setValues([vals]); return this; }
  insertRowsAfter() { return this; } insertRowsBefore() { return this; } insertColumnsAfter() { return this; } insertColumnsBefore() { return this; }
  setFrozenRows() { return this; } setFrozenColumns() { return this; } setColumnWidth() { return this; } setColumnWidths() { return this; }
  getColumnWidth() { return 100; } autoResizeColumns() { return this; } hideColumns() { return this; } showColumns() { return this; }
  getFrozenRows() { return 1; } clearFormats() { return this; } activate() { return this; }
}

class PgRange {
  constructor(sh, r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc;
  }
  getRow() { return this.r; } getColumn() { return this.c; } getNumRows() { return this.nr; } getNumColumns() { return this.nc; }
  getLastRow() { return this.r + this.nr - 1; } getLastColumn() { return this.c + this.nc - 1; }
  getSheet() { return this.sh; }
  getA1Notation() { return colLetter(this.c) + this.r + ':' + colLetter(this.c + this.nc - 1) + (this.r + this.nr - 1); }
  getValues() {
    const d = this.sh.d, out = [];
    for (let i = 0; i < this.nr; i++) {
      const rr = this.r + i, row = [];
      if (rr === 1) { for (let j = 0; j < this.nc; j++) row.push(d.hdr[this.c + j - 1] || ''); }
      else { const rec = d.rows[rr - 2], v = rec ? rec.v : []; for (let j = 0; j < this.nc; j++) { const x = v[this.c + j - 1]; row.push(x === undefined || x === null ? '' : cloneVal(x)); } }
      out.push(row);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(x => (isDate(x) ? dateText(x) : String(x)))); }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (!Array.isArray(vals) || vals.length !== this.nr || !vals.every(r => Array.isArray(r) && r.length === this.nc))
      throw new Error('The number of rows/columns in the data does not match the range. The data has ' + (vals && vals.length) + ' rows but the range has ' + this.nr + '.');
    const book = this.sh.book, name = this.sh.name, d = this.sh.d;
    for (let i = 0; i < this.nr; i++) {
      const rr = this.r + i;
      if (rr === 1) { this._setHeader(vals[i]); continue; }
      while (d.rows.length < rr - 1) d.rows.push({ id: null, ord: 0, v: [] });
      const rec = d.rows[rr - 2];
      for (let j = 0; j < this.nc; j++) {
        const cj = this.c + j - 1, x = vals[i][j];
        if (cj >= d.hdr.length) { if (x === '' || x === null || x === undefined) continue; throw new Error('Sheet ' + name + ': ghi vào cột ' + colLetter(cj + 1) + ' chưa có tiêu đề.'); }
        rec.v[cj] = toCellMem(d.types[cj], x, name, d.hdr[cj], book.rt.Date);
      }
    }
    return this;
  }
  _setHeader(row) {
    const d = this.sh.d, book = this.sh.book;
    for (let j = 0; j < this.nc; j++) {
      const cj = this.c + j - 1, h = row[j] === null || row[j] === undefined ? '' : String(row[j]);
      if (cj < d.hdr.length) { if (d.hdr[cj] !== h) throw new Error('Bản Supabase không đổi tên cột "' + d.hdr[cj] + '" → "' + h + '" được (cột mới luôn thêm vào CUỐI).'); continue; }
      if (!h) continue;
      if (cj > d.hdr.length) throw new Error('Tiêu đề cột phải liền nhau (thiếu cột trước "' + h + '").');
      if (d.hdr.indexOf(h) >= 0) throw new Error('Trùng tên cột "' + h + '" trong ' + this.sh.name);
      const t = book.kieuCotMoi(this.sh.name, h);
      d.hdr.push(h); d.types.push(t); d.add.push({ name: h, type: t });
    }
  }
  setValue(x) { const v = []; for (let i = 0; i < this.nr; i++) { const r = []; for (let j = 0; j < this.nc; j++) r.push(x); v.push(r); } return this.setValues(v); }
  clearContent() { return this.setValue(''); }
}
// định dạng (màu, chữ đậm, số...) không có ý nghĩa trong database → bỏ qua, vẫn trả về chính nó để gọi nối tiếp được
['setNumberFormat', 'setNumberFormats', 'setFontWeight', 'setBackground', 'setFontSize', 'setHorizontalAlignment', 'setVerticalAlignment', 'setFontStyle', 'setWrap',
  'setBorder', 'merge', 'setFontFamily', 'setFontColor', 'setDataValidation', 'clearFormat', 'setNote', 'activate', 'setBackgrounds', 'setFontWeights'].forEach(m => { PgRange.prototype[m] = function () { return this; }; });

module.exports = { PgBook, PgSheet, PgRange, encode, decode, ymd, dateText };
