const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

// раздаёт превью виджета через кеш CDN Netlify — так каждая уникальная картинка
// скачивается из Supabase Storage только один раз (первым запросом от любого пользователя),
// а все дальнейшие просмотры этого же виджета кем угодно берутся из кеша Netlify,
// не расходуя лимит Supabase egress вообще.
exports.handler = async (event) => {
  const widgetId = event.queryStringParameters && event.queryStringParameters.id;
  if (!widgetId) return { statusCode: 400, body: 'id обязателен' };

  const { data: widget, error } = await supabase
    .from('widgets')
    .select('image_url')
    .eq('id', widgetId)
    .maybeSingle();

  if (error) return { statusCode: 500, body: error.message };
  if (!widget) return { statusCode: 404, body: 'Виджет не найден' };

  const imgRes = await fetch(widget.image_url);
  if (!imgRes.ok) return { statusCode: 502, body: 'Не удалось получить картинку' };

  const buf = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': contentType,
      'Netlify-CDN-Cache-Control': 'public, s-maxage=31536000, durable, immutable',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};
