import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(`${config.dataDir}/ig-auto.db`);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Contas do Instagram conectadas (multi-conta desde o início)
CREATE TABLE IF NOT EXISTS accounts (
  ig_user_id        TEXT PRIMARY KEY,          -- ID profissional (o mesmo que chega em entry.id dos webhooks)
  username          TEXT,
  access_token      TEXT NOT NULL,
  token_expires_at  INTEGER,                   -- epoch ms
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Pessoas que interagiram (por conta)
CREATE TABLE IF NOT EXISTS contacts (
  account_id        TEXT NOT NULL REFERENCES accounts(ig_user_id),
  igsid             TEXT NOT NULL,             -- ID da pessoa no escopo da conta
  username          TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  fields            TEXT NOT NULL DEFAULT '{}',-- dados capturados (email, whatsapp...)
  first_seen_at     INTEGER NOT NULL,
  last_inbound_at   INTEGER,                   -- controla a janela de 24h
  PRIMARY KEY (account_id, igsid)
);

-- Log bruto de tudo que a Meta envia (debug + reprocessamento)
CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT,
  source            TEXT,                      -- post_comment, live_comment, dm, story_reply, story_mention, postback...
  dedupe_key        TEXT UNIQUE,               -- comment_id / mid: evita processar retry da Meta 2x
  payload           TEXT NOT NULL,
  received_at       INTEGER NOT NULL
);

-- Automações (Fase 1 em diante)
CREATE TABLE IF NOT EXISTS automations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT NOT NULL REFERENCES accounts(ig_user_id),
  name              TEXT NOT NULL,
  source            TEXT NOT NULL,             -- post_comment | live_comment | story_reply | story_mention | dm
  media_id          TEXT,                      -- NULL = qualquer post/story
  keywords          TEXT NOT NULL DEFAULT '[]',
  match_mode        TEXT NOT NULL DEFAULT 'contains', -- contains | exact | any
  priority          INTEGER NOT NULL DEFAULT 0,
  flow              TEXT NOT NULL DEFAULT '{}',-- grafo de blocos
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Execuções de fluxo (estado de quem está no meio de um fluxo)
CREATE TABLE IF NOT EXISTS runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id     INTEGER NOT NULL REFERENCES automations(id),
  account_id        TEXT NOT NULL,
  igsid             TEXT NOT NULL,
  current_node      TEXT,
  status            TEXT NOT NULL DEFAULT 'running', -- running | waiting | done | failed
  context           TEXT NOT NULL DEFAULT '{}',
  started_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_contact ON runs(account_id, igsid, status);

-- Links enviados em DM passam por /r/<code>: sabemos quem clicou em quê
CREATE TABLE IF NOT EXISTS links (
  code              TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  automation_id     INTEGER,
  run_id            INTEGER,
  igsid             TEXT,
  node_id           TEXT,
  title             TEXT,
  target_url        TEXT NOT NULL,
  clicks            INTEGER NOT NULL DEFAULT 0,
  first_click_at    INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_by_automation ON links(automation_id);
`);

const now = () => Date.now();

export const accounts = {
  upsert({ igUserId, username, accessToken, expiresAt }) {
    db.prepare(`
      INSERT INTO accounts (ig_user_id, username, access_token, token_expires_at, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(ig_user_id) DO UPDATE SET
        username = excluded.username, access_token = excluded.access_token,
        token_expires_at = excluded.token_expires_at, active = 1, updated_at = excluded.updated_at
    `).run(igUserId, username, accessToken, expiresAt, now(), now());
  },
  get: (igUserId) => db.prepare('SELECT * FROM accounts WHERE ig_user_id = ? AND active = 1').get(igUserId),
  list: () => db.prepare('SELECT ig_user_id, username, token_expires_at, active, created_at FROM accounts').all(),
  expiringBefore: (ts) => db.prepare('SELECT * FROM accounts WHERE active = 1 AND token_expires_at < ?').all(ts),
  updateToken(igUserId, accessToken, expiresAt) {
    db.prepare('UPDATE accounts SET access_token = ?, token_expires_at = ?, updated_at = ? WHERE ig_user_id = ?')
      .run(accessToken, expiresAt, now(), igUserId);
  },
};

export const events = {
  // Retorna false se já processamos esse evento (retry da Meta)
  insert({ accountId, source, dedupeKey, payload }) {
    const r = db.prepare(`
      INSERT OR IGNORE INTO events (account_id, source, dedupe_key, payload, received_at) VALUES (?, ?, ?, ?, ?)
    `).run(accountId, source, dedupeKey, JSON.stringify(payload), now());
    return r.changes > 0;
  },
  recent: (limit = 50) =>
    db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
      .map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
};

export const links = {
  create({ accountId, automationId, runId, igsid, nodeId, title, targetUrl }) {
    const code = crypto.randomBytes(6).toString('base64url');
    db.prepare(`INSERT INTO links (code, account_id, automation_id, run_id, igsid, node_id, title, target_url, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, accountId, automationId, runId, igsid, nodeId, title, targetUrl, now());
    return code;
  },
  hit(code) {
    const l = db.prepare('SELECT * FROM links WHERE code = ?').get(code);
    if (!l) return null;
    db.prepare('UPDATE links SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, ?) WHERE code = ?').run(now(), code);
    return l;
  },
};

export const automations = {
  // Automações ativas da conta; `source` guarda a lista de origens separada por vírgula
  listActive: (accountId) =>
    db.prepare('SELECT * FROM automations WHERE account_id = ? AND active = 1 ORDER BY priority DESC, id ASC').all(accountId)
      .map(parseAutomation),
  get: (id) => parseAutomation(db.prepare('SELECT * FROM automations WHERE id = ?').get(id)),
  listAll: (accountId) =>
    db.prepare('SELECT * FROM automations WHERE account_id = ? ORDER BY active DESC, updated_at DESC').all(accountId).map(parseAutomation),
  exists: (accountId, name) => !!db.prepare('SELECT 1 FROM automations WHERE account_id = ? AND name = ?').get(accountId, name),
  create(accountId, a) {
    return Number(db.prepare(`INSERT INTO automations (account_id, name, source, media_id, keywords, match_mode, priority, flow, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(accountId, a.name, a.sources.join(','), a.mediaId ?? null, JSON.stringify(a.keywords),
      a.matchMode, a.priority ?? 0, JSON.stringify(a.flow), a.active ? 1 : 0, now(), now()).lastInsertRowid);
  },
  update(accountId, id, a) {
    return db.prepare(`UPDATE automations SET name = ?, source = ?, media_id = ?, keywords = ?, match_mode = ?, priority = ?, flow = ?, active = ?, updated_at = ?
      WHERE id = ? AND account_id = ?`).run(a.name, a.sources.join(','), a.mediaId ?? null, JSON.stringify(a.keywords), a.matchMode,
      a.priority ?? 0, JSON.stringify(a.flow), a.active ? 1 : 0, now(), id, accountId).changes > 0;
  },
  setActive: (accountId, id, active) =>
    db.prepare('UPDATE automations SET active = ?, updated_at = ? WHERE id = ? AND account_id = ?').run(active ? 1 : 0, now(), id, accountId).changes > 0,
  remove: (accountId, id) =>
    db.prepare('UPDATE automations SET active = 0, account_id = ? WHERE id = ? AND account_id = ?').run(`deleted:${accountId}`, id, accountId).changes > 0,
  // Funil de cada automação: disparos, quem seguiu depois do botão, quem concluiu, cliques por link
  stats(accountId) {
    const base = db.prepare(`SELECT automation_id AS id, COUNT(*) AS runs, COUNT(DISTINCT igsid) AS people,
        SUM(CASE WHEN json_extract(context, '$.continued') = 1 THEN 1 ELSE 0 END) AS continued,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed,
        MAX(started_at) AS last_run_at
      FROM runs WHERE account_id = ? GROUP BY automation_id`).all(accountId);
    const clicks = db.prepare(`SELECT automation_id AS id, title, COUNT(DISTINCT igsid) AS people
      FROM links WHERE account_id = ? AND first_click_at IS NOT NULL GROUP BY automation_id, title`).all(accountId);
    const out = {};
    for (const b of base) out[b.id] = { ...b, clicks: [] };
    for (const c of clicks) (out[c.id] ??= { id: c.id, runs: 0, people: 0, continued: 0, completed: 0, clicks: [] }).clicks.push({ title: c.title, people: c.people });
    return out;
  },
  upsertByName({ accountId, name, sources, mediaId = null, keywords, matchMode = 'contains', priority = 0, flow, active = 1 }) {
    const existing = db.prepare('SELECT id FROM automations WHERE account_id = ? AND name = ?').get(accountId, name);
    const args = [sources.join(','), mediaId, JSON.stringify(keywords), matchMode, priority, JSON.stringify(flow), active, now()];
    if (existing) {
      db.prepare(`UPDATE automations SET source = ?, media_id = ?, keywords = ?, match_mode = ?, priority = ?, flow = ?, active = ?, updated_at = ?
                  WHERE id = ?`).run(...args, existing.id);
      return existing.id;
    }
    return Number(db.prepare(`INSERT INTO automations (source, media_id, keywords, match_mode, priority, flow, active, updated_at, account_id, name, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...args, accountId, name, now()).lastInsertRowid);
  },
};

function parseAutomation(a) {
  if (!a) return a;
  return { ...a, sources: a.source.split(','), keywords: JSON.parse(a.keywords), flow: JSON.parse(a.flow) };
}

export const runs = {
  create({ automationId, accountId, igsid, context }) {
    const r = db.prepare(`INSERT INTO runs (automation_id, account_id, igsid, status, context, started_at, updated_at)
                          VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(automationId, accountId, igsid, JSON.stringify(context), now(), now());
    return runs.get(Number(r.lastInsertRowid));
  },
  get(id) {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r && { ...r, context: JSON.parse(r.context) };
  },
  update(id, { currentNode, status, context }) {
    db.prepare('UPDATE runs SET current_node = ?, status = ?, context = ?, updated_at = ? WHERE id = ?')
      .run(currentNode ?? null, status, JSON.stringify(context), now(), id);
  },
  // Execução mais recente dessa pessoa esperando resposta (dentro da janela de 24h)
  latestWaiting(accountId, igsid) {
    const r = db.prepare(`SELECT * FROM runs WHERE account_id = ? AND igsid = ? AND status = 'waiting' AND updated_at > ?
                          ORDER BY updated_at DESC LIMIT 1`).get(accountId, igsid, now() - 86_400_000);
    return r && { ...r, context: JSON.parse(r.context) };
  },
  startedSince(automationId, accountId, igsid, since) {
    return db.prepare('SELECT COUNT(*) AS n FROM runs WHERE automation_id = ? AND account_id = ? AND igsid = ? AND started_at > ? AND status != \'failed\'')
      .get(automationId, accountId, igsid, since).n > 0;
  },
};

export const leads = {
  list(accountId, limit = 500) {
    const rows = db.prepare(`SELECT c.igsid, c.username, c.tags, c.first_seen_at, c.last_inbound_at,
        (SELECT json_group_array(DISTINCT a.name) FROM runs r JOIN automations a ON a.id = r.automation_id
           WHERE r.account_id = c.account_id AND r.igsid = c.igsid) AS automations,
        (SELECT json_group_array(DISTINCT l.title) FROM links l
           WHERE l.account_id = c.account_id AND l.igsid = c.igsid AND l.first_click_at IS NOT NULL) AS clicked,
        (SELECT MAX(r.started_at) FROM runs r WHERE r.account_id = c.account_id AND r.igsid = c.igsid) AS last_run_at
      FROM contacts c WHERE c.account_id = ?
      ORDER BY COALESCE(last_run_at, c.last_inbound_at, c.first_seen_at) DESC LIMIT ?`).all(accountId, limit);
    return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags), automations: JSON.parse(r.automations), clicked: JSON.parse(r.clicked) }));
  },
};

export const contacts = {
  get: (accountId, igsid) => db.prepare('SELECT * FROM contacts WHERE account_id = ? AND igsid = ?').get(accountId, igsid),
  setUsername: (accountId, igsid, username) =>
    db.prepare('UPDATE contacts SET username = ? WHERE account_id = ? AND igsid = ?').run(username, accountId, igsid),
  touch({ accountId, igsid, username, inbound }) {
    db.prepare(`
      INSERT INTO contacts (account_id, igsid, username, first_seen_at, last_inbound_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, igsid) DO UPDATE SET
        username = COALESCE(excluded.username, contacts.username),
        last_inbound_at = COALESCE(excluded.last_inbound_at, contacts.last_inbound_at)
    `).run(accountId, igsid, username ?? null, now(), inbound ? now() : null);
  },
  addTags(accountId, igsid, newTags) {
    const c = db.prepare('SELECT tags FROM contacts WHERE account_id = ? AND igsid = ?').get(accountId, igsid);
    if (!c) return;
    const tags = [...new Set([...JSON.parse(c.tags), ...newTags])];
    db.prepare('UPDATE contacts SET tags = ? WHERE account_id = ? AND igsid = ?').run(JSON.stringify(tags), accountId, igsid);
  },
};
