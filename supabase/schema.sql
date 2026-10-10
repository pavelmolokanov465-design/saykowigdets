-- SaykoWidgets — схема Supabase

create extension if not exists pgcrypto;

create table if not exists widgets (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('clock','weather','search','lock','other')),
  title text not null,
  description text,
  image_url text not null,
  file_url text not null,
  file_size integer,
  uploaded_by bigint not null,
  downloads_count integer not null default 0,
  created_at timestamptz default now()
);

create table if not exists favorites (
  user_id bigint not null,
  widget_id uuid references widgets(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, widget_id)
);

-- один юзер = одно засчитанное скачивание одного виджета (защита от накрутки счётчика)
create table if not exists downloads (
  user_id bigint not null,
  widget_id uuid references widgets(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, widget_id)
);

-- временное хранилище шагов диалога загрузки виджета (админ)
create table if not exists upload_sessions (
  admin_id bigint primary key,
  step text not null,
  category text,
  title text,
  description text,
  image_url text,
  target_chat_id bigint,
  target_user_id bigint,
  broadcast_offset integer,
  updated_at timestamptz default now()
);

-- временное хранилище шага редактирования виджета (админ)
create table if not exists edit_sessions (
  admin_id bigint primary key,
  widget_id uuid not null,
  field text not null,
  category text,
  page integer,
  updated_at timestamptz default now()
);

-- активность пользователей бота (для /statistics: онлайн + всего пользователей)
create table if not exists bot_users (
  user_id bigint primary key,
  username text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- один чат-лента "предложки" на пользователя
create table if not exists suggestion_chats (
  user_id bigint primary key,
  username text,
  first_name text,
  muted_until timestamptz,
  banned boolean not null default false,
  has_unread_for_admin boolean not null default false,
  has_unread_for_user boolean not null default false,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- сообщения внутри чата предложки
create table if not exists suggestion_messages (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references suggestion_chats(user_id) on delete cascade,
  sender text not null check (sender in ('user', 'admin')),
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists suggestion_messages_user_idx on suggestion_messages(user_id, created_at);

-- антиспам / кулдауны на частые действия (приветствие бота, открытие каталога, навигация по вкладкам)
create table if not exists rate_limits (
  user_id bigint not null,
  action text not null,
  last_at timestamptz not null default now(),
  primary key (user_id, action)
);

-- чаты/группы, куда добавлен бот — для рассылок и блокировки поиска в конкретных чатах
create table if not exists bot_chats (
  chat_id bigint primary key,
  chat_type text,
  title text,
  username text,
  blocked boolean not null default false,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- антиспам: лог нажатий /start (для детекта спама и скоординированных атак)
create table if not exists start_presses (
  id bigserial primary key,
  user_id bigint not null,
  pressed_at timestamptz not null default now()
);
create index if not exists start_presses_time_idx on start_presses(pressed_at);
create index if not exists start_presses_user_idx on start_presses(user_id, pressed_at);

-- атомарно логирует нажатие /start и сразу возвращает счётчик своих нажатий за 60 сек
-- + список юзеров, замешанных в возможной скоординированной атаке — всё одним запросом,
-- чтобы разные параллельные нажатия не гонялись друг с другом за неконсистентные данные
create or replace function check_start_spam(p_user_id bigint)
returns table(own_count bigint, coordinated_offenders bigint[]) as $$
begin
  insert into start_presses (user_id) values (p_user_id);

  return query
  with recent as (
    select sp.user_id as uid from start_presses sp where sp.pressed_at >= now() - interval '60 seconds'
  ),
  counts as (
    select uid, count(*) as c from recent group by uid
  )
  select
    coalesce((select c from counts where uid = p_user_id), 0) as own_count,
    coalesce((select array_agg(uid) from counts where c > 2), '{}'::bigint[]) as coordinated_offenders;
end;
$$ language plpgsql;

-- временные блокировки пользователей (по решению админа из уведомления о подозрительной активности)
create table if not exists banned_users (
  user_id bigint primary key,
  banned_until timestamptz not null,
  reason text,
  banned_by bigint,
  created_at timestamptz not null default now()
);

-- сессии для команды "каталог" в чатах/группах: хранит состояние просмотра
-- (раздел/страница/выбранный виджет) и защищает кнопки от нажатий чужими пользователями
create table if not exists catalog_sessions (
  token text primary key,
  inviter_id bigint not null,
  category text,
  page integer not null default 0,
  selected_widget_id uuid references widgets(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Если таблица widgets уже существует в проде — выполнить отдельно:
-- alter table widgets add column if not exists file_size integer;
-- alter table widgets drop constraint if exists widgets_category_check;
-- alter table widgets add constraint widgets_category_check check (category in ('clock','weather','search','lock','other'));
-- create table if not exists downloads (
--   user_id bigint not null,
--   widget_id uuid references widgets(id) on delete cascade,
--   created_at timestamptz default now(),
--   primary key (user_id, widget_id)
-- );
-- alter table downloads enable row level security;
-- create table if not exists catalog_sessions (
--   token text primary key,
--   inviter_id bigint not null,
--   category text,
--   page integer not null default 0,
--   selected_widget_id uuid references widgets(id) on delete set null,
--   created_at timestamptz not null default now()
-- );
-- alter table catalog_sessions enable row level security;
-- create table if not exists rate_limits (
--   user_id bigint not null,
--   action text not null,
--   last_at timestamptz not null default now(),
--   primary key (user_id, action)
-- );
-- alter table rate_limits enable row level security;
-- alter table upload_sessions add column if not exists target_chat_id bigint;
-- create table if not exists bot_chats (
--   chat_id bigint primary key,
--   chat_type text,
--   title text,
--   username text,
--   blocked boolean not null default false,
--   added_at timestamptz not null default now(),
--   updated_at timestamptz not null default now()
-- );
-- alter table bot_chats enable row level security;
-- alter table upload_sessions add column if not exists target_user_id bigint;
-- alter table upload_sessions add column if not exists broadcast_offset integer;
-- create table if not exists start_presses (
--   id bigserial primary key,
--   user_id bigint not null,
--   pressed_at timestamptz not null default now()
-- );
-- create index if not exists start_presses_time_idx on start_presses(pressed_at);
-- create index if not exists start_presses_user_idx on start_presses(user_id, pressed_at);
-- alter table start_presses enable row level security;
-- create or replace function check_start_spam(p_user_id bigint)
-- returns table(own_count bigint, coordinated_offenders bigint[]) as $$
-- begin
--   insert into start_presses (user_id) values (p_user_id);
--   return query
--   with recent as (
--     select sp.user_id as uid from start_presses sp where sp.pressed_at >= now() - interval '60 seconds'
--   ),
--   counts as (
--     select uid, count(*) as c from recent group by uid
--   )
--   select
--     coalesce((select c from counts where uid = p_user_id), 0) as own_count,
--     coalesce((select array_agg(uid) from counts where c > 2), '{}'::bigint[]) as coordinated_offenders;
-- end;
-- $$ language plpgsql;
-- create table if not exists banned_users (
--   user_id bigint primary key,
--   banned_until timestamptz not null,
--   reason text,
--   banned_by bigint,
--   created_at timestamptz not null default now()
-- );
-- alter table banned_users enable row level security;

alter table widgets enable row level security;
alter table favorites enable row level security;
alter table downloads enable row level security;
alter table bot_users enable row level security;
alter table suggestion_chats enable row level security;
alter table suggestion_messages enable row level security;
alter table catalog_sessions enable row level security;
alter table rate_limits enable row level security;
alter table bot_chats enable row level security;
alter table start_presses enable row level security;
alter table banned_users enable row level security;
-- alter table bot_users add column if not exists username text;
-- bot_users, suggestion_chats, suggestion_messages не читаются и не пишутся публично,
-- только через service_role в Netlify Functions (bot.js, suggestions.js)

-- публичное чтение каталога
create policy "widgets_public_read" on widgets
  for select using (true);

-- избранное читает только сам пользователь (фильтрация на клиенте по user_id из Telegram)
create policy "favorites_public_read" on favorites
  for select using (true);

-- запись в widgets/favorites — только через Netlify Functions с service_role ключом,
-- поэтому политик на insert/update/delete для anon-роли нет.

-- Storage buckets (создать вручную в Supabase Dashboard, оба Public):
--   widget-images  — превью
--   widget-files   — сами .kwgt файлы
