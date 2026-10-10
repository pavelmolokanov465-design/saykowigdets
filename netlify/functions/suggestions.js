const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

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

function muteLabel(mutedUntil) {
  if (!mutedUntil) return null;
  const until = new Date(mutedUntil);
  if (until.getTime() <= Date.now()) return null;
  return until.toISOString();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { action, init_data } = body;
  const tgUser = verifyInitData(init_data);
  if (!tgUser || !tgUser.id) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  const callerId = tgUser.id;
  const callerIsAdmin = ADMIN_IDS.includes(callerId);

  if (!callerIsAdmin) {
    const { data: ban } = await supabase.from('banned_users').select('banned_until').eq('user_id', callerId).maybeSingle();
    if (ban && new Date(ban.banned_until).getTime() > Date.now()) {
      return { statusCode: 403, body: JSON.stringify({ error: 'banned' }) };
    }
  }

  // ---------- пользователь: получить свою переписку ----------
  if (action === 'get_my_chat') {
    const { data: chat } = await supabase.from('suggestion_chats').select('*').eq('user_id', callerId).maybeSingle();
    if (!chat) return { statusCode: 200, body: JSON.stringify({ ok: true, chat: null, messages: [] }) };

    await supabase.from('suggestion_chats').update({ has_unread_for_user: false }).eq('user_id', callerId);

    const { data: messages } = await supabase
      .from('suggestion_messages')
      .select('id, sender, text, created_at')
      .eq('user_id', callerId)
      .order('created_at', { ascending: true });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        chat: { muted_until: muteLabel(chat.muted_until), banned: chat.banned },
        messages: messages || [],
      }),
    };
  }

  // ---------- пользователь: отправить сообщение ----------
  if (action === 'send') {
    const text = (body.text || '').trim().slice(0, 2000);
    if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'text обязателен' }) };

    const { data: chat } = await supabase.from('suggestion_chats').select('*').eq('user_id', callerId).maybeSingle();
    if (chat?.banned) return { statusCode: 403, body: JSON.stringify({ error: 'banned' }) };
    if (chat && muteLabel(chat.muted_until)) {
      return { statusCode: 403, body: JSON.stringify({ error: 'muted', muted_until: muteLabel(chat.muted_until) }) };
    }

    if (!chat) {
      await supabase.from('suggestion_chats').insert({
        user_id: callerId,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        has_unread_for_admin: true,
        last_message_at: new Date().toISOString(),
      });
    } else {
      await supabase
        .from('suggestion_chats')
        .update({
          username: tgUser.username || null,
          first_name: tgUser.first_name || null,
          has_unread_for_admin: true,
          last_message_at: new Date().toISOString(),
        })
        .eq('user_id', callerId);
    }

    await supabase.from('suggestion_messages').insert({ user_id: callerId, sender: 'user', text });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---------- пользователь: узнать, есть ли непрочитанное (для красной точки) ----------
  if (action === 'has_unread') {
    const { data: chat } = await supabase
      .from('suggestion_chats')
      .select('has_unread_for_user')
      .eq('user_id', callerId)
      .maybeSingle();
    return { statusCode: 200, body: JSON.stringify({ ok: true, unread: !!chat?.has_unread_for_user }) };
  }

  // ---------- пользователь: удалить свой чат ----------
  if (action === 'delete_my_chat') {
    await supabase.from('suggestion_chats').delete().eq('user_id', callerId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---------- всё, что ниже — только для админов ----------
  if (!callerIsAdmin) return { statusCode: 403, body: JSON.stringify({ error: 'forbidden' }) };

  if (action === 'admin_list') {
    const { data: chats } = await supabase
      .from('suggestion_chats')
      .select('*')
      .order('last_message_at', { ascending: false });
    return { statusCode: 200, body: JSON.stringify({ ok: true, chats: chats || [] }) };
  }

  if (action === 'admin_get_chat') {
    const targetId = Number(body.user_id);
    if (!targetId) return { statusCode: 400, body: JSON.stringify({ error: 'user_id обязателен' }) };

    await supabase.from('suggestion_chats').update({ has_unread_for_admin: false }).eq('user_id', targetId);

    const { data: chat } = await supabase.from('suggestion_chats').select('*').eq('user_id', targetId).maybeSingle();
    const { data: messages } = await supabase
      .from('suggestion_messages')
      .select('id, sender, text, created_at')
      .eq('user_id', targetId)
      .order('created_at', { ascending: true });

    return { statusCode: 200, body: JSON.stringify({ ok: true, chat: chat || null, messages: messages || [] }) };
  }

  if (action === 'admin_reply') {
    const targetId = Number(body.user_id);
    const text = (body.text || '').trim().slice(0, 2000);
    if (!targetId || !text) return { statusCode: 400, body: JSON.stringify({ error: 'user_id и text обязательны' }) };

    await supabase
      .from('suggestion_chats')
      .update({ has_unread_for_user: true, last_message_at: new Date().toISOString() })
      .eq('user_id', targetId);
    await supabase.from('suggestion_messages').insert({ user_id: targetId, sender: 'admin', text });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (action === 'admin_mute') {
    const targetId = Number(body.user_id);
    const hours = Number(body.hours);
    if (!targetId || !hours) return { statusCode: 400, body: JSON.stringify({ error: 'user_id и hours обязательны' }) };

    const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    await supabase.from('suggestion_chats').update({ muted_until: until }).eq('user_id', targetId);
    return { statusCode: 200, body: JSON.stringify({ ok: true, muted_until: until }) };
  }

  if (action === 'admin_unmute') {
    const targetId = Number(body.user_id);
    if (!targetId) return { statusCode: 400, body: JSON.stringify({ error: 'user_id обязателен' }) };
    await supabase.from('suggestion_chats').update({ muted_until: null }).eq('user_id', targetId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (action === 'admin_ban') {
    const targetId = Number(body.user_id);
    if (!targetId) return { statusCode: 400, body: JSON.stringify({ error: 'user_id обязателен' }) };
    await supabase.from('suggestion_chats').update({ banned: true }).eq('user_id', targetId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (action === 'admin_unban') {
    const targetId = Number(body.user_id);
    if (!targetId) return { statusCode: 400, body: JSON.stringify({ error: 'user_id обязателен' }) };
    await supabase.from('suggestion_chats').update({ banned: false }).eq('user_id', targetId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (action === 'admin_delete_chat') {
    const targetId = Number(body.user_id);
    if (!targetId) return { statusCode: 400, body: JSON.stringify({ error: 'user_id обязателен' }) };
    await supabase.from('suggestion_chats').delete().eq('user_id', targetId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'unknown action' }) };
};
