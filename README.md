# fc-landing-api

Маленький Node-сервис для приёма заявок с лендинга `media-konveyer.ru` и отправки их в приватную Telegram-группу.

## Архитектура

```
браузер  →  POST https://media-konveyer.ru/api/lead
            (nginx fc-landing.conf, location /api/)
                    ↓
              127.0.0.1:3022
                    ↓
              fc-landing-api (этот сервис, pm2)
                    ↓
            api.telegram.org/bot<TOKEN>/sendMessage
                    ↓
              приватная TG-группа
```

- **Без зависимостей** — чистый Node `http` + `https`. `npm install` не требуется.
- **Токен и chat_id** — только в `/opt/fc-landing-api/shared/.env` на VPS, в код и git не попадают.
- **CORS** — только `media-konveyer.ru` и `www.media-konveyer.ru`.
- **Rate-limit** — 5 заявок / 60 секунд с одного IP.
- **Honeypot** — скрытое поле `website` отсеивает ботов.
- **Без логов PII** — в pm2 logs пишется только метка факта доставки, без имени/контакта.

## Эндпоинты

| Method | Path | Описание |
|---|---|---|
| `GET` | `/api/health` | Healthcheck — возвращает `{ok:true}` |
| `POST` | `/api/lead` | Приём заявки (см. ниже) |

### `POST /api/lead`

Body (JSON):
```json
{
  "name": "Иван",
  "contact": "@ivan_user",
  "category": "Одежда",
  "revenue": "1-3 млн",
  "consent": true,
  "page": "https://media-konveyer.ru/",
  "website": ""
}
```

- `name` (string, 1–100)
- `contact` (string, 3–200)
- `category` (whitelist: `Одежда | Дом | Красота | Электроника | Детские | Другое`)
- `revenue` (whitelist: `'' | До 1 млн | 1-3 млн | 3-5 млн | 5-10 млн | Больше 10 млн`)
- `consent` (boolean, должен быть `true` — подпись под офертой и политикой)
- `page` (string, опционально) — откуда отправили
- `website` (honeypot, должно быть пустым)

Ответы:
- `200 {ok:true}` — заявка отправлена в Telegram (или была от бота — тогда тоже `ok:true`, но в ТГ ничего не отправляется)
- `400 {ok:false, error:"invalid_<field>"}` — невалидные данные
- `429 {ok:false, error:"rate_limited"}` — превышен rate-limit
- `502 {ok:false, error:"telegram_failed"}` — Telegram недоступен

## Bootstrap (один раз на VPS)

```bash
# Под root на VPS
mkdir -p /opt/fc-landing-api/{releases,shared}
chown -R clawd:clawd /opt/fc-landing-api

# Создать /opt/fc-landing-api/shared/.env (взять из .env.example, заполнить реальными значениями)
sudo -u clawd nano /opt/fc-landing-api/shared/.env
# или: cat > /opt/fc-landing-api/shared/.env <<EOF ...

# Убедиться, что Node 18+ установлен
node -v
# Если нет — `apt install nodejs` (или nvm под clawd)

# Убедиться, что pm2 установлен у пользователя clawd
sudo -u clawd pm2 -v
```

## Расширение nginx-конфига лендинга

В `/etc/nginx/sites-available/fc-landing.conf` добавить блок:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3022;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
    proxy_connect_timeout 5s;
}
```

Затем `nginx -t && systemctl reload nginx`.

## Деплой

GitHub Actions workflow в `.github/workflows/deploy.yml`. На пуш в `main`:
1. tar архив (без `.git`, `.github`, `node_modules`)
2. scp на VPS
3. распаковать в `releases/<sha>`
4. симлинк `current` → `releases/<sha>` (атомарно)
5. `pm2 startOrReload current/ecosystem.config.cjs --update-env`
6. healthcheck `curl -fsS http://127.0.0.1:3022/api/health`
7. чистка старых релизов (оставляется 5)

## GitHub Secrets

| Secret | Значение |
|---|---|
| `VPS_HOST` | `187.77.88.238` |
| `VPS_USER` | `clawd` |
| `VPS_SSH_KEY` | приватный ключ ed25519 (тот же `claude_agent`) |
| `VPS_PORT` | `22` (опционально) |

## Логи и здоровье

```bash
pm2 logs fc-landing-api --lines 100
pm2 describe fc-landing-api
curl -fsS http://127.0.0.1:3022/api/health
curl -fsS https://media-konveyer.ru/api/health
```

## Rollback

```bash
cd /opt/fc-landing-api
ls -1t releases | head
ln -sfn /opt/fc-landing-api/releases/<previous-sha> current
pm2 startOrReload /opt/fc-landing-api/current/ecosystem.config.cjs --update-env
```

## Изоляция от других сервисов на VPS

| Что | Значение | Не пересекается |
|---|---|---|
| `/opt/fc-landing-api` | свой каталог | `/opt/fc-landing`, `/opt/ai-creator`, `/opt/finances` |
| pm2 process `fc-landing-api` | свой | `ai-backend`, `ai-worker`, `finances` |
| Порт `3022` | свой | `3001`, `3011` |
| nginx | разделяет существующий блок `fc-landing.conf` через `location /api/` | прочие конфиги не задевает |
