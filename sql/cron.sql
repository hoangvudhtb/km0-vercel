-- =====================================================================================
-- KM0 · cron.sql — BẬT LỊCH TỰ ĐỘNG (thay trigger hẹn giờ của Apps Script)
-- Supabase sẽ gọi https://<app>.vercel.app/api/cron MỖI GIỜ; /api/cron tự xem việc nào đến giờ
-- (nhắc nhật ký 17h, gửi báo cáo ngày 18h, bản tin thứ Hai...) rồi chạy.
-- Cách dùng: sửa 2 chỗ <...> bên dưới → dán vào Supabase SQL Editor → Run. Chạy lại được nhiều lần.
-- =====================================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'km0-moi-gio';
select cron.schedule('km0-moi-gio', '2 * * * *', $$
  select net.http_get(
    url := 'https://<TEN-APP>.vercel.app/api/cron',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'),
    timeout_milliseconds := 60000);
$$);

-- Xem lịch đã đặt:        select jobid, jobname, schedule from cron.job;
-- Xem kết quả gần nhất:   select id, status_code, left(content, 300) from net._http_response order by id desc limit 5;
-- Tắt lịch:               select cron.unschedule('km0-moi-gio');
