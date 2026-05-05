'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '..', 'views');

const cache = new Map();

function loadTemplate(name) {
  if (cache.has(name)) return cache.get(name);
  const p = path.join(VIEWS_DIR, name);
  const tpl = fs.readFileSync(p, 'utf8');
  if (process.env.NODE_ENV === 'production') cache.set(name, tpl);
  return tpl;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(name, data = {}) {
  const tpl = loadTemplate(name);
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let v = data;
    for (const p of parts) {
      v = v == null ? undefined : v[p];
    }
    if (v == null) return '';
    return escapeHtml(v);
  });
}

function lookupKey(data, key) {
  const parts = key.split('.');
  let v = data;
  for (const p of parts) {
    v = v == null ? undefined : v[p];
  }
  return v;
}

function renderRaw(name, data = {}) {
  let tpl = loadTemplate(name);
  // Условный блок: {{#var}}...{{/var}} — рендерится, только если var truthy
  // (для нашего случая — непустая строка). Не вложенный, простая реализация.
  tpl = tpl.replace(/\{\{#\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (_, key, body) => {
    const v = lookupKey(data, key);
    return v ? body : '';
  });
  // Простая подстановка
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = lookupKey(data, key);
    if (v == null) return '';
    return String(v);
  });
}

function simplePage({ title, heading, message, status = 200 }) {
  return {
    status,
    body: `<!doctype html>
<html lang="ru"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex,nofollow" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         background: #FFFFFF; color: #0A0A0B; margin: 0;
         min-height: 100vh; display: grid; place-items: center; padding: 20px; }
  .card { max-width: 480px; width: 100%; padding: 40px 32px; border-radius: 20px;
          border: 1px solid #EDEDEF; box-shadow: 0 8px 24px rgba(10,10,11,0.06); }
  .badge { display: inline-block; padding: 6px 12px; border-radius: 999px;
           background: #F3EEFF; color: #5B21B6; font-size: 12px; font-weight: 600;
           letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 16px; }
  h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 14px; line-height: 1.1; }
  p { color: #5B5B62; line-height: 1.6; margin: 0; }
  a { color: #7C3AED; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head><body>
<div class="card">
  <div class="badge">${escapeHtml(title)}</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${message}</p>
  <p style="margin-top:24px"><a href="https://media-konveyer.ru/">← На главную</a></p>
</div>
</body></html>`,
  };
}

module.exports = { render, renderRaw, escapeHtml, simplePage };
