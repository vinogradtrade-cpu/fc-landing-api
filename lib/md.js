'use strict';

// Генерация brief.md из строки таблицы briefs.

function v(x) {
  if (x == null || x === '') return '—';
  return String(x);
}

function asList(jsonStr, fallback = '—') {
  if (!jsonStr) return fallback;
  try {
    const arr = JSON.parse(jsonStr);
    if (Array.isArray(arr) && arr.length) {
      return arr.map((x) => `- ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n');
    }
    return fallback;
  } catch {
    return String(jsonStr);
  }
}

function channelsTable(jsonStr) {
  if (!jsonStr) return '_не заполнено_';
  let arr;
  try {
    arr = JSON.parse(jsonStr);
  } catch {
    return String(jsonStr);
  }
  if (!Array.isArray(arr) || !arr.length) return '_не заполнено_';
  const lines = [
    '| Канал | Статус | Подписчиков | Частота | Что снято/написано |',
    '|---|---|---|---|---|',
  ];
  for (const ch of arr) {
    lines.push(
      `| ${v(ch.name)} | ${v(ch.status)} | ${v(ch.followers)} | ${v(ch.frequency)} | ${v(ch.assets)} |`
    );
  }
  return lines.join('\n');
}

function renderBriefMd(b) {
  return `# Бриф клиента: ${v(b.client_name)}

**Дата заполнения:** ${v(b.completed_at)}
**Контакт (первичный):** ${v(b.client_contact)}
**Email:** ${v(b.email)}
**Telegram:** ${v(b.telegram)}
**Удобное время для созвонов:** ${v(b.call_time)}

---

## 1. Бренд

**Название:** ${v(b.brand_name)}
**Что продаёте:** ${v(b.brand_what_sell)}
**На рынке:** ${v(b.brand_years_on_market)}
**Маркетплейсы:** ${asList(b.brand_marketplaces, v(b.brand_marketplaces))}
**Тип бренда:** ${v(b.brand_personality)}
**Лицо бренда:** ${v(b.brand_face_info)}

**История:**
${v(b.brand_history)}

---

## 2. Покупатель

**Демография:** ${v(b.customer_demographics)}
**География:** ${v(b.customer_geography)}
**Образ жизни:** ${v(b.customer_lifestyle)}
**Какую проблему решает:** ${v(b.customer_problem)}

**До покупки:** ${v(b.customer_before)}
**После покупки:** ${v(b.customer_after)}
**Главный сегмент:** ${v(b.customer_main_segment)}

---

## 3. Тон и стиль

**Обращение:** ${v(b.tone_address)}
**Эмодзи:** ${v(b.tone_emoji)}
**Юмор:** ${v(b.tone_humor)}
**Позиция бренда:** ${v(b.brand_position)}

**Вдохновляющие бренды/блогеры:** ${v(b.inspiring_brands)}
**Что нравится в их коммуникации:** ${v(b.inspiring_what_likes)}

**Стоп-лист:**
- Слова: ${v(b.stop_words)}
- Темы: ${v(b.stop_topics)}
- Форматы: ${v(b.stop_formats)}

---

## 4. Ассортимент и ценник

**Категория на МП:** ${v(b.product_category)}
**Товар-локомотив:** ${v(b.product_locomotive)}
**Доля локомотива:** ${v(b.locomotive_share)}
**Активных SKU:** ${v(b.total_sku)}
**Сегмент:** ${v(b.segment)}
**Средний чек:** ${v(b.average_check)}

---

## 5. Каналы

${channelsTable(b.channels)}

**С какого канала начать (если каналов нет):** ${v(b.first_channel)}
**Готовность снимать вертикальные видео:** ${v(b.vertical_video)}

---

## 6. Цели и метрики

**Главные цели:**
${asList(b.main_goals)}

**Через 3 месяца:** ${v(b.goal_3_months)}
**Через 6 месяцев:** ${v(b.goal_6_months)}

---

## 7. Активы и команда

**Контентные активы:**
${asList(b.content_assets)}

**Подробности активов:**
${v(b.assets_details)}

**Команда:**
- Тексты: ${v(b.team_writer)}
- Видео: ${v(b.team_videographer)}
- Публикация и комментарии: ${v(b.team_publisher)}
- Бюджет на контент в месяц: ${v(b.content_budget)}
- Кто будет публиковать: ${v(b.who_publishes)}

**Боль:**
- Что съедает время: ${v(b.pain_time_eater)}
- Что не получается: ${v(b.pain_doesnt_work)}

---

## 8. Сезонность и планы

**Пиковые месяцы:** ${v(b.peak_months)}
**Месяцы провала:** ${v(b.low_months)}

**Запуски/коллекции:**
${v(b.upcoming_launches)}

**Распродажи МП:**
${asList(b.marketplace_sales)}

---

_Бриф ID: ${b.id} · Token: \`${b.token}\` · IP: ${v(b.ip_address)}_
`;
}

module.exports = { renderBriefMd };
