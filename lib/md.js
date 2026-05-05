'use strict';

// Генерация brief.md из brief — объект с полем .data (JSON ответов).
// Поддерживает три типа: seller / expert / agency.

function v(x) {
  if (x == null || x === '') return '—';
  if (Array.isArray(x)) {
    if (!x.length) return '—';
    return x.map((y) => (typeof y === 'object' ? JSON.stringify(y) : y)).join(', ');
  }
  return String(x);
}

function asList(arr, fallback = '_не заполнено_') {
  if (!arr) return fallback;
  if (!Array.isArray(arr)) return String(arr);
  if (!arr.length) return fallback;
  return arr.map((x) => `- ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n');
}

function channelsTable(arr, columns = ['Канал', 'Статус', 'Подписчиков', 'Частота', 'Контент']) {
  if (!Array.isArray(arr) || !arr.length) return '_не заполнено_';
  const lines = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const ch of arr) {
    lines.push(
      `| ${v(ch.name)} | ${v(ch.status)} | ${v(ch.followers)} | ${v(ch.frequency)} | ${v(ch.assets)} |`
    );
  }
  return lines.join('\n');
}

function header(b, typeTitle) {
  const d = b.data || {};
  return `# Бриф клиента: ${v(b.client_name)} [${typeTitle}]

**Дата заполнения:** ${v(b.completed_at)}
**Контакт (первичный):** ${v(b.client_contact)}
**Email:** ${v(b.email || d.email)}
**Telegram:** ${v(d.telegram)}
**Удобное время для созвонов:** ${v(d.call_time)}

---`;
}

function footer(b) {
  return `\n_Бриф ID: ${b.id} · Тип: ${b.brief_type} · Token: \`${b.token}\` · IP: ${v(b.ip_address)}_\n`;
}

function renderSeller(b) {
  const d = b.data || {};
  return `${header(b, 'СЕЛЛЕР')}

## 1. Бренд

**Название:** ${v(d.brand_name)}
**Что продаёте:** ${v(d.brand_what_sell)}
**На рынке:** ${v(d.brand_years_on_market)}
**Маркетплейсы:** ${v(d.brand_marketplaces)}
**Тип бренда:** ${v(d.brand_personality)}
**Лицо бренда:** ${v(d.brand_face_info)}

**История:**
${v(d.brand_history)}

---

## 2. Покупатель

**Демография:** ${v(d.customer_demographics)}
**География:** ${v(d.customer_geography)}
**Образ жизни:** ${v(d.customer_lifestyle)}
**Какую проблему решает:** ${v(d.customer_problem)}

**До покупки:** ${v(d.customer_before)}
**После покупки:** ${v(d.customer_after)}
**Главный сегмент:** ${v(d.customer_main_segment)}

---

## 3. Тон и стиль

**Обращение:** ${v(d.tone_address)}
**Эмодзи:** ${v(d.tone_emoji)}
**Юмор:** ${v(d.tone_humor)}
**Позиция бренда:** ${v(d.brand_position)}

**Вдохновляющие бренды/блогеры:** ${v(d.inspiring_brands)}
**Что нравится в их коммуникации:** ${v(d.inspiring_what_likes)}

**Стоп-лист:**
- Слова: ${v(d.stop_words)}
- Темы: ${v(d.stop_topics)}
- Форматы: ${v(d.stop_formats)}

---

## 4. Ассортимент и ценник

**Категория на МП:** ${v(d.product_category)}
**Товар-локомотив:** ${v(d.product_locomotive)}
**Доля локомотива:** ${v(d.locomotive_share)}
**Активных SKU:** ${v(d.total_sku)}
**Сегмент:** ${v(d.segment)}
**Средний чек:** ${v(d.average_check)}

---

## 5. Каналы

${channelsTable(d.channels)}

**С какого канала начать (если каналов нет):** ${v(d.first_channel)}
**Готовность снимать вертикальные видео:** ${v(d.vertical_video)}

---

## 6. Цели и метрики

**Главные цели:**
${asList(d.main_goals)}

**Через 3 месяца:** ${v(d.goal_3_months)}
**Через 6 месяцев:** ${v(d.goal_6_months)}

---

## 7. Активы и команда

**Контентные активы:**
${asList(d.content_assets)}

**Подробности активов:**
${v(d.assets_details)}

**Команда:**
- Тексты: ${v(d.team_writer)}
- Видео: ${v(d.team_videographer)}
- Публикация и комментарии: ${v(d.team_publisher)}
- Бюджет на контент в месяц: ${v(d.content_budget)}
- Кто будет публиковать: ${v(d.who_publishes)}

**Боль:**
- Что съедает время: ${v(d.pain_time_eater)}
- Что не получается: ${v(d.pain_doesnt_work)}

---

## 8. Сезонность и планы

**Пиковые месяцы:** ${v(d.peak_months)}
**Месяцы провала:** ${v(d.low_months)}

**Запуски/коллекции:**
${v(d.upcoming_launches)}

**Распродажи МП:**
${asList(d.marketplace_sales)}

---
${footer(b)}`;
}

function renderExpert(b) {
  const d = b.data || {};
  return `${header(b, 'ЭКСПЕРТ')}

## 1. Кто вы и ваша экспертиза

**Имя и фамилия:** ${v(d.expert_name)}
**Ниша:** ${v(d.niche)}
**В практике/преподавании:** ${v(d.years_in_practice)}
**Регалии и доказательства:** ${v(d.credentials)}
**Главное отличие в нише:** ${v(d.differentiator)}
**Команда:** ${v(d.team_size)}

---

## 2. Аудитория

**Кто они:** ${v(d.audience_demographics)}
**География:** ${v(d.audience_geography)}
**Триггер (что заставляет искать продукт):** ${v(d.audience_trigger)}
**Главная боль:** ${v(d.audience_pain)}
**Главный результат от продукта:** ${v(d.audience_desired_outcome)}
**Главное возражение:** ${v(d.audience_objection)}
**Где они «живут»:** ${v(d.audience_lives_where)}

---

## 3. Тон и стиль

**Обращение:** ${v(d.tone_address)}
**Эмодзи:** ${v(d.tone_emoji)}
**Юмор:** ${v(d.tone_humor)}
**Личные истории:** ${v(d.tone_personal_stories)}
**Длина текстов:** ${v(d.tone_length)}
**Позиция эксперта:** ${v(d.expert_position)}

**Вдохновляющие эксперты/авторы:** ${v(d.inspiring_experts)}
**Что нравится в их коммуникации:** ${v(d.inspiring_what_likes)}

**Стоп-лист:**
- Слова: ${v(d.stop_words)}
- Темы: ${v(d.stop_topics)}
- Форматы: ${v(d.stop_formats)}

---

## 4. Продукт и линейка

**Главный продукт:** ${v(d.main_product_name)}
**Формат:** ${v(d.main_product_format)}
**Длительность/объём:** ${v(d.main_product_volume)}
**Цена главного продукта:** ${v(d.main_product_price)}
**Уровень учеников (если курс):** ${v(d.audience_level)}

**Линейка:**
- Бесплатное: ${v(d.product_free)}
- Дешёвый вход: ${v(d.product_tripwire)}
- Основной: ${v(d.product_main)}
- Премиум/VIP: ${v(d.product_premium)}

**Цикл сделки:** ${v(d.deal_cycle)}
**Как часто продаёте:** ${v(d.sales_cadence)}

---

## 5. Каналы и воронка

${channelsTable(d.channels)}

**С какого канала начать (если каналов нет):** ${v(d.first_channel)}

**Где клиент в итоге платит:** ${v(d.payment_funnel)}
**Готовность к вертикальным видео:** ${v(d.vertical_video)}

---

## 6. Цели и метрики

**Главные цели:**
${asList(d.main_goals)}

**Через 3 месяца:** ${v(d.goal_3_months)}
**Через 6 месяцев:** ${v(d.goal_6_months)}

---

## 7. Активы и команда

**Контентные активы:**
${asList(d.content_assets)}

**Команда:**
- Тексты: ${v(d.team_writer)}
- Видео: ${v(d.team_videographer)}
- Продюсер/методолог/ассистент: ${v(d.team_producer)}
- Бюджет на контент: ${v(d.content_budget)}
- Кто будет публиковать: ${v(d.who_publishes)}

**Боль:**
- Что съедает время: ${v(d.pain_time_eater)}
- Что не получается: ${v(d.pain_doesnt_work)}

---

## 8. Запуски и сезонность

**Ближайший запуск:** ${v(d.upcoming_launch)}
**Сезонность спроса:** ${v(d.seasonality)}

**Запуски/новые продукты на 3 месяца:**
${v(d.upcoming_launches)}

**Важные даты ниши:**
${asList(d.niche_dates)}

---
${footer(b)}`;
}

function renderAgency(b) {
  const d = b.data || {};
  return `${header(b, 'УСЛУГИ / B2B')}

## 1. Компания и услуги

**Название:** ${v(d.company_name)}
**Что делаете:** ${v(d.company_what)}
**Лет на рынке:** ${v(d.company_years)}
**Тип бизнеса:** ${v(d.business_type)}
**Тип бренда:** ${v(d.brand_personality)}
**Лицо бренда:** ${v(d.brand_face_info)}
**История:** ${v(d.company_history)}

---

## 2. Клиенты

**Если B2B — типичный клиент:** ${v(d.b2b_typical_client)}
**Размер компании:** ${v(d.b2b_company_size)}
**ЛПР:** ${v(d.b2b_decision_maker)}
**Кто ещё участвует в решении:** ${v(d.b2b_other_participants)}

**Если B2C — демография:** ${v(d.b2c_demographics)}
**Если B2C — география:** ${v(d.b2c_geography)}

**Какую проблему решает услуга:** ${v(d.problem_solved)}
**До обращения:** ${v(d.customer_before)}
**После:** ${v(d.customer_after)}
**Главное возражение:** ${v(d.main_objection)}

---

## 3. Тон и стиль

**Обращение:** ${v(d.tone_address)}
**Эмодзи:** ${v(d.tone_emoji)}
**Юмор:** ${v(d.tone_humor)}
**Позиция бренда:** ${v(d.brand_position)}

**Вдохновляющие бренды:** ${v(d.inspiring_brands)}
**Что нравится в коммуникации:** ${v(d.inspiring_what_likes)}

**Стоп-лист:**
- Слова: ${v(d.stop_words)}
- Темы: ${v(d.stop_topics)}
- Форматы: ${v(d.stop_formats)}

---

## 4. Услуги и пакеты

**Главная услуга:** ${v(d.main_service_name)}
**Что входит:** ${v(d.main_service_what)}
**Формат:** ${v(d.main_service_format)}
**Средний чек / стоимость:** ${v(d.main_service_price)}
**Длительность работы с клиентом:** ${v(d.engagement_length)}

**Линейка:**
- Бесплатное (аудит/демо): ${v(d.service_free)}
- Лёгкий вход: ${v(d.service_entry)}
- Основная услуга: ${v(d.service_main)}
- Премиум/VIP: ${v(d.service_premium)}

**Цикл сделки:** ${v(d.deal_cycle)}
**Маржинальность:** ${v(d.margin)}

---

## 5. Каналы и воронка

${channelsTable(d.channels)}

**С какого канала начать (если каналов нет):** ${v(d.first_channel)}

**Откуда сейчас приходят клиенты:** ${v(d.lead_sources)}
**Куда ведёте на продажу:** ${v(d.sales_funnel_target)}
**Готовность к вертикальным видео:** ${v(d.vertical_video)}

---

## 6. Цели и метрики

**Главные цели:**
${asList(d.main_goals)}

**Через 3 месяца:** ${v(d.goal_3_months)}
**Через 6 месяцев:** ${v(d.goal_6_months)}

---

## 7. Активы и команда

**Контентные активы:**
${asList(d.content_assets)}

**Команда:**
- Тексты: ${v(d.team_writer)}
- Видео: ${v(d.team_videographer)}
- Маркетолог/продюсер/SMM: ${v(d.team_marketing)}
- Бюджет на контент-маркетинг: ${v(d.content_budget)}
- Кто будет публиковать: ${v(d.who_publishes)}

**NDA / открытость:** ${v(d.nda_policy)}

**Боль:**
- Что съедает время: ${v(d.pain_time_eater)}
- Что не получается: ${v(d.pain_doesnt_work)}

---

## 8. Сезонность и крупные проекты

**Пиковые месяцы спроса:** ${v(d.peak_months)}
**Привязка к бюджетным циклам клиентов:** ${v(d.budget_cycles)}

**Крупные проекты на 3 месяца:**
${v(d.upcoming_projects)}

**Отраслевые поводы:**
${asList(d.industry_events)}

---
${footer(b)}`;
}

function renderBriefMd(b) {
  const t = b.brief_type || 'seller';
  if (t === 'expert') return renderExpert(b);
  if (t === 'agency') return renderAgency(b);
  return renderSeller(b);
}

module.exports = { renderBriefMd };
