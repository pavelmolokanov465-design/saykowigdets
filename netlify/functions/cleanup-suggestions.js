const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

exports.handler = async () => {
  const suggestionsCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const catalogSessionsCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // сессии просмотра каталога живут максимум сутки
  const startPressesCutoff = new Date(Date.now() - 3600 * 1000).toISOString(); // для антиспама нужно окно всего в минуту, час — с запасом
  const nowIso = new Date().toISOString();

  const [suggestionsRes, catalogRes, startPressesRes, bannedRes] = await Promise.all([
    supabase.from('suggestion_chats').delete().lt('last_message_at', suggestionsCutoff),
    supabase.from('catalog_sessions').delete().lt('created_at', catalogSessionsCutoff),
    supabase.from('start_presses').delete().lt('pressed_at', startPressesCutoff),
    supabase.from('banned_users').delete().lt('banned_until', nowIso), // просроченные блокировки больше не нужны
  ]);

  if (suggestionsRes.error) console.error('cleanup-suggestions (chats) failed:', suggestionsRes.error);
  if (catalogRes.error) console.error('cleanup-suggestions (catalog_sessions) failed:', catalogRes.error);
  if (startPressesRes.error) console.error('cleanup-suggestions (start_presses) failed:', startPressesRes.error);
  if (bannedRes.error) console.error('cleanup-suggestions (banned_users) failed:', bannedRes.error);

  if (suggestionsRes.error || catalogRes.error || startPressesRes.error || bannedRes.error) {
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

exports.config = {
  schedule: '@daily',
};
