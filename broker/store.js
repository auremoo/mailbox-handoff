'use strict';
/**
 * store.js — couche de persistance du broker (SQLite via better-sqlite3).
 *
 * Isole tout l'accès au stockage derrière une petite API synchrone. Le serveur
 * HTTP (server.js) ne connaît que ces fonctions, jamais le schéma SQL.
 *
 * Choix :
 *  - SQLite (better-sqlite3) pour encaisser de gros volumes de messages, avec un
 *    mode WAL : la durabilité transactionnelle remplace l'ancien remplacement
 *    atomique .tmp + rename du store JSON.
 *  - API **synchrone** (better-sqlite3 l'est) : colle au style du reste du broker.
 *  - "from"/"to" sont des mots réservés SQL -> colonnes "sender"/"recipient",
 *    remappées en "from"/"to" à la sortie. Le contrat JSON de l'API ne change pas.
 *  - Migration douce : au premier démarrage, si un ancien store.json existe et que
 *    la base est vide, on l'importe une fois (puis on le renomme .migrated).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  sender    TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject   TEXT NOT NULL DEFAULT '',
  body      TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'unread',
  readAt    TEXT,
  threadId  TEXT NOT NULL,
  replyTo   TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient);
CREATE INDEX IF NOT EXISTS idx_msg_thread    ON messages(threadId);
CREATE INDEX IF NOT EXISTS idx_msg_status    ON messages(status);

CREATE TABLE IF NOT EXISTS registry (
  project   TEXT PRIMARY KEY,
  host      TEXT,
  role      TEXT,
  channels  TEXT,           -- JSON: tableau de canaux "#x"
  firstSeen TEXT,
  lastSeen  TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// Ligne SQL -> objet Message du contrat JSON (sender/recipient -> from/to).
function rowToMsg(r) {
  if (!r) return null;
  return {
    id: r.id,
    from: r.sender,
    to: r.recipient,
    subject: r.subject || '',
    body: r.body,
    createdAt: r.createdAt,
    status: r.status,
    readAt: r.readAt || null,
    threadId: r.threadId,
    replyTo: r.replyTo || null,
  };
}

function rowToRegistry(r) {
  let channels;
  try { channels = r.channels ? JSON.parse(r.channels) : undefined; } catch { channels = undefined; }
  const entry = { project: r.project, host: r.host || null, role: r.role || null, firstSeen: r.firstSeen, lastSeen: r.lastSeen };
  if (channels !== undefined) entry.channels = channels;
  return entry;
}

// --- Compteur d'ids (table meta) ---------------------------------------------
function getSeq() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('seq');
  return row ? parseInt(row.value, 10) || 0 : 0;
}
function setSeq(n) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('seq', String(n));
}
function nextId() {
  const n = getSeq() + 1;
  setSeq(n);
  return `msg_${String(n).padStart(5, '0')}`;
}

// --- Messages -----------------------------------------------------------------
const insertStmt = () => db.prepare(
  `INSERT INTO messages (id, sender, recipient, subject, body, createdAt, status, readAt, threadId, replyTo)
   VALUES (@id, @sender, @recipient, @subject, @body, @createdAt, @status, @readAt, @threadId, @replyTo)`
);

function addMessage(msg) {
  insertStmt().run({
    id: msg.id,
    sender: msg.from,
    recipient: msg.to,
    subject: msg.subject || '',
    body: msg.body,
    createdAt: msg.createdAt,
    status: msg.status || 'unread',
    readAt: msg.readAt || null,
    threadId: msg.threadId,
    replyTo: msg.replyTo || null,
  });
  return msg;
}

function findMessage(id) {
  return rowToMsg(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

// Boîte de réception : direct (recipient = projet), diffusion ("*"), ou canal
// abonné (recipient dans la liste transmise par le client). Tri par ordre
// d'insertion (rowid) pour rester déterministe comme l'ancien store en tableau.
function getInbox(project, channels, status) {
  const chans = Array.isArray(channels) ? channels : [];
  const params = [project];
  let sql = `SELECT * FROM messages WHERE (recipient = ? OR recipient = '*'`;
  if (chans.length) {
    sql += ` OR recipient IN (${chans.map(() => '?').join(',')})`;
    params.push(...chans);
  }
  sql += `)`;
  if (status) { sql += ` AND status = ?`; params.push(status); }
  sql += ` ORDER BY rowid ASC`;
  return db.prepare(sql).all(...params).map(rowToMsg);
}

function getThread(threadId) {
  return db.prepare('SELECT * FROM messages WHERE threadId = ? ORDER BY createdAt ASC, rowid ASC')
    .all(threadId).map(rowToMsg);
}

// Acquittement groupé idempotent : ne touche que les non-lus, renvoie le nombre.
function ackIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE messages SET status = 'read', readAt = ? WHERE id = ? AND status != 'read'`);
  const tx = db.transaction((list) => {
    let n = 0;
    for (const id of list) { n += stmt.run(now, id).changes; }
    return n;
  });
  return tx(ids);
}

function countMessages() {
  return db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
}

// Liste les fils (pour le monitoring) : un par threadId racine, avec compteurs
// et dernier message. Trié du fil le plus récemment actif au plus ancien.
function listThreads() {
  const rows = db.prepare(`
    SELECT m.threadId AS threadId,
           COUNT(*) AS count,
           SUM(CASE WHEN m.status = 'unread' THEN 1 ELSE 0 END) AS unread,
           MAX(m.createdAt) AS lastAt
    FROM messages m
    GROUP BY m.threadId
    ORDER BY lastAt DESC
  `).all();
  return rows.map((r) => {
    const root = findMessage(r.threadId);
    const last = rowToMsg(db.prepare('SELECT * FROM messages WHERE threadId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1').get(r.threadId));
    return {
      threadId: r.threadId,
      count: r.count,
      unread: r.unread,
      subject: (root && root.subject) || (last && last.subject) || '',
      participants: [...new Set(db.prepare('SELECT DISTINCT sender FROM messages WHERE threadId = ?').all(r.threadId).map((x) => x.sender))],
      lastAt: r.lastAt,
      last: last,
    };
  });
}

// --- Registre -----------------------------------------------------------------
// Fusion façon "touch" : conserve firstSeen, n'écrase que les champs fournis
// dans meta, rafraîchit lastSeen.
function upsertRegistry(project, meta) {
  if (!project) return null;
  meta = meta || {};
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM registry WHERE project = ?').get(project);
  const firstSeen = existing ? existing.firstSeen : now;
  const host = ('host' in meta) ? (meta.host || null) : (existing ? existing.host : null);
  const role = ('role' in meta) ? (meta.role || null) : (existing ? existing.role : null);
  let channels = existing ? existing.channels : null;
  if ('channels' in meta) channels = JSON.stringify(meta.channels || []);
  db.prepare(`
    INSERT INTO registry (project, host, role, channels, firstSeen, lastSeen)
    VALUES (@project, @host, @role, @channels, @firstSeen, @lastSeen)
    ON CONFLICT(project) DO UPDATE SET
      host = excluded.host, role = excluded.role, channels = excluded.channels, lastSeen = excluded.lastSeen
  `).run({ project, host, role, channels, firstSeen, lastSeen: now });
  return rowToRegistry(db.prepare('SELECT * FROM registry WHERE project = ?').get(project));
}

function getRegistry() {
  return db.prepare('SELECT * FROM registry').all().map(rowToRegistry);
}

// --- Migration depuis l'ancien store JSON ------------------------------------
function migrateJson(jsonPath) {
  let data;
  try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return false; }
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const reg = data.registry || {};
  const tx = db.transaction(() => {
    const ins = insertStmt();
    for (const m of msgs) {
      ins.run({
        id: m.id,
        sender: m.from,
        recipient: m.to,
        subject: m.subject || '',
        body: m.body,
        createdAt: m.createdAt,
        status: m.status || 'unread',
        readAt: m.readAt || null,
        threadId: m.threadId || m.id,         // rétro-compat threads
        replyTo: m.replyTo || null,
      });
    }
    for (const project of Object.keys(reg)) {
      const e = reg[project];
      db.prepare(`INSERT OR REPLACE INTO registry (project, host, role, channels, firstSeen, lastSeen)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(project, e.host || null, e.role || null,
             e.channels ? JSON.stringify(e.channels) : null,
             e.firstSeen || null, e.lastSeen || null);
    }
    const seq = typeof data.seq === 'number' ? data.seq : msgs.length;
    setSeq(seq);
  });
  tx();
  return true;
}

// --- Initialisation -----------------------------------------------------------
// dataFile : chemin du fichier de base. Un ancien chemin .json est accepté (on
// utilise alors un .db voisin et on importe le .json). Renvoie le chemin .db réel.
function init(dataFile) {
  let dbFile = dataFile;
  let jsonSource;
  if (dbFile.endsWith('.json')) {
    jsonSource = dbFile;
    dbFile = dbFile.replace(/\.json$/, '.db');
  } else {
    jsonSource = path.join(path.dirname(dbFile), 'store.json');
  }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // Migration unique : base vide + ancien JSON présent.
  const empty = countMessages() === 0 && db.prepare('SELECT COUNT(*) AS c FROM registry').get().c === 0;
  if (empty && jsonSource && fs.existsSync(jsonSource)) {
    if (migrateJson(jsonSource)) {
      try { fs.renameSync(jsonSource, jsonSource + '.migrated'); } catch { /* non bloquant */ }
      console.log(`[mailbox] migration JSON -> SQLite effectuée depuis ${jsonSource}`);
    }
  }
  return dbFile;
}

module.exports = {
  init, nextId, addMessage, findMessage, getInbox, getThread,
  ackIds, countMessages, listThreads, upsertRegistry, getRegistry,
};
