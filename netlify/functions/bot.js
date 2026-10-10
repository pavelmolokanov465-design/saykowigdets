const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const sharp = require('sharp');
const ws = require('ws');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
const SUPER_ADMIN_ID = 8730009321; // единственный, кому доступна /sendgift
const WEBAPP_URL = process.env.WEBAPP_URL;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

const bot = new Telegraf(BOT_TOKEN);

// самая первая проверка — если юзер временно забанен админом, полностью игнорируем его обновления
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try {
    const { data: ban } = await supabase
      .from('banned_users')
      .select('banned_until')
      .eq('user_id', ctx.from.id)
      .maybeSingle();
    if (ban && new Date(ban.banned_until).getTime() > Date.now()) return; // молча игнорируем
  } catch (e) {
    console.error('ban check failed:', e);
  }
  return next();
});

const CATEGORIES = {
  clock: '🕐 Часы',
  weather: '☁️ Погода',
  search: '🔍Поисковая строка',
  lock: '🔒 Экран блокировки',
  other: '✦ Прочие',
};

const isAdmin = (id) => ADMIN_IDS.includes(id);

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 МБ

// ---------- каталог прямо в чате/группе (команда "каталог") ----------
const CATALOG_PAGE_SIZE = 6;
const CATALOG_BANNER_CATEGORIES = `${WEBAPP_URL}/catalog-categories.jpg`;
const CATALOG_BANNER_WIDGETS = `${WEBAPP_URL}/catalog-widgets.jpg`;
const NOT_YOUR_BUTTON = 'Эта кнопка не для тебя — вызови поиск сам командой «поиск».';
const SESSION_EXPIRED = 'Сессия поиска устарела, вызови поиск заново.';

function formatFileSizeBot(bytes) {
  if (!bytes || bytes <= 0) return 'неизвестно';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function genCatalogToken() {
  return crypto.randomBytes(5).toString('hex'); // 10 hex-символов, короткий callback_data
}

async function fetchCatalogPage(category, page) {
  const from = page * CATALOG_PAGE_SIZE;
  const to = from + CATALOG_PAGE_SIZE - 1;
  const { data: widgets, count } = await supabase
    .from('widgets')
    .select('id, title', { count: 'exact' })
    .eq('category', category)
    .order('created_at', { ascending: false })
    .range(from, to);
  return { widgets: widgets || [], count: count || 0 };
}

function sendCatalogCategoriesScreen(ctx, token, edit) {
  const keyboard = Markup.inlineKeyboard([
    ...Object.entries(CATEGORIES).map(([key, label]) => [Markup.button.callback(label, `catg:${token}:${key}`)]),
    [Markup.button.webApp('📂 Открыть каталог', WEBAPP_URL)],
  ]);
  const caption = 'Выберите раздел:';
  if (edit) {
    return ctx.editMessageMedia({ type: 'photo', media: CATALOG_BANNER_CATEGORIES, caption }, keyboard);
  }
  return ctx.replyWithPhoto(CATALOG_BANNER_CATEGORIES, { caption, ...keyboard });
}

async function renderCatalogWidgetList(ctx, token, category, page, isMediaSwitch) {
  const { widgets, count } = await fetchCatalogPage(category, page);
  const totalPages = Math.max(1, Math.ceil(count / CATALOG_PAGE_SIZE));

  let caption;
  let keyboard;
  if (!widgets.length) {
    caption = page === 0
      ? `${CATEGORIES[category]}\n\nВ этом разделе пока нет виджетов.`
      : `${CATEGORIES[category]}\n\nБольше виджетов нет.`;
    keyboard = Markup.inlineKeyboard([[Markup.button.callback('« Назад к разделам', `catb:${token}`)]]);
  } else {
    caption = `${CATEGORIES[category]}\n\nВыберите виджет:`;
    const rows = widgets.map((w, idx) => [Markup.button.callback(w.title, `catw:${token}:${idx}`)]);
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️', `catp:${token}:${category}:${page - 1}`));
    navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'catnoop'));
    if (page + 1 < totalPages) navRow.push(Markup.button.callback('➡️', `catp:${token}:${category}:${page + 1}`));
    rows.push(navRow);
    rows.push([Markup.button.callback('« Назад к разделам', `catb:${token}`)]);
    keyboard = Markup.inlineKeyboard(rows);
  }

  if (isMediaSwitch) {
    return ctx.editMessageMedia({ type: 'photo', media: CATALOG_BANNER_WIDGETS, caption }, keyboard);
  }
  return ctx.editMessageCaption(caption, keyboard);
}

// ---------- helpers для сессии загрузки ----------
async function getSession(adminId) {
  const { data } = await supabase.from('upload_sessions').select('*').eq('admin_id', adminId).maybeSingle();
  return data;
}
async function setSession(adminId, patch) {
  await supabase.from('upload_sessions').upsert({ admin_id: adminId, updated_at: new Date().toISOString(), ...patch });
}
async function clearSession(adminId) {
  await supabase.from('upload_sessions').delete().eq('admin_id', adminId);
}

// ---------- отметка активности пользователя (для /statistics) ----------
async function touchUser(userId, username) {
  try {
    // ON CONFLICT обновит last_seen и username, first_seen (если строка уже есть) не тронется
    await supabase.from('bot_users').upsert(
      { user_id: userId, username: username || null, last_seen: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  } catch (e) {
    console.error('touchUser failed:', e);
  }
}

// ---------- антиспам: кулдаун на частые действия ----------
// возвращает { allowed: true } если действие разрешено (и сразу обновляет метку времени),
// либо { allowed: false, remaining } — сколько секунд ещё осталось ждать
async function checkRateLimit(userId, action, cooldownSeconds) {
  try {
    const { data: row } = await supabase
      .from('rate_limits')
      .select('last_at')
      .eq('user_id', userId)
      .eq('action', action)
      .maybeSingle();

    const now = Date.now();
    if (row) {
      const elapsed = (now - new Date(row.last_at).getTime()) / 1000;
      if (elapsed < cooldownSeconds) {
        return { allowed: false, remaining: Math.ceil(cooldownSeconds - elapsed) };
      }
    }

    await supabase.from('rate_limits').upsert(
      { user_id: userId, action, last_at: new Date().toISOString() },
      { onConflict: 'user_id,action' }
    );
    return { allowed: true };
  } catch (e) {
    console.error('checkRateLimit failed:', e);
    return { allowed: true }; // если БД недоступна — не блокируем пользователя из-за нашей ошибки
  }
}

// ---------- антиспам: оповещение админов о подозрительной активности ----------
// не спамим одинаковыми оповещениями об одном и том же юзере чаще раза в 10 минут
async function flagSuspicious(ctx, targetUserId, reason, targetUsername) {
  const rl = await checkRateLimit(targetUserId, 'suspicious_alert', 600);
  if (!rl.allowed) return;

  const label = targetUsername ? `@${targetUsername}` : `id ${targetUserId}`;
  const text = `⚠️ Замечена подозрительная активность\n\nПользователь: ${label} (id: ${targetUserId})\nПричина: ${reason}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚫 Блокировка', `susp_block:${targetUserId}`)],
    [Markup.button.callback('⏭ Скип', `susp_skip:${targetUserId}`)],
  ]);

  await Promise.all(
    ADMIN_IDS.map((adminId) =>
      ctx.telegram.sendMessage(adminId, text, keyboard).catch((e) => {
        console.error(`[flagSuspicious] notify admin ${adminId} failed:`, e);
      })
    )
  );
}

// автоблокировка — единый механизм для ЛЮБОЙ защиты: если активность перешла явно
// вредительский порог, не ждём решения админа (он может спать), баним сразу сами
// и просто уведомляем постфактум, без кнопок (действие уже применено)
const AUTO_BLOCK_HOURS = 24;

async function autoBlockUser(ctx, targetUserId, reason, targetUsername) {
  const rl = await checkRateLimit(targetUserId, 'suspicious_autoblock', 600);
  if (!rl.allowed) return;

  const bannedUntil = new Date(Date.now() + AUTO_BLOCK_HOURS * 3600 * 1000).toISOString();
  await supabase.from('banned_users').upsert({
    user_id: targetUserId,
    banned_until: bannedUntil,
    reason,
    banned_by: null, // null = заблокировано автоматически, не вручную
  });

  const label = targetUsername ? `@${targetUsername}` : `id ${targetUserId}`;
  const text =
    `🔒 Автоматическая блокировка\n\n` +
    `Пользователь: ${label} (id: ${targetUserId})\n` +
    `Причина: ${reason}\n` +
    `Срок: ${AUTO_BLOCK_HOURS} ч.\n\n` +
    `Если это ошибка — разблокируй командой /banned`;

  await Promise.all(
    ADMIN_IDS.map((adminId) =>
      ctx.telegram.sendMessage(adminId, text).catch((e) => {
        console.error(`[autoBlockUser] notify admin ${adminId} failed:`, e);
      })
    )
  );
}

// оповещение о скоординированной атаке (без привязки к одному юзеру, без кнопок)
async function flagCoordinatedAttack(ctx, offenders) {
  const rl = await checkRateLimit(0, 'suspicious_coordinated', 300);
  if (!rl.allowed) return;

  const list = offenders.map((u) => `• id ${u}`).join('\n');
  const text = `🚨 Похоже на скоординированную атаку\n\nНесколько аккаунтов одновременно много раз нажали /start:\n${list}`;
  await Promise.all(
    ADMIN_IDS.map((adminId) =>
      ctx.telegram.sendMessage(adminId, text).catch((e) => {
        console.error(`[flagCoordinatedAttack] notify admin ${adminId} failed:`, e);
      })
    )
  );
}

// парсит длительность бана вида "24h", "1d" -> количество часов
function parseBanDuration(raw) {
  const match = raw.trim().match(/^(\d+)\s*(h|ч|d|д)$/i);
  if (!match) return null;
  const num = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!num || num <= 0) return null;
  return unit === 'd' || unit === 'д' ? num * 24 : num;
}

bot.use(async (ctx, next) => {
  if (ctx.from) await touchUser(ctx.from.id, ctx.from.username);
  return next();
});

// благодарность за донат — проверяем до всех остальных обработчиков текста
bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.successful_payment) {
    const amount = ctx.message.successful_payment.total_amount;
    await ctx.reply(`Спасибо за поддержку на ${amount} ⭐! Это очень помогает проекту 💛`);

    const donorLabel = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || ctx.from.id);
    const notifyText = `💛 Новый донат!\n\nОт: ${donorLabel} (id: ${ctx.from.id})\nСумма: ${amount} ⭐`;
    for (const adminId of ADMIN_IDS) {
      try {
        await ctx.telegram.sendMessage(adminId, notifyText);
      } catch (e) {
        console.error(`[donate] notify admin ${adminId} failed:`, e);
      }
    }
    return;
  }
  return next();
});

// ---------- приветствие при добавлении бота в группу/чат ----------
bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  if (!update || !ctx.chat) return;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;

  const wasIn = ['member', 'administrator', 'creator'].includes(update.old_chat_member.status);
  const isIn = ['member', 'administrator', 'creator'].includes(update.new_chat_member.status);

  if (wasIn && !isIn) {
    // бота удалили/кикнули из чата — убираем из списка для рассылок
    await supabase.from('bot_chats').delete().eq('chat_id', ctx.chat.id);
    return;
  }
  if (wasIn || !isIn) return; // остальные переходы (например смена прав) нас не интересуют

  // бота только что добавили в чат — запоминаем чат для рассылок/блокировки
  await supabase.from('bot_chats').upsert(
    {
      chat_id: ctx.chat.id,
      chat_type: ctx.chat.type,
      title: ctx.chat.title || null,
      username: ctx.chat.username || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'chat_id', ignoreDuplicates: false }
  );

  const chatName = ctx.chat.username ? `@${ctx.chat.username}` : (ctx.chat.title || 'этот чат');
  try {
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      `Привет, ${chatName}! Я бот по поиску виджетов. Чтобы начать поиск, напишите «поиск».`
    );
  } catch (e) {
    console.error('greet on add to chat failed:', e);
  }
});

bot.command('registerchat', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return ctx.reply('Эта команда работает только внутри группового чата.');
  }
  await supabase.from('bot_chats').upsert(
    {
      chat_id: ctx.chat.id,
      chat_type: ctx.chat.type,
      title: ctx.chat.title || null,
      username: ctx.chat.username || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'chat_id', ignoreDuplicates: false }
  );
  return ctx.reply('Этот чат добавлен в список для рассылок ✅');
});

// ---------- каталог прямо в чате/группе (команда "поиск") ----------
async function startCatalogFlow(ctx) {
  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

  if (!isGroup) {
    return ctx.reply('В личке уже есть кнопка «Открыть каталог» — там удобнее. Команда «поиск» работает в групповых чатах.');
  }

  const chatRow = await supabase.from('bot_chats').select('blocked').eq('chat_id', ctx.chat.id).maybeSingle();
  if (chatRow.data?.blocked) return ctx.reply('Поиск виджетов отключён администратором в этом чате.');

  const cooldown = 30;
  const rl = await checkRateLimit(ctx.from.id, 'catalog_open', cooldown);
  if (!rl.allowed) {
    return ctx.reply(`Не так быстро — подожди ещё ${rl.remaining} сек.`);
  }

  const token = genCatalogToken();
  const { error: sessionError } = await supabase.from('catalog_sessions').insert({ token, inviter_id: ctx.from.id });
  if (sessionError) {
    console.error('[catalog_sessions] insert failed:', sessionError);
    return ctx.reply('Не получилось открыть поиск, попробуй ещё раз через пару секунд.');
  }
  return sendCatalogCategoriesScreen(ctx, token, false);
}

bot.command('search', startCatalogFlow);
bot.hears(/^поиск(@\w+)?$/i, startCatalogFlow);

bot.action('catnoop', (ctx) => ctx.answerCbQuery());

bot.action(/^catg:([0-9a-f]{10}):(\w+)$/, async (ctx) => {
  const [, token, category] = ctx.match;
  const { data: session } = await supabase.from('catalog_sessions').select('*').eq('token', token).maybeSingle();
  if (!session) return ctx.answerCbQuery(SESSION_EXPIRED, { show_alert: true });
  if (session.inviter_id !== ctx.from.id) return ctx.answerCbQuery(NOT_YOUR_BUTTON, { show_alert: true });
  if (!CATEGORIES[category]) return ctx.answerCbQuery();

  const rl = await checkRateLimit(ctx.from.id, 'catalog_nav', 2);
  if (!rl.allowed) return ctx.answerCbQuery(`Не так быстро — подожди ${rl.remaining} сек.`);

  await supabase.from('catalog_sessions').update({ category, page: 0, selected_widget_id: null }).eq('token', token);
  await ctx.answerCbQuery();
  return renderCatalogWidgetList(ctx, token, category, 0, true);
});

bot.action(/^catp:([0-9a-f]{10}):(\w+):(\d+)$/, async (ctx) => {
  const [, token, category, pageStr] = ctx.match;
  const page = Number(pageStr);
  const { data: session } = await supabase.from('catalog_sessions').select('*').eq('token', token).maybeSingle();
  if (!session) return ctx.answerCbQuery(SESSION_EXPIRED, { show_alert: true });
  if (session.inviter_id !== ctx.from.id) return ctx.answerCbQuery(NOT_YOUR_BUTTON, { show_alert: true });

  const rl = await checkRateLimit(ctx.from.id, 'catalog_nav', 2);
  if (!rl.allowed) return ctx.answerCbQuery(`Не так быстро — подожди ${rl.remaining} сек.`);

  await supabase.from('catalog_sessions').update({ page }).eq('token', token);
  await ctx.answerCbQuery();
  return renderCatalogWidgetList(ctx, token, category, page, false);
});

bot.action(/^catb:([0-9a-f]{10})$/, async (ctx) => {
  const [, token] = ctx.match;
  const { data: session } = await supabase.from('catalog_sessions').select('*').eq('token', token).maybeSingle();
  if (!session) return ctx.answerCbQuery(SESSION_EXPIRED, { show_alert: true });
  if (session.inviter_id !== ctx.from.id) return ctx.answerCbQuery(NOT_YOUR_BUTTON, { show_alert: true });

  const rl = await checkRateLimit(ctx.from.id, 'catalog_nav', 2);
  if (!rl.allowed) return ctx.answerCbQuery(`Не так быстро — подожди ${rl.remaining} сек.`);

  await supabase.from('catalog_sessions').update({ category: null, page: 0, selected_widget_id: null }).eq('token', token);
  await ctx.answerCbQuery();
  return sendCatalogCategoriesScreen(ctx, token, true);
});

bot.action(/^catw:([0-9a-f]{10}):(\d+)$/, async (ctx) => {
  const [, token, idxStr] = ctx.match;
  const idx = Number(idxStr);
  const { data: session } = await supabase.from('catalog_sessions').select('*').eq('token', token).maybeSingle();
  if (!session) return ctx.answerCbQuery(SESSION_EXPIRED, { show_alert: true });
  if (session.inviter_id !== ctx.from.id) return ctx.answerCbQuery(NOT_YOUR_BUTTON, { show_alert: true });
  if (!session.category) return ctx.answerCbQuery();

  const { widgets } = await fetchCatalogPage(session.category, session.page);
  const picked = widgets[idx];
  if (!picked) return ctx.answerCbQuery('Виджет не найден, попробуй снова.', { show_alert: true });

  const { data: widget } = await supabase
    .from('widgets')
    .select('id, title, description, image_url, file_size, downloads_count')
    .eq('id', picked.id)
    .maybeSingle();
  if (!widget) return ctx.answerCbQuery('Виджет не найден.', { show_alert: true });

  await supabase.from('catalog_sessions').update({ selected_widget_id: widget.id }).eq('token', token);
  await ctx.answerCbQuery();

  const caption =
    `${widget.title}\n\n` +
    `${widget.description || ''}\n\n` +
    `📦 Размер: ${formatFileSizeBot(widget.file_size)}\n` +
    `⬇️ Загрузок: ${widget.downloads_count || 0}`;

  return ctx.editMessageMedia(
    { type: 'photo', media: `${WEBAPP_URL}/api/image?id=${widget.id}`, caption },
    Markup.inlineKeyboard([
      [Markup.button.url('📥 Установить', `${WEBAPP_URL}/api/file?id=${widget.id}`)],
      [Markup.button.callback('« Назад к виджетам', `catback2list:${token}`)],
    ])
  );
});

bot.action(/^catback2list:([0-9a-f]{10})$/, async (ctx) => {
  const [, token] = ctx.match;
  const { data: session } = await supabase.from('catalog_sessions').select('*').eq('token', token).maybeSingle();
  if (!session) return ctx.answerCbQuery(SESSION_EXPIRED, { show_alert: true });
  if (session.inviter_id !== ctx.from.id) return ctx.answerCbQuery(NOT_YOUR_BUTTON, { show_alert: true });
  if (!session.category) return ctx.answerCbQuery();

  const rl = await checkRateLimit(ctx.from.id, 'catalog_nav', 2);
  if (!rl.allowed) return ctx.answerCbQuery(`Не так быстро — подожди ${rl.remaining} сек.`);

  await ctx.answerCbQuery();
  return renderCatalogWidgetList(ctx, token, session.category, session.page, true);
});

// ---------- /start ----------
bot.start(async (ctx) => {
  // ---------- антиспам: логируем нажатие и проверяем паттерны злоупотребления ----------
  // админы исключены — иначе собственное тестирование (много быстрых /start подряд)
  // может случайно заблокировать самого админа
  if (!isAdmin(ctx.from.id)) try {
    // один атомарный запрос вместо insert+count+select по отдельности —
    // так параллельные быстрые нажатия не гоняются друг с другом за неконсистентные данные
    const { data: spamCheck } = await supabase.rpc('check_start_spam', { p_user_id: ctx.from.id });
    const row = spamCheck && spamCheck[0];
    let myPresses = row ? Number(row.own_count) : 0;
    const offenders = row && row.coordinated_offenders ? row.coordinated_offenders : [];

    const AUTO_BLOCK_THRESHOLD = 15;
    const ALERT_THRESHOLD = 5;

    if (myPresses > ALERT_THRESHOLD) {
      // при пачке почти одновременных нажатий параллельные вызовы ещё не видят друг друга —
      // короткая пауза даёт соседним вставкам долиться в базу, чтобы решение и цифра в
      // уведомлении были точными, а не снимком на середине всплеска
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { count: recheck } = await supabase
        .from('start_presses')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', ctx.from.id)
        .gte('pressed_at', new Date(Date.now() - 60 * 1000).toISOString());
      if (typeof recheck === 'number') myPresses = recheck;
    }

    if (myPresses >= AUTO_BLOCK_THRESHOLD) {
      // явный вред — не ждём решения админа, блокируем сразу и просто уведомляем.
      // отдельный кулдаун от flagSuspicious — чтобы ранее отправленный "мягкий" алерт
      // не мешал более позднему вызову эскалировать до автоблока
      await autoBlockUser(
        ctx,
        ctx.from.id,
        `нажал /start ${myPresses} раз за минуту (автоблок)`,
        ctx.from.username
      );
    } else if (myPresses > ALERT_THRESHOLD) {
      await flagSuspicious(
        ctx,
        ctx.from.id,
        `нажал /start ${myPresses} раз за последнюю минуту`,
        ctx.from.username
      );
    }

    if (offenders.length > 2) {
      await flagCoordinatedAttack(ctx, offenders);
    }
  } catch (e) {
    console.error('[antispam] /start tracking failed:', e);
  }

  const payload = ctx.startPayload; // например "w_<uuid>", когда переход был по ссылке на скачивание

  if (payload && payload.startsWith('w_')) {
    const widgetId = payload.slice(2);
    const { data: widget } = await supabase
      .from('widgets')
      .select('title, file_url, downloads_count')
      .eq('id', widgetId)
      .maybeSingle();

    if (widget) {
      await ctx.replyWithDocument(`${WEBAPP_URL}/api/file?id=${widgetId}`, { caption: widget.title });
      await supabase.from('widgets').update({ downloads_count: widget.downloads_count + 1 }).eq('id', widgetId);
      return;
    }
    // если виджет не найден — просто показываем обычное приветствие ниже
  }

  const rl = await checkRateLimit(ctx.from.id, 'greeting', 15);
  if (!rl.allowed) return; // не спамим приветствием чаще раза в 15 секунд

  try {
    await ctx.replyWithPhoto(
      `${WEBAPP_URL}/welcome-banner.jpg`,
      {
        caption: 'SaykoWidgets — каталог KWGT-виджетов.\nОткрой каталог кнопкой ниже.',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('📂 Открыть каталог', WEBAPP_URL)],
          [Markup.button.callback('💛 Поддержать проект', 'donate_menu')],
          [Markup.button.callback('📡 Статус бота', 'status')],
        ]),
      }
    );
  } catch (e) {
    console.error('welcome banner send failed:', e);
    await ctx.reply(
      'SaykoWidgets — каталог KWGT-виджетов.\nОткрой каталог кнопкой ниже.',
      Markup.inlineKeyboard([
        [Markup.button.webApp('📂 Открыть каталог', WEBAPP_URL)],
        [Markup.button.callback('💛 Поддержать проект', 'donate_menu')],
        [Markup.button.callback('📡 Статус бота', 'status')],
      ])
    );
  }

  if (isAdmin(ctx.from.id)) {
    const name = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    await ctx.reply(
      `привет ${name} админ.\n` +
      `команды:\n` +
      `/delete-удалить пост\n` +
      `/upload-добавить пост\n` +
      `/compressimages-сжать уже загруженные картинки\n` +
      `/message-рассылка (ответом на сообщение)\n` +
      `/mess @чат текст-быстрая отправка в чат\n` +
      `/registerchat-добавить текущий чат в список рассылки\n` +
      `/banned-список заблокированных, разблокировка\n` +
      `/balance-баланс звёзд бота\n` +
      `/statistics-статистика бота\n` +
      `удачи.не потужничай тут`
    );
  }
});

// ---------- статус бота/мини-аппа/бд ----------
bot.action('status', async (ctx) => {
  await ctx.answerCbQuery('Проверяю...');

  // бот активен — раз этот код выполняется, значит webhook дошёл, бот жив
  const botOk = true;

  // мини-апп (Netlify) — быстрый HEAD-запрос к сайту
  let webappOk = false;
  try {
    const res = await fetch(WEBAPP_URL, { method: 'HEAD' });
    webappOk = res.ok;
  } catch (e) {
    webappOk = false;
  }

  // база данных — самый лёгкий запрос: без данных, только заголовок с count
  let dbOk = false;
  try {
    const { error } = await supabase.from('widgets').select('id', { count: 'exact', head: true });
    dbOk = !error;
  } catch (e) {
    dbOk = false;
  }

  const icon = (ok) => (ok ? '🟢' : '🔴');
  const text =
    `${icon(botOk)} бот активен\n` +
    `${icon(webappOk)} мини апп активен\n` +
    `${icon(dbOk)} база данных активна`;

  await ctx.reply(text);
});

// ---------- поддержка проекта (донат звёздами) ----------
const DONATE_PRESETS = [15, 25, 50, 100];

bot.action('donate_menu', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    'Выбери сумму поддержки в звёздах ⭐:',
    Markup.inlineKeyboard([
      DONATE_PRESETS.map((n) => Markup.button.callback(`${n}⭐`, `donate:${n}`)),
      [Markup.button.callback('💬 Другая сумма', 'donate_custom')],
    ])
  );
});

async function sendDonateInvoice(ctx, amount) {
  return ctx.replyWithInvoice({
    title: 'Поддержка SaykoWidgets',
    description: `Спасибо за поддержку проекта на ${amount} ⭐!`,
    payload: `donate_${amount}_${ctx.from.id}_${Date.now()}`,
    provider_token: '', // для звёзд (XTR) провайдер не нужен
    currency: 'XTR',
    prices: [{ label: 'Поддержка проекта', amount }],
  });
}

bot.action(/^donate:(\d+)$/, async (ctx) => {
  const amount = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  try {
    await sendDonateInvoice(ctx, amount);
  } catch (e) {
    console.error('[donate] invoice failed:', e);
    await ctx.reply('Не получилось выставить счёт, попробуй ещё раз.');
  }
});

bot.action('donate_custom', async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { step: 'donate_amount' });
  return ctx.reply('Напиши сумму в звёздах (число от 1 до 10000):\n\n/cancel - отмена действия');
});

// Telegram требует ответить на pre_checkout_query в течение 10 секунд, иначе платёж не пройдёт
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch (e) {
    console.error('[donate] pre_checkout_query failed:', e);
  }
});

// ---------- /sendgift — скрытая команда, доступна и видна только SUPER_ADMIN_ID ----------
bot.command('sendgift', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN_ID) return; // остальные не получают вообще никакого ответа

  // /sendgift @username текст подписи — подпись сразу в команде, подарок выбирается кнопками
  const match = ctx.message.text.match(/^\/sendgift(?:@\w+)?\s+@(\S+)\s+([\s\S]+)$/i);
  if (match) {
    const [, username, caption] = match;

    const { data: user } = await supabase.from('bot_users').select('user_id').ilike('username', username).maybeSingle();
    if (!user) {
      return ctx.reply(`Не нашёл @${username} среди тех, кто писал боту — подарить можно только тем, кто хотя бы раз запускал бота.`);
    }

    let gifts;
    try {
      const res = await ctx.telegram.callApi('getAvailableGifts', {});
      gifts = res.gifts || [];
    } catch (e) {
      console.error('[sendgift] getAvailableGifts failed:', e);
      return ctx.reply('Не удалось получить список подарков: ' + e.message);
    }
    if (!gifts.length) return ctx.reply('Подарки сейчас недоступны.');

    await setSession(ctx.from.id, {
      step: 'gift_target_ready',
      target_user_id: user.user_id,
      description: caption.slice(0, 128),
    });

    const rows = gifts.map((g) => [Markup.button.callback(`${g.sticker?.emoji || '🎁'} ${g.star_count}⭐`, `giftsend:${g.id}`)]);
    return ctx.reply(`Выбери подарок для @${username}:`, Markup.inlineKeyboard(rows));
  }

  // без аргументов — старое поведение: выбрать подарок кнопками и отправить себе
  let gifts;
  try {
    const res = await ctx.telegram.callApi('getAvailableGifts', {});
    gifts = res.gifts || [];
  } catch (e) {
    console.error('[sendgift] getAvailableGifts failed:', e);
    return ctx.reply('Не удалось получить список подарков: ' + e.message);
  }
  if (!gifts.length) return ctx.reply('Подарки сейчас недоступны.');

  const rows = gifts.map((g) => [Markup.button.callback(`${g.sticker?.emoji || '🎁'} ${g.star_count}⭐`, `selfgift:${g.id}`)]);
  return ctx.reply('Выбери подарок для отправки себе:', Markup.inlineKeyboard(rows));
});

bot.action(/^giftsend:(.+)$/, async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN_ID) return ctx.answerCbQuery();
  const giftId = ctx.match[1];
  const session = await getSession(ctx.from.id);
  if (!session || session.step !== 'gift_target_ready') {
    return ctx.answerCbQuery('Сессия устарела, начни заново через /sendgift.', { show_alert: true });
  }
  const targetUserId = session.target_user_id;
  const caption = session.description;
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery('Отправляю...');
  try {
    await ctx.telegram.callApi('sendGift', { user_id: targetUserId, gift_id: giftId, text: caption || undefined });
    return ctx.reply('Подарок отправлен ✅');
  } catch (e) {
    console.error('[giftsend] sendGift failed:', e);
    return ctx.reply('Не получилось отправить подарок: ' + e.message);
  }
});

// ---------- /balance — баланс звёзд бота ----------
bot.command('balance', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    const result = await ctx.telegram.callApi('getMyStarBalance', {});
    const amount = result.amount || 0;
    return ctx.reply(`Баланс бота: ${amount} ⭐`);
  } catch (e) {
    console.error('[balance] getMyStarBalance failed:', e);
    return ctx.reply('Не удалось получить баланс: ' + e.message);
  }
});

// ---------- /gifts — список доступных подарков с эмодзи и ценой ----------
bot.command('gifts', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN_ID) return;

  let gifts;
  try {
    const res = await ctx.telegram.callApi('getAvailableGifts', {});
    gifts = res.gifts || [];
  } catch (e) {
    return ctx.reply('Не удалось получить список подарков: ' + e.message);
  }
  if (!gifts.length) return ctx.reply('Подарки сейчас недоступны.');

  const list = gifts.map((g) => `${g.sticker?.emoji || '🎁'} — ${g.star_count}⭐`).join('\n');
  return ctx.reply(`Доступные подарки и их цена:\n\n${list}\n\nЧтобы подарить: /sendgift @username текст подписи`);
});

// ---------- /balance — текущий баланс звёзд бота ----------
bot.command('balance', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN_ID) return;

  try {
    const result = await ctx.telegram.callApi('getMyStarBalance', {});
    return ctx.reply(`💰 Баланс бота: ${result.amount} ⭐`);
  } catch (e) {
    console.error('[balance] getMyStarBalance failed:', e);
    return ctx.reply('Не удалось получить баланс: ' + e.message);
  }
});

bot.action(/^selfgift:(.+)$/, async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN_ID) return ctx.answerCbQuery();
  const giftId = ctx.match[1];
  await setSession(ctx.from.id, { step: 'gift_caption', description: giftId });
  await ctx.answerCbQuery();
  return ctx.reply('Добавь подпись к подарку (до 128 символов) или пришли /skip, чтобы отправить без подписи.\n\n/cancel - отмена действия');
});

bot.action(/^susp_skip:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery('Пропущено');
  return ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n— Пропущено админом ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}`);
});

// ---------- /banned (только админы) — список заблокированных с возможностью разблокировать ----------
function formatBanDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function renderBannedList(ctx, edit) {
  const { data: bans } = await supabase
    .from('banned_users')
    .select('*')
    .gt('banned_until', new Date().toISOString())
    .order('banned_until', { ascending: true });

  if (!bans || !bans.length) {
    const text = 'Заблокированных пользователей нет.';
    return edit ? ctx.editMessageText(text) : ctx.reply(text);
  }

  const rows = bans.map((b) => [
    Markup.button.callback(`id ${b.user_id} — до ${formatBanDate(b.banned_until)}`, `banview:${b.user_id}`),
  ]);
  const text = 'Заблокированные пользователи:';
  const keyboard = Markup.inlineKeyboard(rows);
  return edit ? ctx.editMessageText(text, keyboard) : ctx.reply(text, keyboard);
}

bot.command('banned', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  return renderBannedList(ctx, false);
});

bot.action('banlist', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  return renderBannedList(ctx, true);
});

bot.action(/^banview:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const userId = Number(ctx.match[1]);
  const { data: ban } = await supabase.from('banned_users').select('*').eq('user_id', userId).maybeSingle();
  if (!ban) return ctx.answerCbQuery('Уже разблокирован или не найден.', { show_alert: true });

  await ctx.answerCbQuery();
  const text =
    `id ${userId}\n` +
    `Причина: ${ban.reason || '—'}\n` +
    `Заблокирован до: ${formatBanDate(ban.banned_until)}\n` +
    `Кем: ${ban.banned_by ? `админ ${ban.banned_by}` : 'автоматически'}`;
  return ctx.editMessageText(
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Разблокировать', `banunlock:${userId}`)],
      [Markup.button.callback('« Назад к списку', 'banlist')],
    ])
  );
});

bot.action(/^banunlock:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const userId = Number(ctx.match[1]);
  await supabase.from('banned_users').delete().eq('user_id', userId);
  // чистим историю нажатий и кулдауны алертов — иначе повторный тестовый /start
  // сразу после разблокировки попадёт в то же скользящее окно и перезабанит юзера снова
  await supabase.from('start_presses').delete().eq('user_id', userId);
  await supabase.from('rate_limits').delete().eq('user_id', userId).in('action', ['suspicious_alert', 'suspicious_autoblock']);
  await ctx.answerCbQuery('Разблокирован ✅');
  return ctx.editMessageText(`id ${userId} разблокирован ✅`);
});

bot.action(/^susp_block:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const targetUserId = Number(ctx.match[1]);

  // подтягиваем причину из исходного алерта как значение по умолчанию
  const msgText = (ctx.callbackQuery.message && ctx.callbackQuery.message.text) || '';
  const reasonMatch = msgText.match(/Причина:\s*([^\n]+)/);
  const defaultReason = reasonMatch ? reasonMatch[1].trim() : 'подозрительная активность';

  await setSession(ctx.from.id, { step: 'ban_duration', target_user_id: targetUserId, description: defaultReason });
  await ctx.answerCbQuery();
  return ctx.reply(
    `На сколько заблокировать и с какой причиной?\nФормат: <срок> <причина>\nПример: 24h спам кнопками\n\n` +
    `Если не укажешь причину — будет использована: «${defaultReason}»\n\n/cancel - отмена действия`
  );
});

// ---------- /upload (только админы) ----------
bot.command('upload', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await clearSession(ctx.from.id);
  await setSession(ctx.from.id, { step: 'category' });
  return ctx.reply(
    'Выбери категорию:\n\n/cancel - отмена действия',
    Markup.inlineKeyboard(
      Object.entries(CATEGORIES).map(([key, label]) => [Markup.button.callback(label, `cat:${key}`)])
    )
  );
});

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx.from.id) && ctx.from.id !== SUPER_ADMIN_ID) return;
  await clearSession(ctx.from.id);
  return ctx.reply('Действие отменено.');
});

bot.action(/^cat:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const category = ctx.match[1];
  await setSession(ctx.from.id, { step: 'title', category });
  await ctx.answerCbQuery();
  return ctx.reply(`Категория: ${CATEGORIES[category]}\n\nОтправь название виджета:\n\n/cancel - отмена действия`);
});


// подпись к подарку — проверяем именно SUPER_ADMIN_ID, а не общий ADMIN_IDS
bot.on('text', async (ctx, next) => {
  const session = await getSession(ctx.from.id);
  if (!session || session.step !== 'gift_caption' || ctx.from.id !== SUPER_ADMIN_ID) return next();

  const giftId = session.description;
  const raw = ctx.message.text.trim();
  const caption = raw === '/skip' ? undefined : raw.slice(0, 128);
  await clearSession(ctx.from.id);

  try {
    await ctx.telegram.callApi('sendGift', { user_id: SUPER_ADMIN_ID, gift_id: giftId, text: caption });
    return ctx.reply('Подарок отправлен ✅');
  } catch (e) {
    console.error('[selfgift] sendGift failed:', e);
    return ctx.reply('Не получилось отправить подарок: ' + e.message);
  }
});

// ---------- приём текста/фото/документа в рамках сессии ----------
// ввод произвольной суммы доната — работает для ЛЮБОГО пользователя, не только админов
bot.on('text', async (ctx, next) => {
  const session = await getSession(ctx.from.id);
  if (!session || session.step !== 'donate_amount') return next();

  const raw = ctx.message.text.trim();
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10000) {
    return ctx.reply('Введи целое число от 1 до 10000.\n\n/cancel - отмена действия');
  }

  await clearSession(ctx.from.id);
  try {
    await sendDonateInvoice(ctx, amount);
  } catch (e) {
    console.error('[donate] custom invoice failed:', e);
    await ctx.reply('Не получилось выставить счёт, попробуй ещё раз.');
  }
});

bot.on(['text', 'photo', 'document'], async (ctx, next) => {
  if (!isAdmin(ctx.from.id)) return next();
  const session = await getSession(ctx.from.id);
  if (!session) return next();

  if (session.step === 'ban_duration' && ctx.message.text) {
    const raw = ctx.message.text.trim();
    const spaceIdx = raw.indexOf(' ');
    const durationPart = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
    const reasonPart = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim();

    const hours = parseBanDuration(durationPart);
    if (!hours) {
      return ctx.reply('Не понял формат. Пример: 24h спам или просто 1d.\n\n/cancel - отмена действия');
    }
    const targetUserId = session.target_user_id;
    const reason = reasonPart || session.description || 'подозрительная активность';
    await clearSession(ctx.from.id);

    const bannedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    await supabase.from('banned_users').upsert({
      user_id: targetUserId,
      banned_until: bannedUntil,
      reason,
      banned_by: ctx.from.id,
    });
    return ctx.reply(`Пользователь ${targetUserId} заблокирован на ${hours} ч.\nПричина: ${reason} ✅`);
  }

  if (session.step === 'title' && ctx.message.text) {
    await setSession(ctx.from.id, { step: 'description', title: ctx.message.text });
    return ctx.reply('Теперь отправь описание виджета:\n\n/cancel - отмена действия');
  }

  if (session.step === 'description' && ctx.message.text) {
    await setSession(ctx.from.id, { step: 'image', description: ctx.message.text });
    return ctx.reply('Пришли фото/скриншот виджета:\n\n/cancel - отмена действия');
  }

  if (session.step === 'image' && ctx.message.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (photo.file_size && photo.file_size > MAX_FILE_BYTES) {
      return ctx.reply('Файл фото больше 5 МБ. Пришли фото поменьше.\n\n/cancel - отмена действия');
    }
    const fileId = photo.file_id;
    const link = await ctx.telegram.getFileLink(fileId);
    const rawBuf = Buffer.from(await (await fetch(link.href)).arrayBuffer());
    if (rawBuf.length > MAX_FILE_BYTES) {
      return ctx.reply('Файл фото больше 5 МБ. Пришли фото поменьше.\n\n/cancel - отмена действия');
    }
    // сжимаем превью перед загрузкой, чтобы экономить трафик Supabase Storage (egress)
    // при каждом просмотре виджета в каталоге
    let buf;
    try {
      buf = await sharp(rawBuf).resize(900, null, { withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    } catch (e) {
      buf = rawBuf; // если сжатие вдруг не удалось — грузим оригинал, лучше так чем упасть
    }
    const path = `${Date.now()}_${ctx.from.id}.jpg`;
    const { error } = await supabase.storage.from('widget-images').upload(path, buf, {
      contentType: 'image/jpeg',
      cacheControl: '31536000', // год — картинка виджета после загрузки не меняется, снижает повторный egress
    });
    if (error) return ctx.reply('Ошибка загрузки фото, попробуй снова.\n\n/cancel - отмена действия');
    const { data: pub } = supabase.storage.from('widget-images').getPublicUrl(path);
    await setSession(ctx.from.id, { step: 'file', image_url: pub.publicUrl });
    return ctx.reply('Теперь пришли сам файл виджета (.kwgt):\n\n/cancel - отмена действия');
  }

  if (session.step === 'file' && ctx.message.document) {
    const doc = ctx.message.document;
    if (doc.file_size && doc.file_size > MAX_FILE_BYTES) {
      return ctx.reply('Файл виджета больше 5 МБ. Пришли файл поменьше.\n\n/cancel - отмена действия');
    }
    const fileId = doc.file_id;
    const fileName = doc.file_name || `${Date.now()}.kwgt`;
    const link = await ctx.telegram.getFileLink(fileId);
    const buf = Buffer.from(await (await fetch(link.href)).arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) {
      return ctx.reply('Файл виджета больше 5 МБ. Пришли файл поменьше.\n\n/cancel - отмена действия');
    }
    const path = `${Date.now()}_${fileName}`;
    const { error } = await supabase.storage.from('widget-files').upload(path, buf, {
      cacheControl: '31536000', // год — файл после загрузки не меняется
    });
    if (error) return ctx.reply('Ошибка загрузки файла, попробуй снова.\n\n/cancel - отмена действия');
    const { data: pub } = supabase.storage.from('widget-files').getPublicUrl(path);

    await supabase.from('widgets').insert({
      category: session.category,
      title: session.title,
      description: session.description,
      image_url: session.image_url,
      file_url: pub.publicUrl,
      file_size: buf.length,
      uploaded_by: ctx.from.id,
    });
    await clearSession(ctx.from.id);
    return ctx.reply(`Готово. Виджет «${session.title}» опубликован в категории ${CATEGORIES[session.category]}.`);
  }

  return next();
});

// ---------- /delete (только админы) ----------
function storagePathFromUrl(publicUrl, bucket) {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  return idx === -1 ? null : publicUrl.slice(idx + marker.length);
}

const DELETE_PAGE_SIZE = 5;

async function renderDeleteList(ctx, category, page, edit) {
  const from = page * DELETE_PAGE_SIZE;
  const to = from + DELETE_PAGE_SIZE - 1;

  let query = supabase
    .from('widgets')
    .select('id, title, category', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (category !== 'all') query = query.eq('category', category);

  const { data: widgets, count } = await query;
  const text = 'Выбери виджет для удаления:\n\n/cancel - отмена действия';

  if (!widgets || !widgets.length) {
    const emptyText = page === 0 ? 'В этой категории нет виджетов.' : 'Больше виджетов нет.';
    return edit ? ctx.editMessageText(emptyText) : ctx.reply(emptyText);
  }

  const totalPages = Math.max(1, Math.ceil((count || widgets.length) / DELETE_PAGE_SIZE));
  const rows = widgets.map((w) => [Markup.button.callback(`${CATEGORIES[w.category] || ''} ${w.title}`, `delwgt:${w.id}:${category}:${page}`)]);

  const navRow = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️', `delcat:${category}:${page - 1}`));
  navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'delnoop'));
  if (page + 1 < totalPages) navRow.push(Markup.button.callback('➡️', `delcat:${category}:${page + 1}`));
  rows.push(navRow);

  const markup = Markup.inlineKeyboard(rows);
  return edit ? ctx.editMessageText(text, markup) : ctx.reply(text, markup);
}

// ---------- /compressimages (только админы) — сжимает уже загруженные превью виджетов ----------
const COMPRESS_BATCH_SIZE = 8; // за один вызов команды, чтобы не упереться в таймаут функции
const ALREADY_SMALL_BYTES = 90 * 1024; // если файл уже меньше — скорее всего уже сжат, пропускаем без скачивания

bot.command('compressimages', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const { data: widgets, error } = await supabase.from('widgets').select('id, title, image_url');
  if (error) return ctx.reply('Не удалось получить список виджетов: ' + error.message);
  if (!widgets || !widgets.length) return ctx.reply('Виджетов пока нет.');

  // одним запросом узнаём текущий размер каждого файла в сторадже — без скачивания содержимого,
  // чтобы не тратить лишний egress на уже сжатые картинки при повторном запуске команды
  const { data: fileList } = await supabase.storage.from('widget-images').list('', { limit: 1000 });
  const sizeByPath = new Map((fileList || []).map((f) => [f.name, f.metadata?.size || 0]));

  const candidates = widgets.filter((w) => {
    const path = storagePathFromUrl(w.image_url, 'widget-images');
    if (!path) return false;
    const size = sizeByPath.get(path);
    return size === undefined || size > ALREADY_SMALL_BYTES;
  });

  if (!candidates.length) {
    return ctx.reply('Все картинки уже сжаты, делать нечего ✅');
  }

  const batch = candidates.slice(0, COMPRESS_BATCH_SIZE);
  const remaining = candidates.length - batch.length;

  const statusMsg = await ctx.reply(`Сжимаю картинки: 0/${batch.length}...`);

  let done = 0;
  let savedBytes = 0;
  let failed = 0;

  for (const widget of batch) {
    try {
      const path = storagePathFromUrl(widget.image_url, 'widget-images');
      const res = await fetch(widget.image_url);
      if (!res.ok) { failed++; continue; }
      const before = Buffer.from(await res.arrayBuffer());

      const after = await sharp(before).resize(900, null, { withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();

      // перезаписываем по тому же пути — ссылка в базе не меняется, ничего обновлять не нужно
      const { error: uploadError } = await supabase.storage.from('widget-images').upload(path, after, {
        contentType: 'image/jpeg',
        cacheControl: '31536000',
        upsert: true,
      });
      if (uploadError) { failed++; continue; }

      if (after.length < before.length) savedBytes += before.length - after.length;
      done++;
    } catch (e) {
      console.error(`[compressimages] widget ${widget.id} failed:`, e);
      failed++;
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `Сжимаю картинки: ${done + failed}/${batch.length}...`
      );
    } catch (e) { /* игнорируем, если текст не изменился */ }
  }

  const savedMb = (savedBytes / (1024 * 1024)).toFixed(2);
  const tail = remaining > 0
    ? `\n\nОсталось ещё ${remaining} — пришли /compressimages ещё раз, чтобы обработать их.`
    : '';
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    undefined,
    `Готово ✅\n\nОбработано: ${done}\nОшибок: ${failed}\nОсвобождено места: ${savedMb} МБ${tail}`
  );
});

// ---------- /message (только админы) — рассылка по чатам, где есть бот ----------
function extractBroadcastContent(msg) {
  if (!msg) return null;
  if (msg.photo && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { type: 'photo', fileId: largest.file_id, caption: msg.caption || '' };
  }
  if (msg.sticker) {
    return { type: 'sticker', fileId: msg.sticker.file_id };
  }
  if (msg.text) {
    return { type: 'text', text: msg.text };
  }
  return null;
}

function sessionToBroadcastContent(session) {
  if (session.broadcast_type === 'photo') {
    return { type: 'photo', fileId: session.broadcast_file_id, caption: session.description || '' };
  }
  if (session.broadcast_type === 'sticker') {
    return { type: 'sticker', fileId: session.broadcast_file_id };
  }
  return { type: 'text', text: session.description || '' };
}

async function sendBroadcastContent(telegram, chatId, content) {
  if (content.type === 'photo') {
    return telegram.sendPhoto(chatId, content.fileId, content.caption ? { caption: content.caption } : {});
  }
  if (content.type === 'sticker') {
    return telegram.sendSticker(chatId, content.fileId);
  }
  return telegram.sendMessage(chatId, content.text);
}

bot.command('message', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const content = extractBroadcastContent(ctx.message.reply_to_message);
  if (!content) {
    return ctx.telegram.sendMessage(
      ctx.from.id,
      'Сначала пришли сообщение, которое хочешь разослать (текст, картинку, картинку с подписью или стикер), а потом ответь на него этой командой (/message).'
    );
  }

  await setSession(ctx.from.id, {
    step: 'broadcast_ready',
    broadcast_type: content.type,
    broadcast_file_id: content.fileId || null,
    description: content.type === 'photo' ? content.caption : (content.text || ''),
  });

  // отвечаем строго в личку — /message могли вызвать ответом на сообщение внутри
  // группового чата, а весь дальнейший диалог по рассылке должен идти только админу
  return ctx.telegram.sendMessage(
    ctx.from.id,
    'Что делаем с этим сообщением?',
    Markup.inlineKeyboard([
      [Markup.button.callback('📢 Массовая рассылка по чатам', 'msgbroadcast')],
      [Markup.button.callback('📨 Рассылка в личку', 'dmbroadcast_start')],
      [Markup.button.callback('📋 Выбор чата', 'msgpick')],
    ])
  );
});

bot.action('msgbroadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (!session || session.step !== 'broadcast_ready') {
    return ctx.answerCbQuery('Сначала ответь командой /message на сообщение для рассылки.', { show_alert: true });
  }
  const content = sessionToBroadcastContent(session);
  await ctx.answerCbQuery();

  const { data: chats } = await supabase.from('bot_chats').select('chat_id').eq('blocked', false);
  if (!chats || !chats.length) {
    await clearSession(ctx.from.id);
    return ctx.reply('Нет ни одного активного чата для рассылки.');
  }

  let sent = 0;
  let failed = 0;
  for (const chat of chats) {
    try {
      await sendBroadcastContent(ctx.telegram, chat.chat_id, content);
      sent++;
    } catch (e) {
      failed++;
    }
  }
  await clearSession(ctx.from.id);
  return ctx.reply(`Рассылка завершена ✅\n\nОтправлено: ${sent}\nОшибок: ${failed}`);
});

bot.action('dmbroadcast_start', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (!session || session.step !== 'broadcast_ready') {
    return ctx.answerCbQuery('Сначала ответь командой /message на сообщение для рассылки.', { show_alert: true });
  }
  const content = sessionToBroadcastContent(session);
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery();

  try {
    // background-функция сама обрабатывает всех получателей, без ручных "продолжить";
    // await здесь — только чтобы дождаться подтверждения запуска (202), не самой рассылки
    await fetch(`${WEBAPP_URL}/.netlify/functions/dm-broadcast-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_id: ctx.from.id, content }),
    });
  } catch (e) {
    console.error('[dmbroadcast_start] failed to trigger background function:', e);
    return ctx.telegram.sendMessage(ctx.from.id, 'Не получилось запустить рассылку, попробуй ещё раз.');
  }

  // отвечаем строго в личку админу, а не в чат, откуда была вызвана команда —
  // /message могли вызвать ответом на сообщение внутри группового чата
  return ctx.telegram.sendMessage(
    ctx.from.id,
    'Рассылка запущена в фоне 🚀\nКогда всё разошлю — напишу тебе сюда с итогом.'
  );
});



async function renderChatPickList(ctx, edit) {
  const { data: chats } = await supabase.from('bot_chats').select('*').order('title', { ascending: true });
  if (!chats || !chats.length) {
    const text = 'Бот пока не добавлен ни в один чат (или чаты ещё не зарегистрированы — используй /registerchat внутри нужного чата).';
    return edit ? ctx.editMessageText(text) : ctx.reply(text);
  }

  const rows = chats.map((c) => {
    const label = `${c.blocked ? '🚫 ' : ''}${c.title || c.username || c.chat_id}`;
    return [Markup.button.callback(label, `chatmenu:${c.chat_id}`)];
  });
  const text = 'Выбери чат:';
  const keyboard = Markup.inlineKeyboard(rows);
  return edit ? ctx.editMessageText(text, keyboard) : ctx.reply(text, keyboard);
}

bot.action('msgpick', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  return renderChatPickList(ctx, false);
});

async function renderChatMenu(ctx, chatId, edit) {
  const { data: chat } = await supabase.from('bot_chats').select('*').eq('chat_id', chatId).maybeSingle();
  if (!chat) return ctx.answerCbQuery('Чат не найден.', { show_alert: true });

  const name = chat.title || chat.username || chat.chat_id;
  const text = `Чат: ${name}\nСтатус: ${chat.blocked ? '🚫 заблокирован' : '✅ активен'}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✉️ Отправить сообщение', `chatmsg:${chatId}`)],
    [Markup.button.callback(chat.blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `chatblock:${chatId}`)],
    [Markup.button.callback('« Назад к списку', 'msgpick')],
  ]);
  return edit ? ctx.editMessageText(text, keyboard) : ctx.reply(text, keyboard);
}

bot.action(/^chatmenu:(-?\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  return renderChatMenu(ctx, Number(ctx.match[1]), true);
});

bot.action(/^chatblock:(-?\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const { data: chat } = await supabase.from('bot_chats').select('blocked').eq('chat_id', chatId).maybeSingle();
  if (!chat) return ctx.answerCbQuery('Чат не найден.', { show_alert: true });

  await supabase.from('bot_chats').update({ blocked: !chat.blocked, updated_at: new Date().toISOString() }).eq('chat_id', chatId);
  await ctx.answerCbQuery(!chat.blocked ? 'Заблокировано' : 'Разблокировано');
  return renderChatMenu(ctx, chatId, true);
});

bot.action(/^chatmsg:(-?\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  if (!session || session.step !== 'broadcast_ready') {
    return ctx.answerCbQuery('Сначала ответь командой /message на сообщение для рассылки.', { show_alert: true });
  }
  const content = sessionToBroadcastContent(session);
  await ctx.answerCbQuery();
  try {
    await sendBroadcastContent(ctx.telegram, chatId, content);
    await clearSession(ctx.from.id);
    return ctx.reply('Отправлено ✅');
  } catch (e) {
    console.error('[chatmsg] send failed:', e);
    return ctx.reply('Не получилось отправить — возможно, бота удалили из этого чата.');
  }
});

// ---------- /mess (только админы) — быстрая отправка без кнопок: /mess @username текст ----------
bot.command('mess', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const match = ctx.message.text.match(/^\/mess(?:@\w+)?\s+@(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    return ctx.reply('Формат: /mess @юзернейм_чата текст сообщения');
  }
  const [, username, text] = match;
  const { data: chat } = await supabase.from('bot_chats').select('*').ilike('username', username).maybeSingle();
  if (!chat) {
    return ctx.reply('Чат с таким юзернеймом не найден среди тех, куда добавлен бот.');
  }
  try {
    await ctx.telegram.sendMessage(chat.chat_id, text);
    return ctx.reply('Отправлено ✅');
  } catch (e) {
    console.error('[mess] send failed:', e);
    return ctx.reply('Не получилось отправить — возможно, бота удалили из этого чата.');
  }
});

// ---------- /statistics (только админы) ----------
bot.command('statistics', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  try {
    const [totalUsersRes, widgetsRes] = await Promise.all([
      supabase.from('bot_users').select('user_id', { count: 'exact', head: true }),
      supabase.from('widgets').select('downloads_count'),
    ]);

    if (totalUsersRes.error) console.error('[statistics] bot_users error:', totalUsersRes.error);
    if (widgetsRes.error) console.error('[statistics] widgets error:', widgetsRes.error);

    const totalUsers = totalUsersRes.count ?? 0;
    const totalDownloads = (widgetsRes.data || []).reduce((sum, w) => sum + (w.downloads_count || 0), 0);

    return ctx.reply(
      `📊 Статистика\n\n` +
      `Всего пользователей: ${totalUsers}\n` +
      `Всего загрузок: ${totalDownloads}`
    );
  } catch (e) {
    console.error('[statistics] failed:', e);
    return ctx.reply('Не получилось собрать статистику, попробуй ещё раз.');
  }
});

bot.command('compressimages', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  await ctx.reply('Начинаю сжатие уже загруженных превью виджетов, это может занять некоторое время...');

  const { data: widgets, error } = await supabase.from('widgets').select('id, title, image_url');
  if (error || !widgets) {
    return ctx.reply('Не получилось получить список виджетов, попробуй ещё раз.');
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let savedBytes = 0;

  for (const widget of widgets) {
    try {
      const path = storagePathFromUrl(widget.image_url, 'widget-images');
      if (!path) { skipped++; continue; }

      const res = await fetch(widget.image_url);
      if (!res.ok) { failed++; continue; }
      const originalBuf = Buffer.from(await res.arrayBuffer());

      // уже маленькие картинки не трогаем — нет смысла тратить время и трафик на пересжатие
      if (originalBuf.length < 60 * 1024) { skipped++; continue; }

      const compressedBuf = await sharp(originalBuf)
        .resize(900, null, { withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();

      // если сжатая версия почему-то не меньше — не трогаем оригинал
      if (compressedBuf.length >= originalBuf.length) { skipped++; continue; }

      const { error: uploadError } = await supabase.storage.from('widget-images').upload(path, compressedBuf, {
        contentType: 'image/jpeg',
        cacheControl: '31536000',
        upsert: true, // перезаписываем тот же путь — ссылка в базе не меняется
      });
      if (uploadError) { failed++; continue; }

      savedBytes += originalBuf.length - compressedBuf.length;
      processed++;
    } catch (e) {
      console.error(`[compressimages] failed for widget ${widget.id}:`, e);
      failed++;
    }
  }

  const savedMb = (savedBytes / (1024 * 1024)).toFixed(2);
  return ctx.reply(
    `Готово ✅\n\n` +
    `Сжато: ${processed}\n` +
    `Пропущено (уже маленькие): ${skipped}\n` +
    `Ошибок: ${failed}\n` +
    `Освобождено места: ${savedMb} МБ`
  );
});

bot.command('delete', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  return ctx.reply(
    'Выбери категорию для удаления:\n\n/cancel - отмена действия',
    Markup.inlineKeyboard([
      [Markup.button.callback('Все', 'delcat:all:0')],
      ...Object.entries(CATEGORIES).map(([key, label]) => [Markup.button.callback(label, `delcat:${key}:0`)]),
    ])
  );
});

bot.action('delnoop', (ctx) => ctx.answerCbQuery());

bot.action(/^delcat:(\w+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const category = ctx.match[1];
  const page = Number(ctx.match[2]);
  await ctx.answerCbQuery();
  return renderDeleteList(ctx, category, page, true);
});

bot.action(/^delwgt:([^:]+):(\w+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const [, id, category, page] = ctx.match;
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    'Точно удалить этот виджет? Это действие необратимо.\n\n/cancel - отмена действия',
    Markup.inlineKeyboard([
      [Markup.button.callback('Да, удалить', `delconfirm:${id}:${category}:${page}`)],
      [Markup.button.callback('Назад', `delcat:${category}:${page}`)],
    ])
  );
});

bot.action(/^delconfirm:([^:]+):(\w+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const [, id, category, page] = ctx.match;

  const { data: widget } = await supabase.from('widgets').select('title, image_url, file_url').eq('id', id).maybeSingle();
  if (!widget) {
    await ctx.answerCbQuery();
    return renderDeleteList(ctx, category, Number(page), true);
  }

  const imgPath = storagePathFromUrl(widget.image_url, 'widget-images');
  const filePath = storagePathFromUrl(widget.file_url, 'widget-files');
  if (imgPath) await supabase.storage.from('widget-images').remove([imgPath]);
  if (filePath) await supabase.storage.from('widget-files').remove([filePath]);

  await supabase.from('widgets').delete().eq('id', id);

  await ctx.answerCbQuery('Удалено');
  await ctx.reply(`Виджет «${widget.title}» удалён.`);
  return renderDeleteList(ctx, category, Number(page), true);
});

// ---------- Netlify function handler ----------
exports.handler = async (event) => {
  try {
    const update = JSON.parse(event.body);
    await bot.handleUpdate(update);
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error(err);
    return { statusCode: 200, body: 'ok' }; // Telegram ждёт 200 в любом случае
  }
};
