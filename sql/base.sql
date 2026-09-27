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
