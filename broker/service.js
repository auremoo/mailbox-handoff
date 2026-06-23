'use strict';
/**
 * service.js — installation du broker comme service Windows via NSSM, pilotable
 * depuis la page de monitoring (boutons « Installer / Désinstaller le service »).
 *
 * Node n'est pas un service Windows natif : NSSM (vendor/nssm/nssm.exe, embarqué)
 * l'enveloppe (démarrage auto sans session, redémarrage auto, arrêt propre).
 *
 * Contraintes inhérentes (pas contournables) :
 *  - service Windows uniquement (no-op ailleurs) ;
 *  - l'installation exige les droits Administrateur -> le broker doit être lancé
 *    dans un PowerShell Admin pour que l'action UI réussisse ;
 *  - on ne démarre PAS le service immédiatement : le broker manuel courant occupe
 *    déjà le port. Le service (démarrage auto) prendra le relais au prochain boot,
 *    ou après arrêt du broker manuel + `net start MailboxBroker`.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = 'MailboxBroker';
const NSSM = path.join(__dirname, '..', 'vendor', 'nssm', 'nssm.exe');

function isWindows() { return process.platform === 'win32'; }
function hasNssm() { return fs.existsSync(NSSM); }

// Admin ? `net session` n'aboutit qu'élevé.
function isAdmin() {
  if (!isWindows()) return false;
  try { execFileSync('net', ['session'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// État du service ("RUNNING"/"STOPPED"/…) ou null s'il n'est pas installé.
function serviceState() {
  if (!isWindows()) return null;
  try {
    const out = execFileSync('sc', ['query', SERVICE_NAME], { encoding: 'utf8' });
    const m = out.match(/STATE\s+:\s+\d+\s+(\w+)/);
    return m ? m[1] : 'UNKNOWN';
  } catch { return null; }
}

function status() {
  return {
    platform: process.platform,
    isWindows: isWindows(),
    admin: isAdmin(),
    nssm: hasNssm(),
    serviceName: SERVICE_NAME,
    state: serviceState(), // null = non installé
  };
}

// Installe/réinstalle le service (sans le démarrer — voir entête).
function install({ port, token, dataFile }) {
  if (!isWindows()) throw new Error('Service Windows uniquement (cette machine n\'est pas sous Windows).');
  if (!hasNssm()) throw new Error('nssm.exe introuvable dans vendor/nssm.');
  if (!isAdmin()) throw new Error('Droits Administrateur requis : relance le broker dans un PowerShell « Administrateur », puis réessaie.');

  const node = process.execPath;
  const serverJs = path.join(__dirname, 'server.js');
  const appDir = path.join(__dirname, '..');

  // Réinstallation propre si déjà présent.
  try { execFileSync(NSSM, ['stop', SERVICE_NAME], { stdio: 'ignore' }); } catch { /* ignore */ }
  try { execFileSync(NSSM, ['remove', SERVICE_NAME, 'confirm'], { stdio: 'ignore' }); } catch { /* ignore */ }

  execFileSync(NSSM, ['install', SERVICE_NAME, node, serverJs]);
  execFileSync(NSSM, ['set', SERVICE_NAME, 'AppDirectory', appDir]);
  execFileSync(NSSM, ['set', SERVICE_NAME, 'Start', 'SERVICE_AUTO_START']);
  execFileSync(NSSM, ['set', SERVICE_NAME, 'DisplayName', 'Mailbox Broker (messagerie inter-agents)']);

  const env = [`MAILBOX_PORT=${port}`];
  if (token) env.push(`MAILBOX_TOKEN=${token}`);
  if (dataFile) env.push(`MAILBOX_DATA=${dataFile}`);
  execFileSync(NSSM, ['set', SERVICE_NAME, 'AppEnvironmentExtra', env.join('\n')]);

  // Logs du service dans data/.
  const logDir = path.join(appDir, 'data');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  try {
    execFileSync(NSSM, ['set', SERVICE_NAME, 'AppStdout', path.join(logDir, 'broker.out.log')]);
    execFileSync(NSSM, ['set', SERVICE_NAME, 'AppStderr', path.join(logDir, 'broker.err.log')]);
  } catch { /* non bloquant */ }

  return {
    ok: true,
    serviceName: SERVICE_NAME,
    message: 'Service installé (démarrage automatique). Il prendra le relais au prochain démarrage de Windows. ' +
             'Pour basculer tout de suite : ferme ce broker manuel puis lance « net start ' + SERVICE_NAME + ' ».',
  };
}

function remove() {
  if (!isWindows()) throw new Error('Service Windows uniquement.');
  if (!hasNssm()) throw new Error('nssm.exe introuvable dans vendor/nssm.');
  if (!isAdmin()) throw new Error('Droits Administrateur requis.');
  try { execFileSync(NSSM, ['stop', SERVICE_NAME], { stdio: 'ignore' }); } catch { /* ignore */ }
  execFileSync(NSSM, ['remove', SERVICE_NAME, 'confirm']);
  return { ok: true, message: 'Service « ' + SERVICE_NAME + ' » désinstallé.' };
}

module.exports = { status, install, remove, SERVICE_NAME };
