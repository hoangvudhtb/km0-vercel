/* ===== KM0 · runtime.js — chạy 1 hàm của Code.gs y như Apps Script chạy =====
 * Mỗi yêu cầu = 1 "lần thực thi" mới tinh (giống Google): biến toàn cục của Code.gs bắt đầu lại từ đầu, không lẫn dữ liệu
 * giữa 2 người dùng. Code.gs chỉ biên dịch 1 lần cho mỗi máy chủ Vercel "còn ấm", mỗi lần chạy chỉ tốn ~10ms dựng lại. */
'use strict';
process.env.TZ = 'Asia/Ho_Chi_Minh';                       // ngày giờ giống Apps Script đặt múi giờ Việt Nam
const vm = require('vm'), crypto = require('crypto');
const { makeDb } = require('./db');
const { PgBook } = require('./pgsheet');
const { makeServices } = require('./services');

let SCRIPT = null, DB = null;
function script() {
  if (!SCRIPT) SCRIPT = new vm.Script(require('./code.gs.js'), { filename: 'Code.gs' });   // code.gs.js do tools/build.js sinh ra
  return SCRIPT;
}
function config() {
  const e = process.env;
  return {
    url: e.SUPABASE_URL, key: e.SUPABASE_SERVICE_ROLE_KEY || e.SUPABASE_SECRET_KEY,
    owner: e.OWNER_EMAIL || 'owner@km0.local', resendKey: e.RESEND_API_KEY || '', mailFrom: e.MAIL_FROM || 'KM0 <onboarding@resend.dev>',
    appUrl: (e.APP_URL || '').replace(/\/+$/, '')
  };
}
function db() { if (!DB) { const c = config(); DB = makeDb({ url: c.url, key: c.key }); } return DB; }

/* "Nhớ đường": hàm nào hay đọc những bảng nào → lần sau tải trước tất cả trong 1 lần gọi (đỡ đi lại nhiều chuyến). */
const HOC = new Map();

/** Dựng 1 lần thực thi mới: đọc sổ đăng ký + cấu hình + phiên đăng nhập + các bảng đoán trước, trong 1 lần gọi km0_boot. */
function newExecution(opts) {
  opts = opts || {};
  const c = config(), d = db();
  const rt = { id: crypto.randomUUID(), db: d, cfg: c, admin: !!opts.admin, trigger: !!opts.trigger, ownerEmail: c.owner,
    baseUrl: c.appUrl || opts.baseUrl || '', cacheMemo: {}, props: {}, alerts: [], verbose: !!opts.verbose, t0: Date.now() };
  rt.book = new PgBook(rt);
  const env = makeServices(rt);
  const ctx = vm.createContext(env);
  rt.Date = vm.runInContext('Date', ctx);                   // Date của "vùng" Code.gs (xem ghi chú trong pgsheet.js)
  const cacheKeys = opts.token ? ['sess_' + opts.token] : [];
  const boot = d.rpc('km0_boot', { p_sheets: opts.prefetch || [], p_cache: cacheKeys }) || {};
  rt.book.applyBoot(boot);
  rt.props = boot.props || {};
  cacheKeys.forEach(k => { rt.cacheMemo[k] = (boot.cache || {})[k] === undefined ? null : boot.cache[k]; });
  script().runInContext(ctx);
  rt.ctx = ctx;
  // ghi đè vài hàm "gắn chặt với Google" bằng bản dành cho Supabase (Code.gs gốc không đổi hành vi trên Apps Script)
  ctx.fileUrl_ = f => f.getUrl();
  return rt;
}
/** Kết thúc: ghi nốt dữ liệu còn trong bộ nhớ, nhả khoá nếu còn giữ. */
function finish(rt) {
  try { rt.book.flush(); }
  finally { if (rt.lockDepth > 0) { rt.lockDepth = 1; try { rt.ctx.LockService.getScriptLock().releaseLock(); } catch (e) { /* khoá tự hết hạn */ } } }
}
/** google.script.run chỉ trả được dữ liệu "thuần": Date → chuỗi ISO, undefined → null, hàm bị bỏ. */
function thuan(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'function' ? undefined : x))); }

/** Chạy hàm public `fn(args)` của Code.gs. Trả {ok, result} hoặc {ok:false, error}. */
function run(fn, args, opts) {
  opts = opts || {};
  const t0 = Date.now(); let rt = null;
  try {
    const token = Array.isArray(args) && typeof args[0] === 'string' && /^[0-9a-f-]{20,}$/i.test(args[0]) ? args[0] : null;
    rt = newExecution(Object.assign({}, opts, { token: token, prefetch: Array.from(HOC.get(fn) || []) }));
    const f = rt.ctx[fn];
    if (typeof f !== 'function' || /_$/.test(fn)) throw new Error('Script function not found: ' + fn);
    const result = f.apply(null, Array.isArray(args) ? args : []);
    finish(rt);
    HOC.set(fn, new Set(rt.book.used));
    return { ok: true, result: thuan(result), alerts: rt.alerts, ms: Date.now() - t0, rpc: rt.db.stats.rpc };
  } catch (e) {
    let msg = e && e.message !== undefined ? e.message : String(e);
    if (rt) { try { finish(rt); } catch (e2) { msg += ' | (ghi dữ liệu còn dở: ' + e2.message + ')'; } }
    return { ok: false, error: msg, alerts: rt ? rt.alerts : [], ms: Date.now() - t0 };
  } finally { if (DB) DB.stats.rpc = 0; }
}
module.exports = { run, newExecution, finish, config, db };
