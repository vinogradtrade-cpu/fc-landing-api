'use strict';

// SQLite через встроенный node:sqlite (Node 22+, без зависимостей).
// Этап 1: leads, briefs (общая) + briefs_<type>_data + bot_states + bot_logs.
// Миграции применяются при старте через PRAGMA user_version.

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

const DB_PATH = process.env.BRIEF_DB_PATH || '/opt/fc-landing-api/shared/briefs.db';
const TOKEN_LIFETIME_DAYS = parseInt(process.env.BRIEF_TOKEN_LIFETIME_DAYS || '14', 10);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const BRIEF_TYPES = ['seller', 'expert', 'agency'];
const DATA_TABLE = (t) => {
  if (!BRIEF_TYPES.includes(t)) throw new Error(`unknown brief_type: ${t}`);
  return `briefs_${t}_data`;
};

// ─── Migrations ───────────────────────────────────────────────────────────────

function getUserVersion() {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function migrate() {
  const v = getUserVersion();
  if (v < 1) migrateV1();
  if (v < 2) migrateV2();
  console.log(`[db] schema version: ${getUserVersion()}`);
}

function migrateV1() {
  // Историческая «старая» схема — на случай свежей БД, где её нет.
  // Если БД уже создавалась прошлой версией кода, IF NOT EXISTS просто пропустит.
  db.exec(`
    CREATE TABLE IF NOT EXISTS briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      client_name TEXT, client_contact TEXT, email TEXT, telegram TEXT, call_time TEXT,
      brand_name TEXT, brand_what_sell TEXT, brand_years_on_market TEXT, brand_marketplaces TEXT,
      brand_personality TEXT, brand_face_info TEXT, brand_history TEXT,
      customer_demographics TEXT, customer_geography TEXT, customer_lifestyle TEXT,
      customer_problem TEXT, customer_before TEXT, customer_after TEXT, customer_main_segment TEXT,
      tone_address TEXT, tone_emoji TEXT, tone_humor TEXT, brand_position TEXT,
      inspiring_brands TEXT, inspiring_what_likes TEXT,
      stop_words TEXT, stop_topics TEXT, stop_formats TEXT,
      product_category TEXT, product_locomotive TEXT, locomotive_share TEXT,
      total_sku TEXT, segment TEXT, average_check TEXT,
      channels TEXT, first_channel TEXT, vertical_video TEXT,
      main_goals TEXT, goal_3_months TEXT, goal_6_months TEXT,
      content_assets TEXT, assets_details TEXT,
      team_writer TEXT, team_videographer TEXT, team_publisher TEXT,
      content_budget TEXT, who_publishes TEXT,
      pain_time_eater TEXT, pain_doesnt_work TEXT,
      peak_months TEXT, low_months TEXT, upcoming_launches TEXT, marketplace_sales TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME, ip_address TEXT, progress_data TEXT
    )
  `);
  db.exec('PRAGMA user_version = 1');
}

// Все «брифовые» поля, которые были колонками в v1.
const SELLER_FIELDS_V1 = [
  'email','telegram','call_time',
  'brand_name','brand_what_sell','brand_years_on_market','brand_marketplaces',
  'brand_personality','brand_face_info','brand_history',
  'customer_demographics','customer_geography','customer_lifestyle',
  'customer_problem','customer_before','customer_after','customer_main_segment',
  'tone_address','tone_emoji','tone_humor','brand_position',
  'inspiring_brands','inspiring_what_likes',
  'stop_words','stop_topics','stop_formats',
  'product_category','product_locomotive','locomotive_share',
  'total_sku','segment','average_check',
  'channels','first_channel','vertical_video',
  'main_goals','goal_3_months','goal_6_months',
  'content_assets','assets_details',
  'team_writer','team_videographer','team_publisher',
  'content_budget','who_publishes',
  'pain_time_eater','pain_doesnt_work',
  'peak_months','low_months','upcoming_launches','marketplace_sales',
];

function migrateV2() {
  db.exec('BEGIN');
  try {
    // 1. Новые таблицы
    db.exec(`
      CREATE TABLE leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, contact TEXT, email TEXT,
        category TEXT, revenue TEXT,
        other_data TEXT,
        status TEXT NOT NULL DEFAULT 'new', -- new | processed | rejected
        brief_id INTEGER,
        ip_address TEXT,
        page TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE SET NULL
      );

      CREATE TABLE briefs_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        brief_type TEXT NOT NULL, -- seller | expert | agency
        client_name TEXT, client_contact TEXT, email TEXT,
        status TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | completed | expired
        source TEXT DEFAULT 'manual',           -- landing | manual | bot
        lead_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        expires_at DATETIME,
        ip_address TEXT,
        progress_data TEXT,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
      );

      CREATE TABLE briefs_seller_data (
        brief_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        FOREIGN KEY (brief_id) REFERENCES briefs_v2(id) ON DELETE CASCADE
      );
      CREATE TABLE briefs_expert_data (
        brief_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        FOREIGN KEY (brief_id) REFERENCES briefs_v2(id) ON DELETE CASCADE
      );
      CREATE TABLE briefs_agency_data (
        brief_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        FOREIGN KEY (brief_id) REFERENCES briefs_v2(id) ON DELETE CASCADE
      );

      CREATE TABLE bot_states (
        user_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        context TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE bot_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        action TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Перенос существующих briefs → briefs_v2 + briefs_seller_data
    const hasOld = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='briefs'"
    ).get();

    if (hasOld) {
      const oldRows = db.prepare('SELECT * FROM briefs').all();
      const insBrief = db.prepare(`
        INSERT INTO briefs_v2 (id, token, brief_type, client_name, client_contact, email,
                               status, source, created_at, completed_at, expires_at,
                               ip_address, progress_data)
        VALUES (?, ?, 'seller', ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)
      `);
      const insData = db.prepare(`
        INSERT INTO briefs_seller_data (brief_id, data) VALUES (?, ?)
      `);

      for (const r of oldRows) {
        // expires_at для старых записей: created_at + TOKEN_LIFETIME_DAYS
        let expiresAt = null;
        if (r.created_at) {
          try {
            const t = new Date(r.created_at.replace(' ', 'T') + 'Z').getTime()
                    + TOKEN_LIFETIME_DAYS * 86_400_000;
            expiresAt = new Date(t).toISOString().replace('T', ' ').slice(0, 19);
          } catch {}
        }
        insBrief.run(
          r.id, r.token, r.client_name, r.client_contact, r.email,
          r.status || 'pending', r.created_at, r.completed_at,
          expiresAt, r.ip_address, r.progress_data
        );
        const data = {};
        for (const f of SELLER_FIELDS_V1) {
          if (r[f] != null && r[f] !== '') data[f] = r[f];
        }
        if (Object.keys(data).length) {
          insData.run(r.id, JSON.stringify(data));
        }
      }
      db.exec('DROP TABLE briefs');
    }

    db.exec('ALTER TABLE briefs_v2 RENAME TO briefs');

    // 3. Индексы
    db.exec(`
      CREATE INDEX idx_briefs_status ON briefs(status);
      CREATE INDEX idx_briefs_type ON briefs(brief_type);
      CREATE INDEX idx_briefs_created ON briefs(created_at);
      CREATE INDEX idx_leads_status ON leads(status);
      CREATE INDEX idx_leads_created ON leads(created_at);
      CREATE INDEX idx_bot_logs_user ON bot_logs(user_id);
      CREATE INDEX idx_bot_logs_created ON bot_logs(created_at);
    `);

    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
    console.log('[db] migrated to v2');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

migrate();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// briefs

function createBrief({ brief_type = 'seller', client_name, client_contact, email,
                       source = 'manual', lead_id = null }) {
  if (!BRIEF_TYPES.includes(brief_type)) {
    throw new Error(`invalid brief_type: ${brief_type}`);
  }
  const token = uuid();
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_DAYS * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const r = db.prepare(`
    INSERT INTO briefs (token, brief_type, client_name, client_contact, email,
                        status, source, lead_id, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(token, brief_type, client_name || null, client_contact || null, email || null,
         source, lead_id, expiresAt);
  return getBriefById(r.lastInsertRowid);
}

function _attachData(brief) {
  if (!brief) return null;
  const row = db.prepare(
    `SELECT data FROM ${DATA_TABLE(brief.brief_type)} WHERE brief_id = ?`
  ).get(brief.id);
  brief.data = row ? safeJson(row.data) : {};
  return brief;
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function getBriefByToken(token) {
  const b = db.prepare('SELECT * FROM briefs WHERE token = ?').get(token);
  return _attachData(b);
}
function getBriefById(id) {
  const b = db.prepare('SELECT * FROM briefs WHERE id = ?').get(id);
  return _attachData(b);
}

function listBriefs({ status, brief_type, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (brief_type) { where.push('brief_type = ?'); params.push(brief_type); }
  const sql = `SELECT * FROM briefs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(_attachData);
}

function isExpired(brief) {
  if (!brief) return true;
  const stamp = brief.expires_at || brief.created_at;
  if (!stamp) return true;
  try {
    const exp = brief.expires_at
      ? new Date(brief.expires_at.replace(' ', 'T') + 'Z').getTime()
      : new Date(brief.created_at.replace(' ', 'T') + 'Z').getTime()
        + TOKEN_LIFETIME_DAYS * 86_400_000;
    return Date.now() > exp;
  } catch {
    return true;
  }
}

function saveProgress(token, partial) {
  if (!partial || typeof partial !== 'object') return false;
  const json = JSON.stringify(partial).slice(0, 200_000);
  const r = db.prepare(
    `UPDATE briefs SET progress_data = ? WHERE token = ? AND status = 'pending'`
  ).run(json, token);
  return r.changes > 0;
}

function submitBrief(token, answers, ipAddress) {
  if (!answers || typeof answers !== 'object') {
    return { ok: false, error: 'invalid_answers' };
  }
  const brief = getBriefByToken(token);
  if (!brief) return { ok: false, error: 'not_found' };
  if (brief.status !== 'pending') return { ok: false, error: 'already_submitted' };

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE briefs SET status = 'completed',
                        completed_at = CURRENT_TIMESTAMP,
                        ip_address = ?,
                        progress_data = NULL
      WHERE id = ? AND status = 'pending'
    `).run(ipAddress || null, brief.id);

    const dataTable = DATA_TABLE(brief.brief_type);
    const json = JSON.stringify(answers).slice(0, 500_000);
    db.prepare(`
      INSERT INTO ${dataTable} (brief_id, data) VALUES (?, ?)
      ON CONFLICT(brief_id) DO UPDATE SET data = excluded.data
    `).run(brief.id, json);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { ok: true, brief: getBriefById(brief.id) };
}

function deleteBrief(id) {
  return db.prepare('DELETE FROM briefs WHERE id = ?').run(id).changes > 0;
}

// leads

function createLead({ name, contact, email, category, revenue, other_data,
                      ip_address, page }) {
  const r = db.prepare(`
    INSERT INTO leads (name, contact, email, category, revenue, other_data, ip_address, page)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name || null, contact || null, email || null, category || null, revenue || null,
         other_data ? JSON.stringify(other_data) : null,
         ip_address || null, page || null);
  return getLeadById(r.lastInsertRowid);
}

function getLeadById(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

function listLeads({ status, limit = 50 } = {}) {
  const sql = status
    ? 'SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM leads ORDER BY created_at DESC LIMIT ?';
  return status
    ? db.prepare(sql).all(status, limit)
    : db.prepare(sql).all(limit);
}

function updateLeadStatus(id, status, briefId = null) {
  const r = db.prepare(`
    UPDATE leads SET status = ?,
                     processed_at = CURRENT_TIMESTAMP,
                     brief_id = COALESCE(?, brief_id)
    WHERE id = ?
  `).run(status, briefId, id);
  return r.changes > 0;
}

// bot states

function getBotState(userId) {
  const r = db.prepare('SELECT * FROM bot_states WHERE user_id = ?').get(userId);
  if (!r) return null;
  return { ...r, context: safeJson(r.context) || {} };
}

function setBotState(userId, state, context = {}) {
  db.prepare(`
    INSERT INTO bot_states (user_id, state, context, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state,
                                       context = excluded.context,
                                       updated_at = CURRENT_TIMESTAMP
  `).run(userId, state, JSON.stringify(context));
}

function clearBotState(userId) {
  db.prepare('DELETE FROM bot_states WHERE user_id = ?').run(userId);
}

// bot logs

function logBot(userId, action, details = null) {
  db.prepare(`
    INSERT INTO bot_logs (user_id, action, details) VALUES (?, ?, ?)
  `).run(userId || null, action, details ? JSON.stringify(details) : null);
}

// stats

function getStats({ daysBack = 30 } = {}) {
  const since = new Date(Date.now() - daysBack * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const leads = db.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE created_at >= ?`
  ).get(since).c;
  const leadsProcessed = db.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE created_at >= ? AND status = 'processed'`
  ).get(since).c;
  const briefsTotal = db.prepare(
    `SELECT COUNT(*) AS c FROM briefs WHERE created_at >= ?`
  ).get(since).c;
  const briefsCompleted = db.prepare(
    `SELECT COUNT(*) AS c FROM briefs WHERE created_at >= ? AND status = 'completed'`
  ).get(since).c;
  const byType = db.prepare(`
    SELECT brief_type, COUNT(*) AS total,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
    FROM briefs WHERE created_at >= ?
    GROUP BY brief_type
  `).all(since);
  const expired = db.prepare(`
    SELECT COUNT(*) AS c FROM briefs
    WHERE created_at >= ?
      AND status = 'pending'
      AND expires_at IS NOT NULL
      AND expires_at < CURRENT_TIMESTAMP
  `).get(since).c;
  return { daysBack, since, leads, leadsProcessed, briefsTotal, briefsCompleted, byType, expired };
}

module.exports = {
  db,
  uuid,
  BRIEF_TYPES,
  TOKEN_LIFETIME_DAYS,
  // briefs
  createBrief, getBriefByToken, getBriefById, listBriefs, isExpired,
  saveProgress, submitBrief, deleteBrief,
  // leads
  createLead, getLeadById, listLeads, updateLeadStatus,
  // bot
  getBotState, setBotState, clearBotState, logBot,
  // misc
  getStats,
};
