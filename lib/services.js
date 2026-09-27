/* ===== KM0 · services.js — "bộ đổi điện" cho từng dịch vụ Google mà Code.gs dùng =====
 * SpreadsheetApp → Postgres (pgsheet.js) · CacheService → bảng km0_cache · PropertiesService → km0_props
 * LockService → km0_locks (khoá có hạn dùng) · DriveApp → Supabase Storage + km0_files · MailApp → Resend (hoặc hộp thư đi)
 * ScriptApp (trigger hẹn giờ) → lưu trong km0_props, /api/cron chạy · UrlFetchApp → fetch đồng bộ · Utilities → Node
 * GmailApp / CalendarApp → chưa hỗ trợ (giai đoạn 2), báo lỗi rõ ràng. */
'use strict';
const crypto = require('crypto');
const { syncFetch } = require('./sync');
const { Utilities, Blob, toSigned, toBuf } = require('./gasutils');

const BUCKET = 'km0-files';
const boDau = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const slug = s => boDau(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'x';
const randId = () => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', b = crypto.randomBytes(24); let s = 'k'; for (let i = 0; i < 24; i++) s += a[b[i] % 62]; return s; };
const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
const chuaHoTro = ten => new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : function () { throw new Error(ten + ' chưa hỗ trợ trên bản Supabase/Vercel (giai đoạn 2). Tắt chức năng này trong Cấu hình tự động.'); }) });

function makeServices(rt) {
  const db = rt.db, book = rt.book;
  rt.cacheMemo = rt.cacheMemo || {}; rt.props = rt.props || {}; rt.lockDepth = 0; rt.alerts = rt.alerts || [];

  /* ---------- CacheService ---------- */
  const cache = {
    get(k) { k = String(k); if (!(k in rt.cacheMemo)) { const r = db.rpc('km0_cache_get', { p_keys: [k] }) || {}; rt.cacheMemo[k] = k in r ? r[k] : null; } return rt.cacheMemo[k]; },
    getAll(keys) { const o = {}; (keys || []).forEach(k => { const v = cache.get(k); if (v !== null) o[k] = v; }); return o; },
    put(k, v, ttl) { db.rpc('km0_cache_put', { p_k: String(k), p_v: String(v), p_ttl: Math.round(ttl || 600) }); rt.cacheMemo[String(k)] = String(v); },
    putAll(o, ttl) { Object.keys(o || {}).forEach(k => cache.put(k, o[k], ttl)); },
    remove(k) { db.rpc('km0_cache_del', { p_k: String(k) }); rt.cacheMemo[String(k)] = null; },
    removeAll(keys) { (keys || []).forEach(k => cache.remove(k)); }
  };
  const CacheService = { getScriptCache: () => cache, getUserCache: () => cache, getDocumentCache: () => cache };

  /* ---------- PropertiesService ---------- */
  const props = {
    getProperty: k => (Object.prototype.hasOwnProperty.call(rt.props, k) ? rt.props[k] : null),
    setProperty(k, v) { db.rpc('km0_prop_set', { p_k: String(k), p_v: String(v) }); rt.props[String(k)] = String(v); return props; },
    deleteProperty(k) { db.rpc('km0_prop_set', { p_k: String(k), p_v: null }); delete rt.props[String(k)]; return props; },
    getProperties: () => Object.assign({}, rt.props), getKeys: () => Object.keys(rt.props),
    setProperties(o) { Object.keys(o || {}).forEach(k => props.setProperty(k, o[k])); return props; }
  };
  const PropertiesService = { getScriptProperties: () => props, getUserProperties: () => props, getDocumentProperties: () => props };

  /* ---------- LockService: khoá chung "script" trong bảng km0_locks ---------- */
  const LOCK_TTL = 70000; // > thời gian tối đa 1 lần chạy trên Vercel (60s): máy chết giữa chừng thì khoá tự nhả
  const lock = {
    tryLock(ms) {
      if (rt.lockDepth > 0) { rt.lockDepth++; return true; }                  // đã giữ khoá → cho giữ tiếp (như Apps Script)
      book.flush();                                                           // ghi nốt phần ghi ngoài khoá trước
      const han = Date.now() + Math.max(0, Number(ms) || 0);
      for (;;) {
        const con = Math.max(0, han - Date.now());
        if (db.rpc('km0_lock_acquire', { p_name: 'script', p_owner: rt.id, p_ttl_ms: LOCK_TTL, p_wait_ms: Math.min(4000, con) })) {
          rt.lockDepth = 1; book.invalidate(); rt.cacheMemo = {}; return true;  // có khoá → đọc lại dữ liệu mới nhất
        }
        if (Date.now() >= han) return false;
      }
    },
    waitLock(ms) { if (!lock.tryLock(ms)) throw new Error('Hệ thống đang bận ghi dữ liệu của người khác, thử lại sau vài giây. (Lock timeout)'); },
    releaseLock() {
      if (rt.lockDepth <= 0) return; if (--rt.lockDepth > 0) return;
      try { book.flush(); } finally { try { db.rpc('km0_lock_release', { p_name: 'script', p_owner: rt.id }); } catch (e) { /* khoá tự hết hạn */ } }
    },
    hasLock: () => rt.lockDepth > 0
  };
  const LockService = { getScriptLock: () => lock, getDocumentLock: () => lock, getUserLock: () => lock };

  /* ---------- SpreadsheetApp ---------- */
  const ui = {
    alert(a, b) { rt.alerts.push(String(b === undefined ? a : a + ': ' + b)); return 'OK'; }, ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' }, Button: { OK: 'OK', YES: 'YES', NO: 'NO' },
    createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addSubMenu() { return this; }, addToUi() { } }),
    prompt: () => ({ getResponseText: () => '', getSelectedButton: () => 'CANCEL' })
  };
  const SpreadsheetApp = {
    getActiveSpreadsheet: () => book, openById: () => book, openByUrl: () => book, getActive: () => book,
    flush: () => { book.flush(); },
    getUi: () => { if (!rt.admin) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); return ui; },
    create: () => { throw new Error('Bản Supabase không tạo Google Sheet mới.'); }
  };

  /* ---------- Session: người dùng web = ẩn danh (''), chủ sở hữu chỉ khi gọi qua /api/admin hoặc trigger ---------- */
  const owner = rt.ownerEmail || 'owner@km0.local';
  const Session = {
    getActiveUser: () => ({ getEmail: () => (rt.admin || rt.trigger ? owner : '') }),
    getEffectiveUser: () => ({ getEmail: () => owner }),
    getScriptTimeZone: () => 'Asia/Ho_Chi_Minh', getTemporaryActiveUserKey: () => ''
  };

  /* ---------- DriveApp → Supabase Storage ---------- */
  const fileObj = rec => ({
    getId: () => rec.id, getName: () => rec.name || rec.id, getMimeType: () => rec.mime || '', getSize: () => Number(rec.size) || 0,
    getUrl: () => rt.baseUrl + '/api/file/d/' + rec.id + '/view', getDownloadUrl: () => rt.baseUrl + '/api/file/d/' + rec.id + '/view?download=1',
    getDateCreated: () => new Date(rec.created_at || Date.now()),
    setSharing() { return this; }, setTrashed() { return this; }, setName(n) { rec.name = n; return this; }, setDescription() { return this; },
    getBlob: () => new Blob(toSigned(rec._bytes || db.storageGet(BUCKET, rec.path)), rec.mime || 'application/octet-stream', rec.name || rec.id),
    getAs(m) { return this.getBlob().setContentType(m); },
    makeCopy: () => { throw new Error('Bản Supabase: sao lưu dùng Supabase → Database → Backups (tự động hằng ngày).'); }
  });
  const createFileIn = (path, a, b, c) => {
    const blob = a && typeof a.getBytes === 'function' ? a : Utilities.newBlob(String(b || ''), c || 'text/plain', String(a || 'file'));
    const name = blob.getName() || 'file', mime = blob.getContentType() || 'application/octet-stream', id = randId();
    const ext = (String(name).match(/\.([A-Za-z0-9]{1,8})$/) || [])[1];
    const key = (path ? path + '/' : '') + id + (ext ? '.' + ext.toLowerCase() : '');
    const bytes = toBuf(blob.getBytes());
    db.storagePut(BUCKET, key, bytes, mime);
    db.rpc('km0_file_add', { p_id: id, p_path: key, p_name: name, p_mime: mime, p_size: bytes.length });
    return fileObj({ id: id, path: key, name: name, mime: mime, size: bytes.length, _bytes: bytes });
  };
  const folder = path => ({
    getId: () => 'fld:' + path, getName: () => path.split('/').pop() || 'KM0', getUrl: () => rt.baseUrl,
    getFoldersByName: n => iter([folder((path ? path + '/' : '') + slug(n))]),
    createFolder: n => folder((path ? path + '/' : '') + slug(n)),
    getFiles: () => iter([]), getFilesByName: () => iter([]), getFolders: () => iter([]),
    createFile: (a, b, c) => createFileIn(path, a, b, c),
    setSharing() { return this; }, addEditor() { return this; }, addViewer() { return this; }, setTrashed() { return this; }
  });
  const DriveApp = {
    Access: { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', PRIVATE: 'PRIVATE' },
    Permission: { VIEW: 'VIEW', EDIT: 'EDIT', COMMENT: 'COMMENT', OWNER: 'OWNER', NONE: 'NONE' },
    getRootFolder: () => folder(''),
    getFolderById: id => { if (!/^fld:/.test(String(id))) throw new Error('Không tìm thấy thư mục ' + id); return folder(String(id).slice(4)); },
    getFoldersByName: n => iter([folder(slug(n))]), createFolder: n => folder(slug(n)),
    createFile: (a, b, c) => createFileIn('', a, b, c),
    getFileById(id) {
      id = String(id);
      if (id === 'SUPABASE') return fileObj({ id: id, name: 'KM0 database' });
      const rec = db.rpc('km0_file_get', { p_id: id });
      if (rec) return fileObj(rec);
      // file cũ còn trên Google Drive (dữ liệu chuyển sang): tải qua link công khai
      const r = syncFetch({ url: 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id), method: 'GET', timeout: 20000 });
      if (r.status >= 300) throw new Error('Không tìm thấy file ' + id);
      return fileObj({ id: id, name: id, mime: r.headers['content-type'] || '', _bytes: r.body, size: r.body.length });
    }
  };

  /* ---------- MailApp → Resend (nếu có RESEND_API_KEY) ---------- */
  function sendEmail(a, subject, body, opt) {
    const o = typeof a === 'object' && a ? Object.assign({}, a) : Object.assign({ to: a, subject: subject, body: body }, opt || {});
    const to = String(o.to || '').split(/[,;\s]+/).filter(Boolean), log = { to: to, subject: o.subject || '', cc: o.cc || '', bcc: o.bcc || '', attachments: (o.attachments || []).map(x => x.getName && x.getName()) };
    if (!rt.cfg.resendKey) {
      db.rpc('km0_outbox_add', { p_kind: 'email', p_payload: log, p_status: 'chưa gửi', p_error: 'Chưa cấu hình RESEND_API_KEY' });
      throw new Error('Chưa cấu hình gửi email trên Vercel (biến RESEND_API_KEY). Email đã lưu vào bảng km0_outbox.');
    }
    const payload = { from: (o.name ? o.name + ' <' + rt.cfg.mailFrom + '>' : rt.cfg.mailFrom), to: to, subject: o.subject || '', html: o.htmlBody || undefined, text: o.body || undefined };
    if (o.cc) payload.cc = String(o.cc).split(/[,;\s]+/).filter(Boolean);
    if (o.bcc) payload.bcc = String(o.bcc).split(/[,;\s]+/).filter(Boolean);
    if (o.replyTo) payload.reply_to = o.replyTo;
    if (o.attachments && o.attachments.length) payload.attachments = o.attachments.map(b => ({ filename: b.getName(), content: toBuf(b.getBytes()).toString('base64') }));
    const r = syncFetch({ url: 'https://api.resend.com/emails', method: 'POST', headers: { Authorization: 'Bearer ' + rt.cfg.resendKey, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout: 20000 });
    const ok = r.status < 300;
    db.rpc('km0_outbox_add', { p_kind: 'email', p_payload: log, p_status: ok ? 'đã gửi' : 'lỗi', p_error: ok ? null : r.body.toString('utf8').slice(0, 500) });
    if (!ok) throw new Error('Gửi email lỗi ' + r.status + ': ' + r.body.toString('utf8').slice(0, 200));
  }
  const MailApp = { sendEmail: sendEmail, getRemainingDailyQuota: () => (rt.cfg.resendKey ? 100 : 0) };

  /* ---------- ScriptApp: trigger hẹn giờ lưu trong km0_props, /api/cron (gọi mỗi giờ) sẽ chạy ---------- */
  const TKEY = '__KM0_TRIGGERS';
  const readTr = () => { try { return JSON.parse(props.getProperty(TKEY) || '[]'); } catch (e) { return []; } };
  const trObj = t => ({ getHandlerFunction: () => t.fn, getUniqueId: () => t.id, getTriggerSource: () => 'CLOCK', getEventType: () => 'CLOCK', _t: t });
  const ScriptApp = {
    getProjectTriggers: () => readTr().map(trObj), getUserTriggers: () => readTr().map(trObj),
    deleteTrigger(t) { const id = t && (t.getUniqueId ? t.getUniqueId() : t.id); props.setProperty(TKEY, JSON.stringify(readTr().filter(x => x.id !== id))); },
    newTrigger(fn) {
      const t = { id: randId(), fn: String(fn) };
      const b = { timeBased: () => b, everyDays: n => { t.everyDays = n; return b; }, atHour: h => { t.atHour = h; return b; }, nearMinute: m => { t.minute = m; return b; }, everyHours: n => { t.everyHours = n; return b; },
        everyMinutes: n => { t.everyHours = 1; void n; return b; }, onWeekDay: d => { t.weekDay = d; return b; }, inTimezone: () => b, create: () => { props.setProperty(TKEY, JSON.stringify(readTr().concat([t]))); return trObj(t); } };
      return b;
    },
    getService: () => ({ getUrl: () => rt.baseUrl, isEnabled: () => true }),
    getOAuthToken: () => '', getScriptId: () => 'KM0-VERCEL',
    WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
    AuthMode: { FULL: 'FULL', NONE: 'NONE' }
  };

  /* ---------- UrlFetchApp ---------- */
  function fetchOne(url, p) {
    p = p || {};
    const method = String(p.method || 'get').toUpperCase(), headers = Object.assign({}, p.headers || {});
    let body;
    if (p.payload !== undefined && p.payload !== null) {
      if (typeof p.payload === 'string') body = p.payload;
      else if (p.payload && typeof p.payload.getBytes === 'function') body = toBuf(p.payload.getBytes());
      else if (Array.isArray(p.payload)) body = toBuf(p.payload);
      else { body = Object.keys(p.payload).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p.payload[k])).join('&'); if (!p.contentType) headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    }
    if (p.contentType) headers['Content-Type'] = p.contentType;
    const r = syncFetch({ url: String(url), method: method, headers: headers, body: body, redirect: p.followRedirects === false ? 'manual' : 'follow', timeout: 30000 });
    if (r.status >= 400 && !p.muteHttpExceptions) throw new Error('Request failed for ' + url + ' returned code ' + r.status + '. Truncated server response: ' + r.body.toString('utf8').slice(0, 200));
    return {
      getResponseCode: () => r.status, getContentText: cs => r.body.toString(/latin|iso-8859/i.test(cs || '') ? 'latin1' : 'utf8'),
      getContent: () => toSigned(r.body), getBlob: () => new Blob(toSigned(r.body), r.headers['content-type'] || '', ''),
      getHeaders: () => Object.assign({}, r.headers), getAllHeaders: () => Object.assign({}, r.headers)
    };
  }
  const UrlFetchApp = { fetch: fetchOne, fetchAll: reqs => reqs.map(q => (typeof q === 'string' ? fetchOne(q) : fetchOne(q.url, q))) };

  const HtmlService = {
    createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; }, getContent: () => '' }) }),
    createHtmlOutputFromFile: () => ({ getContent: () => '' }), createHtmlOutput: h => ({ getContent: () => String(h || ''), setTitle() { return this; } }),
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' }, SandboxMode: { IFRAME: 'IFRAME' }
  };
  const Logger = { log: function () { if (rt.verbose) console.log.apply(console, arguments); }, clear() { }, getLog: () => '' };
  const MimeType = { MICROSOFT_WORD: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', MICROSOFT_EXCEL: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PDF: 'application/pdf', PLAIN_TEXT: 'text/plain', JPEG: 'image/jpeg', PNG: 'image/png', ZIP: 'application/zip', CSV: 'text/csv' };

  return {
    console: console, Logger, SpreadsheetApp, CacheService, PropertiesService, LockService, Session, DriveApp, MailApp,
    GmailApp: chuaHoTro('Gmail (quét hoá đơn qua email)'), CalendarApp: chuaHoTro('Google Calendar'), DocumentApp: chuaHoTro('Google Docs'),
    ScriptApp, UrlFetchApp, Utilities, HtmlService, MimeType, ContentService: chuaHoTro('ContentService')
  };
}
module.exports = { makeServices, slug, boDau, BUCKET };
