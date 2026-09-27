/* ===== KM0 · gasutils.js — Utilities / Blob của Apps Script viết lại bằng Node ===== */
'use strict';
const crypto = require('crypto'), zlib = require('zlib');
const { sleepSync } = require('./sync');

const toSigned = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));                 // Apps Script dùng byte có dấu (-128..127)
const toBuf = arr => (Buffer.isBuffer(arr) ? arr : Buffer.from(Uint8Array.from((arr || []).map(b => (b < 0 ? b + 256 : b)))));

class Blob {
  constructor(bytes, type, name) { this._b = bytes || []; this._t = type || ''; this._n = name || ''; }
  getBytes() { return this._b.slice(); } getName() { return this._n; } setName(n) { this._n = n; return this; }
  getContentType() { return this._t; } setContentType(t) { this._t = t; return this; }
  setDataFromString(s) { this._b = toSigned(Buffer.from(String(s), 'utf8')); return this; }
  getDataAsString(cs) { return toBuf(this._b).toString(/latin|iso-8859/i.test(cs || '') ? 'latin1' : 'utf8'); }
  copyBlob() { return new Blob(this._b.slice(), this._t, this._n); }
  getAs(t) { return new Blob(this._b.slice(), t, this._n); }
  isGoogleType() { return false; }
}

/** Nén zip thật (deflate) — file .xlsx/.docx nhỏ hơn (quan trọng vì Vercel giới hạn 4,5MB mỗi phản hồi). */
function zipDeflate(entries) {
  const parts = [], central = []; let off = 0;
  entries.forEach(e => {
    const name = Buffer.from(e.name, 'utf8'), raw = e.data, crc = zlib.crc32(raw) >>> 0, comp = zlib.deflateRawSync(raw), useDef = comp.length < raw.length, data = useDef ? comp : raw, method = useDef ? 8 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name); off += 30 + name.length + data.length;
  });
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat(parts.concat([cd, end]));
}
function unzip(buf) {
  const out = []; let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('File zip không hợp lệ.');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csz = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.slice(ds, ds + csz);
    out.push({ name: name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** Utilities.formatDate — giờ Việt Nam (+7, không đổi giờ mùa hè). Hỗ trợ các mẫu Code.gs dùng: yyyy yy MM dd HH mm ss. */
function formatDate(d, tz, f) {
  const x = new Date(d.getTime() + 7 * 3600 * 1000), p = (n, w) => String(n).padStart(w || 2, '0');
  const Y = x.getUTCFullYear(), M = x.getUTCMonth() + 1, D = x.getUTCDate(), h = x.getUTCHours(), mi = x.getUTCMinutes(), s = x.getUTCSeconds();
  return String(f).replace('yyyy', Y).replace('yy', p(Y % 100)).replace('MM', p(M)).replace('dd', p(D)).replace('HH', p(h)).replace('mm', p(mi)).replace('ss', p(s));
}

const bytesOf = v => (typeof v === 'string' ? Buffer.from(v, 'utf8') : toBuf(v));
const Utilities = {
  formatDate: formatDate,
  getUuid: () => crypto.randomUUID(),
  DigestAlgorithm: { SHA_256: 'sha256', SHA_1: 'sha1', MD5: 'md5', SHA_512: 'sha512' },
  MacAlgorithm: { HMAC_SHA_256: 'sha256', HMAC_SHA_1: 'sha1' },
  Charset: { UTF_8: 'UTF-8', US_ASCII: 'US-ASCII' },
  computeDigest: (alg, s) => toSigned(crypto.createHash(alg || 'sha256').update(bytesOf(s)).digest()),
  computeHmacSha256Signature: (v, k) => toSigned(crypto.createHmac('sha256', bytesOf(k)).update(bytesOf(v)).digest()),
  base64Decode: s => toSigned(Buffer.from(String(s), 'base64')),
  base64DecodeWebSafe: s => toSigned(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
  base64Encode: v => bytesOf(v).toString('base64'),
  base64EncodeWebSafe: v => bytesOf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  newBlob: (data, type, name) => new Blob(typeof data === 'string' ? toSigned(Buffer.from(data, 'utf8')) : (data || []), type, name),
  zip: (blobs, name) => new Blob(toSigned(zipDeflate(blobs.map(b => ({ name: b.getName(), data: toBuf(b.getBytes()) })))), 'application/zip', name || 'archive.zip'),
  unzip: blob => unzip(toBuf(blob.getBytes())).map(e => new Blob(toSigned(e.data), 'application/octet-stream', e.name)),
  sleep: ms => sleepSync(ms),
  jsonStringify: o => JSON.stringify(o), jsonParse: s => JSON.parse(s)
};
module.exports = { Utilities, Blob, toSigned, toBuf, zipDeflate, unzip, formatDate };
