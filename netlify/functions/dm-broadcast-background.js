const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// у этой функции нет доступа к Telegraf, поэтому шлём напрямую через Bot API
async function tgCall(method, params) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'telegram api error');
  return data.result;
}

async function sendBroadcastContent(chatId, content) {
  if (content.type === 'photo') {
    return tgCall('sendPhoto', { chat_id: chatId, photo: content.fileId, caption: content.caption || undefined });
  }
  if (content.type === 'sticker') {
    return tgCall('sendSticker', { chat_id: chatId, sticker: content.fileId });
  }
  return tgCall('sendMessage', { chat_id: chatId, text: content.text });
}

const PAGE_SIZE = 100;

// Netlify background-функция: запускается асинхронно, может работать до 15 минут,
// вызывающая сторона получает 202 сразу и не ждёт завершения
exports.handler = async (event) => {
  const { admin_id, content } = JSON.parse(event.body || '{}');
  if (!admin_id || !content) return;

  let offset = 0;
  let sent = 0;
  let failed = 0;
  let total = 0;

  while (true) {
    const { data: users, count } = await supabase
      .from('bot_users')
      .select('user_id', { count: 'exact' })
      .order('user_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (offset === 0) total = count || 0;
    if (!users || !users.length) break;

    for (const u of users) {
      try {
        await sendBroadcastContent(u.user_id, content);
        sent++;
      } catch (e) {
        failed++;
      }
    }

    offset += users.length;
    if (offset >= total) break;
  }

  try {
    await tgCall('sendMessage', {
      chat_id: admin_id,
      text: `Рассылка в личку завершена ✅\n\nВсего получателей: ${total}\nОтправлено: ${sent}\nОшибок: ${failed}`,
    });
  } catch (e) {
    console.error('[dm-broadcast-background] final notify failed:', e);
  }
};
