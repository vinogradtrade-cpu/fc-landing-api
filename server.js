'use strict';

// fc-landing-api — приём заявок с media-konveyer.ru и пересылка в Telegram-группу.
// Node http без зависимостей. Токен и chat_id — только в /opt/fc-landing-api/shared/.env.

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '3022', 10);
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://media-konveyer.ru,https://www.media-konveyer.ru')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.error('FATAL: TG_BOT_TOKEN или TG_CHAT_ID не заданы в окружении.');
  process.exit(1);
}

const ALLOWED_CATEGORIES = new Set([
  'Одежда', 'Дом', 'Красота', 'Электроника', 'Детские', 'Другое',
]);
const ALLOWED_REVENUE = new Set([
  '', 'До 1 млн', '1-3 млн', '3-5 млн', '5-10 млн', 'Больше 10 млн',
]);

// In-memory rate limit: 5 запросов / 60с с одного IP.
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;

function rateLimited(ip) {
  const now = Date.now();
  const entry = rateBuckets.get(ip) || [];
  const recent = entry.filter(ts => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    rateBuckets.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(ip, recent);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of rateBuckets) {
    const fresh = ts.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, fresh);
  }
}, 5 * 60_000).unref();

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function pickOrigin(req) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

function jsonReply(res, status, payload, origin) {
  if (origin) setCors(res, origin);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes = 16_000) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tgSend(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TG_CHAT_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text,
    });
    const req = https.request({
      method: 'POST',
      host: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10_000,
    }, (res) => {
      const data = [];
      res.on('data', (c) => data.push(c));
      res.on('end', () => {
        const text = Buffer.concat(data).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text);
        } else {
          reject(new Error(`telegram ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('telegram_timeout')));
    req.write(body);
    req.end();
  });
}

function formatLead({ name, contact, category, revenue, page, ip, ts }) {
  const dt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(ts);
  return [
    '🆕 <b>Новая заявка</b> с media-konveyer.ru',
    '',
    `👤 <b>Имя:</b> ${escapeHtml(name)}`,
    `📞 <b>Контакт:</b> ${escapeHtml(contact)}`,
    `🏷 <b>Категория:</b> ${escapeHtml(category)}`,
    `💰 <b>Оборот:</b> ${escapeHtml(revenue || 'не указан')}`,
    '',
    `🌐 <b>Страница:</b> ${escapeHtml(page || '-')}`,
    `🕒 ${dt} МСК`,
    `🌍 IP: <code>${escapeHtml(ip)}</code>`,
  ].join('\n');
}

const server = http.createServer(async (req, res) => {
  const origin = pickOrigin(req);

  if (req.method === 'OPTIONS') {
    setCors(res, origin);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    return jsonReply(res, 200, { ok: true, service: 'fc-landing-api' }, origin);
  }

  if (req.method !== 'POST' || req.url !== '/api/lead') {
    return jsonReply(res, 404, { ok: false, error: 'not_found' }, origin);
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return jsonReply(res, 429, { ok: false, error: 'rate_limited' }, origin);
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    return jsonReply(res, 400, { ok: false, error: 'bad_json' }, origin);
  }

  // Honeypot — поле должно быть пустым; если заполнено, это бот.
  if (payload.website || payload.url || payload.honeypot) {
    return jsonReply(res, 200, { ok: true }, origin);
  }

  const name = String(payload.name || '').trim();
  const contact = String(payload.contact || '').trim();
  const category = String(payload.category || '').trim();
  const revenue = String(payload.revenue || '').trim();
  const consent = payload.consent === true || payload.consent === 'on' || payload.consent === '1';
  const page = String(payload.page || '').slice(0, 500);

  if (name.length < 1 || name.length > 100) {
    return jsonReply(res, 400, { ok: false, error: 'invalid_name' }, origin);
  }
  if (contact.length < 3 || contact.length > 200) {
    return jsonReply(res, 400, { ok: false, error: 'invalid_contact' }, origin);
  }
  if (!ALLOWED_CATEGORIES.has(category)) {
    return jsonReply(res, 400, { ok: false, error: 'invalid_category' }, origin);
  }
  if (!ALLOWED_REVENUE.has(revenue)) {
    return jsonReply(res, 400, { ok: false, error: 'invalid_revenue' }, origin);
  }
  if (!consent) {
    return jsonReply(res, 400, { ok: false, error: 'consent_required' }, origin);
  }

  const text = formatLead({
    name, contact, category, revenue, page, ip, ts: new Date(),
  });

  try {
    await tgSend(text);
  } catch (err) {
    console.error('[lead] telegram send failed:', err.message);
    return jsonReply(res, 502, { ok: false, error: 'telegram_failed' }, origin);
  }

  // Не логируем PII — только метку.
  console.log('[lead] delivered', { ts: new Date().toISOString(), category, ip });
  return jsonReply(res, 200, { ok: true }, origin);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fc-landing-api listening on 127.0.0.1:${PORT}`);
  console.log(`allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});

const shutdown = (sig) => () => {
  console.log(`${sig} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
