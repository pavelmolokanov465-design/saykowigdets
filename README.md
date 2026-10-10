# SaykoWidgets

## Supabase
1. Новый проект → SQL Editor → выполнить `supabase/schema.sql`.
2. Storage → создать 2 публичных бакета: `widget-images`, `widget-files`.
3. Settings → API → скопировать `Project URL`, `anon public key`, `service_role key`.

## Netlify
1. Задеплоить эту папку как сайт.
2. Site settings → Environment variables:
   - `BOT_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `ADMIN_IDS` (два Telegram ID через запятую)
   - `WEBAPP_URL` (адрес этого же сайта после деплоя)
3. В `public/config.js` вписать `SUPABASE_URL` и `SUPABASE_ANON_KEY`.

## Telegram
```
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<сайт>.netlify.app/bot"
```

## Как работает скачивание
Кнопка скачивания в каталоге открывает диплинк `t.me/<бот>?start=w_<id>` — Telegram сам переходит в чат с ботом и отправляет `/start w_<id>`. Бот распознаёт параметр и присылает файл прямо в чате. Юзеру ничего вручную вводить не нужно.

## Команды бота
- `/start` — открыть мини-аппу
- `/upload` — загрузить виджет (только `ADMIN_IDS`): категория → название → описание → фото → файл
- `/delete` — удалить виджет (только `ADMIN_IDS`): список → выбор → подтверждение
- `/editing` — редактировать виджет (только `ADMIN_IDS`): категория → список → выбор поля (изображение / описание / название / файл) → новое значение
- `/statistics` — статистика бота (только `ADMIN_IDS`): всего пользователей, всего скачиваний
- `/cancel` — отменить текущее действие (загрузку или редактирование)

Ограничение: фото и файл виджета — до 5 МБ каждый. Больше — бот попросит прислать файл поменьше.

⚠️ Для `/statistics` нужна новая таблица `bot_users`, а для `/editing` — таблица `edit_sessions`. Выполни в Supabase SQL Editor:
```sql
create table if not exists bot_users (
  user_id bigint primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table bot_users enable row level security;

create table if not exists edit_sessions (
  admin_id bigint primary key,
  widget_id uuid not null,
  field text not null,
  category text,
  page integer,
  updated_at timestamptz default now()
);
```


