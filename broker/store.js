'use strict';
/**
 * store.js — couche de persistance du broker (SQLite via better-sqlite3).
 *
 * Isole tout l'accès au stockage derrière une petite API synchrone. Le serveur
 * HTTP (server.js) ne connaît que ces fonctions, jamais le schéma SQL.
 *
 * Choix :
 *  - SQLite (better-sqlite3) en mode WAL : durabilité transactionnelle.
 *  - API **synchrone** (better-sqlite3 l'est) : colle au style du reste du broker.
 *  - "from"/"to" sont des mots réservés SQL -> colonnes "sender"/"recipient",
 *    remappées en "from"/"to" à la sortie. Le contrat JSON de l'API ne change pas.
 *  - Accusés de lecture **par projet** (table receipts) : un message de diffusion
 *    ou de canal a plusieurs destinataires, chacun doit le recevoir une fois. Le
 *    project "*" dans receipts = « lu pour tous » (acquittement hérité, sans projet).
 *  - messages.status n'est plus qu'un indicateur de MONITORING : "read" quand tous
 *    les destinataires connus l'ont lu. La remise aux agents ne dépend que de receipts.
 *  - Requêtes préparées une seule fois (cache), listes passées via json_each pour
 *    garder un SQL fixe quelle que soit leur longueur.
 *  - Curseur par projet (registry.cursor) : la recherche des non-lus repart du
 *    premier non-lu connu au lieu de rebalayer tout l'historique à chaque prompt.
 *    Les rowid ne doivent donc jamais être réutilisés (cf. purgeOlderThan).
 *  - Migrations douces au démarrage : ancien store.json importé une fois, puis
 *    accusés de lecture reconstruits depuis l'ancienne colonne status.
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
CREATE INDEX IF NOT EXISTS idx_msg_created   ON messages(createdAt);

-- Accusé de lecture d'un message par un projet ("*" = lu pour tous, hérité).
CREATE TABLE IF NOT EXISTS receipts (
  messageId TEXT NOT NULL,
  project   TEXT NOT NULL,
  readAt    TEXT NOT NULL,
  PRIMARY KEY (messageId, project)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS registry (
  project   TEXT PRIMARY KEY,
  host      TEXT,
  role      TEXT,
  channels  TEXT,           -- JSON: tableau de canaux "#x"
  firstSeen TEXT,
  lastSeen  TEXT,
  cursor    INTEGER NOT NULL DEFAULT 0  -- rowid jusqu'auquel ce projet n'a plus rien de non lu
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// Cache des requêtes préparées : préparer coûte plus cher qu'exécuter.
const stmts = new Map();
function q(sql) {
  let s = stmts.get(sql);
  if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
  return s;
}

function isGroupAddress(to) { return to === '*' || String(to).charAt(0) === '#'; }

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

function parseChannelsJson(s) {
  try { return s ? JSON.parse(s) : undefined; } catch { return undefined; }
}

// (le curseur est un détail interne : il n'apparaît pas dans le contrat JSON)
function rowToRegistry(r) {
  const channels = parseChannelsJson(r.channels);
  const entry = { project: r.project, host: r.host || null, role: r.role || null, firstSeen: r.firstSeen, lastSeen: r.lastSeen };
  if (channels !== undefined) entry.channels = channels;
  return entry;
}

function getMeta(key) {
  const row = q('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// --- Compteur d'ids -----------------------------------------------------------
function nextId() {
  const n = (parseInt(getMeta('seq'), 10) || 0) + 1;
  setMeta('seq', n);
  return `msg_${String(n).padStart(5, '0')}`;
}

// Exécute fn dans une transaction (ex. nextId + insertion : pas de trou de séquence).
function transaction(fn) { return db.transaction(fn)(); }

// --- Messages -----------------------------------------------------------------
const INSERT_SQL =
  `INSERT INTO messages (id, sender, recipient, subject, body, createdAt, status, readAt, threadId, replyTo)
   VALUES (@id, @sender, @recipient, @subject, @body, @createdAt, @status, @readAt, @threadId, @replyTo)`;

function addMessage(msg) {
  q(INSERT_SQL).run({
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
  return rowToMsg(q('SELECT * FROM messages WHERE id = ?').get(id));
}

// Boîte de réception d'un projet. Reçoit :
//  - ses messages directs (quelle que soit leur date : on peut écrire à un projet
//    avant son arrivée) ;
//  - les diffusions "*" et les canaux abonnés (liste transmise par le client), SAUF
//    ses propres envois et ce qui précède sa première apparition (firstSeen) : un
//    nouveau venu n'hérite pas de tout l'historique des canaux.
// Le statut lu/non-lu renvoyé est celui DE CE PROJET (accusé à son nom ou "*").
// @cursor : pour les non-lus, on ne regarde qu'au-delà du curseur du projet.
const INBOX_BASE = `
  SELECT * FROM (
    SELECT m.rowid AS rid, m.*,
           (SELECT MIN(r.readAt) FROM receipts r
             WHERE r.messageId = m.id AND r.project IN (@p, '*')) AS myReadAt
    FROM messages m
    -- Un seul IN sur recipient (et pas des OR) : SQLite peut parcourir l'index.
    WHERE m.recipient IN (SELECT @p UNION ALL SELECT '*' UNION ALL SELECT value FROM json_each(@chans))
      AND m.rowid > @cursor
      AND (m.recipient = @p
           OR (m.sender <> @p
               AND m.createdAt >= COALESCE((SELECT firstSeen FROM registry WHERE project = @p), '')))
  )
  WHERE (@status IS NULL
         OR (@status = 'unread' AND myReadAt IS NULL)
         OR (@status = 'read' AND myReadAt IS NOT NULL))`;

function getInbox(project, channels, status, limit) {
  const unreadOnly = status === 'unread';
  const reg = unreadOnly ? q('SELECT cursor FROM registry WHERE project = ?').get(project) : null;
  const params = {
    p: project,
    chans: JSON.stringify(Array.isArray(channels) ? channels : []),
    status: unreadOnly || status === 'read' ? status : null,
    limit: limit > 0 ? limit : -1, // -1 = sans limite en SQLite
    cursor: (reg && reg.cursor) || 0,
  };
  const rows = q(INBOX_BASE + ' ORDER BY rid ASC LIMIT @limit').all(params);
  if (reg) {
    // Tout ce qui précède le premier non-lu est lu : le curseur peut avancer
    // jusque-là (jusqu'au dernier message s'il n'y a rien). Les messages renvoyés
    // restent au-delà -> toujours re-remis si l'ack qui suit échoue.
    const next = rows.length ? rows[0].rid - 1 : (q('SELECT MAX(rowid) AS m FROM messages').get().m || 0);
    if (next > params.cursor) q('UPDATE registry SET cursor = ? WHERE project = ?').run(next, project);
  }
  const messages = rows.map((r) => {
    const m = rowToMsg(r);
    m.status = r.myReadAt ? 'read' : 'unread';
    m.readAt = r.myReadAt || null;
    return m;
  });
  // total = nombre de messages correspondants sans la limite (pour signaler un reliquat).
  const total = params.limit > 0 && rows.length === params.limit
    ? q(`SELECT COUNT(*) AS c FROM (${INBOX_BASE})`).get(params).c
    : messages.length;
  return { messages, total };
}

// --- Remise / accusés de lecture ---------------------------------------------
// Charge le registre une fois pour calculer les destinataires attendus en JS.
function loadRegistryForDelivery() {
  return q('SELECT project, channels, firstSeen FROM registry').all().map((r) => ({
    project: r.project, firstSeen: r.firstSeen || '', channels: parseChannelsJson(r.channels) || [],
  }));
}

// Destinataires attendus d'un message (ligne SQL ou Message), d'après le registre.
// Sert au monitoring uniquement (qui l'a lu, qui ne l'a pas encore reçu) ; la
// remise elle-même reste sans état côté broker (canaux transmis par le client).
function expectedRecipients(m, reg) {
  const sender = m.sender || m.from;
  const to = m.recipient || m.to;
  if (!isGroupAddress(to)) return [to];
  return reg
    .filter((e) => e.project !== sender && e.firstSeen <= m.createdAt &&
                   (to === '*' || e.channels.includes(to)))
    .map((e) => e.project);
}

function receiptsFor(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = q('SELECT messageId, project FROM receipts WHERE messageId IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids));
  for (const r of rows) {
    if (!map.has(r.messageId)) map.set(r.messageId, []);
    map.get(r.messageId).push(r.project);
  }
  return map;
}

// Passe messages.status à "read" si tous les destinataires connus ont lu (ou "*").
function refreshStatus(row, readers, reg, now) {
  if (row.status === 'read') return;
  const set = new Set(readers);
  const expected = expectedRecipients(row, reg);
  const done = set.has('*') || (expected.length ? expected.every((p) => set.has(p)) : set.size > 0);
  if (done) q("UPDATE messages SET status = 'read', readAt = ? WHERE id = ?").run(now, row.id);
}

// Acquittement idempotent. project fourni -> accusé à son nom (cas normal).
// Sans project (clients d'avant les accusés par projet) : un message direct est
// attribué à son destinataire, une diffusion/un canal est marqué lu pour tous ("*")
// -> comportement d'origine conservé, jamais pire qu'avant.
// Renvoie le nombre de nouveaux accusés.
function ackIds(ids, project) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const list = [...new Set(ids.map(String))];
  const now = new Date().toISOString();
  return transaction(() => {
    const rows = q('SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(list));
    const ins = q('INSERT OR IGNORE INTO receipts (messageId, project, readAt) VALUES (?, ?, ?)');
    let n = 0;
    for (const r of rows) {
      const who = project || (isGroupAddress(r.recipient) ? '*' : r.recipient);
      n += ins.run(r.id, who, now).changes;
    }
    const reg = loadRegistryForDelivery();
    const readers = receiptsFor(rows.map((r) => r.id));
    for (const r of rows) refreshStatus(r, readers.get(r.id) || [], reg, now);
    return n;
  });
}

// « Vu » côté monitoring (bouton de l'UI) : éteint l'indicateur non-lu sans créer
// d'accusé -> n'empêche AUCUN agent de recevoir le message.
function markSeen(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  return q("UPDATE messages SET status = 'read', readAt = ? WHERE status <> 'read' AND id IN (SELECT value FROM json_each(?))")
    .run(new Date().toISOString(), JSON.stringify(ids.map(String))).changes;
}

// Enrichit des Messages (vues globales) avec readBy (qui l'a lu) et pending
// (destinataires connus qui ne l'ont pas encore reçu).
function withDelivery(msgs) {
  if (!msgs.length) return msgs;
  const reg = loadRegistryForDelivery();
  const readers = receiptsFor(msgs.map((m) => m.id));
  return msgs.map((m) => {
    const readBy = readers.get(m.id) || [];
    const all = readBy.includes('*');
    const pending = all ? [] : expectedRecipients(m, reg).filter((p) => !readBy.includes(p));
    return Object.assign(m, { readBy, pending });
  });
}

function countMessages() {
  return q('SELECT COUNT(*) AS c FROM messages').get().c;
}

function countUnread() {
  return q("SELECT COUNT(*) AS c FROM messages WHERE status = 'unread'").get().c;
}

// --- Vues de monitoring -------------------------------------------------------
function getThread(threadId) {
  return withDelivery(q('SELECT * FROM messages WHERE threadId = ? ORDER BY createdAt ASC, rowid ASC')
    .all(threadId).map(rowToMsg));
}

// Clé de conversation : un canal (#x), la diffusion (*), ou la paire de projets
// pour un échange direct (triée -> A↔B = B↔A = une seule conversation). Calculée
// en SQL pour regrouper sans charger tous les messages en mémoire.
const CONV_KEY_SQL = `CASE WHEN recipient = '*' THEN '*'
  WHEN substr(recipient, 1, 1) = '#' THEN recipient
  ELSE '@' || min(sender, recipient) || '|' || max(sender, recipient) END`;

function describeConvKey(key) {
  if (key === '*') return { kind: 'bcast', label: 'Diffusion', members: null };
  if (key.charAt(0) === '#') return { kind: 'chan', label: key, members: null };
  const pair = key.slice(1).split('|');
  return { kind: 'dir', label: pair.join(' ↔ '), members: pair };
}

// Vue "boîte mail" : un canal = une conversation (tous ses fils fondus).
function listConversations() {
  const rows = q(`
    WITH c AS (SELECT rowid AS rid, sender, subject, status, (${CONV_KEY_SQL}) AS ckey FROM messages)
    SELECT g.ckey, g.count, g.unread, g.participants,
           l.sender AS lastFrom, l.createdAt AS lastAt, substr(l.body, 1, 160) AS snippet,
           COALESCE(s.subject, '') AS subject
    FROM (SELECT ckey, COUNT(*) AS count,
                 SUM(status = 'unread') AS unread,
                 json_group_array(DISTINCT sender) AS participants,
                 MAX(rid) AS lastRid,
                 MAX(CASE WHEN subject <> '' THEN rid END) AS subjRid
          FROM c GROUP BY ckey) g
    JOIN messages l ON l.rowid = g.lastRid
    LEFT JOIN messages s ON s.rowid = g.subjRid
    ORDER BY l.createdAt DESC`).all();
  return rows.map((r) => Object.assign({ key: r.ckey }, describeConvKey(r.ckey), {
    count: r.count, unread: r.unread, participants: JSON.parse(r.participants),
    lastAt: r.lastAt, lastFrom: r.lastFrom, subject: r.subject, snippet: r.snippet || '',
  }));
}

// Tous les messages d'une conversation, triés chronologiquement.
function getConversation(key) {
  let rows;
  if (key === '*' || key.charAt(0) === '#') {
    rows = q('SELECT * FROM messages WHERE recipient = ? ORDER BY createdAt ASC, rowid ASC').all(key);
  } else if (key.charAt(0) === '@') {
    const pair = key.slice(1).split('|');
    rows = q(
      "SELECT * FROM messages WHERE recipient NOT LIKE '#%' AND recipient <> '*' AND " +
      '((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) ORDER BY createdAt ASC, rowid ASC'
    ).all(pair[0], pair[1], pair[1], pair[0]);
  } else {
    rows = [];
  }
  return withDelivery(rows.map(rowToMsg));
}

// Liste des fils (monitoring) en une requête : compteurs, racine et dernier message.
function listThreads() {
  const rows = q(`
    SELECT t.threadId, t.count, t.unread, t.lastAt, t.participants,
           root.subject AS rootSubject, root.recipient AS rootTo, l.*
    FROM (SELECT threadId, COUNT(*) AS count, SUM(status = 'unread') AS unread,
                 MAX(createdAt) AS lastAt, MAX(rowid) AS lastRid,
                 json_group_array(DISTINCT sender) AS participants
          FROM messages GROUP BY threadId) t
    JOIN messages l ON l.rowid = t.lastRid
    LEFT JOIN messages root ON root.id = t.threadId
    ORDER BY t.lastAt DESC`).all();
  return rows.map((r) => {
    const last = rowToMsg(r);
    return {
      threadId: r.threadId,
      count: r.count,
      unread: r.unread,
      subject: r.rootSubject || last.subject || '',
      // Destination du fil = "to" du message racine (canal #…, "*" diffusion, ou projet).
      to: r.rootTo || last.to || null,
      participants: JSON.parse(r.participants),
      lastAt: r.lastAt,
      last,
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
  const existing = q('SELECT * FROM registry WHERE project = ?').get(project);
  const firstSeen = existing ? existing.firstSeen : now;
  const host = ('host' in meta) ? (meta.host || null) : (existing ? existing.host : null);
  const role = ('role' in meta) ? (meta.role || null) : (existing ? existing.role : null);
  let channels = existing ? existing.channels : null;
  if ('channels' in meta) channels = JSON.stringify(meta.channels || []);
  q(`
    INSERT INTO registry (project, host, role, channels, firstSeen, lastSeen)
    VALUES (@project, @host, @role, @channels, @firstSeen, @lastSeen)
    ON CONFLICT(project) DO UPDATE SET
      host = excluded.host, role = excluded.role, channels = excluded.channels, lastSeen = excluded.lastSeen
  `).run({ project, host, role, channels, firstSeen, lastSeen: now });
  return rowToRegistry({ project, host, role, channels, firstSeen, lastSeen: now });
}

function getRegistry() {
  return q('SELECT * FROM registry ORDER BY project').all().map(rowToRegistry);
}

// --- Rétention ----------------------------------------------------------------
// Supprime les messages ENTIÈREMENT remis (status "read") plus vieux que `days`
// jours. Un message encore attendu par quelqu'un n'est jamais purgé.
function purgeOlderThan(days) {
  if (!(days > 0)) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  // Le dernier message (MAX(rowid)) n'est jamais purgé : sinon SQLite pourrait
  // réattribuer son rowid à un nouveau message, situé alors sous les curseurs.
  const PURGEABLE = "status = 'read' AND createdAt < ? AND rowid < (SELECT MAX(rowid) FROM messages)";
  return transaction(() => {
    q(`DELETE FROM receipts WHERE messageId IN (SELECT id FROM messages WHERE ${PURGEABLE})`).run(cutoff);
    return q(`DELETE FROM messages WHERE ${PURGEABLE}`).run(cutoff).changes;
  });
}

// --- Migrations ---------------------------------------------------------------
function migrateJson(jsonPath) {
  let data;
  try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return false; }
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const reg = data.registry || {};
  transaction(() => {
    const ins = q(INSERT_SQL);
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
      q(`INSERT OR REPLACE INTO registry (project, host, role, channels, firstSeen, lastSeen)
         VALUES (?, ?, ?, ?, ?, ?)`)
        .run(project, e.host || null, e.role || null,
             e.channels ? JSON.stringify(e.channels) : null,
             e.firstSeen || null, e.lastSeen || null);
    }
    setMeta('seq', typeof data.seq === 'number' ? data.seq : msgs.length);
  });
  return true;
}

// Bases d'avant les accusés par projet : chaque message déjà "read" reçoit un
// accusé équivalent à l'ancien comportement (direct -> son destinataire, groupe ->
// "*"), pour que rien de déjà lu ne soit remis une seconde fois.
function migrateReceipts() {
  if (getMeta('receipts_v1')) return 0;
  return transaction(() => {
    const n = q(`INSERT OR IGNORE INTO receipts (messageId, project, readAt)
      SELECT id,
             CASE WHEN recipient = '*' OR substr(recipient, 1, 1) = '#' THEN '*' ELSE recipient END,
             COALESCE(readAt, createdAt)
      FROM messages WHERE status = 'read'`).run().changes;
    setMeta('receipts_v1', new Date().toISOString());
    return n;
  });
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
  stmts.clear();
  db.pragma('journal_mode = WAL');
  // synchronous reste FULL (défaut) : un message confirmé (201) survit à une coupure.
  db.exec(SCHEMA);
  // Bases d'avant la 0.2 : la table registry existe déjà, sans curseur.
  if (!db.prepare('PRAGMA table_info(registry)').all().some((c) => c.name === 'cursor')) {
    db.exec('ALTER TABLE registry ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0');
  }

  // Migration unique : base vide + ancien JSON présent.
  const empty = countMessages() === 0 && q('SELECT COUNT(*) AS c FROM registry').get().c === 0;
  if (empty && jsonSource && fs.existsSync(jsonSource)) {
    if (migrateJson(jsonSource)) {
      try { fs.renameSync(jsonSource, jsonSource + '.migrated'); } catch { /* non bloquant */ }
      console.log(`[mailbox] migration JSON -> SQLite effectuée depuis ${jsonSource}`);
    }
  }
  const n = migrateReceipts();
  if (n) console.log(`[mailbox] migration : ${n} accusé(s) de lecture reconstruit(s)`);
  return dbFile;
}

function close() { if (db) { db.close(); db = null; stmts.clear(); } }

module.exports = {
  init, close, transaction, nextId, addMessage, findMessage, getInbox, getThread,
  ackIds, markSeen, countMessages, countUnread, listThreads, listConversations, getConversation,
  upsertRegistry, getRegistry, purgeOlderThan, isGroupAddress,
};
