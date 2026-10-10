const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

// отдельный лёгкий эндпоинт для счётчика скачиваний.
// вынесен из file.js специально: сама отдача файла теперь кешируется на CDN Netlify
// (чтобы не есть лимит Supabase egress на повторных скачиваниях), а кешированный ответ
// не запускает код внутри функции повторно — поэтому подсчёт делаем отдельным вызовом,
// который фронтенд/бот стреляют параллельно с открытием файла.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const widgetId = body.widget_id;
  const userId = Number(body.user_id);
  if (!widgetId || !userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'widget_id и user_id обязательны' }) };
  }

  const { data: ban } = await supabase.from('banned_users').select('banned_until').eq('user_id', userId).maybeSingle();
  if (ban && new Date(ban.banned_until).getTime() > Date.now()) {
    return { statusCode: 403, body: JSON.stringify({ error: 'banned' }) };
  }

  const { data: widget } = await supabase
    .from('widgets')
    .select('downloads_count')
    .eq('id', widgetId)
    .maybeSingle();
  if (!widget) return { statusCode: 404, body: JSON.stringify({ error: 'not found' }) };

  // один юзер = одно засчитанное скачивание одного виджета (защита от накрутки)
  const { error: insertError } = await supabase.from('downloads').insert({ user_id: userId, widget_id: widgetId });
  if (!insertError) {
    await supabase.from('widgets').update({ downloads_count: widget.downloads_count + 1 }).eq('id', widgetId);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
