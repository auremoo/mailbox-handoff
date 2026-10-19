'use strict';
/**
 * Tests d'acceptation (SPECS §10) — lancer : npm test
 *
 * Zéro dépendance : node:test + node:assert. Chaque groupe démarre un broker réel
 * sur un port libre et une base temporaire, puis le pilote par HTTP comme le font
 * les clients (hooks, façade MCP, UI).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'broker', 'server.js');
const MCP = path.join(ROOT, 'mcp', 'mailbox-mcp.js');
const HOOK_JS = path.join(ROOT, 'client', 'mailbox-check.js');
const HOOK_PS1 = path.join(ROOT, 'client', 'mailbox-check.ps1');
const IS_WIN = process.platform === 'win32';

const TMP_DIRS = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `mbx-${prefix}-`));
  TMP_DIRS.push(d);
  return d;
}
// Après tous les tests (brokers arrêtés, bases libérées) : ménage des dossiers temporaires.
test.after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); });

// Démarre un broker ; résout { url, stop, dir } quand il annonce son port.
function startBroker(env = {}, dir = tmpDir('broker')) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, { MAILBOX_PORT: '0', MAILBOX_DATA: path.join(dir, 'store.db'), MAILBOX_TOKEN: '' }, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (c) => {
      out += c;
      const m = out.match(/port (\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({
          url: `http://127.0.0.1:${m[1]}`, dir, log: () => out,
          stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }),
        });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { out += c; });
    child.once('exit', (code) => reject(new Error(`broker arrêté (code ${code}) :\n${out}`)));
  });
}

async function api(b, method, route, body, headers = {}) {
  const r = await fetch(b.url + route, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const send = (b, m) => api(b, 'POST', '/messages', m);
const inbox = async (b, project, qs = 'status=unread') => (await api(b, 'GET', `/inbox/${project}?${qs}`)).data;
const ack = (b, ids, project) => api(b, 'POST', '/ack', project === undefined ? { ids } : { ids, project });
const ids = (box) => box.messages.map((m) => m.id);

// Exécute un hook comme Claude Code : JSON d'événement sur stdin, projet via env.
function runHook(cmd, args, projectDir, stateDir, event = 'UserPromptSubmit') {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    input: JSON.stringify({ hook_event_name: event }),
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: projectDir, TEMP: stateDir, TMP: stateDir }),
    encoding: 'utf8', timeout: 20000,
  });
  const out = (r.stdout || '').trim();
  return { code: r.status, ms: Date.now() - t0, stderr: r.stderr, out, ctx: out ? JSON.parse(out).hookSpecificOutput.additionalContext : '' };
}

function writeConfig(dir, cfg) {
  fs.writeFileSync(path.join(dir, '.mailbox.json'), '﻿' + JSON.stringify(cfg)); // BOM comme Out-File
}

// ---------------------------------------------------------------------------
test('broker : envoi, remise et accusés par projet', async (t) => {
  const b = await startBroker();
  t.after(() => b.stop());
  // Projets connus avant les envois de groupe (firstSeen).
  for (const p of ['server', 'frontend', 'automate']) await api(b, 'POST', '/register', { project: p, channels: p === 'automate' ? [] : ['auth'] });

  await t.test('1. vie', async () => {
    const r = await api(b, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.match(r.data.version, /^\d+\.\d+\.\d+$/);
  });

  await t.test('2-3. direct : reçu, puis retiré des non-lus après ack', async () => {
    const { data } = await send(b, { from: 'server', to: 'frontend', subject: 'Contrat', body: 'status devient un enum ✅' });
    let box = await inbox(b, 'frontend');
    assert.deepEqual(ids(box), [data.id]);
    assert.equal(box.messages[0].body, 'status devient un enum ✅');
    await ack(b, [data.id], 'frontend');
    box = await inbox(b, 'frontend');
    assert.equal(box.count, 0);
  });

  await t.test('4. diffusion : chaque projet la reçoit une fois, pas l\'expéditeur', async () => {
    const { data } = await send(b, { from: 'server', to: '*', body: 'ISO 8601 partout' });
    assert.deepEqual(ids(await inbox(b, 'server')), [], 'l\'expéditeur ne reçoit pas sa diffusion');
    assert.deepEqual(ids(await inbox(b, 'frontend')), [data.id]);
    await ack(b, [data.id], 'frontend');
    // Régression : avant 0.2, l'ack de frontend la cachait à automate.
    assert.deepEqual(ids(await inbox(b, 'automate')), [data.id]);
    await ack(b, [data.id], 'automate');
    assert.equal((await inbox(b, 'automate')).count, 0);
  });

  await t.test('4b. canal : seuls les abonnés, chacun indépendamment', async () => {
    const { data } = await send(b, { from: 'server', to: '#auth', body: 'format des tokens' });
    assert.deepEqual(ids(await inbox(b, 'server', 'status=unread&channels=auth')), [], 'pas ses propres envois');
    assert.deepEqual(ids(await inbox(b, 'frontend', 'status=unread&channels=auth')), [data.id]);
    assert.equal((await inbox(b, 'automate', 'status=unread')).count, 0, 'non abonné');
    assert.equal((await inbox(b, 'automate', 'status=unread&channels=billing')).count, 0, 'autre canal');
    const conv = await api(b, 'GET', '/conversation?key=' + encodeURIComponent('#auth'));
    assert.deepEqual(conv.data.messages[0].pending, ['frontend']);
    await ack(b, [data.id], 'frontend');
    const after = await api(b, 'GET', '/conversation?key=' + encodeURIComponent('#auth'));
    assert.deepEqual(after.data.messages[0].readBy, ['frontend']);
    assert.equal(after.data.messages[0].status, 'read', 'remis à tous les abonnés connus');
  });

  await t.test('4c. nouveau venu : pas l\'historique des groupes, mais ses directs en attente', async () => {
    await send(b, { from: 'server', to: '*', body: 'ancienne annonce' });
    const direct = (await send(b, { from: 'server', to: 'gateway', body: 'bienvenue' })).data;
    const box = await inbox(b, 'gateway', 'status=unread&channels=auth');
    assert.deepEqual(ids(box), [direct.id]);
    const later = (await send(b, { from: 'server', to: '*', body: 'nouvelle annonce' })).data;
    assert.deepEqual(ids(await inbox(b, 'gateway', 'status=unread&channels=auth')), [direct.id, later.id]);
  });

  await t.test('4d. ack sans projet (clients < 0.2) : comportement hérité conservé', async () => {
    const d = (await send(b, { from: 'server', to: 'automate', body: 'direct' })).data;
    const g = (await send(b, { from: 'server', to: '*', body: 'groupe' })).data;
    await ack(b, [d.id, g.id]);
    const left = ids(await inbox(b, 'automate'));
    assert.ok(!left.includes(d.id) && !left.includes(g.id), 'direct attribué à son destinataire');
    assert.ok(!ids(await inbox(b, 'frontend')).includes(g.id), 'diffusion marquée lue pour tous');
  });

  await t.test('4e. « Marquer vu » de l\'UI n\'empêche aucune remise', async () => {
    const { data } = await send(b, { from: 'server', to: 'frontend', body: 'à voir' });
    await api(b, 'POST', '/ack', { ids: [data.id], monitorOnly: true });
    assert.ok(ids(await inbox(b, 'frontend')).includes(data.id));
    await ack(b, [data.id], 'frontend');
  });

  await t.test('4f. limit / total : lot borné, reliquat signalé', async () => {
    for (let i = 0; i < 5; i++) await send(b, { from: 'server', to: 'erp', body: `m${i}` });
    const box = await inbox(b, 'erp', 'status=unread&limit=2');
    assert.equal(box.count, 2);
    assert.equal(box.total, 5);
    assert.deepEqual(box.messages.map((m) => m.body), ['m0', 'm1'], 'les plus anciens d\'abord');
  });

  await t.test('4g. adresses réservées et champs manquants refusés (400)', async () => {
    for (const m of [{ from: '*', to: 'x', body: 'b' }, { from: '#a', to: 'x', body: 'b' }, { from: 'a|b', to: 'x', body: 'b' },
      { from: 'a', to: '#', body: 'b' }, { from: 'a', to: '@x', body: 'b' }, { from: 'a', to: 'x' }]) {
      assert.equal((await send(b, m)).status, 400, JSON.stringify(m));
    }
    const bad = await fetch(b.url + '/messages', { method: 'POST', body: '{oops' });
    assert.equal(bad.status, 400);
  });

  await t.test('11. fils : reply hérite du fil, du destinataire et du sujet', async () => {
    const root = (await send(b, { from: 'server', to: 'frontend', subject: 'Q', body: 'ok ?' })).data;
    const rep = await api(b, 'POST', '/reply', { from: 'frontend', replyTo: root.id, body: 'oui' });
    assert.equal(rep.status, 201);
    assert.equal(rep.data.to, 'server');
    assert.equal(rep.data.threadId, root.id);
    const th = (await api(b, 'GET', `/thread/${root.id}`)).data;
    assert.deepEqual(th.messages.map((m) => m.subject), ['Q', 'Re: Q']);
    assert.equal((await api(b, 'POST', '/reply', { from: 'x', replyTo: 'msg_99999', body: 'b' })).status, 404);
  });

  await t.test('vues de monitoring : conversations et fils cohérents', async () => {
    const convs = (await api(b, 'GET', '/conversations')).data.conversations;
    const auth = convs.find((c) => c.key === '#auth');
    assert.equal(auth.kind, 'chan');
    assert.deepEqual(auth.participants, ['server']);
    const pair = convs.find((c) => c.key === '@frontend|server');
    assert.ok(pair && pair.count >= 3);
    assert.equal(pair.subject, 'Re: Q', 'dernier sujet non vide');
    const threads = (await api(b, 'GET', '/threads')).data.threads;
    assert.ok(threads.every((th) => th.count >= 1 && th.last && th.participants.length));
  });
});

// ---------------------------------------------------------------------------
test('7. jeton : 401 sans en-tête, /health reste libre', async (t) => {
  const b = await startBroker({ MAILBOX_TOKEN: 's3cret' });
  t.after(() => b.stop());
  assert.equal((await api(b, 'GET', '/registry')).status, 401);
  assert.equal((await api(b, 'GET', '/registry', undefined, { 'X-Mailbox-Token': 's3cret' })).status, 200);
  assert.equal((await api(b, 'GET', '/health')).status, 200);
});

// ---------------------------------------------------------------------------
test('12. migration store.json (v0.1) + accusés + rétention', async (t) => {
  const dir = tmpDir('migr');
  const old = new Date(Date.now() - 100 * 86400000).toISOString();
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({
    seq: 3,
    registry: { a: { firstSeen: old, lastSeen: old }, b: { firstSeen: old, lastSeen: old } },
    messages: [
      { id: 'msg_00001', from: 'a', to: '*', body: 'vieille diffusion lue', createdAt: old, status: 'read', readAt: old },
      { id: 'msg_00002', from: 'a', to: 'b', body: 'vieux direct NON lu', createdAt: old, status: 'unread', readAt: null },
      { id: 'msg_00003', from: 'b', to: 'a', body: 'récent lu', createdAt: new Date().toISOString(), status: 'read', readAt: null },
    ],
  }));
  const b = await startBroker({ MAILBOX_RETENTION_DAYS: '30' }, dir);
  t.after(() => b.stop());
  assert.ok(fs.existsSync(path.join(dir, 'store.json.migrated')));
  // Rétention : seul le message remis ET ancien est purgé ; le non-lu ancien reste dû.
  assert.equal((await api(b, 'GET', '/health')).data.messages, 2);
  assert.deepEqual(ids(await inbox(b, 'b')), ['msg_00002']);
  // Le message déjà lu avant migration n'est pas remis une seconde fois.
  assert.equal((await inbox(b, 'a')).count, 0);
  // Threads rétro-compatibles + séquence reprise.
  assert.equal((await api(b, 'GET', '/thread/msg_00002')).data.count, 1);
  assert.equal((await send(b, { from: 'a', to: 'b', body: 'x' })).data.id, 'msg_00004');
});

// ---------------------------------------------------------------------------
test('mise à niveau d\'une base SQLite 0.1 + curseur de lecture', async (t) => {
  // Base créée avec le schéma 0.1 (registry sans curseur, pas de table receipts).
  const dir = tmpDir('v01');
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const old = new Database(path.join(dir, 'store.db'));
  const past = new Date(Date.now() - 3600000).toISOString();
  old.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, createdAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unread', readAt TEXT, threadId TEXT NOT NULL, replyTo TEXT);
    CREATE TABLE registry (project TEXT PRIMARY KEY, host TEXT, role TEXT, channels TEXT, firstSeen TEXT, lastSeen TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  old.prepare("INSERT INTO meta VALUES ('seq', '2')").run();
  old.prepare('INSERT INTO registry (project, firstSeen, lastSeen) VALUES (?, ?, ?)').run('a', past, past);
  old.prepare('INSERT INTO registry (project, firstSeen, lastSeen) VALUES (?, ?, ?)').run('b', past, past);
  const ins = old.prepare('INSERT INTO messages (id, sender, recipient, body, createdAt, status, threadId) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('msg_00001', 'a', '*', 'déjà lue (globalement, en 0.1)', past, 'read', 'msg_00001');
  ins.run('msg_00002', 'a', 'b', 'en attente', past, 'unread', 'msg_00002');
  old.close();

  const b = await startBroker({}, dir);
  t.after(() => b.stop());
  assert.deepEqual(ids(await inbox(b, 'b')), ['msg_00002'], 'la diffusion lue en 0.1 n\'est pas re-remise');

  // Pas d'ack (hook coupé juste après la lecture) -> re-remis au prochain appel.
  assert.deepEqual(ids(await inbox(b, 'b')), ['msg_00002']);
  await ack(b, ['msg_00002'], 'b');
  assert.equal((await inbox(b, 'b')).count, 0);
  // Curseur avancé : les nouveaux messages arrivent toujours, directs comme groupes.
  const n1 = (await send(b, { from: 'a', to: 'b', body: 'nouveau direct' })).data.id;
  const n2 = (await send(b, { from: 'a', to: '*', body: 'nouvelle diffusion' })).data.id;
  assert.deepEqual(ids(await inbox(b, 'b')), [n1, n2]);
  assert.deepEqual(ids(await inbox(b, 'b', 'status=all')).length, 4, 'l\'historique complet reste lisible');
});

// ---------------------------------------------------------------------------
test('8-10. façade MCP : handshake, 6 tools, envoi/lecture/ack', async (t) => {
  const b = await startBroker();
  t.after(() => b.stop());
  await api(b, 'POST', '/register', { project: 'front', channels: ['auth'] });

  const mcp = spawn(process.execPath, [MCP], {
    env: Object.assign({}, process.env, { MAILBOX_PROJECT: 'front', MAILBOX_BROKER: b.url, MAILBOX_CHANNELS: 'auth', MAILBOX_TOKEN: '' }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => mcp.kill());
  let buf = '';
  const waiting = new Map();
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++seq; waiting.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;

  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'mailbox');
  const tools = (await rpc('tools/list')).result.tools.map((x) => x.name).sort();
  assert.deepEqual(tools, ['mailbox_ack', 'mailbox_inbox', 'mailbox_registry', 'mailbox_reply', 'mailbox_send', 'mailbox_thread']);

  await send(b, { from: 'back', to: '#auth', body: 'via canal' });
  let r = JSON.parse((await call('mailbox_inbox', { markRead: true })).content[0].text);
  assert.equal(r.count, 1);
  assert.equal(r.messages[0].body, 'via canal');
  r = JSON.parse((await call('mailbox_inbox', {})).content[0].text);
  assert.equal(r.count, 0, 'acquitté au nom de front');

  const sent = await call('mailbox_send', { to: 'back', body: 'reçu 👍' });
  assert.ok(!sent.isError, sent.content[0].text);
  assert.equal((await inbox(b, 'back')).messages[0].body, 'reçu 👍');
  const bad = await call('mailbox_send', { to: '#', body: 'x' });
  assert.equal(bad.isError, true);
});

// ---------------------------------------------------------------------------
// Hooks : la version Node partout, la version PowerShell sous Windows.
const HOOKS = [['node', process.execPath, [HOOK_JS]]];
if (IS_WIN) HOOKS.push(['powershell', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK_PS1]]);

for (const [name, cmd, args] of HOOKS) {
  test(`5-6. hook ${name} : silence, remise, ack, coupe-circuit`, async (t) => {
    const b = await startBroker();
    t.after(() => b.stop());
    const project = tmpDir('proj');
    const state = tmpDir('state');

    await t.test('5. projet non rattaché -> aucune sortie', () => {
      const r = runHook(cmd, args, project, state);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.out, '');
    });

    writeConfig(project, { project: 'front', broker: b.url.replace('127.0.0.1', 'localhost'), channels: ['auth'] });

    await t.test('remise : contexte injecté puis acquitté', async () => {
      runHook(cmd, args, project, state, 'SessionStart'); // enregistre firstSeen
      await send(b, { from: 'back', to: 'front', subject: 'Schéma', body: 'Le champ « état » change — voir 📎' });
      await send(b, { from: 'back', to: '#auth', body: 'x'.repeat(5000) });
      const r = runHook(cmd, args, project, state);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.ctx, /📬 2 message\(s\) inter-agents pour le projet « front »/);
      assert.match(r.ctx, /de \[back\] le .* — Schéma/);
      assert.match(r.ctx, /Le champ « état » change — voir 📎/);
      assert.match(r.ctx, /\(canal #auth\)/);
      assert.match(r.ctx, /message tronqué/);
      assert.equal(runHook(cmd, args, project, state).out, '', 'déjà acquitté');
    });

    await t.test('lot de 20 + reliquat annoncé', async () => {
      for (let i = 0; i < 23; i++) await send(b, { from: 'back', to: 'front', body: `n${i}` });
      const r = runHook(cmd, args, project, state);
      assert.match(r.ctx, /📬 20 message/);
      assert.match(r.ctx, /3 autre\(s\) message\(s\) en attente/);
      assert.match(runHook(cmd, args, project, state).ctx, /📬 3 message/);
    });

    await t.test('6. broker injoignable -> note, puis prompts suivants sans attente', async () => {
      writeConfig(project, { project: 'front', broker: 'http://127.0.0.1:9' });
      const first = runHook(cmd, args, project, state);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.ctx, /Broker injoignable/);
      const second = runHook(cmd, args, project, state);
      assert.equal(second.code, 0);
      assert.equal(second.out, '', 'coupe-circuit armé : silence sur UserPromptSubmit');
      assert.match(runHook(cmd, args, project, state, 'SessionStart').ctx, /Broker injoignable/, 'rappel en début de session');
    });

    await t.test('jeton refusé -> note explicite', async () => {
      const b2 = await startBroker({ MAILBOX_TOKEN: 'bon' });
      t.after(() => b2.stop());
      writeConfig(project, { project: 'front', broker: b2.url, token: 'mauvais' });
      assert.match(runHook(cmd, args, project, state).ctx, /HTTP 401/);
    });
  });
}

// ---------------------------------------------------------------------------
test('scripts PowerShell : BOM UTF-8 présent (sinon PowerShell 5.1 ne les parse pas)', () => {
  const files = ['install.ps1', 'setup-client.ps1', 'setup-server.ps1', 'start-server.ps1', 'client/mailbox-check.ps1', 'client/mailbox-send.ps1'];
  for (const f of files) {
    const head = fs.readFileSync(path.join(ROOT, f)).subarray(0, 3).toString('hex');
    assert.equal(head, 'efbbbf', `${f} doit commencer par un BOM UTF-8`);
  }
});
