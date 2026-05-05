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
const TG_BOT_USERNAME = process.env.TG_BOT_USERNAME || 'mediakonveyer_bot';
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

  // Команда /start с deep-link параметром b_<8 hex> — выдаём клиенту ссылку на его бриф.
  if (message.text) {
    const m = message.text.match(/^\/start(?:@\w+)?\s+b_([a-f0-9]{6,12})/i);
    if (m) {
      const short = m[1].toLowerCase();
      const brief = briefDb.findBriefByShortToken(short);
      if (!brief) {
        await tgSendTo(message.chat.id,
          '⚠️ Ссылка не найдена. Попросите оператора прислать новую.');
        return;
      }
      if (brief.status !== 'pending') {
        await tgSendTo(message.chat.id,
          '⚠️ Этот бриф уже заполнен. Если нужно дополнить — напишите оператору.');
        return;
      }
      if (briefDb.isExpired(brief)) {
        await tgSendTo(message.chat.id,
          '⚠️ Срок действия ссылки истёк. Попросите оператора прислать новую.');
        return;
      }
      const url = briefDirectUrl(brief);
      const greet = brief.client_name ? `, ${escapeHtml(brief.client_name)}` : '';
      await tgSendTo(message.chat.id,
        `Здравствуйте${greet}! 👋\n\n` +
        '<b>МедиаКонвеер</b> — фабрика контента для маркетплейсов и услуг.\n\n' +
        '🔗 Вот ваша персональная ссылка на бриф:\n' +
        `${url}\n\n` +
        '<i>Заполнение займёт 20–25 минут. Можно прерваться и вернуться по этой же ссылке — прогресс сохраняется автоматически.</i>'
      );
      return;
    }
  }

  // Обычная команда /start или /help — приветствуем юзера, в группу не форвардим.
  if (message.text && /^\/(start|help)(\s|$|@)/.test(message.text)) {
    await tgSendTo(message.chat.id,
      'Здравствуйте! 👋\n\n' +
      'Это бот <b>МедиаКонвеер</b>. Просто опишите свой вопрос здесь — ' +
      'я передам его Никите, и он ответит вам в этом же чате.\n\n' +
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

  // Текст — шлём header + текст одним сообщением.
  if (message.text) {
    const safeText = escapeHtml(message.text).slice(0, 3500);
    await tgSendTo(TG_CHAT_ID, `${header}\n\n${safeText}`);
  } else {
    // Не-текстовое (фото/документ/голос) — header первым, копия — reply на него.
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

  // Подтверждение пользователю в личке: «принято» с rate-limit (раз в 30 минут на user_id).
  // Хранится в bot_states, чтобы спам-сообщения не получали 10 «принято» подряд.
  const SUPPORT_GREET_TTL_MS = 30 * 60 * 1000;
  const prev = briefDb.getBotState(from.id);
  const lastGreet = prev?.context?.support_greeted_at || 0;
  if (Date.now() - lastGreet > SUPPORT_GREET_TTL_MS) {
    await tgSendTo(message.chat.id,
      '✅ <b>Спасибо, ваше сообщение получено</b>\n\n' +
      'Никита ответит вам прямо здесь, в этом чате — обычно в течение ' +
      'нескольких часов в рабочее время (будни 10:00–19:00 МСК).\n\n' +
      '<i>Можете писать дополнения и уточнения сюда же.</i>'
    );
    // Сохраняем флаг — но не сбрасываем активный диалог /new_brief (если есть).
    const isInDialog = (prev?.state || '').startsWith('new_brief:');
    const stateName = isInDialog ? prev.state : 'support';
    briefDb.setBotState(from.id, stateName, {
      ...(prev?.context || {}),
      support_greeted_at: Date.now(),
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
    // 1) Pending state машины диалога — приоритет
    if (message.from && message.text && !message.text.startsWith('/')) {
      const state = briefDb.getBotState(message.from.id);
      if (state && state.state.startsWith('new_brief:')) {
        await handleNewBriefMessage(message, state);
        return;
      }
    }
    // 2) Команды
    if (message.text && /^\/(brief|help|start|menu|list_briefs|stats|new_brief|cancel)(@\w+)?(\s|$)/.test(message.text)) {
      await handleGroupCommand(message);
      return;
    }
    // 3) Reply на пересланное (relay support)
    if (message.reply_to_message) {
      await handleGroupReply(message);
    }
  }
}

async function handleGroupCommand(message) {
  const text = (message.text || '').trim();
  // Снимаем возможный @mention бота — `/brief@mediakonveyer_bot args` → `/brief args`
  const cleaned = text.replace(/^(\/[a-z]+)@\w+/, '$1');

  if (/^\/(start|menu)\b/.test(cleaned)) {
    await sendMainMenu(message.message_id);
    return;
  }
  if (/^\/help\b/.test(cleaned)) {
    await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        '<b>Команды бота</b>\n\n' +
        '<code>/menu</code> — главное меню\n' +
        '<code>/new_brief</code> — создать бриф через диалог\n' +
        '<code>/brief Имя | @контакт | email | тип</code> — быстрое создание ссылки\n' +
        '<code>/list_briefs [filter]</code> — список последних брифов\n' +
        '<code>/stats</code> — статистика за 30 дней\n' +
        '<code>/cancel</code> — отменить текущий диалог\n\n' +
        '<b>Тип брифа:</b> <code>seller</code> (по умолчанию) · <code>expert</code> · <code>agency</code>\n\n' +
        '<b>Фильтры /list_briefs:</b> <code>pending</code> · <code>completed</code> · <code>expired</code> · ' +
        '<code>seller</code> · <code>expert</code> · <code>agency</code>\n\n' +
        '<b>Примеры:</b>\n' +
        '<code>/brief Иван Петров | @ivan | ivan@example.com</code>\n' +
        '<code>/brief Анна Карьера | @anna | anna@mail.ru | expert</code>\n' +
        '<code>/list_briefs pending</code>',
    });
    return;
  }

  if (/^\/menu\b/.test(cleaned)) {
    await sendMainMenu(message.message_id);
    return;
  }

  if (/^\/cancel\b/.test(cleaned)) {
    const had = briefDb.getBotState(message.from.id);
    briefDb.clearBotState(message.from.id);
    await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID,
      text: had ? '❌ Текущий диалог отменён.' : 'Нет активного диалога.',
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (/^\/new_brief\b/.test(cleaned)) {
    await startNewBriefDialog(message);
    return;
  }

  if (/^\/list_briefs\b/.test(cleaned)) {
    const filter = (cleaned.replace(/^\/list_briefs\s*/, '').trim() || '').toLowerCase();
    await sendBriefsList(filter, message.message_id);
    return;
  }

  if (/^\/stats\b/.test(cleaned)) {
    await sendStats(message.message_id);
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

    const msg = formatBriefCreatedMessage({
      brief, briefType: brief_type,
      clientName: client_name, clientContact: client_contact, email,
    });
    await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: msg.text,
      reply_markup: msg.reply_markup,
      reply_to_message_id: message.message_id,
    });
    return;
  }
}

// ─── Главное меню и сводки ────────────────────────────────────────────────────

const STATUS_ICON = { pending: '⚪', in_progress: '🟡', completed: '🟢', expired: '🔴' };
const TYPE_TAG = { seller: 'СЕЛЛЕР', expert: 'ЭКСПЕРТ', agency: 'B2B' };

function mainMenuKeyboard() {
  const newLeads = briefDb.listLeads({ status: 'new', limit: 999 }).length;
  const totalBriefs = briefDb.listBriefs({ limit: 999 }).length;
  return {
    inline_keyboard: [
      [{ text: `🔥 Новые заявки (${newLeads})`, callback_data: 'menu:leads' }],
      [{ text: `📋 Брифы (${totalBriefs})`, callback_data: 'menu:briefs' }],
      [{ text: '➕ Создать бриф вручную', callback_data: 'menu:new_brief' }],
      [{ text: '📈 Статистика', callback_data: 'menu:stats' }],
    ],
  };
}

async function sendMainMenu(replyToMessageId) {
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    parse_mode: 'HTML',
    text: '<b>📊 Главное меню МедиаКонвеер</b>\n\nВыбери действие:',
    reply_markup: mainMenuKeyboard(),
    reply_to_message_id: replyToMessageId,
  });
}

function shortDate(stamp) {
  if (!stamp) return '—';
  const s = String(stamp);
  // 2026-05-05 12:37:37 → 05.05 12:37
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : s.slice(0, 16);
}

function effectiveStatus(b) {
  if (b.status === 'pending' && briefDb.isExpired(b)) return 'expired';
  return b.status;
}

function formatBriefsList(briefs, filter) {
  if (!briefs.length) {
    return `<b>📋 Брифы</b>${filter ? ` <i>(фильтр: ${escapeHtml(filter)})</i>` : ''}\n\n<i>Пока нет.</i>`;
  }
  const lines = [
    `<b>📋 Брифы</b>${filter ? ` <i>(фильтр: ${escapeHtml(filter)})</i>` : ''}`,
    '',
    '<i>🟢 Заполнен · 🟡 В процессе · ⚪ Не начат · 🔴 Истёк</i>',
    '',
  ];
  for (const b of briefs) {
    const st = effectiveStatus(b);
    const icon = STATUS_ICON[st] || '⚪';
    const tag = TYPE_TAG[b.brief_type] || (b.brief_type || '').toUpperCase();
    const name = b.client_name || '—';
    const date = shortDate(b.completed_at || b.created_at);
    lines.push(`${icon} <b>${escapeHtml(name)}</b> [${escapeHtml(tag)}] · ${escapeHtml(date)}`);
  }
  return lines.join('\n');
}

async function sendBriefsList(filter, replyToMessageId) {
  let opts = { limit: 30 };
  if (['pending', 'completed', 'in_progress'].includes(filter)) opts.status = filter;
  if (briefDb.BRIEF_TYPES.includes(filter)) opts.brief_type = filter;
  let briefs = briefDb.listBriefs(opts);
  if (filter === 'expired') {
    briefs = briefs.filter((b) => effectiveStatus(b) === 'expired');
  }
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: formatBriefsList(briefs, filter),
    reply_to_message_id: replyToMessageId,
    reply_markup: {
      inline_keyboard: [[
        { text: '⚪ pending', callback_data: 'briefs:pending' },
        { text: '🟢 completed', callback_data: 'briefs:completed' },
        { text: '🔴 expired', callback_data: 'briefs:expired' },
      ], [
        { text: '🛒 seller', callback_data: 'briefs:seller' },
        { text: '🎓 expert', callback_data: 'briefs:expert' },
        { text: '🏢 agency', callback_data: 'briefs:agency' },
      ], [
        { text: '⬅ Меню', callback_data: 'menu:home' },
      ]],
    },
  });
}

function formatStats() {
  const s = briefDb.getStats({ daysBack: 30 });
  const conv = s.leads ? Math.round((s.leadsProcessed / s.leads) * 100) : 0;
  const filledPct = s.briefsTotal ? Math.round((s.briefsCompleted / s.briefsTotal) * 100) : 0;
  const byType = { seller: { total: 0, completed: 0 }, expert: { total: 0, completed: 0 }, agency: { total: 0, completed: 0 } };
  for (const r of s.byType) {
    if (byType[r.brief_type]) byType[r.brief_type] = { total: r.total, completed: r.completed };
  }
  return [
    '<b>📈 Статистика</b> <i>(за 30 дней)</i>',
    '',
    `Заявок с лендинга: <b>${s.leads}</b>`,
    `Конвертировано в бриф: <b>${s.leadsProcessed}</b> (${conv}%)`,
    `Заполнено брифов: <b>${s.briefsCompleted}</b> из ${s.briefsTotal} (${filledPct}%)`,
    '',
    '<b>По типам:</b>',
    `🛒 Селлер — ${byType.seller.completed} / ${byType.seller.total}`,
    `🎓 Эксперт — ${byType.expert.completed} / ${byType.expert.total}`,
    `🏢 B2B — ${byType.agency.completed} / ${byType.agency.total}`,
    '',
    `Истёкшие без заполнения: ${s.expired}`,
  ].join('\n');
}

async function sendStats(replyToMessageId) {
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    parse_mode: 'HTML',
    text: formatStats(),
    reply_to_message_id: replyToMessageId,
    reply_markup: { inline_keyboard: [[{ text: '⬅ Меню', callback_data: 'menu:home' }]] },
  });
}

async function sendLeadsList(replyToMessageId) {
  const leads = briefDb.listLeads({ status: 'new', limit: 20 });
  if (!leads.length) {
    return tgApi('sendMessage', {
      chat_id: TG_CHAT_ID,
      parse_mode: 'HTML',
      text: '<b>🔥 Новые заявки</b>\n\n<i>Пока нет.</i>',
      reply_to_message_id: replyToMessageId,
      reply_markup: { inline_keyboard: [[{ text: '⬅ Меню', callback_data: 'menu:home' }]] },
    });
  }
  const lines = ['<b>🔥 Новые заявки</b>', ''];
  for (const l of leads) {
    lines.push(`#${l.id} · <b>${escapeHtml(l.name || '—')}</b> · ${escapeHtml(l.contact || '—')} · ${escapeHtml(l.category || '—')} · ${shortDate(l.created_at)}`);
  }
  lines.push('', '<i>Чтобы создать бриф из заявки — открой исходное сообщение в группе и выбери тип.</i>');
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    parse_mode: 'HTML',
    text: lines.join('\n'),
    reply_to_message_id: replyToMessageId,
    reply_markup: { inline_keyboard: [[{ text: '⬅ Меню', callback_data: 'menu:home' }]] },
  });
}

// ─── Диалог /new_brief (state machine через bot_states) ───────────────────────

const NEW_BRIEF_CANCEL_KB = { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'new_brief:cancel' }]] };

async function startNewBriefDialog(message) {
  briefDb.setBotState(message.from.id, 'new_brief:name', {});
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    parse_mode: 'HTML',
    text: '<b>➕ Новый бриф</b>\n\n<b>Шаг 1/4:</b> Имя клиента?\n\n<i>Просто напишите ответом.</i>',
    reply_markup: NEW_BRIEF_CANCEL_KB,
    reply_to_message_id: message.message_id,
  });
}

async function handleNewBriefMessage(message, state) {
  const userId = message.from.id;
  const ctx = state.context || {};
  const text = (message.text || '').trim();

  if (state.state === 'new_brief:name') {
    if (text.length < 1 || text.length > 200) {
      return tgApi('sendMessage', {
        chat_id: TG_CHAT_ID, text: '⚠️ Имя должно быть 1–200 символов. Попробуйте ещё раз или /cancel.',
        reply_to_message_id: message.message_id,
      });
    }
    ctx.client_name = text;
    briefDb.setBotState(userId, 'new_brief:contact', ctx);
    return tgApi('sendMessage', {
      chat_id: TG_CHAT_ID, parse_mode: 'HTML',
      text: `Имя: <b>${escapeHtml(text)}</b>\n\n<b>Шаг 2/4:</b> Контакт (Telegram, телефон или email)?`,
      reply_markup: NEW_BRIEF_CANCEL_KB,
      reply_to_message_id: message.message_id,
    });
  }

  if (state.state === 'new_brief:contact') {
    if (text.length < 3 || text.length > 200) {
      return tgApi('sendMessage', {
        chat_id: TG_CHAT_ID, text: '⚠️ Контакт должен быть 3–200 символов.',
        reply_to_message_id: message.message_id,
      });
    }
    ctx.client_contact = text;
    briefDb.setBotState(userId, 'new_brief:email', ctx);
    return tgApi('sendMessage', {
      chat_id: TG_CHAT_ID, parse_mode: 'HTML',
      text: `Контакт: <b>${escapeHtml(text)}</b>\n\n<b>Шаг 3/4:</b> Email (опционально, можно пропустить)`,
      reply_markup: { inline_keyboard: [
        [{ text: '⏭ Пропустить', callback_data: 'new_brief:skip_email' }],
        [{ text: '❌ Отмена', callback_data: 'new_brief:cancel' }],
      ] },
      reply_to_message_id: message.message_id,
    });
  }

  if (state.state === 'new_brief:email') {
    if (text.length > 200) {
      return tgApi('sendMessage', {
        chat_id: TG_CHAT_ID, text: '⚠️ Email слишком длинный.',
        reply_to_message_id: message.message_id,
      });
    }
    ctx.email = text;
    briefDb.setBotState(userId, 'new_brief:type', ctx);
    return sendNewBriefTypeStep(message.message_id);
  }
  // type / confirm — только через кнопки
}

async function sendNewBriefTypeStep(replyToMessageId) {
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID, parse_mode: 'HTML',
    text: '<b>Шаг 4/4:</b> Тип брифа?',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🛒 Селлер', callback_data: 'new_brief:type:seller' },
          { text: '🎓 Эксперт', callback_data: 'new_brief:type:expert' },
          { text: '🏢 B2B', callback_data: 'new_brief:type:agency' },
        ],
        [{ text: '❌ Отмена', callback_data: 'new_brief:cancel' }],
      ],
    },
    reply_to_message_id: replyToMessageId,
  });
}

async function sendNewBriefConfirm(userId, ctx, chatMsgId) {
  briefDb.setBotState(userId, 'new_brief:confirm', ctx);
  const typeTitle = BRIEF_TYPE_TITLES[ctx.brief_type] || ctx.brief_type;
  const lines = [
    '<b>✅ Подтверждение</b>',
    '',
    `👤 Имя: <b>${escapeHtml(ctx.client_name)}</b>`,
    `📞 Контакт: <b>${escapeHtml(ctx.client_contact)}</b>`,
    ctx.email ? `📧 Email: <b>${escapeHtml(ctx.email)}</b>` : '📧 Email: <i>не указан</i>',
    `🏷 Тип: <b>${escapeHtml(typeTitle)}</b>`,
    '',
    '<i>Создать ссылку?</i>',
  ];
  return tgApi('sendMessage', {
    chat_id: TG_CHAT_ID, parse_mode: 'HTML', text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Создать', callback_data: 'new_brief:confirm' },
        { text: '❌ Отмена', callback_data: 'new_brief:cancel' },
      ]],
    },
    reply_to_message_id: chatMsgId,
  });
}

async function handleCallbackQuery(cb) {
  const data = cb.data || '';

  // Скачать .md по brief_id (кнопка под уведомлением о заполненном брифе)
  let m = data.match(/^download_brief:(\d+)$/);
  if (m) {
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
    return;
  }

  // Конверсия лида в бриф: lead:create:<lead_id>:<type>
  m = data.match(/^lead:create:(\d+):(\w+)$/);
  if (m) {
    const leadId = parseInt(m[1], 10);
    const briefType = m[2];
    if (!briefDb.BRIEF_TYPES.includes(briefType)) {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Неизвестный тип' });
      return;
    }
    const lead = briefDb.getLeadById(leadId);
    if (!lead) {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Лид не найден' });
      return;
    }
    if (lead.status !== 'new') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Лид уже обработан' });
      return;
    }
    let brief;
    try {
      brief = briefDb.createBrief({
        brief_type: briefType,
        client_name: lead.name,
        client_contact: lead.contact,
        email: lead.email,
        source: 'landing',
        lead_id: leadId,
      });
      briefDb.updateLeadStatus(leadId, 'processed', brief.id);
    } catch (err) {
      console.error('[lead-cb] create brief failed:', err.message);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Ошибка создания брифа' });
      return;
    }
    const typeTitle = BRIEF_TYPE_TITLES[briefType] || briefType.toUpperCase();
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: `Бриф [${typeTitle}] создан` });

    // Редактируем оригинальное сообщение лида: вместо 4 кнопок выбора типа —
    // блок «Создан бриф [X]» + ссылки (прямая + deep-link для клиента).
    const msg = formatBriefCreatedMessage({
      brief, briefType,
      clientName: lead.name, clientContact: lead.contact, email: lead.email,
    });
    const newText = (cb.message?.text || '') + `\n\n✅ <i>Создан бриф</i>\n\n` + msg.text;
    try {
      await tgApi('editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: newText,
        reply_markup: msg.reply_markup,
      });
    } catch (e) {
      console.error('[lead-cb] editMessageText failed:', e.message);
    }
    return;
  }

  // Отклонение лида: lead:reject:<id>
  m = data.match(/^lead:reject:(\d+)$/);
  if (m) {
    const leadId = parseInt(m[1], 10);
    const lead = briefDb.getLeadById(leadId);
    if (!lead) {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Лид не найден' });
      return;
    }
    if (lead.status !== 'new') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Лид уже обработан' });
      return;
    }
    briefDb.updateLeadStatus(leadId, 'rejected');
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отклонено' });
    const newText = (cb.message?.text || '') + `\n\n❌ <i>Отклонено</i>`;
    try {
      await tgApi('editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: newText,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (e) {
      console.error('[lead-cb] reject editMessageText failed:', e.message);
    }
    return;
  }

  // ─── Главное меню ─────────────────────────────────────────────────────
  if (data === 'menu:home') {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    return tgApi('editMessageText', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      parse_mode: 'HTML',
      text: '<b>📊 Главное меню МедиаКонвеер</b>\n\nВыбери действие:',
      reply_markup: mainMenuKeyboard(),
    });
  }
  if (data === 'menu:leads') {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    return sendLeadsList(cb.message.message_id);
  }
  if (data === 'menu:briefs') {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    return sendBriefsList('', cb.message.message_id);
  }
  if (data === 'menu:stats') {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    return sendStats(cb.message.message_id);
  }
  if (data === 'menu:new_brief') {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    briefDb.setBotState(cb.from.id, 'new_brief:name', {});
    return tgApi('sendMessage', {
      chat_id: TG_CHAT_ID, parse_mode: 'HTML',
      text: '<b>➕ Новый бриф</b>\n\n<b>Шаг 1/4:</b> Имя клиента?\n\n<i>Просто напишите ответом.</i>',
      reply_markup: NEW_BRIEF_CANCEL_KB,
    });
  }

  // ─── Фильтры списка брифов ────────────────────────────────────────────
  m = data.match(/^briefs:(\w+)$/);
  if (m) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: m[1] });
    return sendBriefsList(m[1], cb.message.message_id);
  }

  // ─── Диалог /new_brief ────────────────────────────────────────────────
  if (data === 'new_brief:cancel') {
    briefDb.clearBotState(cb.from.id);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отменено' });
    return tgApi('editMessageReplyMarkup', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  if (data === 'new_brief:skip_email') {
    const state = briefDb.getBotState(cb.from.id);
    if (!state || state.state !== 'new_brief:email') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Сессия истекла' });
      return;
    }
    state.context.email = '';
    briefDb.setBotState(cb.from.id, 'new_brief:type', state.context);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    return sendNewBriefTypeStep(cb.message.message_id);
  }

  m = data.match(/^new_brief:type:(\w+)$/);
  if (m) {
    const briefType = m[1];
    if (!briefDb.BRIEF_TYPES.includes(briefType)) {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Неизвестный тип' });
      return;
    }
    const state = briefDb.getBotState(cb.from.id);
    if (!state || state.state !== 'new_brief:type') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Сессия истекла' });
      return;
    }
    state.context.brief_type = briefType;
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: BRIEF_TYPE_TITLES[briefType] });
    return sendNewBriefConfirm(cb.from.id, state.context, cb.message.message_id);
  }

  if (data === 'new_brief:confirm') {
    const state = briefDb.getBotState(cb.from.id);
    if (!state || state.state !== 'new_brief:confirm') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Сессия истекла' });
      return;
    }
    const ctx = state.context;
    let brief;
    try {
      brief = briefDb.createBrief({
        brief_type: ctx.brief_type,
        client_name: ctx.client_name,
        client_contact: ctx.client_contact,
        email: ctx.email,
        source: 'bot',
      });
      briefDb.clearBotState(cb.from.id);
    } catch (e) {
      console.error('[new_brief] createBrief failed:', e.message);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Ошибка создания' });
      return;
    }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Бриф создан' });
    const msg = formatBriefCreatedMessage({
      brief, briefType: ctx.brief_type,
      clientName: ctx.client_name, clientContact: ctx.client_contact, email: ctx.email,
    });
    return tgApi('editMessageText', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      parse_mode: 'HTML', disable_web_page_preview: true,
      text: msg.text,
      reply_markup: msg.reply_markup,
    });
  }

  await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Неизвестная команда' });
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

function shortToken(token) {
  return (token || '').slice(0, 8);
}

function briefDirectUrl(brief) {
  return `${PUBLIC_BASE_URL}/brief?token=${brief.token}`;
}

function briefDeepLink(brief) {
  return `https://t.me/${TG_BOT_USERNAME}?start=b_${shortToken(brief.token)}`;
}

function firstName(fullName) {
  if (!fullName) return '';
  const trimmed = String(fullName).trim();
  const m = trimmed.match(/^[^\s,]+/);
  return m ? m[0] : trimmed.slice(0, 30);
}

function clientReadyText({ clientName, deepLink, directUrl }) {
  const name = firstName(clientName);
  const greet = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  return [
    `${greet} Спасибо за заявку с media-konveyer.ru.`,
    '',
    'Чтобы я подготовил стратегию и контент-план, заполните детальный бриф (20–25 минут, прогресс сохраняется автоматически).',
    '',
    `📲 Если есть Telegram — нажмите на ссылку, в чате с ботом нажмите START, он пришлёт форму:`,
    deepLink,
    '',
    `🌐 Если удобнее в браузере:`,
    directUrl,
    '',
    '— МедиаКонвеер',
  ].join('\n');
}

function isEmailLike(s) {
  return s && /@/.test(s) && /\./.test(s) && !s.startsWith('@');
}

function formatBriefCreatedMessage({ brief, briefType, clientName, clientContact, email }) {
  const typeTitle = BRIEF_TYPE_TITLES[briefType] || briefType.toUpperCase();
  const directUrl = briefDirectUrl(brief);
  const deepLink = briefDeepLink(brief);
  const expires = new Date(Date.now() + briefDb.TOKEN_LIFETIME_DAYS * 86_400_000);
  const expiresFmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: 'long',
  }).format(expires);

  const readyText = clientReadyText({ clientName, deepLink, directUrl });

  const lines = [
    `🔗 <b>Ссылка на бриф</b> [${escapeHtml(typeTitle)}]`,
    '',
    `👤 ${escapeHtml(clientName || '—')}`,
  ];
  if (clientContact) lines.push(`📞 ${escapeHtml(clientContact)}`);
  if (email) lines.push(`✉️ ${escapeHtml(email)}`);
  lines.push(
    '',
    '<b>📤 Готовый текст для клиента</b> <i>(тапни на блок ниже и удерживай → «Скопировать»):</i>',
    '<blockquote>' + escapeHtml(readyText) + '</blockquote>',
    '',
    '<i>Перешли клиенту любым каналом: Telegram, email, мессенджер.</i>',
    '',
    `<i>Бриф действует до ${expiresFmt}.</i>`,
  );

  // Кнопки: открыть бриф, скопировать deep-link, и (если email) — готовый mailto:
  const row1 = [
    { text: '🔗 Открыть бриф', url: directUrl },
    { text: '📲 Открыть deep-link', url: deepLink },
  ];
  const keyboard = [row1];
  if (isEmailLike(email)) {
    const subject = encodeURIComponent('Бриф МедиаКонвеер');
    const body = encodeURIComponent(readyText);
    keyboard.push([
      { text: '✉️ Отправить email клиенту', url: `mailto:${email}?subject=${subject}&body=${body}` },
    ]);
  }

  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: keyboard },
  };
}

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

function formatLead({ id, name, contact, email, category, revenue, page, ip, ts }) {
  const dt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(ts);
  const lines = [
    `🔥 <b>Новая заявка</b> с media-konveyer.ru${id ? ` <code>#${id}</code>` : ''}`,
    '',
    `👤 <b>Имя:</b> ${escapeHtml(name)}`,
    `📞 <b>Контакт:</b> ${escapeHtml(contact)}`,
  ];
  if (email) lines.push(`✉️ <b>Email:</b> ${escapeHtml(email)}`);
  lines.push(
    `🏷 <b>Категория:</b> ${escapeHtml(category)}`,
    `💰 <b>Оборот:</b> ${escapeHtml(revenue || 'не указан')}`,
    '',
    `🌐 <b>Страница:</b> ${escapeHtml(page || '-')}`,
    `🕒 ${dt} МСК`,
    `🌍 IP: <code>${escapeHtml(ip)}</code>`,
  );
  return lines.join('\n');
}

const LEAD_KEYBOARD = (leadId) => ({
  inline_keyboard: [
    [
      { text: '💼 Селлер',  callback_data: `lead:create:${leadId}:seller` },
      { text: '🎓 Эксперт', callback_data: `lead:create:${leadId}:expert` },
    ],
    [
      { text: '🏢 B2B',         callback_data: `lead:create:${leadId}:agency` },
      { text: '❌ Отклонить',   callback_data: `lead:reject:${leadId}` },
    ],
  ],
});

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
  const email = String(payload.email || '').trim();
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

  // Сохраняем в БД, потом шлём в TG с inline-кнопками выбора типа брифа.
  let lead;
  try {
    lead = briefDb.createLead({
      name, contact, email, category, revenue,
      ip_address: ip, page,
    });
  } catch (err) {
    console.error('[lead] db save failed:', err.message);
    return jsonReply(res, 500, { ok: false, error: 'db_failed' }, origin);
  }

  const text = formatLead({
    id: lead.id, name, contact, email, category, revenue, page, ip, ts: new Date(),
  });

  try {
    await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text,
      reply_markup: LEAD_KEYBOARD(lead.id),
    });
  } catch (err) {
    console.error('[lead] telegram send failed:', err.message);
    // лид в БД — не теряем, но клиенту вернём 502
    return jsonReply(res, 502, { ok: false, error: 'telegram_failed' }, origin);
  }

  console.log('[lead] delivered', { id: lead.id, ts: new Date().toISOString(), category, ip });
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
