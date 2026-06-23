#!/usr/bin/env node
/**
 * mailbox-broker — service central de messagerie inter-agents Claude Code.
 *
 * Zéro dépendance externe : http natif + stockage JSON sur disque.
 * Lancer :  node broker/server.js   (ou via npm start)
 * Config par variables d'environnement :
 *   MAILBOX_PORT   port d'écoute            (défaut 7777)
 *   MAILBOX_HOST   interface d'écoute       (défaut 0.0.0.0 — accessible sur le LAN)
 *   MAILBOX_DATA   chemin du fichier d'état (défaut ./data/store.json)
 *   MAILBOX_TOKEN  jeton partagé optionnel  (si défini, exigé en en-tête X-Mailbox-Token)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.MAILBOX_PORT || '7777', 10);
const HOST = process.env.MAILBOX_HOST || '0.0.0.0';
const DATA_FILE = process.env.MAILBOX_DATA || path.join(__dirname, '..', 'data', 'store.json');
const TOKEN = process.env.MAILBOX_TOKEN || null;

// ---------------------------------------------------------------------------
// Stockage : un objet en mémoire, persisté en JSON à chaque mutation.
// Volume attendu faible (quelques agents), une écriture synchrone suffit.
// ---------------------------------------------------------------------------
let store = { seq: 0, messages: [], registry: {} };

function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    store = JSON.parse(raw);
    if (!store.messages) store.messages = [];
    if (!store.registry) store.registry = {};
    if (typeof store.seq !== 'number') store.seq = store.messages.length;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[mailbox] lecture du store échouée, repart à vide :', err.message);
    }
    store = { seq: 0, messages: [], registry: {} };
  }
}

let writePending = false;
function saveStore() {
  // Coalesce les écritures rapprochées en une seule passe disque.
  if (writePending) return;
  writePending = true;
  setImmediate(() => {
    writePending = false;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, DATA_FILE); // remplacement atomique
    } catch (err) {
      console.error('[mailbox] écriture du store échouée :', err.message);
    }
  });
}

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

function nextId() {
  store.seq += 1;
  const n = String(store.seq).padStart(5, '0');
  return `msg_${n}`;
}

function touchRegistry(project, meta) {
  if (!project) return;
  const now = new Date().toISOString();
  const cur = store.registry[project] || { project, firstSeen: now };
  store.registry[project] = { ...cur, ...meta, project, lastSeen: now };
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
    return send(res, 200, { ok: true, service: 'mailbox-broker', messages: store.messages.length });
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
    touchRegistry(b.project, meta);
    saveStore();
    return send(res, 200, { ok: true, registry: store.registry[b.project] });
  }

  // GET /registry — liste des projets connus.
  if (req.method === 'GET' && url.pathname === '/registry') {
    return send(res, 200, { projects: Object.values(store.registry) });
  }

  // POST /messages  { from, to, subject?, body }
  if (req.method === 'POST' && url.pathname === '/messages') {
    const b = await readBody(req);
    if (!b.from || !b.to || !b.body) {
      return send(res, 400, { error: 'champs "from", "to" et "body" requis' });
    }
    const msg = {
      id: nextId(),
      from: String(b.from),
      to: String(b.to), // nom de projet, ou "*" pour diffusion
      subject: b.subject ? String(b.subject) : '',
      body: String(b.body),
      createdAt: new Date().toISOString(),
      status: 'unread',
      readAt: null,
    };
    store.messages.push(msg);
    touchRegistry(b.from, {});
    saveStore();
    return send(res, 201, { ok: true, id: msg.id });
  }

  // GET /inbox/:project?status=unread&channels=sujet-x,sujet-y
  if (req.method === 'GET' && seg[0] === 'inbox' && seg[1]) {
    const project = decodeURIComponent(seg[1]);
    const statusFilter = url.searchParams.get('status'); // unread | read | (tous)
    // Canaux auxquels ce projet est abonné : transmis par le client (sans état
    // de membership côté broker -> filtrage fiable quel que soit l'ordre).
    const channelSet = new Set(parseChannels(url.searchParams.get('channels')));
    const meta = {};
    if (url.searchParams.has('channels')) meta.channels = [...channelSet];
    touchRegistry(project, meta);
    const items = store.messages.filter((m) => {
      const isChannel = typeof m.to === 'string' && m.to.startsWith('#');
      const addressed = m.to === project || m.to === '*' || (isChannel && channelSet.has(m.to));
      if (!addressed) return false;
      if (statusFilter && m.status !== statusFilter) return false;
      return true;
    });
    saveStore(); // persiste le lastSeen / channels
    return send(res, 200, { project, count: items.length, messages: items });
  }

  // POST /messages/:id/ack — marque lu
  if (req.method === 'POST' && seg[0] === 'messages' && seg[1] && seg[2] === 'ack') {
    const id = decodeURIComponent(seg[1]);
    const msg = store.messages.find((m) => m.id === id);
    if (!msg) return send(res, 404, { error: 'message introuvable' });
    msg.status = 'read';
    msg.readAt = new Date().toISOString();
    saveStore();
    return send(res, 200, { ok: true, id });
  }

  // POST /ack  { ids: [...] } — acquittement groupé
  if (req.method === 'POST' && url.pathname === '/ack') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    let n = 0;
    for (const id of ids) {
      const msg = store.messages.find((m) => m.id === id);
      if (msg && msg.status !== 'read') {
        msg.status = 'read';
        msg.readAt = new Date().toISOString();
        n += 1;
      }
    }
    saveStore();
    return send(res, 200, { ok: true, acked: n });
  }

  return send(res, 404, { error: 'route inconnue', path: url.pathname });
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------
loadStore();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  route(req, res, url).catch((err) => {
    send(res, 400, { error: err.message || 'erreur serveur' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mailbox] broker à l'écoute sur http://${HOST}:${PORT}`);
  console.log(`[mailbox] stockage : ${DATA_FILE}`);
  console.log(`[mailbox] auth jeton : ${TOKEN ? 'activée' : 'désactivée'}`);
});

process.on('SIGINT', () => { console.log('\n[mailbox] arrêt.'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
