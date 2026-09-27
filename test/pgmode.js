/* ===== KM0 · pgmode.js — chạy BỘ TEST CŨ nhưng dữ liệu nằm trong Postgres thật =====
 * Bật bằng biến môi trường KM0_PG=1. test/mock.js gọi patch(env) khi tạo môi trường và afterLoad(ctx) sau khi nạp Code.gs:
 *  - SpreadsheetApp / CacheService / PropertiesService / LockService → bản Supabase (lib/services.js) nối vào "Supabase giả".
 *  - Mỗi lần gọi 1 hàm public (apiXxx...) xong = hết 1 "yêu cầu": ghi xuống Postgres rồi XOÁ bộ nhớ tạm, lần gọi sau đọc lại
 *    từ database → chứng minh dữ liệu thực sự lưu được và đọc lại đúng. */
'use strict';
const path = require('path'), { spawn } = require('child_process'), crypto = require('crypto');
const { syncFetch, sleepSync } = require('../lib/sync');
const { makeDb } = require('../lib/db');
const { PgBook } = require('../lib/pgsheet');
const { makeServices } = require('../lib/services');

const PORT = 18600 + (process.pid % 300);
let child = null, seq = 0;
function server() {
  if (child) return;
  child = spawn(process.execPath, [path.join(__dirname, 'pgdouble.js'), String(PORT)], { stdio: ['ignore', 'ignore', 'inherit'] });
  child.unref(); process.on('exit', () => { try { child.kill(); } catch (e) { /* đã tắt */ } });
  const t = Date.now();
  for (;;) {
    try { if (syncFetch({ url: 'http://127.0.0.1:' + PORT + '/health', timeout: 1000 }).status === 200) return; } catch (e) { /* chưa lên */ }
    if (Date.now() - t > 20000) throw new Error('Không khởi động được Supabase giả');
    sleepSync(100);
  }
}
function patch(env) {
  server();
  const name = 'km0_t' + process.pid + '_' + (++seq);
  const r = syncFetch({ url: 'http://127.0.0.1:' + PORT + '/newdb', method: 'POST', body: JSON.stringify({ name: name }) });
  if (r.status !== 200) throw new Error('newdb: ' + r.body);
  const db = makeDb({ url: 'http://127.0.0.1:' + PORT + '/' + name, key: 'test-key' });
  const rt = { id: crypto.randomUUID(), db: db, cfg: { resendKey: '', mailFrom: 'x@y' }, admin: true, baseUrl: 'https://km0.test', cacheMemo: {}, props: {}, alerts: [], dbName: name };
  rt.book = new PgBook(rt);
  const boot = db.rpc('km0_boot', { p_sheets: [], p_cache: [] }); rt.book.applyBoot(boot); rt.props = boot.props || {};
  const s = makeServices(rt), mockUi = env.SpreadsheetApp.getUi;
  s.SpreadsheetApp.getUi = mockUi;                                                   // giữ hành vi UI của mock (test bật/tắt được)
  env.SpreadsheetApp = s.SpreadsheetApp; env.CacheService = s.CacheService; env.PropertiesService = s.PropertiesService; env.LockService = s.LockService;
  env.ss = rt.book; env.__pg = rt; env.__pgAfterLoad = ctx => afterLoad(rt, ctx);
  // cho test đọc giá trị props/cache qua env.props / env.cache như mock
  env.props = new Proxy({}, { get: (_, k) => rt.props[k], set: (_, k, v) => { s.PropertiesService.getScriptProperties().setProperty(k, v); return true; }, has: (_, k) => k in rt.props, ownKeys: () => Reflect.ownKeys(rt.props), getOwnPropertyDescriptor: (_, k) => (k in rt.props ? { enumerable: true, configurable: true, value: rt.props[k] } : undefined) });
  const c = s.CacheService.getScriptCache();
  env.cache = new Proxy({}, { get: (_, k) => { const v = c.get(k); return v === null ? undefined : v; }, set: (_, k, v) => { c.put(k, v, 600); return true; }, deleteProperty: (_, k) => { c.remove(k); return true; } });
  return env;
}
function ranhGioi(rt) {                                   // hết 1 "yêu cầu"
  if (rt.lockDepth > 0) throw new Error('Còn giữ khoá khi kết thúc yêu cầu');
  rt.book.flush(); rt.book.invalidate(); rt.cacheMemo = {}; rt.requests = (rt.requests || 0) + 1;
}
function afterLoad(rt, ctx) {
  rt.ctx = ctx; rt.Date = require('vm').runInContext('Date', ctx);
  let sau = 0;
  Object.keys(ctx).forEach(k => {
    const f = ctx[k];
    if (typeof f !== 'function' || /_$/.test(k) || k === 'console' || /^[A-Z]/.test(k)) return;
    ctx[k] = function () { sau++; try { return f.apply(this, arguments); } finally { if (--sau === 0) ranhGioi(rt); } };
  });
}
module.exports = { patch };
/* tiện ích riêng cho test cũ (run.js) vốn "nhìn trộm" vào Sheet giả của mock */
const { PgSheet } = require('../lib/pgsheet');
PgSheet.prototype.get = function (r, c) { return this.getRange(r, c).getValue(); };
Object.defineProperty(PgSheet.prototype, 'frozen', { get: () => 1 });
Object.defineProperty(PgSheet.prototype, 'fmt', { get() { const d = this.d; return new Proxy({}, { get: (_, k) => { const c = +String(k).split(',')[1]; const t = d.types[c - 1]; return t === 'text' ? '@' : t === 'date' ? 'yyyy-mm-dd' : undefined; } }); } });
Object.defineProperty(PgBook.prototype, 'sheets', { get() { return this.getSheets(); } });
Object.defineProperty(PgBook.prototype, 'tz', { get: () => 'Asia/Ho_Chi_Minh' });
