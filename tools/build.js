#!/usr/bin/env node
/* ===== KM0 · tools/build.js — đóng gói bản Vercel từ đúng bộ khung cũ =====
 * Đầu vào : ../out/Code.gs, ../out/Index.html, ../out/CSS.html, ../out/JS.html  (sinh bởi ../build.sh + ../build_fe.py)
 * Đầu ra  : lib/code.gs.js      Code.gs dạng module Node (Vercel chạy)
 *           public/index.html   giao diện (Index + CSS + JS) + "bộ đổi điện" google.script.run → fetch('/api/rpc')
 *           sql/schema.sql      base.sql + 68 bảng (kiểu cột suy từ ENTITY_CONFIG) — dán vào Supabase SQL Editor
 * Chạy: node tools/build.js   (không cần npm install) */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { kieuCot } = require('../lib/db');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, '..', 'out');
const rd = f => fs.readFileSync(path.join(OUT, f), 'utf8');

// 1) Code.gs → lib/code.gs.js
const code = rd('Code.gs').replace(/^(const|let) /mg, 'var ');   // const/let cấp cao nhất → var: để runtime gọi được hàm theo tên
new vm.Script(code, { filename: 'Code.gs' });                     // kiểm tra cú pháp
const build = (code.match(/BACKEND_BUILD = '([^']+)'/) || [])[1] || '?';
fs.writeFileSync(path.join(ROOT, 'lib', 'code.gs.js'), '/* SINH TỰ ĐỘNG bởi tools/build.js từ out/Code.gs — bản ' + build + '. ĐỪNG SỬA TAY. */\nmodule.exports = ' + JSON.stringify(code) + ';\n');

// 2) giao diện
const shim = fs.readFileSync(path.join(ROOT, 'lib', 'client-shim.js'), 'utf8');
let idx = rd('Index.html');
const css = rd('CSS.html'), js = rd('JS.html');
if (!/<\?!= include\('CSS'\); \?>/.test(idx) || !/<\?!= include\('JS'\); \?>/.test(idx)) throw new Error('Index.html không có đủ 2 include');
idx = idx.replace("<?!= include('CSS'); ?>", () => css).replace("<?!= include('JS'); ?>", () => '<script>\n' + shim + '\n</script>\n' + js);
const appName = (code.match(/APP_NAME = '([^']+)'/) || [])[1] || 'KM0';
if (!/<title>/i.test(idx)) idx = idx.replace(/<head>/i, '<head>\n<title>' + appName + '</title>');
if (!/name="viewport"/i.test(idx)) idx = idx.replace(/<head>/i, '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">');
if (!/charset/i.test(idx)) idx = idx.replace(/<head>/i, '<head>\n<meta charset="utf-8">');
if (/<\?/.test(idx)) throw new Error('Còn scriptlet <? trong index.html');
fs.writeFileSync(path.join(ROOT, 'public', 'index.html'), idx);

// 3) schema.sql
const stub = new Proxy({}, { get: () => stub, apply: () => stub });
const ctx = vm.createContext({ console: console });
['SpreadsheetApp', 'CacheService', 'PropertiesService', 'LockService', 'Utilities', 'Session', 'DriveApp', 'MailApp', 'GmailApp', 'CalendarApp', 'ScriptApp', 'UrlFetchApp', 'HtmlService', 'Logger'].forEach(k => { ctx[k] = stub; });
vm.runInContext(code, ctx);
const defs = ctx.getSchemaDefinitions_(), names = Object.keys(defs);
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";
let nCot = 0; const dem = { text: 0, numeric: 0, date: 0 };
const bang = names.map(n => {
  const fm = ctx.fieldMap_(n), cols = defs[n].map(c => { const t = kieuCot(fm[c]); dem[t]++; nCot++; return { name: c, type: t }; });
  return 'select km0_create_sheet(' + lit(n) + ', ' + lit(JSON.stringify(cols)) + '::jsonb);';
});
const sqlOut = '-- =====================================================================================\n' +
  '-- KM0 · schema.sql — SINH TỰ ĐỘNG bởi tools/build.js (Code.gs bản ' + build + '). Dán TOÀN BỘ vào Supabase → SQL Editor → Run.\n' +
  '-- Chạy lại bao nhiêu lần cũng được: chỉ tạo bảng/cột còn thiếu, không xoá dữ liệu.\n' +
  '-- ' + names.length + ' bảng · ' + nCot + ' cột (' + dem.text + ' chữ, ' + dem.numeric + ' số, ' + dem.date + ' ngày)\n' +
  '-- =====================================================================================\n\n' +
  fs.readFileSync(path.join(ROOT, 'sql', 'base.sql'), 'utf8') +
  '\n-- ---------- ' + names.length + ' BẢNG DỮ LIỆU (mỗi tab Google Sheet cũ = 1 bảng) ----------\n' + bang.join('\n') + '\n' +
  "\nselect count(*) as so_bang_km0 from km0_sheets;\n";
fs.writeFileSync(path.join(ROOT, 'sql', 'schema.sql'), sqlOut);
fs.writeFileSync(path.join(ROOT, 'lib', 'version.json'), JSON.stringify({ build: build, bang: names.length, cot: nCot, luc: new Date().toISOString() }) + '\n');
console.log('OK bản ' + build + ': code.gs.js ' + Math.round(code.length / 1024) + 'KB · index.html ' + Math.round(idx.length / 1024) + 'KB · schema.sql ' + names.length + ' bảng / ' + nCot + ' cột ' + JSON.stringify(dem));
