const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const BOT_TOKEN = process.env.BOT_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'bad json' }) };
  }

  const { id: widgetId, user_id: userId } = payload;
  if (!widgetId || !userId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'id и user_id обязательны' }) };
  }

  const { data: widget, error } = await supabase
    .from('widgets')
    .select('title, file_url, downloads_count')
    .eq('id', widgetId)
    .maybeSingle();

  if (error) return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  if (!widget) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Виджет не найден' }) };

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        document: widget.file_url,
        caption: widget.title,
      }),
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      // Частая причина: пользователь не запускал бота (нет чата) — просим открыть бота
      return {
        statusCode: 502,
        body: JSON.stringify({ ok: false, error: tgData.description || 'Telegram API error' }),
      };
    }

    supabase.from('widgets').update({ downloads_count: (widget.downloads_count || 0) + 1 }).eq('id', widgetId).then(() => {});

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Не удалось отправить файл' }) };
  }
};
