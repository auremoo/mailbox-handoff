#!/usr/bin/env node
/**
 * mailbox-handoff — Auteur : Aurélien Moote - Moo - 2026
 * https://github.com/auremoo/mailbox-handoff — Licence MIT (voir LICENSE).
 *
 * mailbox-broker — service central de messagerie inter-agents Claude Code.
 *
 * Stockage SQLite (better-sqlite3) — voir broker/store.js. Le reste du broker
 * (HTTP) reste sur l'API Node standard.
 * Lancer :  node broker/server.js   (ou via npm start)
 * Config par variables d'environnement :
 *   MAILBOX_PORT            port d'écoute (défaut 7777)
 *   MAILBOX_HOST            interface d'écoute (défaut "::" = IPv4 + IPv6, repli 0.0.0.0)
 *   MAILBOX_DATA            chemin de la base SQLite (défaut ./data/store.db ; un ancien
 *                           store.json voisin est migré automatiquement au 1er démarrage)
 *   MAILBOX_TOKEN           jeton partagé optionnel (si défini, exigé en en-tête X-Mailbox-Token)
 *   MAILBOX_RETENTION_DAYS  purge des messages entièrement remis plus vieux que N jours
 *                           (défaut 0 = jamais)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const service = require('./service');
const { version: VERSION } = require('../package.json');

const PORT = parseInt(process.env.MAILBOX_PORT || '7777', 10);
// "::" écoute aussi en IPv4 (double pile) : sans ça, un client qui vise
// "localhost" tente d'abord ::1, se fait refuser, et Windows patiente ~2 s avant
// de retomber sur 127.0.0.1 — à chaque appel du hook.
const HOST = process.env.MAILBOX_HOST || '::';
const DATA_FILE = process.env.MAILBOX_DATA || path.join(__dirname, '..', 'data', 'store.db');
const TOKEN = process.env.MAILBOX_TOKEN || null;
const RETENTION_DAYS = parseFloat(process.env.MAILBOX_RETENTION_DAYS || '0') || 0;
const INBOX_MAX_LIMIT = 500;
// Page de monitoring servie à la racine (HTML autonome, voir broker/ui.html).
const UI_FILE = path.join(__dirname, 'ui.html');

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------
// Erreur « attendue » portant son code HTTP (les autres deviennent des 500).
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Requête issue de la machine serveur elle-même ? (garde des actions d'admin)
function isLocalhost(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Sert un fichier statique (la page de monitoring). 404 propre si absent.
function sendFile(res, file, contentType) {
  fs.readFile(file, (err, data) => {
    if (err) {
      return send(res, 404, { error: 'page de monitoring introuvable (broker/ui.html)' });
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { // garde-fou 1 Mo
        reject(new HttpError(413, 'corps de requête trop volumineux (max 1 Mo)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' ? v : {});
      } catch { reject(new HttpError(400, 'JSON invalide')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Validation des adresses
// ---------------------------------------------------------------------------
// Nom de projet : "*" (diffusion), "#" (canaux) et "@" (clés de conversation) sont
// des préfixes réservés ; "|" sépare les membres d'une clé de conversation directe.
function checkProject(value, field) {
  const s = value == null ? '' : String(value).trim();
  if (!s) throw new HttpError(400, `champ "${field}" requis`);
  if (s === '*' || s.startsWith('#') || s.startsWith('@') || s.includes('|')) {
    throw new HttpError(400, `"${field}" doit être un nom de projet ("*", "#…", "@…" et "|" sont réservés)`);
  }
  if (s.length > 100) throw new HttpError(400, `"${field}" trop long (max 100 caractères)`);
  return s;
}

// Destinataire : un projet, "*" ou "#canal".
function checkRecipient(value) {
  const s = value == null ? '' : String(value).trim();
  if (s === '*') return s;
  if (s.startsWith('#')) {
    if (s.length < 2) throw new HttpError(400, 'nom de canal vide');
    return s;
  }
  return checkProject(s, 'to');
}

function requireText(value, field) {
  if (value == null || String(value) === '') throw new HttpError(400, `champ "${field}" requis`);
  return String(value);
}

// Normalise un nom de canal : préfixe "#" garanti, vide ignoré.
// Accepte "#sujet-x" comme "sujet-x".
function normalizeChannel(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (!s || s === '#') return null;
  return s.startsWith('#') ? s : '#' + s;
}

// Extrait la liste de canaux d'une entrée (query "a,b" ou tableau JSON).
function parseChannels(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(',');
  return [...new Set(arr.map(normalizeChannel).filter(Boolean))];
}

// Crée et persiste un message en résolvant son fil de discussion.
// Règle threadId : si parent (replyTo) -> hérite du fil du parent ; sinon si
// threadId fourni -> utilisé ; sinon le message est racine (threadId == son id).
// nextId + insertion dans une même transaction : pas de trou de séquence.
function createMessage({ from, to, subject, body, replyTo, threadId, parent }) {
  return store.transaction(() => {
    const id = store.nextId();
    const msg = {
      id,
      from,
      to, // nom de projet, "*" (diffusion) ou "#canal"
      subject: subject ? String(subject) : '',
      body,
      createdAt: new Date().toISOString(),
      status: 'unread',
      readAt: null,
      threadId: (parent && parent.threadId) || threadId || id,
      replyTo: replyTo || null,
    };
    store.addMessage(msg);
    store.upsertRegistry(msg.from, {});
    return msg;
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function route(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ["messages"], ["inbox","server"]...

  // GET /health — sonde de vie, pas de token requis.
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'mailbox-broker', version: VERSION, messages: store.countMessages(), unread: store.countUnread() });
  }

  // GET / et /ui — page de monitoring (HTML autonome). Pas de token : la page
  // demande elle-même le jeton et l'ajoute en en-tête sur ses appels d'API.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) {
    return sendFile(res, UI_FILE, 'text/html; charset=utf-8');
  }

  // Auth optionnelle pour tout le reste.
  if (TOKEN && req.headers['x-mailbox-token'] !== TOKEN) {
    return send(res, 401, { error: 'jeton manquant ou invalide' });
  }

  // POST /register  { project, host?, role?, channels? }
  if (req.method === 'POST' && url.pathname === '/register') {
    const b = await readBody(req);
    const project = checkProject(b.project, 'project');
    const meta = { host: b.host || null, role: b.role || null };
    if (b.channels !== undefined) meta.channels = parseChannels(b.channels);
    const entry = store.upsertRegistry(project, meta);
    return send(res, 200, { ok: true, registry: entry });
  }

  // GET /registry — liste des projets connus.
  if (req.method === 'GET' && url.pathname === '/registry') {
    return send(res, 200, { projects: store.getRegistry() });
  }

  // GET /threads — liste des fils (monitoring).
  if (req.method === 'GET' && url.pathname === '/threads') {
    return send(res, 200, { threads: store.listThreads() });
  }

  // GET /conversations — vue "boîte mail" : messages regroupés par canal /
  // diffusion / paire directe (un canal = une seule conversation).
  if (req.method === 'GET' && url.pathname === '/conversations') {
    return send(res, 200, { conversations: store.listConversations() });
  }

  // GET /conversation?key=... — tous les messages d'une conversation, chronologiques.
  if (req.method === 'GET' && url.pathname === '/conversation') {
    const key = url.searchParams.get('key') || '';
    const items = store.getConversation(key);
    return send(res, 200, { key, count: items.length, messages: items });
  }

  // Endpoints d'administration (gestion du service Windows) : réservés à la
  // machine serveur (localhost), car ils exécutent nssm avec les droits du process.
  if (seg[0] === 'admin') {
    if (!isLocalhost(req)) {
      return send(res, 403, { error: "actions d'administration réservées à la machine serveur (localhost)" });
    }
    if (req.method === 'GET' && url.pathname === '/admin/status') {
      return send(res, 200, { service: service.status(), broker: { version: VERSION, port: PORT, dataFile: DB_FILE, retentionDays: RETENTION_DAYS } });
    }
    if (req.method === 'POST' && url.pathname === '/admin/service/install') {
      try { return send(res, 200, service.install({ port: PORT, token: TOKEN, dataFile: DB_FILE, retentionDays: RETENTION_DAYS })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/admin/service/remove') {
      try { return send(res, 200, service.remove()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    return send(res, 404, { error: 'route admin inconnue' });
  }

  // POST /messages  { from, to, subject?, body, replyTo?, threadId? }
  if (req.method === 'POST' && url.pathname === '/messages') {
    const b = await readBody(req);
    const from = checkProject(b.from, 'from');
    const to = checkRecipient(b.to);
    const body = requireText(b.body, 'body');
    // replyTo facultatif : on rattache au fil du parent si on le retrouve.
    let parent = null;
    if (b.replyTo) {
      parent = store.findMessage(String(b.replyTo));
      if (!parent) return send(res, 404, { error: 'message parent (replyTo) introuvable' });
    }
    const msg = createMessage({
      from, to, subject: b.subject, body,
      replyTo: parent ? parent.id : null, threadId: b.threadId ? String(b.threadId) : null, parent,
    });
    return send(res, 201, { ok: true, id: msg.id, threadId: msg.threadId });
  }

  // POST /reply  { from, replyTo, body, subject? }
  // Répond dans le fil : destinataire = expéditeur du parent, fil hérité.
  if (req.method === 'POST' && url.pathname === '/reply') {
    const b = await readBody(req);
    const from = checkProject(b.from, 'from');
    const replyTo = requireText(b.replyTo, 'replyTo');
    const body = requireText(b.body, 'body');
    const parent = store.findMessage(replyTo);
    if (!parent) return send(res, 404, { error: 'message parent (replyTo) introuvable' });
    const subject = b.subject
      ? String(b.subject)
      : (parent.subject ? (parent.subject.startsWith('Re:') ? parent.subject : 'Re: ' + parent.subject) : '');
    const msg = createMessage({
      from, to: parent.from, subject, body, replyTo: parent.id, parent,
    });
    return send(res, 201, { ok: true, id: msg.id, threadId: msg.threadId, to: msg.to });
  }

  // GET /thread/:threadId — tout le fil, trié par date croissante.
  if (req.method === 'GET' && seg[0] === 'thread' && seg[1]) {
    const threadId = decodeURIComponent(seg[1]);
    const items = store.getThread(threadId);
    return send(res, 200, { threadId, count: items.length, messages: items });
  }

  // GET /inbox/:project?status=unread&channels=sujet-x,sujet-y&limit=20
  if (req.method === 'GET' && seg[0] === 'inbox' && seg[1]) {
    const project = checkProject(decodeURIComponent(seg[1]), 'project');
    const statusFilter = url.searchParams.get('status'); // unread | read | (tous)
    // Canaux auxquels ce projet est abonné : transmis par le client (sans état
    // de membership côté broker -> filtrage fiable quel que soit l'ordre).
    const channels = parseChannels(url.searchParams.get('channels'));
    const limitRaw = parseInt(url.searchParams.get('limit') || '0', 10);
    const limit = limitRaw > 0 ? Math.min(limitRaw, INBOX_MAX_LIMIT) : 0;
    const meta = {};
    if (url.searchParams.has('channels')) meta.channels = channels;
    store.upsertRegistry(project, meta); // persiste le lastSeen / channels
    const { messages, total } = store.getInbox(project, channels, statusFilter || null, limit);
    return send(res, 200, { project, count: messages.length, total, messages });
  }

  // POST /messages/:id/ack  { project? } — marque lu (pour ce projet)
  if (req.method === 'POST' && seg[0] === 'messages' && seg[1] && seg[2] === 'ack') {
    const id = decodeURIComponent(seg[1]);
    const b = await readBody(req);
    const p = b.project || url.searchParams.get('project');
    const project = p ? checkProject(p, 'project') : null;
    if (!store.findMessage(id)) return send(res, 404, { error: 'message introuvable' });
    store.ackIds([id], project);
    return send(res, 200, { ok: true, id });
  }

  // POST /ack  { ids: [...], project?, monitorOnly? } — acquittement groupé.
  // project : à qui attribuer la lecture (fortement recommandé ; sans lui, une
  // diffusion/un canal est marqué lu pour tous — comportement hérité).
  // monitorOnly : simple « vu » de l'interface web, n'affecte aucune remise.
  if (req.method === 'POST' && url.pathname === '/ack') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    if (b.monitorOnly) return send(res, 200, { ok: true, acked: store.markSeen(ids) });
    const project = b.project ? checkProject(b.project, 'project') : null;
    return send(res, 200, { ok: true, acked: store.ackIds(ids, project) });
  }

  return send(res, 404, { error: 'route inconnue', path: url.pathname });
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------
const DB_FILE = store.init(DATA_FILE);

function runRetention() {
  if (!RETENTION_DAYS) return;
  try {
    const n = store.purgeOlderThan(RETENTION_DAYS);
    if (n) console.log(`[mailbox] rétention : ${n} message(s) remis de plus de ${RETENTION_DAYS} j purgé(s)`);
  } catch (e) { console.error('[mailbox] purge de rétention échouée :', e.message); }
}
runRetention();
setInterval(runRetention, 3600_000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://broker');
  route(req, res, url).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[mailbox] erreur interne :', err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'erreur interne du broker' : err.message });
  });
});

function onListening() {
  const a = server.address();
  const shown = a.address === '::' || a.address === '0.0.0.0' ? 'localhost' : a.address;
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  mailbox-handoff                             │');
  console.log('│  Aurélien Moote - Moo - 2026  ·  Licence MIT │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`[mailbox] broker v${VERSION} à l'écoute sur ${a.address} port ${a.port}`);
  console.log(`[mailbox] monitoring : http://${shown}:${a.port}/`);
  console.log(`[mailbox] stockage SQLite : ${DB_FILE}`);
  console.log(`[mailbox] auth jeton : ${TOKEN ? 'activée' : 'désactivée'}`);
  console.log(`[mailbox] rétention : ${RETENTION_DAYS ? RETENTION_DAYS + ' jour(s)' : 'désactivée (aucune purge)'}`);
}

// Machine sans IPv6 : "::" échoue -> on retombe sur 0.0.0.0 (IPv4 seul).
server.on('error', (err) => {
  if (!process.env.MAILBOX_HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
    console.log('[mailbox] IPv6 indisponible, écoute en IPv4 seul (0.0.0.0).');
    server.listen(PORT, '0.0.0.0', onListening);
    return;
  }
  console.error(`[mailbox] impossible d'écouter sur le port ${PORT} : ${err.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, onListening);

function shutdown() {
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => { console.log('\n[mailbox] arrêt.'); shutdown(); });
process.on('SIGTERM', shutdown);
