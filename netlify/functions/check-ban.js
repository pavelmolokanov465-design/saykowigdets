const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const BOT_TOKEN = process.env.BOT_TOKEN;

// проверка подписи Telegram WebApp initData (защита от подмены user_id с фронта)
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;
    return JSON.parse(userRaw);
  } catch (e) {
    return null;
  }
}

// вызывается мини-аппом перед показом каталога — если юзер забанен, приложение
// показывает экран блокировки вместо каталога (основной просмотр виджетов идёт
// напрямую из браузера в Supabase, минуя другие функции, поэтому проверка нужна
// именно на входе в приложение, а не на отдельных действиях)
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const tgUser = verifyInitData(body.init_data);
  if (!tgUser || !tgUser.id) {
    return { statusCode: 200, body: JSON.stringify({ banned: false }) };
  }

  const { data: ban } = await supabase
    .from('banned_users')
    .select('banned_until, reason')
    .eq('user_id', tgUser.id)
    .maybeSingle();

  if (ban && new Date(ban.banned_until).getTime() > Date.now()) {
    return {
      statusCode: 200,
      body: JSON.stringify({ banned: true, banned_until: ban.banned_until, reason: ban.reason || null }),
    };
  }

  return { statusCode: 200, body: JSON.stringify({ banned: false }) };
};
