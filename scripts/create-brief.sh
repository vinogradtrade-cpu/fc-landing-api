#!/usr/bin/env bash
# Создание уникальной ссылки на бриф.
#
# Использование:
#   ADMIN_TOKEN=... ./scripts/create-brief.sh "Имя клиента" "@telegram_or_phone" [email]
#
# или с переменными:
#   ADMIN_TOKEN=...
#   API_URL=https://media-konveyer.ru     (опционально, дефолт)
#   ./scripts/create-brief.sh "Иван Петров" "@ivan" "ivan@example.com"

set -euo pipefail

API_URL="${API_URL:-https://media-konveyer.ru}"
: "${ADMIN_TOKEN:?Установите ADMIN_TOKEN из /opt/fc-landing-api/shared/.env}"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 \"Имя клиента\" [\"контакт\"] [\"email\"]" >&2
  exit 1
fi

NAME="${1:-}"
CONTACT="${2:-}"
EMAIL="${3:-}"

PAYLOAD=$(cat <<JSON
{ "client_name": "$NAME", "client_contact": "$CONTACT", "email": "$EMAIL" }
JSON
)

RESP=$(curl -sS -X POST "$API_URL/api/admin/create-brief-link" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "$RESP" | python3 -m json.tool
