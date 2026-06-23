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
 *   MAILBOX_PORT   port d'écoute            (défaut 7777)
 *   MAILBOX_HOST   interface d'écoute       (défaut 0.0.0.0 — accessible sur le LAN)
 *   MAILBOX_DATA   chemin de la base SQLite (défaut ./data/store.db ; un ancien
 *                  store.json voisin est migré automatiquement au 1er démarrage)
 *   MAILBOX_TOKEN  jeton partagé optionnel  (si défini, exigé en en-tête X-Mailbox-Token)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const service = require('./service');

const PORT = parseInt(process.env.MAILBOX_PORT || '7777', 10);
const HOST = process.env.MAILBOX_HOST || '0.0.0.0';
const DATA_FILE = process.env.MAILBOX_DATA || path.join(__dirname, '..', 'data', 'store.db');
const TOKEN = process.env.MAILBOX_TOKEN || null;
// Page de monitoring servie à la racine (HTML autonome, voir broker/ui.html).
const UI_FILE = path.join(__dirname, 'ui.html');

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------
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
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
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
        reject(new Error('corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

// Crée et persiste un message en résolvant son fil de discussion.
// Règle threadId : si replyTo -> hérite du fil du parent ; sinon si threadId
// fourni -> utilisé ; sinon le message est racine (threadId == son propre id).
// `parent` (optionnel) évite de re-chercher le message parent côté appelant.
function createMessage({ from, to, subject, body, replyTo, threadId, parent }) {
  const id = store.nextId();
  let thread = threadId || null;
  if (parent) thread = parent.threadId;
  if (!thread) thread = id;
  const msg = {
    id,
    from: String(from),
    to: String(to), // nom de projet, "*" (diffusion) ou "#canal"
    subject: subject ? String(subject) : '',
    body: String(body),
    createdAt: new Date().toISOString(),
    status: 'unread',
    readAt: null,
    threadId: thread,
    replyTo: replyTo || null,
  };
  store.addMessage(msg);
  store.upsertRegistry(msg.from, {});
  return msg;
}

// Normalise un nom de canal : préfixe "#" garanti, vide ignoré.
// Accepte "#sujet-x" comme "sujet-x".
function normalizeChannel(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (!s) return null;
  return s.startsWith('#') ? s : '#' + s;
}

// Extrait la liste de canaux d'une entrée (query "a,b" ou tableau JSON).
function parseChannels(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(',');
  return arr.map(normalizeChannel).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function route(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ["messages"], ["inbox","server"]...

  // GET /health — sonde de vie, pas de token requis.
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'mailbox-broker', messages: store.countMessages() });
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
    if (!b.project) return send(res, 400, { error: 'champ "project" requis' });
    const meta = { host: b.host || null, role: b.role || null };
    if (b.channels !== undefined) meta.channels = parseChannels(b.channels);
    const entry = store.upsertRegistry(b.project, meta);
    return send(res, 200, { ok: true, registry: entry });
  }

  // GET /registry — liste des projets connus.
  if (req.method === 'GET' && url.pathname === '/registry') {
    return send(res, 200, { projects: store.getRegistry() });
  }

  // GET /threads — liste des fils (monitoring UI).
  if (req.method === 'GET' && url.pathname === '/threads') {
    return send(res, 200, { threads: store.listThreads() });
  }

  // Endpoints d'administration (gestion du service Windows) : réservés à la
  // machine serveur (localhost), car ils exécutent nssm avec les droits du process.
  if (seg[0] === 'admin') {
    if (!isLocalhost(req)) {
      return send(res, 403, { error: "actions d'administration réservées à la machine serveur (localhost)" });
    }
    if (req.method === 'GET' && url.pathname === '/admin/status') {
      return send(res, 200, { service: service.status(), broker: { port: PORT, dataFile: DB_FILE } });
    }
    if (req.method === 'POST' && url.pathname === '/admin/service/install') {
      try { return send(res, 200, service.install({ port: PORT, token: TOKEN, dataFile: DB_FILE })); }
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
    if (!b.from || !b.to || !b.body) {
      return send(res, 400, { error: 'champs "from", "to" et "body" requis' });
    }
    // replyTo facultatif : on rattache au fil du parent si on le retrouve.
    let parent = null;
    if (b.replyTo) {
      parent = store.findMessage(b.replyTo);
      if (!parent) return send(res, 404, { error: 'message parent (replyTo) introuvable' });
    }
    const msg = createMessage({
      from: b.from, to: b.to, subject: b.subject, body: b.body,
      replyTo: b.replyTo || null, threadId: b.threadId || null, parent,
    });
    return send(res, 201, { ok: true, id: msg.id, threadId: msg.threadId });
  }

  // POST /reply  { from, replyTo, body, subject? }
  // Répond dans le fil : destinataire = expéditeur du parent, fil hérité.
  if (req.method === 'POST' && url.pathname === '/reply') {
    const b = await readBody(req);
    if (!b.from || !b.replyTo || !b.body) {
      return send(res, 400, { error: 'champs "from", "replyTo" et "body" requis' });
    }
    const parent = store.findMessage(b.replyTo);
    if (!parent) return send(res, 404, { error: 'message parent (replyTo) introuvable' });
    const subject = b.subject
      ? String(b.subject)
      : (parent.subject ? (parent.subject.startsWith('Re:') ? parent.subject : 'Re: ' + parent.subject) : '');
    const msg = createMessage({
      from: b.from, to: parent.from, subject, body: b.body, replyTo: parent.id, parent,
    });
    return send(res, 201, { ok: true, id: msg.id, threadId: msg.threadId, to: msg.to });
  }

  // GET /thread/:threadId — tout le fil, trié par date croissante.
  if (req.method === 'GET' && seg[0] === 'thread' && seg[1]) {
    const threadId = decodeURIComponent(seg[1]);
    const items = store.getThread(threadId);
    return send(res, 200, { threadId, count: items.length, messages: items });
  }

  // GET /inbox/:project?status=unread&channels=sujet-x,sujet-y
  if (req.method === 'GET' && seg[0] === 'inbox' && seg[1]) {
    const project = decodeURIComponent(seg[1]);
    const statusFilter = url.searchParams.get('status'); // unread | read | (tous)
    // Canaux auxquels ce projet est abonné : transmis par le client (sans état
    // de membership côté broker -> filtrage fiable quel que soit l'ordre).
    const channels = parseChannels(url.searchParams.get('channels'));
    const meta = {};
    if (url.searchParams.has('channels')) meta.channels = channels;
    store.upsertRegistry(project, meta); // persiste le lastSeen / channels
    const items = store.getInbox(project, channels, statusFilter || null);
    return send(res, 200, { project, count: items.length, messages: items });
  }

  // POST /messages/:id/ack — marque lu
  if (req.method === 'POST' && seg[0] === 'messages' && seg[1] && seg[2] === 'ack') {
    const id = decodeURIComponent(seg[1]);
    if (!store.findMessage(id)) return send(res, 404, { error: 'message introuvable' });
    store.ackIds([id]);
    return send(res, 200, { ok: true, id });
  }

  // POST /ack  { ids: [...] } — acquittement groupé
  if (req.method === 'POST' && url.pathname === '/ack') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const n = store.ackIds(ids);
    return send(res, 200, { ok: true, acked: n });
  }

  return send(res, 404, { error: 'route inconnue', path: url.pathname });
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------
const DB_FILE = store.init(DATA_FILE);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  route(req, res, url).catch((err) => {
    send(res, 400, { error: err.message || 'erreur serveur' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mailbox] broker à l'écoute sur http://${HOST}:${PORT}`);
  console.log(`[mailbox] monitoring : http://${HOST}:${PORT}/`);
  console.log(`[mailbox] stockage SQLite : ${DB_FILE}`);
  console.log(`[mailbox] auth jeton : ${TOKEN ? 'activée' : 'désactivée'}`);
});

process.on('SIGINT', () => { console.log('\n[mailbox] arrêt.'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
