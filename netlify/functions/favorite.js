const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const { user_id, widget_id, action } = JSON.parse(event.body || '{}');
  if (!user_id || !widget_id || !action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'user_id, widget_id, action обязательны' }) };
  }

  const { data: ban } = await supabase.from('banned_users').select('banned_until').eq('user_id', user_id).maybeSingle();
  if (ban && new Date(ban.banned_until).getTime() > Date.now()) {
    return { statusCode: 403, body: JSON.stringify({ error: 'banned' }) };
  }

  if (action === 'add') {
    const { error } = await supabase.from('favorites').insert({ user_id, widget_id });
    if (error && error.code !== '23505') return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  } else if (action === 'remove') {
    const { error } = await supabase.from('favorites').delete().eq('user_id', user_id).eq('widget_id', widget_id);
    if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'action должен быть add или remove' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
