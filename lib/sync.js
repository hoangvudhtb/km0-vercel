/* ===== KM0 · sync.js — "cho code cũ được CHỜ thật" =====
 * Code.gs viết cho Google: gọi SpreadsheetApp là có kết quả NGAY (đồng bộ). Còn gọi Supabase qua mạng thì Node bắt buộc
 * dùng Promise (bất đồng bộ). Cầu nối: 1 luồng phụ (worker) đi gửi thư fetch(); luồng chính đứng chờ ở Atomics.wait
 * cho tới khi luồng phụ bật "đèn báo" trong vùng nhớ chung (SharedArrayBuffer) — giống đứng ở quầy chờ gọi số.
 * Không cần thư viện npm nào. */
'use strict';
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

const WORKER_SRC = `
const { parentPort } = require('worker_threads');
parentPort.on('message', async ({ sab, port, req }) => {
  const flag = new Int32Array(sab); let out;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), req.timeout || 30000);
    const r = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {}, body: req.body === undefined || req.body === null ? undefined : req.body, redirect: req.redirect || 'follow', signal: ctl.signal });
    const buf = new Uint8Array(await r.arrayBuffer()); clearTimeout(t);
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    out = { status: r.status, headers, body: buf };
  } catch (e) { out = { error: String(e && (e.cause && e.cause.message || e.message) || e) }; }
  port.postMessage(out); port.close();
  Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
});`;

let worker = null;
function getWorker_() {
  if (!worker) { worker = new Worker(WORKER_SRC, { eval: true }); worker.unref(); worker.on('error', () => { worker = null; }); worker.on('exit', () => { worker = null; }); }
  return worker;
}
/** fetch ĐỒNG BỘ. req = {url, method, headers, body (string|Uint8Array), timeout}. Trả {status, headers, body: Buffer}. */
function syncFetch(req) {
  const sab = new SharedArrayBuffer(4), flag = new Int32Array(sab), { port1, port2 } = new MessageChannel();
  const w = getWorker_();
  w.postMessage({ sab, port: port2, req }, [port2]);
  const waited = Atomics.wait(flag, 0, 0, (req.timeout || 30000) + 2000);
  const msg = receiveMessageOnPort(port1); port1.close();
  if (waited === 'timed-out' && !msg) throw new Error('Hết thời gian chờ mạng: ' + req.url);
  const m = msg && msg.message;
  if (!m) throw new Error('Không nhận được phản hồi: ' + req.url);
  if (m.error) throw new Error('Lỗi mạng (' + String(req.url).replace(/\?.*$/, '') + '): ' + m.error);
  return { status: m.status, headers: m.headers, body: Buffer.from(m.body) };
}
/** Ngủ đồng bộ (thay Utilities.sleep). */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.min(ms, 30000))); }

module.exports = { syncFetch, sleepSync };
