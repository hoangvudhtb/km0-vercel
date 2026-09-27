/* KM0 · tiện ích nhỏ cho các hàm /api */
'use strict';
const crypto = require('crypto');
function json(res, status, obj) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }
function body(req) { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } } if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch (e) { b = {}; } } return b || {}; }
function baseUrl(req) { const h = req.headers || {}; return (process.env.APP_URL || ((h['x-forwarded-proto'] || 'https') + '://' + (h['x-forwarded-host'] || h.host || ''))).replace(/\/+$/, ''); }
/** So khớp bí mật chống đoán dần từng ký tự (timing-safe). */
function sameSecret(a, b) { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); }
module.exports = { json, body, baseUrl, sameSecret };
