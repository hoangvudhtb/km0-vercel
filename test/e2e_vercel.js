/* KM0 · e2e_vercel.js — trình duyệt thật (Chromium) → tools/dev.js (y như Vercel) → Supabase giả (Postgres 16 thật).
 * Kiểm: giao diện cũ KHÔNG sửa dòng nào vẫn chạy qua bộ đổi điện google.script.run → fetch('/api/rpc'). */
'use strict';
const path = require('path'), { spawn, execFileSync } = require('child_process');
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { syncFetch, sleepSync } = require('../lib/sync');
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const PORT = 18900 + (process.pid % 40), WEB = 3100 + (process.pid % 50), DB = 'km0_e2e' + process.pid, BASE = 'http://127.0.0.1:' + PORT + '/' + DB, APP = 'http://127.0.0.1:' + WEB;
const kids = [];
const cho = (url, ms) => { for (let t = Date.now(); ;) { try { if (syncFetch({ url: url, timeout: 1000 }).status < 500) return; } catch (e) { /* */ } if (Date.now() - t > ms) throw new Error('không lên: ' + url); sleepSync(100); } };
process.on('exit', () => kids.forEach(k => { try { k.kill(); } catch (e) { /* */ } }));

kids.push(spawn(process.execPath, [path.join(__dirname, 'pgdouble.js'), String(PORT)], { stdio: ['ignore', 'ignore', 'inherit'] }));
cho('http://127.0.0.1:' + PORT + '/health', 20000);
syncFetch({ url: 'http://127.0.0.1:' + PORT + '/newdb', method: 'POST', body: JSON.stringify({ name: DB }) });
execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', path.join(__dirname, '..', 'sql', 'schema.sql')], { stdio: ['ignore', 'ignore', 'pipe'] });
kids.push(spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'dev.js')], { stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { PORT: String(WEB), SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: 'test-key', ADMIN_SECRET: 'admin-secret-123', CRON_SECRET: 'cron-secret-123', DEV_LOG: '0' }) }));
cho(APP + '/', 20000);

const admin = fn => JSON.parse(syncFetch({ url: APP + '/api/admin', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-km0-admin': 'admin-secret-123' }, body: JSON.stringify({ fn: fn }), timeout: 60000 }).body.toString());
(async () => {
  console.log('# Quản trị qua /api/admin (thay menu Google Sheet)');
  let r = admin('initializeDatabase'); ok(r.ok, 'Khởi tạo / vá database' + (r.ok ? '' : ': ' + r.error));
  r = admin('seedDemoData'); ok(r.ok, 'Nạp dữ liệu DEMO ' + (r.ms || '') + 'ms' + (r.ok ? '' : ': ' + r.error));
  r = admin('checkDatabaseVersion'); ok(r.ok && /khớp/.test(r.result), 'Kiểm tra database: khớp');

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const mo = async vp => {
    const ctx = await browser.newContext({ viewport: vp, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' }), page = await ctx.newPage(), errors = [], rpc = [];
    await page.route('**/*', rt => { const u = rt.request().url(); if (u.indexOf(APP) === 0 || u.indexOf('data:') === 0) rt.continue(); else rt.abort(); });   // chặn CDN bên ngoài (máy thử không có mạng)
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
    page.on('request', q => { if (/\/api\/rpc$/.test(q.url())) rpc.push(JSON.parse(q.postData() || '{}').fn); });
    return { page, errors, rpc };
  };
  const settle = async page => { await page.waitForFunction(() => !document.querySelector('#content .skeleton') && !document.querySelector('.btn.loading'), null, { timeout: 15000 }); await page.waitForTimeout(150); };
  const go = async (page, route) => { await page.evaluate(x => navigate(x), route); await settle(page); };

  console.log('# Trình duyệt máy tính');
  const { page, errors, rpc } = await mo({ width: 1440, height: 900 });
  let t = Date.now(); await page.goto(APP + '/'); await page.waitForSelector('#lu');
  ok(true, 'mở trang đăng nhập ' + (Date.now() - t) + 'ms');
  await page.fill('#lu', 'admin'); await page.fill('#lp', 'admin123'); t = Date.now(); await page.click('#lgo');
  await page.waitForSelector('#app', { timeout: 15000 }); await settle(page);
  ok(rpc.indexOf('apiLogin') >= 0, 'đăng nhập qua google.script.run → /api/rpc (' + (Date.now() - t) + 'ms, các lệnh: ' + rpc.slice(0, 5).join(', ') + ')');
  await go(page, 'e:ct'); const nCT = await page.locator('#m-tbl tbody tr').count(); ok(nCT === 3, 'danh sách công trình: ' + nCT + ' dòng');
  await go(page, 'e:nktc'); ok(await page.locator('#m-tbl tbody tr').count() > 10, 'nhật ký KL thi công hiển thị dữ liệu từ Postgres');
  await go(page, 'p:dashboard'); await page.waitForSelector('.vz-grid', { timeout: 15000 });
  ok(await page.locator('[data-tile]').count() >= 10, 'dashboard: ' + await page.locator('[data-tile]').count() + ' ô biểu đồ');
  await page.screenshot({ path: path.join(__dirname, 'shot_vercel_dashboard.png') });
  // ghi qua giao diện thật (form cũ, không sửa): thêm → sửa → xoá đối tác
  const btn = t => page.locator('.modal-f button', { hasText: t }).last();
  await go(page, 'e:dt'); const n0 = await page.locator('#m-tbl tbody tr').count();
  await page.click('#m-add'); await page.waitForSelector('#frm');
  await page.fill('[data-k="TenDT"]', 'Công ty Thép Phú Quốc (thử Vercel)'); await page.selectOption('[data-k="LoaiDT"]', 'NCC vật tư'); await page.fill('[data-k="MST"]', '0312345678');
  await btn('Lưu').click(); await page.waitForSelector('.toast:has-text("Đã thêm")', { timeout: 15000 }); await settle(page);
  await page.reload(); await page.waitForSelector('#app', { timeout: 15000 }); await settle(page); await go(page, 'e:dt');
  ok(await page.locator('#m-tbl tbody tr', { hasText: 'Thép Phú Quốc' }).count() === 1 && await page.locator('#m-tbl tbody tr').count() === n0 + 1, 'THÊM đối tác bằng form → tải lại trang vẫn còn (đã lưu Postgres)');
  await page.locator('#m-tbl tr.click', { hasText: 'Thép Phú Quốc' }).first().click(); await page.waitForSelector('.modal-b');
  await btn('Sửa').click(); await page.waitForSelector('#frm'); await page.fill('[data-k="SDT"]', '0901234567'); await btn('Lưu').click();
  await page.waitForSelector('.toast:has-text("Đã lưu")', { timeout: 15000 }); await settle(page);
  ok((await page.textContent('#m-tbl')).includes('0901234567'), 'SỬA số điện thoại → bảng cập nhật');
  page.once('dialog', d => d.accept());
  await page.locator('#m-tbl tr.click', { hasText: 'Thép Phú Quốc' }).first().locator('[data-a="del"]').click();
  await page.locator('.modal-f button', { hasText: /Xoá|Xóa|Đồng ý/ }).last().click({ timeout: 3000 }).catch(() => { });
  await page.waitForFunction(() => !/Thép Phú Quốc/.test(document.querySelector('#m-tbl').textContent), null, { timeout: 15000 }).catch(() => { });
  await page.reload(); await page.waitForSelector('#app', { timeout: 15000 }); await settle(page); await go(page, 'e:dt');
  ok(await page.locator('#m-tbl tbody tr', { hasText: 'Thép Phú Quốc' }).count() === 0, 'XOÁ → tải lại trang không còn');
  ok(!errors.length, 'không lỗi JS' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));

  console.log('# Điện thoại 390px');
  const m = await mo({ width: 390, height: 844 });
  await m.page.goto(APP + '/'); await m.page.waitForSelector('#lu'); await m.page.fill('#lu', 'admin'); await m.page.fill('#lp', 'admin123'); await m.page.click('#lgo');
  await m.page.waitForSelector('#app', { timeout: 15000 }); await settle(m.page); await go(m.page, 'e:nktc');
  ok(await m.page.locator('.mcard').count() > 0 && await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'danh sách dạng thẻ, không cuộn ngang');
  await m.page.screenshot({ path: path.join(__dirname, 'shot_vercel_mobile.png') });
  ok(!m.errors.length, 'không lỗi JS (điện thoại)' + (m.errors.length ? ': ' + m.errors.join(' | ') : ''));

  console.log('# Sai mật khẩu / hết phiên');
  const p3 = await mo({ width: 1200, height: 800 });
  await p3.page.goto(APP + '/'); await p3.page.waitForSelector('#lu'); await p3.page.fill('#lu', 'admin'); await p3.page.fill('#lp', 'sai'); await p3.page.click('#lgo');
  await p3.page.waitForSelector('#lerr:not(.hide)', { timeout: 10000 }); ok(/Sai/.test(await p3.page.textContent('#lerr')), 'sai mật khẩu → báo lỗi từ máy chủ: ' + (await p3.page.textContent('#lerr')).trim());
  await browser.close();
  syncFetch({ url: 'http://127.0.0.1:' + PORT + '/dropdb', method: 'POST', body: JSON.stringify({ name: DB }) });
  console.log(bad ? '\n✗ ' + bad + ' lỗi' : '\n✓ e2e_vercel: tất cả đạt');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
