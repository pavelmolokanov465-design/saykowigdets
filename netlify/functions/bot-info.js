const BOT_TOKEN = process.env.BOT_TOKEN;

exports.handler = async () => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (!data.ok) return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, username: data.result.username }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
