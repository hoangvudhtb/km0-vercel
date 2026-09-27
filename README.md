# KM0 · bản Supabase + Vercel

Giữ nguyên bộ khung KM0 (Code.gs + giao diện JS/CSS/Index), thay "móng": dữ liệu nằm trong **Supabase (Postgres)**, máy chủ chạy trên **Vercel**. Không cần cài thư viện npm nào.

```
Trình duyệt (giao diện cũ) ──POST /api/rpc──▶ Vercel: Code.gs + bộ đổi điện (lib/) ──REST──▶ Supabase: 68 bảng + Storage
                                                 ▲
                              Supabase pg_cron ──┘ /api/cron mỗi giờ (nhắc nhật ký, báo cáo ngày)
```

| Thư mục | Nội dung |
|---|---|
| `api/` | `rpc.js` (thay google.script.run) · `admin.js` (thay menu Sheet) · `cron.js` (thay trigger) · `file.js` (mở file đã tải) |
| `lib/` | bộ đổi điện: `pgsheet.js` (Sheet giả trên Postgres), `services.js` (Cache/Props/Lock/Drive/Mail/…), `runtime.js`, `sync.js`, `db.js`, `client-shim.js` · `code.gs.js` do máy sinh |
| `public/` | `index.html` (giao diện, máy sinh) · `admin.html` (trang quản trị) |
| `sql/` | `schema.sql` (dán vào Supabase SQL Editor) · `cron.sql` (lịch tự động) · `base.sql` (phần chung) |
| `gas/` | `XuatSangSupabase.gs` — dán vào Apps Script CŨ để chuyển dữ liệu |
| `tools/` | `build.js` (đóng gói từ `../out/`) · `dev.js` (chạy thử trên máy: `node tools/dev.js`) |
| `test/` | Supabase giả + bộ test (chỉ dùng khi phát triển, không deploy) |

Biến môi trường: xem `.env.example`. Hướng dẫn từng bước: **Sổ tay chuyển nhà KM0** (Claude Docs).

Giới hạn Vercel Hobby: mỗi lần gửi/nhận ≤ 4,5 MB (file tải lên nên < 3 MB), mỗi lệnh ≤ 60 giây. Gmail (quét hoá đơn) và Google Calendar: giai đoạn 2.
