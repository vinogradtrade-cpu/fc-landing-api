# Чек-лист тестирования fc-landing-api

Проходим после каждого деплоя или при подозрении на регрессию.
Все команды для локального терминала, кроме отмеченных как "в группе TG".

## Переменные

```bash
ADMIN='<значение из /opt/fc-landing-api/shared/.env>'
TG_TOKEN='<токен бота>'
PUBLIC=https://media-konveyer.ru
```

---

## 1. Healthcheck

```bash
curl -fsS "$PUBLIC/api/health"
# ожидание: {"ok":true,"service":"fc-landing-api"}
```

✅ — 200, ok:true

---

## 2. Лендинг → лид → бриф

**Создание лида с лендинга:**

```bash
curl -sS -X POST "$PUBLIC/api/lead" \
  -H "Content-Type: application/json" \
  -H "Origin: $PUBLIC" \
  -d '{
    "name":"E2E Lead",
    "contact":"@e2e_test",
    "email":"e2e@test.ru",
    "category":"Одежда",
    "revenue":"1-3 млн",
    "consent":true,
    "page":"https://media-konveyer.ru/?utm=test"
  }'
```

**В группе TG:**
- ✅ Прилетело сообщение `🔥 Новая заявка #N`
- ✅ Под ним 4 кнопки: `[💼 Селлер] [🎓 Эксперт] [🏢 B2B] [❌ Отклонить]`

**Конверсия в бриф:**
- Нажать `[💼 Селлер]`
- ✅ Алерт «Бриф [СЕЛЛЕР] создан»
- ✅ Сообщение редактируется: добавлен `✅ Создан бриф [СЕЛЛЕР]` + ссылка
- ✅ Кнопки заменены на одну `[🔗 Открыть бриф]`

**Повторное нажатие:**
- ✅ Алерт «Лид уже обработан», изменений нет

---

## 3. Форма брифа

```bash
# Создаём ссылку через admin API
RESP=$(curl -sS -X POST "$PUBLIC/api/admin/create-brief-link" \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Test","client_contact":"@t","brief_type":"expert"}')
TOKEN=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
URL="$PUBLIC/brief?token=$TOKEN"
echo "$URL"
```

**Браузер:**
- ✅ Открыть URL — рендерится форма с тегом `[ЭКСПЕРТ]` в шапке
- ✅ Прогресс-бар (Шаг 1 из 9)
- ✅ Заполнить шаг 1, нажать «Далее →» — переходит на шаг 2
- ✅ Поле обязательное (помечено `*`) даёт ошибку при пустом значении
- ✅ Закрыть вкладку, открыть заново — форма открыта на последнем шаге, поля восстановлены
- ✅ Дойти до конца, отправить — увидеть «Спасибо!»

**В группе TG (после сабмита):**
- ✅ Прилетело `✅ Заполнен бриф [ЭКСПЕРТ]` со сводкой
- ✅ Кнопка `[📥 Скачать brief.md]`
- ✅ Нажать кнопку — бот шлёт `.md` как документ в чат

**Повторное открытие ссылки:**
- ✅ Страница «Бриф уже заполнен»

---

## 4. Bot relay (поддержка через бота)

**В Telegram (личка с @mediakonveyer_bot):**
- Написать `/start` — приветствие
- Написать «привет от теста»
- ✅ В группе появляется `💬 Новое сообщение пользователю` со sтегом `🆔 user_id:N`

**В группе:**
- Сделать reply на пересланное сообщение, написать «получено»
- ✅ Юзер в личке получает «получено» от бота

---

## 5. Команды бота в группе

В группе TG:

| Команда | Ожидание |
|---|---|
| `/menu` или `/start` | 4 кнопки `[🔥 Заявки (N)] [📋 Брифы (N)] [➕ Создать] [📈 Статистика]` |
| `/help` | Текст-справка с командами и фильтрами |
| `/new_brief` | Запускается диалог: «Шаг 1/4: Имя клиента?» |
| `/cancel` | «❌ Текущий диалог отменён» (если был активен) |
| `/list_briefs` | Список последних брифов со статус-иконками |
| `/list_briefs pending` | Только pending |
| `/list_briefs expert` | Только expert |
| `/stats` | 30-дневный отчёт |
| `/brief Иван \| @иван \| email \| seller` | Ссылка с тегом [СЕЛЛЕР] |

**Диалог `/new_brief`:**
1. Имя → пишешь
2. Контакт → пишешь
3. Email → пишешь или `⏭ Пропустить`
4. Тип → 1 из 3 кнопок
5. Подтверждение → `✅ Создать` → ссылка с `[🔗 Открыть бриф]`
6. На любом шаге `❌ Отмена` или `/cancel`

---

## 6. Безопасность

```bash
# admin без auth
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$PUBLIC/api/admin/create-brief-link" \
  -H "Content-Type: application/json" -d '{}'
# ожидание: 401

# /api/lead с пустым именем
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$PUBLIC/api/lead" \
  -H "Content-Type: application/json" \
  -d '{"name":"","contact":"@x","category":"Одежда","consent":true}'
# ожидание: 400

# rate-limit /api/lead — пушим 6 запросов подряд
for i in 1 2 3 4 5 6 7; do
  echo -n "$i: "
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$PUBLIC/api/lead" \
    -H "Content-Type: application/json" \
    -d '{"name":"rl","contact":"@rl","category":"Другое","consent":true}'
done
# ожидание: первые 5 → 200/502 (зависит от TG), последние → 429
```

---

## 7. БД

```bash
ssh vps-claude 'node -e "
const { DatabaseSync } = require(\"node:sqlite\");
const db = new DatabaseSync(\"/opt/fc-landing-api/shared/briefs.db\");
console.log(\"version:\", db.prepare(\"PRAGMA user_version\").get().user_version);
console.log(\"briefs:\", db.prepare(\"SELECT COUNT(*) AS c FROM briefs\").get().c);
console.log(\"leads:\", db.prepare(\"SELECT COUNT(*) AS c FROM leads\").get().c);
console.log(\"states:\", db.prepare(\"SELECT COUNT(*) AS c FROM bot_states\").get().c);
" 2>&1 | grep -v Experimental'
```

✅ version: 2, и значимые числа

---

## 8. Backup

```bash
ssh vps-claude 'bash /opt/fc-landing-api/current/scripts/backup-db.sh && ls -la /opt/fc-landing-api/shared/backups/ | tail -3'
```

✅ Свежий `briefs-YYYYMMDD-HHMMSS.db.gz` в shared/backups/

---

## 9. Healthcheck Telegram webhook

```bash
curl -s "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo" | python3 -m json.tool
```

✅ `url: https://media-konveyer.ru/api/tg/webhook`
✅ `pending_update_count: 0` (или близко к 0)
✅ `last_error_date` если есть — старше последнего перезапуска (значит уже починилось)

---

## Если что-то падает

| Симптом | Куда смотреть |
|---|---|
| 504 Gateway Timeout на сабмите | `pm2 logs fc-landing-api --lines 50` — ищем стек |
| Кнопка не работает | `getWebhookInfo` — `last_error_message`; позже `pm2 logs` |
| Не обновляется страница после деплоя | Hard refresh (Cmd+Shift+R) |
| Нельзя создать бриф из бота | `pm2 describe fc-landing-api` — script path должен указывать на текущий релиз |
| БД-схема не та | `node -e "...PRAGMA user_version..."` — должно быть 2 |
