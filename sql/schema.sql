-- =====================================================================================
-- KM0 · schema.sql — SINH TỰ ĐỘNG bởi tools/build.js (Code.gs bản 1.0.34). Dán TOÀN BỘ vào Supabase → SQL Editor → Run.
-- Chạy lại bao nhiêu lần cũng được: chỉ tạo bảng/cột còn thiếu, không xoá dữ liệu.
-- 68 bảng · 1143 cột (952 chữ, 124 số, 67 ngày)
-- =====================================================================================

-- =====================================================================================
-- KM0 · NỀN MÓNG SUPABASE — phần chung (sổ đăng ký bảng + các hàm RPC mà "bộ đổi điện" gọi)
-- Chạy được NHIỀU LẦN (idempotent): chỉ tạo cái còn thiếu, KHÔNG xoá dữ liệu.
-- Mọi hàm km0_* chỉ cho service_role (chìa khoá bí mật nằm ở Vercel) gọi; anon/authenticated bị chặn.
-- =====================================================================================

-- 1) SỔ ĐĂNG KÝ: sheet nào ↔ bảng nào, cột theo đúng thứ tự như tiêu đề Google Sheet
create table if not exists public.km0_sheets (
  sheet_name text primary key,                        -- tên tab Google Sheet cũ, vd CONG_TRINH
  table_name text not null unique,                    -- tên bảng Postgres, vd cong_trinh
  columns    jsonb not null default '[]'::jsonb,      -- [{"name":"MaCT","type":"text"}, ...] đúng thứ tự cột
  pos        bigint generated always as identity,     -- thứ tự tab
  created_at timestamptz not null default now()
);
-- 2) Thay CacheService (phiên đăng nhập, dữ liệu tạm có hạn dùng)
create table if not exists public.km0_cache (k text primary key, v text, expires_at timestamptz not null);
-- 3) Thay PropertiesService (cấu hình của script)
create table if not exists public.km0_props (k text primary key, v text, updated_at timestamptz not null default now());
-- 4) Thay LockService (khoá có hạn dùng — ai giữ quá hạn thì tự nhả)
create table if not exists public.km0_locks (name text primary key, owner text not null, expires_at timestamptz not null);
-- 5) Thay Google Drive: danh bạ file trong Supabase Storage
create table if not exists public.km0_files (id text primary key, path text not null, name text, mime text, size bigint, created_at timestamptz not null default now());
-- 6) Hộp thư đi (email chưa gửi được / chưa cấu hình dịch vụ gửi mail)
create table if not exists public.km0_outbox (id bigserial primary key, created_at timestamptz not null default now(), kind text, payload jsonb, status text, error text);

-- ---------- tiện ích nội bộ ----------
create or replace function public.km0_kieu_(p text) returns text language sql immutable as $$
  select case p when 'numeric' then 'numeric' when 'date' then 'date' else 'text' end
$$;
create or replace function public.km0_ten_bang_(p_sheet text) returns text language sql immutable as $$
  select case when x ~ '^[a-z_]' and x !~ '^(km0_|pg_)' then x else 's_' || x end
  from (select left(trim(both '_' from regexp_replace(lower(p_sheet), '[^a-z0-9_]+', '_', 'g')), 55) as x) q
$$;
/** Biểu thức SQL gói 1 dòng thành mảng JSON [_id, _ord, cột1, cột2, ...] (chia khúc 90 cột vì hàm tối đa 100 tham số). */
create or replace function public.km0_row_expr_(p_cols jsonb) returns text language plpgsql immutable as $$
declare nm text; chunk text[] := array['_id', '_ord']; parts text[] := array[]::text[];
begin
  for nm in select x->>'name' from jsonb_array_elements(coalesce(p_cols, '[]'::jsonb)) x loop
    if coalesce(array_length(chunk, 1), 0) >= 90 then
      parts := parts || ('jsonb_build_array(' || array_to_string(chunk, ',') || ')'); chunk := array[]::text[];
    end if;
    chunk := chunk || quote_ident(nm);
  end loop;
  if coalesce(array_length(chunk, 1), 0) > 0 then parts := parts || ('jsonb_build_array(' || array_to_string(chunk, ',') || ')'); end if;
  return array_to_string(parts, ' || ');
end $$;

-- ---------- BẢNG (sheet) ----------
/** Thêm cột còn thiếu vào CUỐI bảng (quy tắc vàng #1 y như trên Google Sheet). p_columns = [{"name":..,"type":"text|numeric|date"}] */
create or replace function public.km0_add_columns(p_sheet text, p_columns jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t text; v_cols jsonb; c jsonb; v_name text; v_type text;
begin
  select table_name, columns into v_t, v_cols from km0_sheets where sheet_name = p_sheet for update;
  if v_t is null then raise exception 'KM0: chưa có bảng cho sheet %', p_sheet; end if;
  for c in select * from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb)) loop
    v_name := c->>'name'; v_type := km0_kieu_(c->>'type');
    if v_name is null or v_name = '' or v_name in ('_id', '_ord') then continue; end if;
    if exists (select 1 from jsonb_array_elements(v_cols) x where x->>'name' = v_name) then continue; end if;
    execute format('alter table public.%I add column if not exists %I %s', v_t, v_name, v_type);
    v_cols := v_cols || jsonb_build_array(jsonb_build_object('name', v_name, 'type', v_type));
  end loop;
  update km0_sheets set columns = v_cols where sheet_name = p_sheet;
  return v_cols;
end $$;

/** Tạo bảng cho 1 sheet (nếu chưa có) + thêm cột còn thiếu. Mỗi bảng có 2 cột kỹ thuật: _id (số nhận diện), _ord (thứ tự dòng). */
create or replace function public.km0_create_sheet(p_sheet text, p_columns jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t text; v_base text; v_n int := 0; v_seq text;
begin
  select table_name into v_t from km0_sheets where sheet_name = p_sheet;
  if v_t is null then
    v_base := km0_ten_bang_(p_sheet); v_t := v_base;
    while exists (select 1 from km0_sheets where table_name = v_t) or to_regclass('public.' || quote_ident(v_t)) is not null loop
      v_n := v_n + 1; v_t := v_base || '_' || v_n;
    end loop;
    execute format('create table public.%I (_id bigserial primary key, _ord bigint not null default 0)', v_t);
    execute format('create index %I on public.%I (_ord, _id)', v_t || '_ord_idx', v_t);
    execute format('alter table public.%I enable row level security', v_t);
    execute format('revoke all on public.%I from public', v_t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on public.%I from anon, authenticated', v_t); end if;
    v_seq := pg_get_serial_sequence('public.' || quote_ident(v_t), '_id');
    if v_seq is not null and exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on sequence %s from anon, authenticated', v_seq); end if;
    insert into km0_sheets(sheet_name, table_name) values (p_sheet, v_t);
  end if;
  perform km0_add_columns(p_sheet, p_columns);
  return (select jsonb_build_object('s', sheet_name, 't', table_name, 'c', columns) from km0_sheets where sheet_name = p_sheet);
end $$;

/** Xoá 1 sheet (chỉ khi bảng rỗng — giống code cũ chỉ xoá tab "Sheet1" trống). */
create or replace function public.km0_drop_sheet(p_sheet text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t text; v_has boolean;
begin
  select table_name into v_t from km0_sheets where sheet_name = p_sheet;
  if v_t is null then return false; end if;
  execute format('select exists (select 1 from public.%I)', v_t) into v_has;
  if v_has then raise exception 'KM0: không xoá bảng % vì còn dữ liệu', v_t; end if;
  execute format('drop table public.%I', v_t);
  delete from km0_sheets where sheet_name = p_sheet;
  return true;
end $$;

/** ĐỌC: p_sheets = ["CONG_TRINH", ...] → {"CONG_TRINH": {"c":[cột], "r":[[_id,_ord,giá trị...], ...]}} — 1 lần gọi đọc nhiều bảng. */
create or replace function public.km0_read(p_sheets jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s text; v_t text; v_cols jsonb; v_rows jsonb; v_out jsonb := '{}'::jsonb;
begin
  for s in select jsonb_array_elements_text(coalesce(p_sheets, '[]'::jsonb)) loop
    select table_name, columns into v_t, v_cols from km0_sheets where sheet_name = s;
    if v_t is null then continue; end if;
    execute format('select coalesce(jsonb_agg(%s order by _ord, _id), ''[]''::jsonb) from public.%I', km0_row_expr_(v_cols), v_t) into v_rows;
    v_out := v_out || jsonb_build_object(s, jsonb_build_object('c', v_cols, 'r', v_rows));
  end loop;
  return v_out;
end $$;

/** GHI (1 giao dịch cho mọi bảng — hỏng 1 chỗ là không ghi gì):
 *  p_ops = [{"sheet":..,"add":[{name,type}],"cols":[tên cột theo thứ tự giá trị],"del":[_id..],"upd":[[_id,_ord,v..]],"ins":[[_ord,v..]]}]
 *  Trả về {"sheet": [[_ord,_id], ...]} cho các dòng vừa thêm (để "bộ đổi điện" biết số _id mới). */
create or replace function public.km0_apply(p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare op jsonb; v_t text; v_reg jsonb; nm text; ty text; i int; v_set text; v_sel text; v_list text; v_ids jsonb; v_out jsonb := '{}'::jsonb;
begin
  for op in select * from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    if jsonb_array_length(coalesce(op->'add', '[]'::jsonb)) > 0 then perform km0_add_columns(op->>'sheet', op->'add'); end if;
    select table_name, columns into v_t, v_reg from km0_sheets where sheet_name = op->>'sheet';
    if v_t is null then raise exception 'KM0: chưa có bảng cho sheet %', op->>'sheet'; end if;
    if jsonb_array_length(coalesce(op->'del', '[]'::jsonb)) > 0 then
      execute format('delete from public.%I where _id in (select (jsonb_array_elements_text($1))::bigint)', v_t) using op->'del';
    end if;
    v_set := ''; v_sel := ''; v_list := ''; i := 0;
    for nm in select jsonb_array_elements_text(coalesce(op->'cols', '[]'::jsonb)) loop
      ty := null;
      select km0_kieu_(x->>'type') into ty from jsonb_array_elements(v_reg) x where x->>'name' = nm;
      if ty is null then raise exception 'KM0: bảng % không có cột %', v_t, nm; end if;
      v_set  := v_set  || format(', %I = (r.v->>%s)::%s', nm, i + 2, ty);
      v_sel  := v_sel  || format(', (r.v->>%s)::%s', i + 1, ty);
      v_list := v_list || format(', %I', nm);
      i := i + 1;
    end loop;
    begin
      if jsonb_array_length(coalesce(op->'upd', '[]'::jsonb)) > 0 then
        execute format('update public.%I x set _ord = (r.v->>1)::bigint%s from jsonb_array_elements($1) r(v) where x._id = (r.v->>0)::bigint', v_t, v_set) using op->'upd';
      end if;
      if jsonb_array_length(coalesce(op->'ins', '[]'::jsonb)) > 0 then
        execute format('with ins as (insert into public.%I (_ord%s) select (r.v->>0)::bigint%s from jsonb_array_elements($1) with ordinality r(v, n) order by n returning _id, _ord) '
                    || 'select coalesce(jsonb_agg(jsonb_build_array(_ord, _id)), ''[]''::jsonb) from ins', v_t, v_list, v_sel) using op->'ins' into v_ids;
        v_out := v_out || jsonb_build_object(op->>'sheet', v_ids);
      end if;
    exception when others then
      raise exception 'KM0: ghi bảng % (sheet %) lỗi: %', v_t, op->>'sheet', sqlerrm;
    end;
  end loop;
  return v_out;
end $$;

-- ---------- KHOÁ (thay LockService) ----------
/** Xin khoá: chờ tối đa p_wait_ms; khoá tự hết hạn sau p_ttl_ms (phòng máy chủ chết giữa chừng). */
create or replace function public.km0_lock_acquire(p_name text, p_owner text, p_ttl_ms int default 60000, p_wait_ms int default 4000) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare t0 timestamptz := clock_timestamp(); n int;
begin
  loop
    insert into km0_locks(name, owner, expires_at) values (p_name, p_owner, clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0))
    on conflict (name) do update set owner = excluded.owner, expires_at = excluded.expires_at
      where km0_locks.expires_at < clock_timestamp() or km0_locks.owner = excluded.owner;
    get diagnostics n = row_count;
    if n > 0 then return true; end if;
    if clock_timestamp() - t0 > make_interval(secs => p_wait_ms / 1000.0) then return false; end if;
    perform pg_sleep(0.05);
  end loop;
end $$;
create or replace function public.km0_lock_release(p_name text, p_owner text) returns boolean
language sql volatile security definer set search_path = public, pg_temp as $$
  with d as (delete from km0_locks where name = p_name and owner = p_owner returning 1) select exists (select 1 from d)
$$;

-- ---------- CACHE (thay CacheService) ----------
create or replace function public.km0_cache_get(p_keys jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from km0_cache
  where k in (select jsonb_array_elements_text(coalesce(p_keys, '[]'::jsonb))) and expires_at > now()
$$;
create or replace function public.km0_cache_put(p_k text, p_v text, p_ttl int default 600) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  insert into km0_cache(k, v, expires_at) values (p_k, p_v, now() + make_interval(secs => least(greatest(coalesce(p_ttl, 600), 1), 21600)))
  on conflict (k) do update set v = excluded.v, expires_at = excluded.expires_at;
  if random() < 0.02 then delete from km0_cache where expires_at < now(); end if;   -- dọn rác thỉnh thoảng
end $$;
create or replace function public.km0_cache_del(p_k text) returns void
language sql volatile security definer set search_path = public, pg_temp as $$ delete from km0_cache where k = p_k $$;

-- ---------- CẤU HÌNH SCRIPT (thay PropertiesService) ----------
create or replace function public.km0_prop_set(p_k text, p_v text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_v is null then delete from km0_props where k = p_k;
  else insert into km0_props(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v, updated_at = now(); end if;
end $$;

-- ---------- FILE / HỘP THƯ ----------
create or replace function public.km0_file_add(p_id text, p_path text, p_name text, p_mime text, p_size bigint) returns void
language sql volatile security definer set search_path = public, pg_temp as $$
  insert into km0_files(id, path, name, mime, size) values (p_id, p_path, p_name, p_mime, p_size) on conflict (id) do update set path = excluded.path, name = excluded.name, mime = excluded.mime, size = excluded.size
$$;
create or replace function public.km0_file_get(p_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$ select to_jsonb(f) from km0_files f where id = p_id $$;
create or replace function public.km0_outbox_add(p_kind text, p_payload jsonb, p_status text, p_error text) returns void
language sql volatile security definer set search_path = public, pg_temp as $$
  insert into km0_outbox(kind, payload, status, error) values (p_kind, p_payload, p_status, p_error)
$$;

-- ---------- KHỞI ĐỘNG 1 LẦN GỌI (sổ đăng ký + cấu hình + phiên + các bảng đoán trước sẽ dùng) ----------
create or replace function public.km0_boot(p_sheets jsonb, p_cache jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'reg',   (select coalesce(jsonb_agg(jsonb_build_object('s', sheet_name, 't', table_name, 'c', columns) order by pos), '[]'::jsonb) from km0_sheets),
    'props', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from km0_props),
    'cache', km0_cache_get(p_cache),
    'data',  km0_read(p_sheets))
$$;

-- ---------- CHUYỂN NHÀ (dữ liệu từ Google Sheet cũ) ----------
/** Nhập 1 khúc dòng: xoá các dòng có _ord >= p_from_ord rồi chèn khúc mới → chạy lại khúc bị đứt giữa chừng không sinh trùng.
 *  p_rows = [[_ord (số dòng trên Sheet), giá trị theo p_cols...], ...] */
create or replace function public.km0_import(p_sheet text, p_cols jsonb, p_from_ord bigint, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t text;
begin
  select table_name into v_t from km0_sheets where sheet_name = p_sheet;
  if v_t is null then raise exception 'KM0: chưa có bảng cho sheet %', p_sheet; end if;
  execute format('delete from public.%I where _ord >= $1', v_t) using p_from_ord;
  perform km0_apply(jsonb_build_array(jsonb_build_object('sheet', p_sheet, 'cols', p_cols, 'ins', coalesce(p_rows, '[]'::jsonb))));
  return jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
end $$;
/** Đếm số dòng từng bảng — để đối chiếu với Google Sheet sau khi chuyển. */
create or replace function public.km0_count(p_sheets jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s text; v_t text; n bigint; v_out jsonb := '{}'::jsonb;
begin
  for s in select jsonb_array_elements_text(coalesce(p_sheets, '[]'::jsonb)) loop
    select table_name into v_t from km0_sheets where sheet_name = s;
    if v_t is null then v_out := v_out || jsonb_build_object(s, null); continue; end if;
    execute format('select count(*) from public.%I', v_t) into n;
    v_out := v_out || jsonb_build_object(s, n);
  end loop;
  return v_out;
end $$;

-- ---------- BẢO MẬT ----------
alter table public.km0_sheets enable row level security;
alter table public.km0_cache  enable row level security;
alter table public.km0_props  enable row level security;
alter table public.km0_locks  enable row level security;
alter table public.km0_files  enable row level security;
alter table public.km0_outbox enable row level security;
do $$
declare f record; has_roles boolean := exists (select 1 from pg_roles where rolname = 'anon');
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'km0\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    if has_roles then
      execute format('revoke all on function %s from anon, authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
  if has_roles then
    revoke all on public.km0_sheets, public.km0_cache, public.km0_props, public.km0_locks, public.km0_files, public.km0_outbox from anon, authenticated;
  end if;
  -- kho file (Supabase Storage): công khai theo đường link khó đoán, giống "ai có link thì xem được" của Drive
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('km0-files', 'km0-files', true) on conflict (id) do nothing;
  end if;
end $$;

-- ---------- 68 BẢNG DỮ LIỆU (mỗi tab Google Sheet cũ = 1 bảng) ----------
select km0_create_sheet('CONG_TRINH', '[{"name":"MaCT","type":"text"},{"name":"TenCT","type":"text"},{"name":"Loai","type":"text"},{"name":"LoaiCT","type":"text"},{"name":"ChuDauTu","type":"text"},{"name":"DiaChi","type":"text"},{"name":"DinhVi","type":"text"},{"name":"KhoangCachChoPhep","type":"numeric"},{"name":"VaoSang","type":"text"},{"name":"RaSang","type":"text"},{"name":"VaoChieu","type":"text"},{"name":"RaChieu","type":"text"},{"name":"ChiHuyTruong","type":"text"},{"name":"NgayKhoiCong","type":"date"},{"name":"NgayHoanThanh","type":"date"},{"name":"GiaTriHD","type":"numeric"},{"name":"TrangThai","type":"text"},{"name":"GoiThau","type":"text"},{"name":"GoiThauBCT","type":"text"},{"name":"DiaDiemBCT","type":"text"},{"name":"SoHopDong","type":"text"},{"name":"DonViTVGS","type":"text"},{"name":"NhaThauBC","type":"text"},{"name":"NhaThauVietTat","type":"text"},{"name":"TenNganCT","type":"text"},{"name":"KyHieuBC","type":"text"},{"name":"GiaiDoan","type":"text"},{"name":"ThoiGianThiCongBC","type":"text"},{"name":"LogoBC","type":"text"},{"name":"GuiDenBC","type":"text"},{"name":"CcBC","type":"text"},{"name":"ChucDanhKyBC","type":"text"},{"name":"NguoiKyBC","type":"text"},{"name":"ChuKyBC","type":"text"},{"name":"TieuDeYKienBCT","type":"text"},{"name":"YKienNhaThauBCT","type":"text"},{"name":"EmailNhanBaoCao","type":"text"},{"name":"WebhookChat","type":"text"}]'::jsonb);
select km0_create_sheet('NHAN_VIEN', '[{"name":"MaNV","type":"text"},{"name":"HoTen","type":"text"},{"name":"MatKhau","type":"text"},{"name":"VaiTro","type":"text"},{"name":"MaCT","type":"text"},{"name":"TinhTrang","type":"text"},{"name":"GioiTinh","type":"text"},{"name":"MaCD","type":"text"},{"name":"MaPB","type":"text"},{"name":"CVKiemNhiem","type":"text"},{"name":"NoiLamViec","type":"text"},{"name":"HinhAnh","type":"text"},{"name":"Email","type":"text"},{"name":"SDT","type":"text"},{"name":"HonNhan","type":"text"},{"name":"NgaySinh","type":"date"},{"name":"NgayThuViec","type":"date"},{"name":"NgayChinhThuc","type":"date"},{"name":"NgayNghiViec","type":"date"},{"name":"Tinh","type":"text"},{"name":"Phuong","type":"text"},{"name":"DiaChi","type":"text"},{"name":"CCCD","type":"text"},{"name":"NgayCap","type":"date"},{"name":"NoiCap","type":"text"},{"name":"MST","type":"text"},{"name":"TrinhDo","type":"text"},{"name":"NoiDaoTao","type":"text"},{"name":"ChuyenMon","type":"text"},{"name":"BHXH","type":"text"},{"name":"NganHang","type":"text"},{"name":"SoTK","type":"text"},{"name":"ChiNhanhNH","type":"text"},{"name":"NgachLuong","type":"text"},{"name":"BacLuong","type":"numeric"},{"name":"PhuCap","type":"numeric"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('PHONG_BAN', '[{"name":"MaPB","type":"text"},{"name":"TenPB","type":"text"},{"name":"PBQuanLy","type":"text"},{"name":"ThuTu","type":"numeric"}]'::jsonb);
select km0_create_sheet('CHUC_DANH', '[{"name":"MaCD","type":"text"},{"name":"TenCD","type":"text"},{"name":"Cap","type":"text"},{"name":"CapTren","type":"text"},{"name":"MaPB","type":"text"},{"name":"NgachLuong","type":"text"},{"name":"ThuTu","type":"numeric"}]'::jsonb);
select km0_create_sheet('CHI_NHANH', '[{"name":"MaCN","type":"text"},{"name":"Loai","type":"text"},{"name":"TenVietTat","type":"text"},{"name":"TenDayDu","type":"text"},{"name":"Logo","type":"text"},{"name":"DiaChi","type":"text"},{"name":"Email","type":"text"},{"name":"SDT","type":"text"},{"name":"Fax","type":"text"},{"name":"MST","type":"text"},{"name":"GiamDoc","type":"text"},{"name":"SDTGiamDoc","type":"text"},{"name":"EmailGiamDoc","type":"text"}]'::jsonb);
select km0_create_sheet('NGACH_BAC_LUONG', '[{"name":"MaNB","type":"text"},{"name":"Ngach","type":"text"},{"name":"Bac","type":"numeric"},{"name":"HeSo","type":"numeric"}]'::jsonb);
select km0_create_sheet('DS_SO_XUONG', '[{"name":"MaDS","type":"text"},{"name":"NhomDS","type":"text"},{"name":"GiaTri","type":"text"},{"name":"DienGiai","type":"text"}]'::jsonb);
select km0_create_sheet('CAU_HINH', '[{"name":"Khoa","type":"text"},{"name":"GiaTri","type":"text"},{"name":"MoTa","type":"text"}]'::jsonb);
select km0_create_sheet('NHAT_KY_HE_THONG', '[{"name":"MaLog","type":"text"},{"name":"TG","type":"text"},{"name":"NguoiDung","type":"text"},{"name":"HanhDong","type":"text"},{"name":"Entity","type":"text"},{"name":"MaBanGhi","type":"text"},{"name":"ChiTiet","type":"text"}]'::jsonb);
select km0_create_sheet('CONG_VIEC', '[{"name":"MaCV","type":"text"},{"name":"MaCT","type":"text"},{"name":"BoPhan","type":"text"},{"name":"TenCV","type":"text"},{"name":"GhiChu","type":"text"},{"name":"ViTri","type":"text"},{"name":"DonVi","type":"text"},{"name":"KLKeHoach","type":"numeric"},{"name":"KLThucHien","type":"numeric"},{"name":"MucDo","type":"text"},{"name":"ThoiHan","type":"date"},{"name":"TrachNhiem","type":"text"},{"name":"NguoiHoTro","type":"text"},{"name":"TrangThai","type":"text"},{"name":"KetQua","type":"text"},{"name":"LinkBaoCao","type":"text"},{"name":"NgayHoanThanh","type":"date"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('THONG_BAO', '[{"name":"MaTB","type":"text"},{"name":"Module","type":"text"},{"name":"MaThamChieu","type":"text"},{"name":"NoiDung","type":"text"},{"name":"NguoiNhan","type":"text"},{"name":"DaDoc","type":"text"},{"name":"TGTao","type":"text"}]'::jsonb);
select km0_create_sheet('BOQ_CONG_VIEC', '[{"name":"MaCVCT","type":"text"},{"name":"MaCT","type":"text"},{"name":"HangMuc","type":"text"},{"name":"NhomCV","type":"text"},{"name":"MaHieu","type":"text"},{"name":"TenCV","type":"text"},{"name":"DonVi","type":"text"},{"name":"KLThietKe","type":"numeric"},{"name":"DonGia","type":"numeric"},{"name":"NgayBatDauKH","type":"date"},{"name":"NgayKetThucKH","type":"date"},{"name":"GhiChu","type":"text"},{"name":"TienDe","type":"text"},{"name":"TienDoChot","type":"text"},{"name":"DMNhanCong","type":"numeric"},{"name":"BoTienDeTuDong","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DINH_MUC', '[{"name":"MaDM","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaCVCT","type":"text"},{"name":"Loai","type":"text"},{"name":"MaTaiNguyen","type":"text"},{"name":"DinhMuc","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"HaoHut","type":"numeric"},{"name":"NguonDM","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NK_KL_THI_CONG', '[{"name":"MaNKTC","type":"text"},{"name":"MaCT","type":"text"},{"name":"Ngay","type":"date"},{"name":"MaCVCT","type":"text"},{"name":"DoiThiCong","type":"text"},{"name":"LyTrinh","type":"text"},{"name":"NoiDung","type":"text"},{"name":"DonVi","type":"text"},{"name":"KLThucHien","type":"numeric"},{"name":"Anh1","type":"text"},{"name":"Anh2","type":"text"},{"name":"Anh3","type":"text"},{"name":"NguoiLap","type":"text"},{"name":"TrangThaiNT","type":"text"},{"name":"KyTT","type":"text"},{"name":"NguoiNghiemThu","type":"text"},{"name":"NgayNghiemThu","type":"text"},{"name":"GhiChuNT","type":"text"},{"name":"Anh4","type":"text"},{"name":"Anh5","type":"text"},{"name":"Anh6","type":"text"},{"name":"MaNKCT","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NHAT_KY_CT', '[{"name":"MaNKCT","type":"text"},{"name":"MaCT","type":"text"},{"name":"Ngay","type":"date"},{"name":"MuiThiCong","type":"text"},{"name":"ThoiTiet","type":"text"},{"name":"MuaTuSang","type":"text"},{"name":"MuaDenSang","type":"text"},{"name":"ThoiTietChieu","type":"text"},{"name":"MuaTuChieu","type":"text"},{"name":"MuaDenChieu","type":"text"},{"name":"SuCo","type":"text"},{"name":"AnToan","type":"text"},{"name":"NguoiLap","type":"text"},{"name":"KeHoachNgayMai","type":"text"},{"name":"MoTaAnh","type":"text"},{"name":"Anh1","type":"text"},{"name":"Anh2","type":"text"},{"name":"Anh3","type":"text"},{"name":"Anh4","type":"text"},{"name":"Anh5","type":"text"},{"name":"Anh6","type":"text"},{"name":"Anh7","type":"text"},{"name":"Anh8","type":"text"},{"name":"Anh9","type":"text"},{"name":"Anh10","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('KE_HOACH_NGAY_MAI', '[{"name":"MaKHNM","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaNKCT","type":"text"},{"name":"Ngay","type":"date"},{"name":"Loai","type":"text"},{"name":"NoiDung","type":"text"},{"name":"ThoiGian","type":"text"},{"name":"CanBoPhuTrach","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('KE_HOACH_TUAN', '[{"name":"MaKHT","type":"text"},{"name":"MaCT","type":"text"},{"name":"TuNgay","type":"date"},{"name":"DenNgay","type":"date"},{"name":"MaCVCT","type":"text"},{"name":"PctKH","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('TRINH_TU_THI_CONG', '[{"name":"MaTT","type":"text"},{"name":"ThuTu","type":"numeric"},{"name":"TenGiaiDoan","type":"text"},{"name":"Loai","type":"text"},{"name":"TuKhoa","type":"text"},{"name":"DonViNS","type":"text"},{"name":"NangSuat","type":"numeric"},{"name":"SoTo","type":"numeric"},{"name":"SoNgayMacDinh","type":"numeric"},{"name":"GianCach","type":"numeric"},{"name":"PhamVi","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('TIEN_DO_PHIEN_BAN', '[{"name":"MaPB","type":"text"},{"name":"MaCT","type":"text"},{"name":"SoPB","type":"numeric"},{"name":"TenPB","type":"text"},{"name":"Loai","type":"text"},{"name":"NgayCapNhat","type":"date"},{"name":"NgayBD","type":"date"},{"name":"NgayKT","type":"date"},{"name":"SoCV","type":"numeric"},{"name":"SoGang","type":"numeric"},{"name":"PctHT","type":"numeric"},{"name":"TrangThai","type":"text"},{"name":"GhiChu","type":"text"},{"name":"ThamSo","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('TIEN_DO_PB_CHI_TIET', '[{"name":"MaDong","type":"text"},{"name":"MaPB","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaCVCT","type":"text"},{"name":"MaHieu","type":"text"},{"name":"TenCV","type":"text"},{"name":"HangMuc","type":"text"},{"name":"NhomCV","type":"text"},{"name":"DonVi","type":"text"},{"name":"KLThietKe","type":"numeric"},{"name":"KLDaLam","type":"numeric"},{"name":"KLConLai","type":"numeric"},{"name":"BatDau","type":"date"},{"name":"KetThuc","type":"date"},{"name":"SoNgay","type":"numeric"},{"name":"NangSuat","type":"numeric"},{"name":"SoTo","type":"numeric"},{"name":"Gang","type":"text"},{"name":"TinhTrang","type":"text"},{"name":"GiaiDoan","type":"text"},{"name":"LyDo","type":"text"}]'::jsonb);
select km0_create_sheet('DANH_MUC_HS_BO_SUNG', '[{"name":"MaDong","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaMuc","type":"text"},{"name":"TenTL","type":"text"},{"name":"SoHieu","type":"text"},{"name":"Ngay","type":"date"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('BIEN_BAN_NGHIEM_THU', '[{"name":"MaBB","type":"text"},{"name":"MaCT","type":"text"},{"name":"Loai","type":"text"},{"name":"SoBB","type":"text"},{"name":"NgayNT","type":"date"},{"name":"GioBD","type":"text"},{"name":"GioKT","type":"text"},{"name":"MaCVCT","type":"text"},{"name":"HangMuc","type":"text"},{"name":"DoiTuong","type":"text"},{"name":"ViTri","type":"text"},{"name":"KLNghiemThu","type":"numeric"},{"name":"DonVi","type":"text"},{"name":"DiaDiem","type":"text"},{"name":"CanCu","type":"text"},{"name":"DanhGiaChatLuong","type":"text"},{"name":"KetLuan","type":"text"},{"name":"ChoPhepTiepTheo","type":"text"},{"name":"YeuCau","type":"text"},{"name":"GS_HoTen","type":"text"},{"name":"GS_ChucVu","type":"text"},{"name":"CDT_HoTen","type":"text"},{"name":"CDT_ChucVu","type":"text"},{"name":"NT_HoTen","type":"text"},{"name":"NT_ChucVu","type":"text"},{"name":"NTDD_HoTen","type":"text"},{"name":"NTDD_ChucVu","type":"text"},{"name":"NTP_Ten","type":"text"},{"name":"NTP_HoTen","type":"text"},{"name":"NTP_ChucVu","type":"text"},{"name":"TK_Ten","type":"text"},{"name":"TK_HoTen","type":"text"},{"name":"TK_ChucVu","type":"text"},{"name":"PhuLuc","type":"text"},{"name":"CapNhatKL","type":"text"},{"name":"DsMaNKTC","type":"text"},{"name":"GhiChu","type":"text"},{"name":"TrangThaiBB","type":"text"},{"name":"MaPhieuQC","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NKCT_NHAN_LUC', '[{"name":"MaNKNL","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaNKCT","type":"text"},{"name":"Nhom","type":"text"},{"name":"LoaiNL","type":"text"},{"name":"SoLuong","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NKCT_MAY_MOC', '[{"name":"MaNKMM","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaNKCT","type":"text"},{"name":"TenThietBi","type":"text"},{"name":"SoLuong","type":"numeric"},{"name":"DanhGia","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NHAN_LUC_HUY_DONG', '[{"name":"MaNLHD","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaDT","type":"text"},{"name":"Nhom","type":"text"},{"name":"HoTen","type":"text"},{"name":"LoaiNL","type":"text"},{"name":"ChucDanhCuThe","type":"text"},{"name":"SDT","type":"text"},{"name":"Email","type":"text"},{"name":"SoLuongCamKet","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('MAY_MOC_HUY_DONG', '[{"name":"MaMMHD","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaDT","type":"text"},{"name":"NoiDung","type":"text"},{"name":"TenThietBi","type":"text"},{"name":"SoLuong","type":"numeric"},{"name":"SoKiemDinh","type":"text"},{"name":"NgayHetHanKD","type":"date"},{"name":"TinhTrangHoatDong","type":"text"},{"name":"DanhGia","type":"text"},{"name":"ThietBiChinh","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('KE_HOACH_DE_TRINH', '[{"name":"MaKHTS","type":"text"},{"name":"MaCT","type":"text"},{"name":"NoiDung","type":"text"},{"name":"NgayDuKien","type":"date"},{"name":"NgayThucTe","type":"date"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DE_XUAT_TT', '[{"name":"MaDXTT","type":"text"},{"name":"MaCT","type":"text"},{"name":"KyThanhToan","type":"text"},{"name":"NgayDeNghi","type":"date"},{"name":"TuNgay","type":"date"},{"name":"DenNgay","type":"date"},{"name":"GTKhoiLuong","type":"numeric"},{"name":"GTPhatSinh","type":"numeric"},{"name":"GTDeNghi","type":"numeric"},{"name":"GTDuyet","type":"numeric"},{"name":"TyLeVAT","type":"numeric"},{"name":"TyLeHoanUng","type":"numeric"},{"name":"TyLeGiuLai","type":"numeric"},{"name":"DaThu","type":"numeric"},{"name":"TrangThai","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"HoSoKemTheo","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HO_SO_PHAT_SINH', '[{"name":"MaPS","type":"text"},{"name":"MaCT","type":"text"},{"name":"NgayDeXuat","type":"date"},{"name":"LoaiPhatSinh","type":"text"},{"name":"MoTa","type":"text"},{"name":"DonVi","type":"text"},{"name":"KLDeNghi","type":"numeric"},{"name":"DonGia","type":"numeric"},{"name":"FileTKMoi","type":"text"},{"name":"TrangThai","type":"text"},{"name":"KyTT","type":"text"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('VAN_DE_HIEN_TRUONG', '[{"name":"MaVD","type":"text"},{"name":"MaCT","type":"text"},{"name":"Ngay","type":"date"},{"name":"Loai","type":"text"},{"name":"MucDo","type":"text"},{"name":"MoTa","type":"text"},{"name":"ViTri","type":"text"},{"name":"Anh1","type":"text"},{"name":"Anh2","type":"text"},{"name":"NguoiPhuTrach","type":"text"},{"name":"HanXuLy","type":"date"},{"name":"TrangThai","type":"text"},{"name":"BienPhap","type":"text"},{"name":"MaPhieuQC","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DOI_TAC', '[{"name":"MaDT","type":"text"},{"name":"TenDT","type":"text"},{"name":"LoaiDT","type":"text"},{"name":"MST","type":"text"},{"name":"DiaChi","type":"text"},{"name":"SDT","type":"text"},{"name":"Email","type":"text"},{"name":"NguoiDaiDien","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NHAN_SU_DOI_TAC', '[{"name":"MaNSDT","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaDT","type":"text"},{"name":"HoTen","type":"text"},{"name":"ChucVu","type":"text"},{"name":"SDT","type":"text"},{"name":"Email","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HOP_DONG', '[{"name":"SoHD","type":"text"},{"name":"MaCT","type":"text"},{"name":"NgayKy","type":"date"},{"name":"MaDT","type":"text"},{"name":"LoaiHD","type":"text"},{"name":"TenHD","type":"text"},{"name":"GiaTriHD","type":"numeric"},{"name":"TyLeTamUng","type":"numeric"},{"name":"SoTienTamUng","type":"numeric"},{"name":"NgayHetHan","type":"date"},{"name":"FileHD","type":"text"},{"name":"TrangThai","type":"text"},{"name":"PhuTrach","type":"text"},{"name":"KhoanMucCP","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('TT_CONG_NO', '[{"name":"MaTT","type":"text"},{"name":"SoHD","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaDT","type":"text"},{"name":"NgayDeXuat","type":"date"},{"name":"LoaiTT","type":"text"},{"name":"SoTienDeNghi","type":"numeric"},{"name":"NoiDung","type":"text"},{"name":"FileHoSo","type":"text"},{"name":"TrangThai","type":"text"},{"name":"DaChi","type":"numeric"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('VAT_TU', '[{"name":"MaVT","type":"text"},{"name":"TenVT","type":"text"},{"name":"DonVi","type":"text"},{"name":"DonGia","type":"numeric"},{"name":"TonToiThieu","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"NguonGia","type":"text"},{"name":"NgayGia","type":"date"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NK_KHO', '[{"name":"MaNK","type":"text"},{"name":"MaCT","type":"text"},{"name":"Ngay","type":"date"},{"name":"Loai","type":"text"},{"name":"MaVT","type":"text"},{"name":"DonVi","type":"text"},{"name":"KhoiLuong","type":"numeric"},{"name":"DonGia","type":"numeric"},{"name":"MaDT","type":"text"},{"name":"MaCVCT","type":"text"},{"name":"NguoiThucHien","type":"text"},{"name":"GhiChu","type":"text"},{"name":"MaDCK","type":"text"},{"name":"SoLo","type":"text"},{"name":"SoBBTN","type":"text"},{"name":"NgayTN","type":"date"},{"name":"KetQuaTN","type":"text"},{"name":"MaDX","type":"text"},{"name":"MaHDDT","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DINH_MUC_THAM_KHAO', '[{"name":"MaDMTK","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaHieuDM","type":"text"},{"name":"TenCongTac","type":"text"},{"name":"TuKhoa","type":"text"},{"name":"DonViCT","type":"text"},{"name":"Loai","type":"text"},{"name":"TenTaiNguyen","type":"text"},{"name":"DonViTN","type":"text"},{"name":"HaoPhi","type":"numeric"},{"name":"HaoHut","type":"numeric"},{"name":"TheoDay","type":"text"},{"name":"NguonDM","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NGAN_SACH_CT', '[{"name":"MaNS","type":"text"},{"name":"MaCT","type":"text"},{"name":"PhienBan","type":"numeric"},{"name":"KhoanMuc","type":"text"},{"name":"NoiDung","type":"text"},{"name":"GiaTri","type":"numeric"},{"name":"CoSo","type":"text"},{"name":"TrangThai","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('MAU_CAU', '[{"name":"MaMC","type":"text"},{"name":"Truong","type":"text"},{"name":"NoiDung","type":"text"},{"name":"ThuTu","type":"numeric"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HOA_DON_DAU_VAO', '[{"name":"MaHDDT","type":"text"},{"name":"MaCT","type":"text"},{"name":"KyHieu","type":"text"},{"name":"SoHD","type":"text"},{"name":"NgayHD","type":"date"},{"name":"MSTNCC","type":"text"},{"name":"TenNCC","type":"text"},{"name":"MaDT","type":"text"},{"name":"TongChuaThue","type":"numeric"},{"name":"TienThue","type":"numeric"},{"name":"TongTien","type":"numeric"},{"name":"TrangThai","type":"text"},{"name":"Nguon","type":"text"},{"name":"MaTraCuu","type":"text"},{"name":"FileXML","type":"text"},{"name":"ChiTiet","type":"text"},{"name":"DsMaNK","type":"text"},{"name":"MaTT","type":"text"},{"name":"CanhBao","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('TAN_SUAT_THI_NGHIEM', '[{"name":"MaTS","type":"text"},{"name":"NhomVL","type":"text"},{"name":"TuKhoa","type":"text"},{"name":"LoMau","type":"numeric"},{"name":"DonVi","type":"text"},{"name":"QuyCachMau","type":"text"},{"name":"TieuChuan","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('PHIEU_DE_NGHI_VT', '[{"name":"MaPDX","type":"text"},{"name":"MaCT","type":"text"},{"name":"SoPhieu","type":"text"},{"name":"NgayDeNghi","type":"date"},{"name":"DotDeNghi","type":"text"},{"name":"TieuDe","type":"text"},{"name":"NoiLap","type":"text"},{"name":"GhiNgay","type":"text"},{"name":"KinhGui","type":"text"},{"name":"CanCuHD","type":"text"},{"name":"GoiThau","type":"text"},{"name":"DuAn","type":"text"},{"name":"DiaDiem","type":"text"},{"name":"LoiDeNghi","type":"text"},{"name":"KyTrai","type":"text"},{"name":"KyPhai","type":"text"},{"name":"NguoiKyTrai","type":"text"},{"name":"NguoiKyPhai","type":"text"},{"name":"TrangThai","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('THONG_KE_VI_TRI_VT', '[{"name":"MaTK","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaDX","type":"text"},{"name":"STT","type":"numeric"},{"name":"Tuyen","type":"text"},{"name":"TuCoc","type":"text"},{"name":"DenCoc","type":"text"},{"name":"Trai","type":"numeric"},{"name":"Phai","type":"numeric"},{"name":"BanKinh","type":"text"},{"name":"DienGiai","type":"text"},{"name":"KhoiLuong","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HO_SO_MAU', '[{"name":"MaMau","type":"text"},{"name":"NhomHS","type":"text"},{"name":"ThuTu","type":"numeric"},{"name":"TenHS","type":"text"},{"name":"CanCu","type":"text"},{"name":"ThanhPhanKy","type":"text"},{"name":"SoBan","type":"numeric"},{"name":"ApDung","type":"text"},{"name":"MaMucVIB","type":"text"},{"name":"KichHoat","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('SO_HO_SO_CONG_TRINH', '[{"name":"MaHSCT","type":"text"},{"name":"MaCT","type":"text"},{"name":"NhomHS","type":"text"},{"name":"MaMuc","type":"text"},{"name":"TenHS","type":"text"},{"name":"SoHieu","type":"text"},{"name":"NgayHS","type":"date"},{"name":"HangMuc","type":"text"},{"name":"Tuyen","type":"text"},{"name":"LyTrinh","type":"text"},{"name":"ViTri","type":"text"},{"name":"ThanhPhanKy","type":"text"},{"name":"NguoiPhuTrach","type":"text"},{"name":"HanHoanThanh","type":"date"},{"name":"TrangThai","type":"text"},{"name":"LinkHS","type":"text"},{"name":"SoBan","type":"numeric"},{"name":"MaMucVIB","type":"text"},{"name":"Nguon","type":"text"},{"name":"NguonKhoa","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DE_XUAT_MAY', '[{"name":"MaDXM","type":"text"},{"name":"MaCT","type":"text"},{"name":"NgayDeXuat","type":"date"},{"name":"NguoiDeXuat","type":"text"},{"name":"MaMay","type":"text"},{"name":"SoLuong","type":"numeric"},{"name":"TuNgay","type":"date"},{"name":"DenNgay","type":"date"},{"name":"SoCa","type":"numeric"},{"name":"MucDich","type":"text"},{"name":"TrangThai","type":"text"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DE_XUAT_VAT_TU', '[{"name":"MaDX","type":"text"},{"name":"MaCT","type":"text"},{"name":"NgayDeXuat","type":"date"},{"name":"NguoiDeXuat","type":"text"},{"name":"MaVT","type":"text"},{"name":"DonVi","type":"text"},{"name":"SLYeuCau","type":"numeric"},{"name":"MucDich","type":"text"},{"name":"NgayCan","type":"date"},{"name":"TrangThai","type":"text"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"NgayDuyetDX","type":"text"},{"name":"NgayMua","type":"text"},{"name":"MaDTMua","type":"text"},{"name":"NgayGiaoDK","type":"date"},{"name":"MaPDX","type":"text"},{"name":"NhomDX","type":"text"},{"name":"TenHienThi","type":"text"},{"name":"ChungLoai","type":"text"},{"name":"KLHopDong","type":"numeric"},{"name":"KLBVTC","type":"numeric"},{"name":"HeSoHaoHut","type":"numeric"},{"name":"KLLuyKe","type":"numeric"},{"name":"GhiChuPhieu","type":"text"},{"name":"ThuTu","type":"numeric"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HAO_HUT_VAT_TU', '[{"name":"MaHH","type":"text"},{"name":"MaCT","type":"text"},{"name":"NgayBaoCao","type":"date"},{"name":"MaVT","type":"text"},{"name":"KLHaoHut","type":"numeric"},{"name":"LyDo","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DM_CA_MAY', '[{"name":"MaMay","type":"text"},{"name":"TenMay","type":"text"},{"name":"BienSo","type":"text"},{"name":"DonViTinh","type":"text"},{"name":"DonGiaThue","type":"numeric"},{"name":"MaDT","type":"text"},{"name":"TrangThai","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NK_CA_MAY', '[{"name":"MaNKM","type":"text"},{"name":"MaCT","type":"text"},{"name":"Ngay","type":"date"},{"name":"MaMay","type":"text"},{"name":"MaCVCT","type":"text"},{"name":"NoiDung","type":"text"},{"name":"SoCa","type":"numeric"},{"name":"NhienLieuLit","type":"numeric"},{"name":"NguoiLap","type":"text"},{"name":"HinhThuc","type":"text"},{"name":"MaDT","type":"text"},{"name":"BienSo","type":"text"},{"name":"TaiXe","type":"text"},{"name":"DonViTinh","type":"text"},{"name":"SoLuongTinh","type":"numeric"},{"name":"DonGia","type":"numeric"},{"name":"GioHoatDong","type":"text"},{"name":"KmDau","type":"numeric"},{"name":"KmCuoi","type":"numeric"},{"name":"XacNhan","type":"text"},{"name":"NguoiXacNhan","type":"text"},{"name":"MaTTCN","type":"text"},{"name":"MaNKCT","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HAO_HUT_CA_MAY', '[{"name":"MaHC","type":"text"},{"name":"MaCT","type":"text"},{"name":"NgayBaoCao","type":"date"},{"name":"MaMay","type":"text"},{"name":"LyDo","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('VAN_BAN', '[{"name":"MaVB","type":"text"},{"name":"Loai","type":"text"},{"name":"Phong","type":"text"},{"name":"NhomTL","type":"text"},{"name":"MaTL","type":"text"},{"name":"TenTL","type":"text"},{"name":"Link","type":"text"},{"name":"FileTL","type":"text"},{"name":"TLLienQuan","type":"text"},{"name":"GhiChu","type":"text"},{"name":"TrangThai","type":"text"},{"name":"PhanPhoi","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HO_SO_LUU_TRU', '[{"name":"MaHS","type":"text"},{"name":"Phong","type":"text"},{"name":"MaVB","type":"text"},{"name":"MaTL","type":"text"},{"name":"Ngay","type":"date"},{"name":"MaHoSo","type":"text"},{"name":"TenHoSo","type":"text"},{"name":"GhiChu","type":"text"},{"name":"File","type":"text"},{"name":"Link","type":"text"},{"name":"Anh1","type":"text"},{"name":"Anh2","type":"text"},{"name":"PhanPhoiVaiTro","type":"text"},{"name":"PhanPhoiNV","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HSE_DM_HO_SO', '[{"name":"MaHS","type":"text"},{"name":"NhomHS","type":"text"},{"name":"TenHS","type":"text"},{"name":"QuyCach","type":"text"},{"name":"ThoiHanDinhKy","type":"numeric"}]'::jsonb);
select km0_create_sheet('HSE_QUAN_LY', '[{"name":"MaQL","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaHS","type":"text"},{"name":"File","type":"text"},{"name":"NgayBanHanh","type":"date"},{"name":"NgayHetHan","type":"date"},{"name":"TrangThai","type":"text"},{"name":"DonViKiemTra","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('HSE_THEO_DOI', '[{"name":"MaTD","type":"text"},{"name":"MaCT","type":"text"},{"name":"Loai","type":"text"},{"name":"DoiTuong","type":"text"},{"name":"LoaiChungChi","type":"text"},{"name":"NgayCap","type":"date"},{"name":"NgayToiHan","type":"date"},{"name":"File","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('QC_CHECKLIST', '[{"name":"MaQC","type":"text"},{"name":"MaCT","type":"text"},{"name":"NhomHS","type":"text"},{"name":"TenLoaiHS","type":"text"},{"name":"HangMucApDung","type":"text"},{"name":"QuyCach","type":"text"},{"name":"CanCuPhapLy","type":"text"},{"name":"SoLuongBanLuu","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('QC_TRACKING', '[{"name":"MaQCT","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaQC","type":"text"},{"name":"HangMuc","type":"text"},{"name":"TenHS","type":"text"},{"name":"SoHieuBB","type":"text"},{"name":"NgayNghiemThu","type":"date"},{"name":"DonViTinh","type":"text"},{"name":"KhoiLuong","type":"numeric"},{"name":"KyThanhToan","type":"text"},{"name":"File","type":"text"},{"name":"TrangThai","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('QC_PHIEU_KIEM_TRA', '[{"name":"SoPhieu","type":"text"},{"name":"MaCT","type":"text"},{"name":"NgayKiemTra","type":"date"},{"name":"MaCVCT","type":"text"},{"name":"HangMuc","type":"text"},{"name":"ViTri","type":"text"},{"name":"LoaiDiemDung","type":"text"},{"name":"TieuChuan","type":"text"},{"name":"SoBanVe","type":"text"},{"name":"SoBienPhap","type":"text"},{"name":"SoITP","type":"text"},{"name":"KetLuan","type":"text"},{"name":"DieuKien","type":"text"},{"name":"SoNCR","type":"text"},{"name":"NgayPhatHienKPH","type":"date"},{"name":"YeuCauViPham","type":"text"},{"name":"MoTaKPH","type":"text"},{"name":"NguyenNhanGoc","type":"text"},{"name":"HanhDongKhacPhuc","type":"text"},{"name":"HanhDongPhongNgua","type":"text"},{"name":"XacMinh","type":"text"},{"name":"NgayDongNCR","type":"date"},{"name":"NguoiKiemTra","type":"text"},{"name":"ChiHuyTruongXacNhan","type":"text"},{"name":"NgayCHTXacNhan","type":"date"},{"name":"DaiDienTVGS","type":"text"},{"name":"NgayTVGSXacNhan","type":"date"},{"name":"File","type":"text"},{"name":"TrangThai","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('QC_NOI_DUNG_KT', '[{"name":"MaND","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaPhieu","type":"text"},{"name":"STT","type":"numeric"},{"name":"HangMucKiemTra","type":"text"},{"name":"PhuongPhap","type":"text"},{"name":"TieuChi","type":"text"},{"name":"TrachNhiem","type":"text"},{"name":"KetQua","type":"text"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('SO_THU_CHI', '[{"name":"MaGD","type":"text"},{"name":"Ngay","type":"date"},{"name":"LoaiPhieu","type":"text"},{"name":"MaHM","type":"text"},{"name":"MaCT","type":"text"},{"name":"SoTien","type":"numeric"},{"name":"HinhThuc","type":"text"},{"name":"DienGiai","type":"text"},{"name":"File","type":"text"},{"name":"MaGDGoc","type":"text"},{"name":"NguoiLap","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('DM_CHI_PHI', '[{"name":"MaHM","type":"text"},{"name":"TenHM","type":"text"},{"name":"Loai","type":"text"},{"name":"KhoanMucCP","type":"text"}]'::jsonb);
select km0_create_sheet('TAM_UNG', '[{"name":"MaGD","type":"text"},{"name":"Ngay","type":"date"},{"name":"LoaiGD","type":"text"},{"name":"MaCT","type":"text"},{"name":"MaNV","type":"text"},{"name":"SoLuong","type":"numeric"},{"name":"DonGia","type":"numeric"},{"name":"DienGiai","type":"text"},{"name":"File","type":"text"},{"name":"TrangThai","type":"text"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('THUONG_GIAM_TRU', '[{"name":"MaTG","type":"text"},{"name":"NamThang","type":"text"},{"name":"Ngay","type":"date"},{"name":"MaNV","type":"text"},{"name":"Loai","type":"text"},{"name":"HangMuc","type":"text"},{"name":"DienGiai","type":"text"},{"name":"SoTien","type":"numeric"},{"name":"TrangThai","type":"text"},{"name":"SoTienChiThucTe","type":"numeric"},{"name":"FileCT","type":"text"},{"name":"NguoiDuyet","type":"text"},{"name":"NgayDuyet","type":"text"},{"name":"GhiChuDuyet","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('CHAM_CONG', '[{"name":"MaCC","type":"text"},{"name":"Ngay","type":"date"},{"name":"Thu","type":"text"},{"name":"Nam","type":"numeric"},{"name":"Thang","type":"numeric"},{"name":"MaNV","type":"text"},{"name":"HoTen","type":"text"},{"name":"MaPB","type":"text"},{"name":"MaCT","type":"text"},{"name":"VaoSang","type":"text"},{"name":"RaSang","type":"text"},{"name":"VaoChieu","type":"text"},{"name":"RaChieu","type":"text"},{"name":"BanKinh","type":"numeric"},{"name":"L1","type":"text"},{"name":"L2","type":"text"},{"name":"L3","type":"text"},{"name":"L4","type":"text"},{"name":"L5","type":"text"},{"name":"L6","type":"text"},{"name":"ViTri1","type":"text"},{"name":"KC1","type":"numeric"},{"name":"Anh1","type":"text"},{"name":"ViTri2","type":"text"},{"name":"KC2","type":"numeric"},{"name":"Anh2","type":"text"},{"name":"ViTri3","type":"text"},{"name":"KC3","type":"numeric"},{"name":"Anh3","type":"text"},{"name":"ViTri4","type":"text"},{"name":"KC4","type":"numeric"},{"name":"Anh4","type":"text"},{"name":"ViTri5","type":"text"},{"name":"KC5","type":"numeric"},{"name":"Anh5","type":"text"},{"name":"ViTri6","type":"text"},{"name":"KC6","type":"numeric"},{"name":"Anh6","type":"text"},{"name":"ChiDinhCong","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('BANG_LUONG', '[{"name":"MaBL","type":"text"},{"name":"Nam","type":"numeric"},{"name":"Thang","type":"numeric"},{"name":"MaNV","type":"text"},{"name":"HoTen","type":"text"},{"name":"MaPB","type":"text"},{"name":"Ngach","type":"text"},{"name":"Bac","type":"numeric"},{"name":"MucLuongDM","type":"numeric"},{"name":"Luong1NgayDM","type":"numeric"},{"name":"PhuCapDM","type":"numeric"},{"name":"TongNgayCong","type":"numeric"},{"name":"LuongTheoCong","type":"numeric"},{"name":"NgayPhep","type":"numeric"},{"name":"LuongPhep","type":"numeric"},{"name":"NgayLe","type":"numeric"},{"name":"LuongLe","type":"numeric"},{"name":"PhuCap","type":"numeric"},{"name":"ThuongKhac","type":"numeric"},{"name":"GiamTruKhac","type":"numeric"},{"name":"LuongThucNhan","type":"numeric"},{"name":"GhiChu","type":"text"},{"name":"TrangThai","type":"text"},{"name":"HienThi","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);
select km0_create_sheet('NHOM_PHIEU', '[{"name":"MaPhieu","type":"text"},{"name":"TenPhieu","type":"text"},{"name":"SLChoPhep","type":"numeric"},{"name":"TinhLuong","type":"text"},{"name":"DienGiai","type":"text"}]'::jsonb);
select km0_create_sheet('PHIEU_HANH_CHINH', '[{"name":"MaPH","type":"text"},{"name":"MaNV","type":"text"},{"name":"HoTen","type":"text"},{"name":"MaPB","type":"text"},{"name":"Ngay","type":"date"},{"name":"Sang","type":"text"},{"name":"Chieu","type":"text"},{"name":"LyDo","type":"text"},{"name":"TrangThai","type":"text"},{"name":"QuanLy","type":"text"},{"name":"NgayQL","type":"text"},{"name":"GhiChuQL","type":"text"},{"name":"HCNS","type":"text"},{"name":"NgayHCNS","type":"text"},{"name":"GhiChuHCNS","type":"text"},{"name":"NguoiTao","type":"text"},{"name":"TGTao","type":"text"},{"name":"NguoiCapNhat","type":"text"},{"name":"TGCapNhat","type":"text"}]'::jsonb);

select count(*) as so_bang_km0 from km0_sheets;
