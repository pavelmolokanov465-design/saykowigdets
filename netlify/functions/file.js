const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

exports.handler = async (event) => {
  const widgetId = event.queryStringParameters && event.queryStringParameters.id;
  if (!widgetId) return { statusCode: 400, body: 'id обязателен' };

  const { data: widget, error } = await supabase
    .from('widgets')
    .select('title, file_url')
    .eq('id', widgetId)
    .maybeSingle();

  if (error) return { statusCode: 500, body: error.message };
  if (!widget) return { statusCode: 404, body: 'Виджет не найден' };

  const fileRes = await fetch(widget.file_url);
  if (!fileRes.ok) return { statusCode: 502, body: 'Не удалось получить файл' };

  const buf = Buffer.from(await fileRes.arrayBuffer());
  const fileName = widget.file_url.split('/').pop() || `${widget.title}.kwgt`;

  // подсчёт скачиваний теперь отдельно в /api/track-download — см. комментарий там.
  // здесь только отдаём файл, максимально кешируемо: одна и та же ссылка виджета всегда
  // ведёт на один и тот же неизменяемый файл, поэтому кешируем на CDN Netlify на год.
  // Повторные скачивания ЛЮБЫМ пользователем после первого — уже не долетают до Supabase.
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Netlify-CDN-Cache-Control': 'public, s-maxage=31536000, durable, immutable',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};
