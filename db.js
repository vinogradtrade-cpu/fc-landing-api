'use strict';

// SQLite через встроенный node:sqlite (Node 22+, без зависимостей).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.BRIEF_DB_PATH || '/opt/fc-landing-api/shared/briefs.db';
const TOKEN_LIFETIME_DAYS = parseInt(process.env.BRIEF_TOKEN_LIFETIME_DAYS || '14', 10);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Схема: одна таблица briefs со всеми колонками ТЗ.
// JSON-массивы храним как TEXT (JSON.stringify).
db.exec(`
  CREATE TABLE IF NOT EXISTS briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    client_name TEXT,
    client_contact TEXT,
    email TEXT,
    telegram TEXT,
    call_time TEXT,

    brand_name TEXT,
    brand_what_sell TEXT,
    brand_years_on_market TEXT,
    brand_marketplaces TEXT,
    brand_personality TEXT,
    brand_face_info TEXT,
    brand_history TEXT,

    customer_demographics TEXT,
    customer_geography TEXT,
    customer_lifestyle TEXT,
    customer_problem TEXT,
    customer_before TEXT,
    customer_after TEXT,
    customer_main_segment TEXT,

    tone_address TEXT,
    tone_emoji TEXT,
    tone_humor TEXT,
    brand_position TEXT,
    inspiring_brands TEXT,
    inspiring_what_likes TEXT,
    stop_words TEXT,
    stop_topics TEXT,
    stop_formats TEXT,

    product_category TEXT,
    product_locomotive TEXT,
    locomotive_share TEXT,
    total_sku TEXT,
    segment TEXT,
    average_check TEXT,

    channels TEXT,
    first_channel TEXT,
    vertical_video TEXT,

    main_goals TEXT,
    goal_3_months TEXT,
    goal_6_months TEXT,

    content_assets TEXT,
    assets_details TEXT,
    team_writer TEXT,
    team_videographer TEXT,
    team_publisher TEXT,
    content_budget TEXT,
    who_publishes TEXT,
    pain_time_eater TEXT,
    pain_doesnt_work TEXT,

    peak_months TEXT,
    low_months TEXT,
    upcoming_launches TEXT,
    marketplace_sales TEXT,

    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    ip_address TEXT,
    progress_data TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_briefs_status ON briefs(status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs(created_at)');

const ALL_FIELDS = [
  'email', 'telegram', 'call_time',
  'brand_name', 'brand_what_sell', 'brand_years_on_market', 'brand_marketplaces',
  'brand_personality', 'brand_face_info', 'brand_history',
  'customer_demographics', 'customer_geography', 'customer_lifestyle',
  'customer_problem', 'customer_before', 'customer_after', 'customer_main_segment',
  'tone_address', 'tone_emoji', 'tone_humor', 'brand_position',
  'inspiring_brands', 'inspiring_what_likes',
  'stop_words', 'stop_topics', 'stop_formats',
  'product_category', 'product_locomotive', 'locomotive_share',
  'total_sku', 'segment', 'average_check',
  'channels', 'first_channel', 'vertical_video',
  'main_goals', 'goal_3_months', 'goal_6_months',
  'content_assets', 'assets_details',
  'team_writer', 'team_videographer', 'team_publisher',
  'content_budget', 'who_publishes',
  'pain_time_eater', 'pain_doesnt_work',
  'peak_months', 'low_months', 'upcoming_launches', 'marketplace_sales',
];

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function createBrief({ client_name, client_contact, email }) {
  const token = uuid();
  db.prepare(`
    INSERT INTO briefs (token, client_name, client_contact, email, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(token, client_name || null, client_contact || null, email || null);
  return getBriefByToken(token);
}

function getBriefByToken(token) {
  return db.prepare('SELECT * FROM briefs WHERE token = ?').get(token);
}

function isExpired(brief) {
  if (!brief?.created_at) return true;
  const created = new Date(brief.created_at.replace(' ', 'T') + 'Z').getTime();
  const ttl = TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - created > ttl;
}

function saveProgress(token, partial) {
  if (!partial || typeof partial !== 'object') return false;
  const json = JSON.stringify(partial).slice(0, 100_000);
  const r = db.prepare(
    `UPDATE briefs SET progress_data = ? WHERE token = ? AND status = 'pending'`
  ).run(json, token);
  return r.changes > 0;
}

function submitBrief(token, answers, ipAddress) {
  if (!answers || typeof answers !== 'object') {
    return { ok: false, error: 'invalid_answers' };
  }
  const cols = ALL_FIELDS.filter((c) => Object.prototype.hasOwnProperty.call(answers, c));
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => {
    const v = answers[c];
    if (v == null) return null;
    if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
    return String(v).slice(0, 10_000);
  });

  const sql = `
    UPDATE briefs
    SET ${setClause}${cols.length ? ',' : ''}
        status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        ip_address = ?,
        progress_data = NULL
    WHERE token = ? AND status = 'pending'
  `;
  const r = db.prepare(sql).run(...values, ipAddress || null, token);
  if (r.changes === 0) return { ok: false, error: 'already_submitted_or_invalid' };
  return { ok: true, brief: getBriefByToken(token) };
}

function getBriefById(id) {
  return db.prepare('SELECT * FROM briefs WHERE id = ?').get(id);
}

module.exports = {
  db,
  uuid,
  ALL_FIELDS,
  TOKEN_LIFETIME_DAYS,
  createBrief,
  getBriefByToken,
  getBriefById,
  isExpired,
  saveProgress,
  submitBrief,
};
