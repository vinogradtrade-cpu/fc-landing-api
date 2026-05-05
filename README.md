# fc-landing-api

Backend для сайта **media-konveyer.ru**: приём лидов, формы детальных брифов трёх типов (селлер / эксперт / B2B), Telegram-бот как админ-интерфейс.

---

## Что внутри

```
       ┌─────────────────┐         ┌─────────────────┐
       │ media-konveyer  │  POST   │  fc-landing-api │
       │ форма заявки    │  ─────▶ │  /api/lead      │
       └─────────────────┘         │                 │
                                   │  /api/brief/*   │ ◀───┐
       ┌─────────────────┐  POST   │  /api/admin/*   │     │
       │  /brief?token   │  ─────▶ │  /api/tg/webhook│     │
       │ форма брифа     │         │                 │     │
       └─────────────────┘         └────────┬────────┘     │
                                            │              │
                                            ▼              │
                                    ┌──────────────┐       │
                                    │ SQLite (WAL) │       │
                                    │ briefs.db    │       │
                                    └──────────────┘       │
                                            ▲              │
                                            │              │
                                   ┌────────┴────────┐     │
                                   │ @mediakonveyer  │ ◀───┤
                                   │      _bot       │     │
                                   │ • командам      │     │
                                   │ • кнопкам       │─────┘
                                   │ • relay поддержка│
                                   └─────────────────┘
```

---

## Архитектура

| Компонент | Файл / путь |
|---|---|
| HTTP-сервер | [server.js](server.js) — Node `http` без зависимостей |
| БД | [db.js](db.js) — `node:sqlite`, миграции через `PRAGMA user_version` |
| Схемы брифов | [schemas/](schemas/) — JSON-схемы трёх типов (single source of truth) |
| Рендерер форм | [lib/forms.js](lib/forms.js) — Schema → HTML |
| Шаблон формы | [views/form.html](views/form.html) — общий, без хардкода полей |
| Markdown-экспорт | [lib/md.js](lib/md.js) — `brief.data` → `.md` |
| Шаблонизатор | [lib/render.js](lib/render.js) — `{{var}}` и `{{#var}}...{{/var}}` |
| Скрипт создания ссылки | [scripts/create-brief.sh](scripts/create-brief.sh) |
| Backup БД | [scripts/backup-db.sh](scripts/backup-db.sh) |
| Чек-лист тестов | [deploy/TESTING.md](deploy/TESTING.md) |

**Без зависимостей.** Используется только встроенный Node.js (требуется ≥22). `npm install` не выполняется ни локально, ни на VPS.

---

## БД-схема (v2)

```
leads                    — лиды с лендинга
  status: new | processed | rejected
  brief_id → briefs.id (NULL до конверсии)

briefs                   — общая таблица брифов всех типов
  brief_type: seller | expert | agency
  source: landing | manual | bot
  status: pending | in_progress | completed | expired
  lead_id → leads.id (если создан из лида)

briefs_seller_data       — JSON ответов для селлера
briefs_expert_data       — JSON ответов для эксперта
briefs_agency_data       — JSON ответов для агентства

bot_states               — state machine для диалогов в боте
  user_id, state, context (JSON)

bot_logs                 — аудит-лог действий бота
```

Миграции применяются автоматически при старте процесса.

---

## API эндпоинты

### Публичные

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/health` | Healthcheck — `{ok:true}` |
| `POST` | `/api/lead` | Лид с лендинга — пишет в БД, шлёт в TG с 4 кнопками |
| `GET` | `/brief?token=...` | Страница формы брифа (тип определяется по токену) |
| `POST` | `/api/brief/save-progress` | Автосохранение прогресса заполнения |
| `POST` | `/api/brief/submit` | Финальная отправка брифа |
| `POST` | `/api/tg/webhook` | Telegram webhook (защищён `X-Telegram-Bot-Api-Secret-Token`) |

### Админские (header `Authorization: Bearer $ADMIN_TOKEN`)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/admin/create-brief-link` | Создать токен брифа |
| `GET` | `/api/admin/briefs/:token/download` | Скачать `brief.md` |

---

## Telegram-бот: команды

В группе **«МедиаКонвеер заявки»** (`TG_CHAT_ID` в `.env`):

| Команда | Что делает |
|---|---|
| `/menu` или `/start` | Главное меню с inline-кнопками и счётчиками |
| `/new_brief` | Пошаговый диалог создания брифа (имя → контакт → email → тип → confirm) |
| `/brief Имя \| контакт \| email \| тип` | Быстрое создание ссылки одной строкой |
| `/list_briefs [filter]` | Список брифов; фильтры: `pending`, `completed`, `expired`, `seller`, `expert`, `agency` |
| `/stats` | Статистика за 30 дней |
| `/cancel` | Отменить текущий диалог |
| `/help` | Справка |

В **личке** боту: relay-поддержка — пользовательские сообщения пересылаются в группу, ответы (reply) из группы возвращаются пользователю.

### Inline-кнопки на лидах

Уведомление о новом лиде содержит 4 кнопки:
- `💼 Селлер / 🎓 Эксперт / 🏢 B2B` — создаёт бриф нужного типа из данных лида, выдаёт ссылку
- `❌ Отклонить` — помечает лид `rejected`

Сообщение редактируется после действия (кнопки исчезают, добавляется результат).

---

## Переменные окружения

`.env` лежит в `/opt/fc-landing-api/shared/.env` (пример: [.env.example](.env.example)).

| Ключ | Назначение |
|---|---|
| `TG_BOT_TOKEN` | Токен от @BotFather |
| `TG_CHAT_ID` | ID приватной группы для уведомлений |
| `TG_WEBHOOK_SECRET` | Секрет для валидации webhook-запросов |
| `ADMIN_TOKEN` | Токен для `/api/admin/*` (Bearer) |
| `PUBLIC_BASE_URL` | `https://media-konveyer.ru` (для генерации ссылок на бриф) |
| `ALLOWED_ORIGINS` | CORS allowlist (запятая) |
| `PORT` | Локальный порт (по умолчанию 3022) |
| `BRIEF_DB_PATH` | Путь к SQLite (по умолчанию `/opt/fc-landing-api/shared/briefs.db`) |
| `BRIEF_TOKEN_LIFETIME_DAYS` | Срок жизни токена брифа (по умолчанию 14) |

---

## Деплой

GitHub Actions при пуше в `main`:
1. tar архива (без `.git`, `node_modules`, `.env`)
2. scp на VPS
3. распаковка в `/opt/fc-landing-api/releases/<sha>/`
4. атомарное переключение симлинка `current`
5. `pm2 delete + start ecosystem.config.cjs --update-env` (с подгрузкой `.env`)
6. healthcheck `/api/health`
7. чистка старых релизов (оставляется 5)

См. [.github/workflows/deploy.yml](.github/workflows/deploy.yml).

### GitHub Secrets

`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PORT` (опц).

---

## Bootstrap нового сервера

```bash
# На VPS под root:
mkdir -p /opt/fc-landing-api/{releases,shared,shared/backups}
chown -R clawd:clawd /opt/fc-landing-api

# Создать /opt/fc-landing-api/shared/.env по .env.example.
# Сгенерировать ADMIN_TOKEN и TG_WEBHOOK_SECRET через `openssl rand -hex 32`.

# Установить Node ≥22 и pm2 от пользователя clawd, настроить pm2 startup.

# Расширить nginx-конфиг fc-landing.conf:
#   location = /brief    → proxy на 127.0.0.1:3022
#   location  /api/      → proxy на 127.0.0.1:3022
```

После этого — `git push` запустит первый деплой.

### Регистрация Telegram webhook

После деплоя:

```bash
TG_TOKEN=...
SECRET=$(grep TG_WEBHOOK_SECRET /opt/fc-landing-api/shared/.env | cut -d= -f2-)
curl -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  --data-urlencode "url=https://media-konveyer.ru/api/tg/webhook" \
  --data-urlencode "secret_token=$SECRET" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

### Регистрация slash-меню бота для группы

```bash
TG_TOKEN=...
CHAT=-XXXXXXXXXX  # chat_id группы
curl -X POST "https://api.telegram.org/bot$TG_TOKEN/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": {"type":"chat","chat_id":'$CHAT'},
    "commands": [
      {"command":"menu","description":"📊 Главное меню"},
      {"command":"new_brief","description":"➕ Создать бриф через диалог"},
      {"command":"brief","description":"⚡ Быстрое создание"},
      {"command":"list_briefs","description":"📋 Список брифов"},
      {"command":"stats","description":"📈 Статистика"},
      {"command":"cancel","description":"❌ Отменить диалог"},
      {"command":"help","description":"ℹ️ Помощь"}
    ]
  }'
```

---

## Backup и восстановление

### Backup

```bash
bash /opt/fc-landing-api/current/scripts/backup-db.sh
```

Cron под `clawd` (рекомендуется ежедневно ночью):

```cron
0 3 * * * /opt/fc-landing-api/current/scripts/backup-db.sh >> /opt/fc-landing-api/shared/backup.log 2>&1
```

Бэкапы лежат в `/opt/fc-landing-api/shared/backups/briefs-YYYYMMDD-HHMMSS.db.gz`. Хранится последние 30.

### Восстановление

```bash
ssh vps-claude
gunzip -c /opt/fc-landing-api/shared/backups/briefs-20260101-030001.db.gz \
  > /opt/fc-landing-api/shared/briefs.db
pm2 restart fc-landing-api
```

---

## Откат релиза

```bash
ssh vps-claude
cd /opt/fc-landing-api
ls -1t releases | head
ln -sfn /opt/fc-landing-api/releases/<previous-sha> current
cd current && pm2 delete fc-landing-api 2>/dev/null || true
pm2 start ecosystem.config.cjs --update-env
pm2 save
curl -fsS http://127.0.0.1:3022/api/health
```

---

## Тестирование

См. [deploy/TESTING.md](deploy/TESTING.md) — полный чек-лист E2E-тестов после деплоя.

---

## Логи и здоровье

```bash
pm2 logs fc-landing-api --lines 100
pm2 describe fc-landing-api

curl -fsS http://127.0.0.1:3022/api/health
curl -fsS https://media-konveyer.ru/api/health

# Telegram webhook info
curl -s "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo" | python3 -m json.tool

# nginx
sudo tail -f /var/log/nginx/fc-landing.access.log
sudo tail -f /var/log/nginx/fc-landing.error.log
```

---

## Изоляция от других сервисов на VPS

| Что | Значение | Не пересекается с |
|---|---|---|
| `/opt/fc-landing-api` | свой каталог | `/opt/fc-landing`, `/opt/ai-creator`, `/opt/finances`, `/opt/minio` |
| pm2 process `fc-landing-api` | свой | `ai-backend`, `ai-worker`, `finances` |
| Порт `3022` | свой (только для локального nginx-proxy) | `3001`, `3011` |
| nginx-блок | разделяет существующий `fc-landing.conf` через `location /api/` и `location = /brief` | прочие конфиги нетронуты |

---

## Frontend (форма брифа)

`GET /brief?token=...` рендерит [views/form.html](views/form.html), подставляя:
- HTML всех шагов через `renderForm(schema)` из [lib/forms.js](lib/forms.js)
- token, type_title, intro, число шагов

Клиентский JS управляет:
- переходами между шагами + прогресс-баром
- автосохранением в `localStorage` + `POST /api/brief/save-progress` при переходе шага
- restore из localStorage и/или из БД при повторном открытии
- сабмитом через `POST /api/brief/submit`
- генерацией строк таблицы каналов из `data-channels-items` (без хардкода)

Чтобы добавить **новый тип брифа** — достаточно:
1. Создать `schemas/<type>.js` со списком шагов и полей
2. Добавить тип в `BRIEF_TYPES` в [db.js](db.js) и `DATA_TABLE` mapping
3. Создать таблицу `briefs_<type>_data` через миграцию
4. (опц) Добавить рендер `.md` в [lib/md.js](lib/md.js)

Никаких изменений в HTML / JS / nginx не нужно.
