/* KM0 · bộ đổi điện phía trình duyệt: giao diện cũ vẫn gọi google.script.run.withSuccessHandler(..).apiXxx(..)
 * → ở đây đổi thành fetch('/api/rpc', {fn:'apiXxx', args:[..]}). JS.html giữ nguyên, không sửa dòng nào. */
(function () {
  function goi(fn, args, ok, loi, u) {
    fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: fn, args: args }) })
      .then(function (r) {
        return r.text().then(function (t) {
          try { return JSON.parse(t); } catch (e) { return { ok: false, error: r.status === 413 ? 'Dữ liệu gửi lên quá lớn (Vercel giới hạn ~4,5MB mỗi lần). Chia nhỏ file rồi thử lại.' : r.status === 504 ? 'Máy chủ xử lý quá 60 giây — thử lại với ít dữ liệu hơn.' : 'Máy chủ trả lỗi ' + r.status }; }
        });
      })
      .then(function (j) { if (j && j.ok) { if (ok) ok(j.result, u); } else if (loi) loi(new Error((j && j.error) || 'Lỗi không xác định'), u); })
      .catch(function (e) { if (loi) loi(new Error('Mất kết nối tới máy chủ: ' + (e && e.message || e)), u); });
  }
  function runner(ok, loi, u) {
    return new Proxy({}, { get: function (_, k) {
      if (k === 'withSuccessHandler') return function (f) { return runner(f, loi, u); };
      if (k === 'withFailureHandler') return function (f) { return runner(ok, f, u); };
      if (k === 'withUserObject') return function (x) { return runner(ok, loi, x); };
      if (typeof k !== 'string') return undefined;
      return function () { goi(k, Array.prototype.slice.call(arguments).map(function (a) { return a === undefined ? null : a; }), ok, loi, u); };
    } });
  }
  window.google = window.google || {};
  google.script = google.script || {};
  google.script.run = runner(null, null, undefined);
  google.script.url = { getLocation: function (cb) { var p = {}, pp = {}; new URLSearchParams(location.search).forEach(function (v, k) { if (!(k in p)) p[k] = v; (pp[k] = pp[k] || []).push(v); }); cb({ parameter: p, parameters: pp, hash: location.hash.replace(/^#/, '') }); } };
  google.script.host = { close: function () { }, setHeight: function () { }, setWidth: function () { }, origin: location.origin, editor: { focus: function () { } } };
})();
