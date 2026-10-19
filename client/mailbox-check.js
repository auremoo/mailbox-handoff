#!/usr/bin/env node
/**
 * mailbox-handoff — Auteur : Aurélien Moote - Moo - 2026
 * https://github.com/auremoo/mailbox-handoff — Licence MIT (voir LICENSE).
 *
 * mailbox-check.js — hook de réception (version Node, jumelle de mailbox-check.ps1).
 *
 * Même rôle et même sortie que la version PowerShell, mais ~4x plus rapide au
 * démarrage (~100 ms contre ~400 ms), ce qui compte puisqu'il tourne à CHAQUE
 * prompt. install.ps1 le choisit quand Node est présent (déjà requis par la
 * façade MCP) ; sinon c'est le .ps1 qui est branché.
 *
 * Zéro dépendance (http/https/fs/path/os natifs). Ne fait jamais échouer la
 * session : toute erreur -> sortie 0, au plus une note de contexte.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const MAX_MESSAGES = 20;     // messages injectés par prise de main
const MAX_BODY_CHARS = 4000; // au-delà, corps tronqué (lecture complète via mailbox_thread)
const RETRY_SECONDS = 60;    // broker injoignable : pas de nouvel essai avant ce délai
const TIMEOUT_MS = 3000;

function emit(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

// Appel HTTP minimal -> { status, data } ; rejette sur erreur réseau/timeout.
function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const h = Object.assign({ Accept: 'application/json' }, headers);
    if (payload) { h['Content-Type'] = 'application/json; charset=utf-8'; h['Content-Length'] = payload.length; }
    const req = lib.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h, timeout: TIMEOUT_MS, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { /* corps illisible */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  // --- Entrée du hook (stdin JSON fourni par Claude Code) ---------------------
  let event = 'UserPromptSubmit';
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); // un pipe PowerShell peut préfixer un BOM
    if (raw) { const h = JSON.parse(raw); if (h.hook_event_name) event = h.hook_event_name; }
  } catch { /* pas de stdin : on garde le défaut */ }

  // --- Config du projet -------------------------------------------------------
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const configPath = path.join(projectDir, '.mailbox.json');
  if (!fs.existsSync(configPath)) return; // projet non rattaché -> silence
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '')); // BOM d'Out-File
  } catch (e) {
    emit(event, `[mailbox] .mailbox.json illisible (${configPath}) : ${e.message}`);
    return;
  }
  if (!cfg.project || !cfg.broker) return;

  const me = String(cfg.project);
  // "localhost" peut d'abord tenter ::1 et perdre du temps si le broker n'écoute qu'en IPv4.
  const broker = String(cfg.broker).replace(/\/+$/, '').replace(/:\/\/localhost(?=[:/]|$)/, '://127.0.0.1');
  const headers = cfg.token ? { 'X-Mailbox-Token': String(cfg.token) } : {};
  const chans = (Array.isArray(cfg.channels) ? cfg.channels : (cfg.channels ? String(cfg.channels).split(',') : []))
    .map((c) => String(c).trim()).filter(Boolean);

  // --- Coupe-circuit (fichier partagé avec la version PowerShell) -------------
  const stateDir = path.join(process.env.TEMP || os.tmpdir(), 'mailbox-handoff');
  const downFile = path.join(stateDir, 'down-' + broker.replace(/[^A-Za-z0-9]/g, '_') + '.txt');
  const downNote = `[mailbox] Broker injoignable (${broker}). Messages inter-agents indisponibles pour l'instant (nouvel essai automatique d'ici ${RETRY_SECONDS} s).`;
  try {
    const age = (Date.now() - fs.statSync(downFile).mtimeMs) / 1000;
    if (age < RETRY_SECONDS) {
      if (event === 'SessionStart') emit(event, downNote);
      return;
    }
  } catch { /* pas de coupe-circuit armé */ }

  // --- Récupération des non-lus -------------------------------------------------
  let q = `?status=unread&limit=${MAX_MESSAGES}`;
  if (chans.length) q += `&channels=${encodeURIComponent(chans.join(','))}`;
  let resp;
  try {
    resp = await request('GET', `${broker}/inbox/${encodeURIComponent(me)}${q}`, headers);
  } catch {
    try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(downFile, new Date().toISOString()); } catch { /* ignore */ }
    emit(event, downNote);
    return;
  }
  try { fs.unlinkSync(downFile); } catch { /* absent */ }
  if (resp.status < 200 || resp.status >= 300) {
    emit(event, `[mailbox] Le broker refuse la requête (HTTP ${resp.status}). Vérifie « project » et « token » dans ${configPath}.`);
    return;
  }
  const msgs = Array.isArray(resp.data.messages) ? resp.data.messages : [];
  if (!msgs.length) return; // rien de neuf

  // --- Mise en forme du contexte injecté (identique au .ps1) ------------------
  const lines = [`📬 ${msgs.length} message(s) inter-agents pour le projet « ${me} » :`, ''];
  for (const m of msgs) {
    const subj = m.subject ? ` — ${m.subject}` : '';
    const dest = m.to === '*' ? ' (diffusion)' : (String(m.to).startsWith('#') ? ` (canal ${m.to})` : '');
    const thread = m.threadId && m.threadId !== m.id ? ` [fil ${m.threadId}]` : '';
    lines.push(`─── [${m.id}] de [${m.from}]${dest} le ${m.createdAt}${subj}${thread}`);
    let body = String(m.body);
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + `\n[… message tronqué : lis-le en entier avec mailbox_thread (threadId=${m.threadId})]`;
    }
    lines.push(body, '');
  }
  const rest = (Number(resp.data.total) || 0) - msgs.length;
  if (rest > 0) lines.push(`(${rest} autre(s) message(s) en attente : ils arriveront à la prochaine prise de main.)`, '');
  lines.push(
    "Prends ces messages en compte pour t'aligner avec les autres projets.",
    'Pour répondre DANS LE FIL : tool MCP mailbox_reply (replyTo=<id du message>) — ou /msg --reply <id> <texte>.',
    'Pour un nouveau message : /msg <projet|*|#canal> <texte>.'
  );

  // --- Acquittement au nom de CE projet ---------------------------------------
  // Si l'ack échoue, le message reste non lu -> re-surfacé plus tard (acceptable).
  try { await request('POST', `${broker}/ack`, headers, { ids: msgs.map((m) => m.id), project: me }); } catch { /* ignore */ }

  emit(event, lines.join('\n'));
}

// Pas de process.exit() : il pourrait couper la sortie avant son écriture dans le
// pipe. agent:false (sans keep-alive) laisse le process se terminer tout seul.
process.exitCode = 0;
main().catch(() => { /* jamais bloquant */ });
