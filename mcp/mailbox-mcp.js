#!/usr/bin/env node
/**
 * mailbox-mcp — façade MCP du broker de messagerie inter-agents.
 *
 * Serveur MCP minimal (JSON-RPC 2.0 sur stdio, sans dépendance) qui expose au
 * format "tool" les opérations de la mailbox. L'agent appelle directement
 * mailbox_send / mailbox_inbox / mailbox_ack / mailbox_registry sans passer par
 * un script PowerShell.
 *
 * Identité du projet + URL broker, par ordre de priorité :
 *   1. variables d'env  MAILBOX_PROJECT / MAILBOX_BROKER / MAILBOX_TOKEN
 *      (renseignées dans .mcp.json — recommandé)
 *   2. fichier .mailbox.json du projet (CLAUDE_PROJECT_DIR, puis cwd)
 *
 * Transport stdio : un message JSON-RPC par ligne (délimité par \n).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// --- Résolution de la configuration ------------------------------------------
function normalizeChannels(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(',');
  return arr
    .map((c) => (c == null ? '' : String(c).trim()))
    .filter(Boolean)
    .map((c) => (c.startsWith('#') ? c : '#' + c));
}

function loadConfig() {
  let project = process.env.MAILBOX_PROJECT || null;
  let broker = process.env.MAILBOX_BROKER || null;
  let token = process.env.MAILBOX_TOKEN || null;
  let channels = process.env.MAILBOX_CHANNELS ? normalizeChannels(process.env.MAILBOX_CHANNELS) : null;

  if (!project || !broker || !channels) {
    const dirs = [process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(Boolean);
    for (const d of dirs) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(d, '.mailbox.json'), 'utf8'));
        project = project || cfg.project;
        broker = broker || cfg.broker;
        token = token || cfg.token || null;
        if (!channels && cfg.channels) channels = normalizeChannels(cfg.channels);
        if (project && broker) break;
      } catch { /* fichier absent ou invalide : on continue */ }
    }
  }
  if (broker) broker = broker.replace(/\/+$/, '');
  return { project, broker, token: token || null, channels: channels || [] };
}

const CONFIG = loadConfig();

// --- Appels HTTP vers le broker ----------------------------------------------
// Module http/https natif (pas de fetch/undici) : connexion fraîche à chaque
// appel, sans pool keep-alive susceptible de réutiliser un socket périmé sur un
// process long-vivant. Cohérent avec le broker (100% stdlib).
function brokerFetch(method, route, body) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.broker) {
      return reject(new Error('broker non configuré (MAILBOX_BROKER ou .mailbox.json)'));
    }
    const url = new URL(CONFIG.broker + route);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (CONFIG.token) headers['X-Mailbox-Token'] = CONFIG.token;

    const req = lib.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers, timeout: 6000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let data;
          try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`broker ${res.statusCode} : ${data.error || text || 'erreur'}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('délai dépassé en joignant le broker')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Retente une fois en cas d'erreur de connexion transitoire (SYN droppé sous
// rafale sur le loopback, socket réinitialisé). Les erreurs applicatives du
// broker (4xx/5xx) ne sont PAS retentées.
const TRANSIENT = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'];
function isTransient(err) {
  return TRANSIENT.some((c) => (err.code === c) || (err.message && err.message.includes(c)));
}
async function brokerCall(method, route, body) {
  try {
    return await brokerFetch(method, route, body);
  } catch (err) {
    if (!isTransient(err)) throw err;
    await new Promise((r) => setTimeout(r, 150));
    return brokerFetch(method, route, body); // 2e (et dernière) tentative
  }
}

// --- Définition des tools -----------------------------------------------------
const TOOLS = [
  {
    name: 'mailbox_send',
    description:
      "Envoie un message fire-and-forget à un autre projet/agent lié, pour s'aligner " +
      "(changement de contrat d'API, schéma de données, décision). Destinataire : un nom " +
      'de projet (ex: "frontend"), "*" pour diffuser à tous, ou "#canal" pour un canal/sujet ' +
      "nommé (seuls les abonnés du canal le reçoivent).",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Projet destinataire (ex: "frontend"), "*" pour tous, ou "#canal" pour un sujet nommé.' },
        body: { type: 'string', description: 'Contenu du message.' },
        subject: { type: 'string', description: 'Sujet court (optionnel).' },
        replyTo: { type: 'string', description: 'Id d\'un message auquel rattacher celui-ci (même fil). Pour répondre à un expéditeur, préférer mailbox_reply.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'mailbox_inbox',
    description:
      'Lit la boîte de réception du projet courant. Par défaut ne renvoie que les non-lus ' +
      'et ne les marque PAS lus (mettre markRead=true pour acquitter après lecture). ' +
      'Note : les non-lus sont déjà injectés automatiquement à chaque prise de main via le hook.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['unread', 'read', 'all'], description: 'Filtre (défaut "unread").' },
        markRead: { type: 'boolean', description: 'Si true, acquitte les messages lus (défaut false).' },
      },
    },
  },
  {
    name: 'mailbox_reply',
    description:
      "Répond à un message reçu, dans le même fil de discussion (thread). Le destinataire est " +
      "automatiquement l'expéditeur du message d'origine ; le sujet hérite (\"Re: …\"). À utiliser " +
      'pour le mode question/réponse plutôt que mailbox_send.',
    inputSchema: {
      type: 'object',
      properties: {
        replyTo: { type: 'string', description: "Id du message auquel on répond (ex: \"msg_00042\")." },
        body: { type: 'string', description: 'Contenu de la réponse.' },
        subject: { type: 'string', description: 'Sujet (optionnel ; sinon hérite du message parent).' },
      },
      required: ['replyTo', 'body'],
    },
  },
  {
    name: 'mailbox_thread',
    description: "Récupère tous les messages d'un fil de discussion (thread), triés du plus ancien au plus récent.",
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Id du fil (champ "threadId" d\'un message ; souvent l\'id du message racine).' },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'mailbox_ack',
    description: 'Marque comme lus une liste de messages (par leurs ids).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Identifiants de messages à acquitter.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'mailbox_registry',
    description: 'Liste les projets/agents connus du broker (avec dernière activité).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// --- Exécution d'un tool ------------------------------------------------------
async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'mailbox_send': {
      if (!CONFIG.project) throw new Error('projet émetteur non configuré (MAILBOX_PROJECT ou .mailbox.json)');
      if (!args.to || !args.body) throw new Error('"to" et "body" sont requis');
      const r = await brokerCall('POST', '/messages', {
        from: CONFIG.project, to: args.to, subject: args.subject || '', body: args.body,
        replyTo: args.replyTo || undefined,
      });
      return `Message envoyé à « ${args.to} » (id ${r.id}, fil ${r.threadId}) depuis « ${CONFIG.project} ».`;
    }
    case 'mailbox_reply': {
      if (!CONFIG.project) throw new Error('projet émetteur non configuré (MAILBOX_PROJECT ou .mailbox.json)');
      if (!args.replyTo || !args.body) throw new Error('"replyTo" et "body" sont requis');
      const r = await brokerCall('POST', '/reply', {
        from: CONFIG.project, replyTo: args.replyTo, subject: args.subject || undefined, body: args.body,
      });
      return `Réponse envoyée à « ${r.to} » dans le fil ${r.threadId} (id ${r.id}).`;
    }
    case 'mailbox_thread': {
      if (!args.threadId) throw new Error('"threadId" est requis');
      const r = await brokerCall('GET', `/thread/${encodeURIComponent(args.threadId)}`);
      return JSON.stringify({ threadId: r.threadId, count: r.count, messages: r.messages || [] }, null, 2);
    }
    case 'mailbox_inbox': {
      if (!CONFIG.project) throw new Error('projet non configuré (MAILBOX_PROJECT ou .mailbox.json)');
      const status = args.status && args.status !== 'all' ? args.status : null;
      const params = [];
      if (status) params.push(`status=${encodeURIComponent(status)}`);
      if (CONFIG.channels.length) params.push(`channels=${encodeURIComponent(CONFIG.channels.join(','))}`);
      const q = params.length ? `?${params.join('&')}` : '';
      const r = await brokerCall('GET', `/inbox/${encodeURIComponent(CONFIG.project)}${q}`);
      const msgs = r.messages || [];
      if (args.markRead && msgs.length) {
        await brokerCall('POST', '/ack', { ids: msgs.map((m) => m.id) }).catch(() => {});
      }
      return JSON.stringify({ project: CONFIG.project, count: msgs.length, messages: msgs }, null, 2);
    }
    case 'mailbox_ack': {
      if (!Array.isArray(args.ids)) throw new Error('"ids" doit être un tableau');
      const r = await brokerCall('POST', '/ack', { ids: args.ids });
      return `${r.acked} message(s) acquitté(s).`;
    }
    case 'mailbox_registry': {
      const r = await brokerCall('GET', '/registry');
      return JSON.stringify(r.projects || [], null, 2);
    }
    default:
      throw new Error(`tool inconnu : ${name}`);
  }
}

// --- Boucle JSON-RPC sur stdio ------------------------------------------------
const SERVER_INFO = { name: 'mailbox', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      return; // notification, pas de réponse

    case 'ping':
      if (isRequest) reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const text = await callTool(name, args);
        reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        // Erreur applicative : renvoyée comme résultat isError (l'agent peut réagir).
        reply(id, { content: [{ type: 'text', text: `Erreur : ${err.message}` }], isError: true });
      }
      return;
    }

    default:
      if (isRequest) replyError(id, -32601, `méthode non supportée : ${method}`);
  }
}

let buffer = '';
let pending = 0;     // requêtes en cours de traitement (appels broker async)
let ended = false;   // stdin fermé par le parent
function maybeExit() {
  // Ne sort que lorsque stdin est clos ET plus aucune requête en vol,
  // pour ne pas perdre une réponse asynchrone (ex: appel broker en cours).
  if (ended && pending === 0) process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; } // ligne illisible : ignorée
    pending += 1;
    Promise.resolve(handle(msg))
      .catch((err) => {
        if (msg && msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, err.message);
      })
      .finally(() => { pending -= 1; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });
