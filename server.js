'use strict';

// fc-landing-api — приём заявок с media-konveyer.ru и пересылка в Telegram-группу.
// Node http без зависимостей. Токен и chat_id — только в /opt/fc-landing-api/shared/.env.

const http = require('http');
const https = require('https');
const url = require('url');

const briefDb = require('./db');
const { renderRaw, simplePage } = require('./lib/render');
const { renderBriefMd } = require('./lib/md');
const { renderForm } = require('./lib/forms');
const { getSchema } = require('./schemas');

const PORT = parseInt(process.env.PORT || '3022', 10);
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://media-konveyer.ru';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://media-konveyer.ru,https://www.media-konveyer.ru')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.error('FATAL: TG_BOT_TOKEN или TG_CHAT_ID не заданы в окружении.');
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.warn('WARN: ADMIN_TOKEN не задан — админские эндпоинты отключены.');
}

const ALLOWED_CATEGORIES = new Set([
  'Одежда', 'Дом', 'Красота', 'Электроника', 'Детские', 'Другое',
]);
const ALLOWED_REVENUE = new Set([
  '', 'До 1 млн', '1-3 млн', '3-5 млн', '5-10 млн', 'Больше 10 млн',
]);

// In-memory rate limit. Лиды — 5/мин, бриф — 3/мин (отдельные ключи).
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;

function rateLimited(ip, bucket = 'lead', max = 5) {
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const entry = rateBuckets.get(key) || [];
  const recent = entry.filter(ts => now - ts < RATE_WINDOW_MS);
  if (recent.length >= max) {
    rateBuckets.set(key, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  return false;
}

function requireAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7) === ADMIN_TOKEN;
  return false;
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ab.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ab, bb);
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

function tgApi(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      method: 'POST',
      host: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/${method}`,
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
          reject(new Error(`telegram ${method} ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('telegram_timeout')));
    req.write(body);
    req.end();
  });
}

function tgSend(text) {
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text,
  });
}

function tgSendTo(chatId, text, replyTo) {
  const payload = {
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text,
  };
  if (replyTo) payload.reply_to_message_id = replyTo;
  return tgApi('sendMessage', payload);
}

function tgCopyTo(chatId, fromChatId, fromMessageId, caption) {
  const payload = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: fromMessageId,
  };
  if (caption) {
    payload.caption = caption;
    payload.parse_mode = 'HTML';
  }
  return tgApi('copyMessage', payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot relay: личка боту ↔ группа поддержки.
// Юзер пишет боту → пересылаем в группу с тегом user_id.
// Кто-то в группе делает reply на пересланное → парсим user_id из reply_to,
// отправляем ответ юзеру в личку.
// ─────────────────────────────────────────────────────────────────────────────

const USER_ID_TAG = '🆔 user_id:';

function extractUserId(text) {
  if (!text) return null;
  const m = text.match(/user_id:(\d+)/);
  return m ? m[1] : null;
}

function userLabel(from) {
  if (!from) return 'неизвестный';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  const handle = from.username ? `@${from.username}` : '';
  if (name && handle) return `${name} ${handle}`;
  return name || handle || `id:${from.id}`;
}

async function handleUserToGroup(message) {
  const from = message.from;
  if (!from) return;

  // Команда /start — приветствуем юзера, в группу не форвардим.
  if (message.text && /^\/start(\s|$|@)/.test(message.text)) {
    await tgSendTo(message.chat.id,
      'Здравствуйте! 👋\n\n' +
      'Это бот <b>МедиаКонвеер</b>. Опишите ваш вопрос — я передам Никите, ' +
      'и он ответит вам прямо в этом чате.\n\n' +
      '<i>Заявку на пилотный месяц удобнее оставить через форму на ' +
      '<a href="https://media-konveyer.ru/">media-konveyer.ru</a>.</i>'
    );
    return;
  }

  const header = [
    '💬 <b>Новое сообщение пользователю</b>',
    `👤 ${escapeHtml(userLabel(from))}`,
    `${USER_ID_TAG}${from.id}`,
    '<i>Ответьте reply на это сообщение, чтобы написать пользователю.</i>',
    '— — — — — — — — — — —',
  ].join('\n');

  // Если пришёл текст — шлём header + текст одним сообщением. Так reply_to.text
  // содержит USER_ID_TAG, и парсер найдёт user_id.
  if (message.text) {
    const safeText = escapeHtml(message.text).slice(0, 3500);
    await tgSendTo(TG_CHAT_ID, `${header}\n\n${safeText}`);
    return;
  }

  // Не-текстовое (фото/документ/голос) — отправляем header первым сообщением,
  // следом копируем оригинал с reply_to_message на header (так reply на медиа
  // тоже даст нам user_id через цепочку reply_to).
  const headerResp = JSON.parse(await tgSend(header));
  const headerMsgId = headerResp?.result?.message_id;
  if (headerMsgId) {
    await tgApi('copyMessage', {
      chat_id: TG_CHAT_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      reply_to_message_id: headerMsgId,
    });
  }
}

async function handleGroupReply(message) {
  const replyTo = message.reply_to_message;
  if (!replyTo) return;

  // user_id может быть в text самого reply_to или в его reply_to_message
  // (если это копия медиа с привязкой к header).
  const userId = extractUserId(replyTo.text || replyTo.caption || '') ||
                 extractUserId(replyTo.reply_to_message?.text || '');
  if (!userId) return;

  // Текст
  if (message.text) {
    const safeText = escapeHtml(message.text).slice(0, 3500);
    await tgSendTo(userId, safeText);
    // Подтверждение в группу как reaction (reply на сообщение оператора)
    return;
  }

  // Не-текст — пробрасываем копированием с подписью
  await tgCopyTo(userId, message.chat.id, message.message_id);
}

async function handleTgUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }
  const message = update.message;
  if (!message || !message.chat) return;

  const chatType = message.chat.type;
  const chatId = String(message.chat.id);

  if (chatType === 'private') {
    await handleUserToGroup(message);
  } else if (chatId === String(TG_CHAT_ID)) {
    // Команды в нашей рабочей группе — только от участников (всё, кто в группе).
    if (message.text && /^\/(brief|help|start)(@\w+)?(\s|$)/.test(message.text)) {
      await handleGroupCommand(message);
      return;
    }
    if (message.reply_to_message) {
      await handleGroupReply(message);
    }
  }
}

async function handleGroupCommand(message) {
  const text = (message.text || '').trim();
  // Снимаем возможный @mention бота — `/brief@mediakonveyer_bot args` → `/brief args`
  const cleaned = text.replace(/^(\/[a-z]+)@\w+/, '$1');

  if (/^\/(help|start)\b/.test(cleaned)) {
    await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        '<b>Команды бота</b>\n\n' +
        '<code>/brief Имя | @контакт | email | тип</code>\n' +
        '— создать ссылку на детальный бриф (срок действия 14 дней).\n' +
        'Email и тип необязательны. Разделитель — символ <code>|</code>.\n\n' +
        '<b>Тип:</b> <code>seller</code> (по умолчанию) · <code>expert</code> · <code>agency</code>\n\n' +
        '<b>Примеры:</b>\n' +
        '<code>/brief Иван Петров | @ivan | ivan@example.com</code>\n' +
        '<code>/brief Анна Карьера | @anna | anna@mail.ru | expert</code>\n' +
        '<code>/brief ООО Ромашка | hello@romashka.ru | | agency</code>\n' +
        '<code>/brief Тестовый клиент</code>',
    });
    return;
  }

  if (/^\/brief\b/.test(cleaned)) {
    const args = cleaned.replace(/^\/brief\s*/, '').trim();
    if (!args) {
      await tgApi('sendMessage', {
        chat_id: TG_CHAT_ID,
        parse_mode: 'HTML',
        text:
          '⚠️ Имя клиента не указано.\n\n' +
          'Формат: <code>/brief Имя | @контакт | email | тип</code>\n' +
          'Подробнее: /help',
        reply_to_message_id: message.message_id,
      });
      return;
    }
    // parts могут быть пустыми между |, поэтому не filter(Boolean)
    const parts = args.split('|').map((s) => s.trim());
    const client_name = (parts[0] || '').slice(0, 200);
    const client_contact = (parts[1] || '').slice(0, 200);
    const email = (parts[2] || '').slice(0, 200);
    const typeArg = (parts[3] || 'seller').toLowerCase();
    const brief_type = briefDb.BRIEF_TYPES.includes(typeArg) ? typeArg : null;

    if (!client_name) {
      await tgApi('sendMessage', {
        chat_id: TG_CHAT_ID,
        text: '⚠️ Имя клиента пустое.',
        reply_to_message_id: message.message_id,
      });
      return;
    }
    if (!brief_type) {
      await tgApi('sendMessage', {
        chat_id: TG_CHAT_ID,
        parse_mode: 'HTML',
        text: `⚠️ Неизвестный тип брифа: <code>${escapeHtml(typeArg)}</code>.\n` +
              `Доступные: <code>seller</code> · <code>expert</code> · <code>agency</code>`,
        reply_to_message_id: message.message_id,
      });
      return;
    }

    let brief;
    try {
      brief = briefDb.createBrief({ brief_type, client_name, client_contact, email,
                                     source: 'bot' });
    } catch (err) {
      console.error('[brief-cmd] createBrief failed:', err.message);
      await tgApi('sendMessage', {
        chat_id: TG_CHAT_ID,
        text: '❌ Не удалось создать ссылку. Попробуй ещё раз.',
        reply_to_message_id: message.message_id,
      });
      return;
    }

    const briefUrl = `${PUBLIC_BASE_URL}/brief?token=${brief.token}`;
    const expires = new Date(Date.now() + briefDb.TOKEN_LIFETIME_DAYS * 86_400_000);
    const expiresFmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit', month: 'long', year: 'numeric',
    }).format(expires);
    const typeTitle = BRIEF_TYPE_TITLES[brief_type] || brief_type.toUpperCase();

    const lines = [
      `🔗 <b>Ссылка на бриф</b> [${escapeHtml(typeTitle)}]`,
      '',
      `👤 ${escapeHtml(client_name)}`,
    ];
    if (client_contact) lines.push(`📞 ${escapeHtml(client_contact)}`);
    if (email) lines.push(`✉️ ${escapeHtml(email)}`);
    lines.push('', `<a href="${briefUrl}">${briefUrl}</a>`, '', `<i>Действует до ${expiresFmt}.</i>`);

    await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: lines.join('\n'),
      reply_to_message_id: message.message_id,
    });
    return;
  }
}

async function handleCallbackQuery(cb) {
  const data = cb.data || '';
  const m = data.match(/^download_brief:(\d+)$/);
  if (!m) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Неизвестная команда' });
    return;
  }
  const briefId = parseInt(m[1], 10);
  const brief = briefDb.getBriefById(briefId);
  if (!brief || brief.status !== 'completed') {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Бриф не найден или ещё не заполнен' });
    return;
  }
  await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Готовлю файл…' });

  const md = renderBriefMd(brief);
  const filename = `brief-${(brief.client_name || 'client').replace(/[^a-zA-Zа-яА-Я0-9]+/g, '_')}-${brief.id}.md`;
  const chatId = cb.message?.chat?.id || TG_CHAT_ID;
  await tgSendDocument(chatId, filename, md, { reply_to_message_id: cb.message?.message_id });
}

function tgSendDocument(chatId, filename, content, options = {}) {
  const boundary = '----fclndapi' + Math.random().toString(36).slice(2);
  const buf = Buffer.from(content, 'utf8');
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
  if (options.reply_to_message_id) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${options.reply_to_message_id}\r\n`));
  }
  if (options.caption) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${options.caption}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`));
  parts.push(buf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      host: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendDocument`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(new Error(`sendDocument ${res.statusCode}: ${text}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('sendDocument_timeout')));
    req.write(body);
    req.end();
  });
}

// Уведомление о заполненном брифе — с inline-кнопкой «Скачать brief.md».
const BRIEF_TYPE_TITLES = { seller: 'СЕЛЛЕР', expert: 'ЭКСПЕРТ', agency: 'УСЛУГИ / B2B' };

function summarizeBrief(brief) {
  const d = brief.data || {};
  const channels = Array.isArray(d.channels) ? d.channels : [];
  const main = channels.find((c) => (c.status || '').toLowerCase().includes('главн'));
  const mainCh = main?.name || '—';

  if (brief.brief_type === 'expert') {
    return [
      `🎯 Ниша: ${escapeHtml(d.niche || '—')}`,
      `📚 Главный продукт: ${escapeHtml(d.main_product_name || '—')}` +
        (d.main_product_price ? ` · ${escapeHtml(d.main_product_price)}` : ''),
      `🎨 Тон: ${escapeHtml(d.tone_address || '—')}, ${escapeHtml(d.expert_position || '—')}`,
      `📊 Главный канал: ${escapeHtml(mainCh)}`,
    ];
  }
  if (brief.brief_type === 'agency') {
    return [
      `🏢 Компания: ${escapeHtml(d.company_name || '—')}`,
      `🛠 Главная услуга: ${escapeHtml(d.main_service_name || '—')}` +
        (d.main_service_price ? ` · ${escapeHtml(d.main_service_price)}` : ''),
      `🎨 Тон: ${escapeHtml(d.tone_address || '—')}, ${escapeHtml(d.brand_position || '—')}`,
      `📊 Главный канал: ${escapeHtml(mainCh)}`,
    ];
  }
  // seller (default)
  return [
    `🛍 Бренд: ${escapeHtml(d.brand_name || '—')}`,
    `🎯 Главный канал: ${escapeHtml(mainCh)}`,
    `💰 Сегмент: ${escapeHtml(d.segment || '—')} | средний чек: ${escapeHtml(d.average_check || '—')}`,
    `🎨 Тон: ${escapeHtml(d.tone_address || '—')}, ${escapeHtml(d.brand_position || '—')}`,
  ];
}

async function notifyBriefSubmitted(brief) {
  const d = brief.data || {};
  const typeTitle = BRIEF_TYPE_TITLES[brief.brief_type] || brief.brief_type.toUpperCase();
  const lines = [
    `✅ <b>Заполнен бриф</b> [${escapeHtml(typeTitle)}]`,
    `👤 Клиент: ${escapeHtml(brief.client_name || '—')}`,
    `📞 ${escapeHtml(brief.client_contact || '—')} | ${escapeHtml(brief.email || d.email || '—')}`,
    ...summarizeBrief(brief),
    `⏰ Заполнен: ${escapeHtml(brief.completed_at || '—')}`,
  ];

  await tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '📥 Скачать brief.md', callback_data: `download_brief:${brief.id}` },
      ]],
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

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

  // ─── Бриф клиента ─────────────────────────────────────────────────────────

  // GET /brief?token=...  — рендер формы или сообщение
  if (req.method === 'GET' && req.url.startsWith('/brief')) {
    const u = url.parse(req.url, true);
    const token = String(u.query.token || '');
    if (!token) {
      const p = simplePage({ title: 'Бриф', heading: 'Ссылка не найдена',
        message: 'Откройте уникальную ссылку, которую прислал Никита.', status: 404 });
      res.statusCode = p.status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(p.body);
    }
    const brief = briefDb.getBriefByToken(token);
    if (!brief) {
      const p = simplePage({ title: 'Бриф', heading: 'Ссылка не найдена',
        message: 'Возможно, ссылка введена с ошибкой. Свяжитесь с Никитой — пришлёт новую.',
        status: 404 });
      res.statusCode = p.status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(p.body);
    }
    if (brief.status === 'completed' || brief.status === 'processed') {
      const p = simplePage({ title: 'Бриф', heading: 'Бриф уже заполнен',
        message: `Спасибо! Я работаю с вашими ответами от ${brief.completed_at || 'недавнего времени'}. Если нужно дополнить — напишите в Telegram.`,
        status: 200 });
      res.statusCode = p.status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(p.body);
    }
    if (briefDb.isExpired(brief)) {
      const p = simplePage({ title: 'Бриф', heading: 'Ссылка истекла',
        message: 'Ссылка на бриф действует 14 дней. Свяжитесь с Никитой — пришлёт новую.',
        status: 410 });
      res.statusCode = p.status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(p.body);
    }
    let progress = '{}';
    try {
      if (brief.progress_data) {
        JSON.parse(brief.progress_data);
        progress = brief.progress_data;
      }
    } catch {}
    const schema = getSchema(brief.brief_type);
    if (!schema) {
      const p = simplePage({ title: 'Бриф', heading: 'Тип брифа не поддерживается',
        message: `Внутренняя ошибка: схема "${brief.brief_type}" не найдена. Свяжитесь с Никитой.`,
        status: 500 });
      res.statusCode = p.status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(p.body);
    }
    const html = renderRaw('form.html', {
      title: schema.title,
      type_title: schema.type_title,
      intro: schema.intro || '',
      token: brief.token,
      token_json: JSON.stringify(brief.token),
      progress_json: progress,
      form_steps: renderForm(schema),
      form_steps_count: schema.steps.length,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.statusCode = 200;
    return res.end(html);
  }

  // POST /api/admin/create-brief-link — генерация уникальной ссылки
  if (req.method === 'POST' && req.url === '/api/admin/create-brief-link') {
    if (!requireAdmin(req)) return jsonReply(res, 401, { ok: false, error: 'unauthorized' });
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return jsonReply(res, 400, { ok: false, error: 'bad_json' });
    }
    const client_name = String(payload.client_name || '').slice(0, 200).trim();
    const client_contact = String(payload.client_contact || '').slice(0, 200).trim();
    const email = String(payload.email || '').slice(0, 200).trim();
    const briefType = String(payload.brief_type || 'seller').toLowerCase();
    if (!client_name) return jsonReply(res, 400, { ok: false, error: 'invalid_client_name' });
    if (!briefDb.BRIEF_TYPES.includes(briefType)) {
      return jsonReply(res, 400, { ok: false, error: 'invalid_brief_type' });
    }
    const brief = briefDb.createBrief({
      brief_type: briefType, client_name, client_contact, email, source: 'manual',
    });
    const expires = new Date(Date.now() + briefDb.TOKEN_LIFETIME_DAYS * 86_400_000).toISOString();
    return jsonReply(res, 200, {
      ok: true,
      url: `${PUBLIC_BASE_URL}/brief?token=${brief.token}`,
      token: brief.token,
      brief_id: brief.id,
      expires_at: expires,
    });
  }

  // POST /api/brief/save-progress — автосохранение
  if (req.method === 'POST' && req.url === '/api/brief/save-progress') {
    const ip = clientIp(req);
    if (rateLimited(ip, 'brief-save', 30)) {
      return jsonReply(res, 429, { ok: false, error: 'rate_limited' });
    }
    let payload;
    try { payload = JSON.parse(await readBody(req, 200_000)); } catch {
      return jsonReply(res, 400, { ok: false, error: 'bad_json' });
    }
    const token = String(payload.token || '');
    const partial = payload.partial_answers;
    if (!token || !partial) return jsonReply(res, 400, { ok: false, error: 'invalid_payload' });
    const brief = briefDb.getBriefByToken(token);
    if (!brief) return jsonReply(res, 404, { ok: false, error: 'not_found' });
    if (brief.status !== 'pending') return jsonReply(res, 409, { ok: false, error: 'not_pending' });
    if (briefDb.isExpired(brief)) return jsonReply(res, 410, { ok: false, error: 'expired' });
    briefDb.saveProgress(token, partial);
    return jsonReply(res, 200, { ok: true });
  }

  // POST /api/brief/submit — финальная отправка
  if (req.method === 'POST' && req.url === '/api/brief/submit') {
    const ip = clientIp(req);
    if (rateLimited(ip, 'brief-submit', 3)) {
      return jsonReply(res, 429, { ok: false, error: 'rate_limited' });
    }
    let payload;
    try { payload = JSON.parse(await readBody(req, 200_000)); } catch {
      return jsonReply(res, 400, { ok: false, error: 'bad_json' });
    }
    const token = String(payload.token || '');
    const answers = payload.answers;
    if (!token || !answers || typeof answers !== 'object') {
      return jsonReply(res, 400, { ok: false, error: 'invalid_payload' });
    }
    const brief = briefDb.getBriefByToken(token);
    if (!brief) return jsonReply(res, 404, { ok: false, error: 'not_found' });
    if (brief.status !== 'pending') return jsonReply(res, 409, { ok: false, error: 'not_pending' });
    if (briefDb.isExpired(brief)) return jsonReply(res, 410, { ok: false, error: 'expired' });

    const r = briefDb.submitBrief(token, answers, ip);
    if (!r.ok) return jsonReply(res, 400, { ok: false, error: r.error });
    try {
      await notifyBriefSubmitted(r.brief);
    } catch (e) {
      console.error('[brief] notify failed:', e.message);
    }
    return jsonReply(res, 200, { ok: true });
  }

  // GET /api/admin/briefs/:token/download — .md файл по токену
  if (req.method === 'GET' && req.url.startsWith('/api/admin/briefs/')) {
    if (!requireAdmin(req)) return jsonReply(res, 401, { ok: false, error: 'unauthorized' });
    const m = req.url.match(/^\/api\/admin\/briefs\/([\w-]+)\/download/);
    if (!m) return jsonReply(res, 404, { ok: false, error: 'not_found' });
    const token = m[1];
    const brief = briefDb.getBriefByToken(token);
    if (!brief) return jsonReply(res, 404, { ok: false, error: 'not_found' });
    if (brief.status !== 'completed') return jsonReply(res, 409, { ok: false, error: 'not_completed' });
    const md = renderBriefMd(brief);
    const safeName = (brief.client_name || 'client').replace(/[^a-zA-Zа-яА-Я0-9]+/g, '_');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="brief-${safeName}-${brief.id}.md"`);
    return res.end(md);
  }

  // ──────────────────────────────────────────────────────────────────────────

  // Telegram webhook — приём апдейтов от @mediakonveyer_bot.
  if (req.method === 'POST' && req.url === '/api/tg/webhook') {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (!TG_WEBHOOK_SECRET || headerSecret !== TG_WEBHOOK_SECRET) {
      return jsonReply(res, 401, { ok: false, error: 'bad_secret' });
    }
    let update;
    try {
      const raw = await readBody(req, 1_000_000);
      update = JSON.parse(raw || '{}');
    } catch (e) {
      return jsonReply(res, 400, { ok: false, error: 'bad_json' });
    }
    // Отвечаем Telegram сразу 200 — обработку делаем асинхронно, чтобы не таймаутил.
    jsonReply(res, 200, { ok: true });
    Promise.resolve().then(() => handleTgUpdate(update)).catch((err) => {
      console.error('[webhook] handler failed:', err.message);
    });
    return;
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
