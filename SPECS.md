# SPECS — mailbox-handoff

Spécification technique du système de messagerie inter-agents Claude Code (version 0.2).

---

## 1. Objectif et périmètre

Permettre à N agents Claude Code, exécutés sur des **machines distinctes** d'un même
réseau, ouverts sur des **projets liés**, d'échanger des messages **asynchrones et
fire-and-forget** pour s'aligner.

Les messages peuvent former des **fils de discussion** (threads) : une réponse reste
rattachée au message d'origine, ce qui couvre le mode **question/réponse asynchrone**.

**Hors périmètre** : temps réel / push instantané, question-réponse *synchrone* (l'agent
ne répond qu'à sa prochaine prise de main), authentification par utilisateur, chiffrement
de bout en bout.

---

## 2. Acteurs et composants

| Composant         | Localisation                       | Rôle                                                |
|-------------------|------------------------------------|-----------------------------------------------------|
| **Broker**        | 1 machine du LAN                   | Stocke les messages (SQLite, `broker/store.js`) et le registre, expose l'API |
| **Interface web** | servie par le broker sur `/`       | Monitoring, générateur de config client, guide, install du service (`broker/ui.html`) |
| **Service Windows**| machine broker (optionnel)        | Broker en service auto-démarrage via NSSM (`broker/service.js`, routes `/admin/*`) |
| **Hook réception**| `~/.claude/mailbox-check.js` (Node) ou `mailbox-check.ps1` (PowerShell) | Récupère et injecte les non-lus à chaque prise de main |
| **Script envoi**  | `~/.claude/mailbox-send.ps1`       | Dépose un message (via `/msg`)                       |
| **Commande**      | `~/.claude/commands/msg.md`        | Interface `/msg` pour l'agent                        |
| **Façade MCP**    | `~/.claude/mailbox-mcp.js`         | Tools `mailbox_*` (envoi/lecture sans script)        |
| **Config projet** | `<projet>/.mailbox.json`           | Identité du projet + URL broker (+ jeton, canaux)    |
| **Config MCP**    | `<projet>/.mcp.json`               | Déclare le serveur MCP `mailbox` + ses variables d'env |

Un **projet** est identifié par un nom logique unique (`server`, `frontend`, `automate`).
Ce nom est l'adresse de la boîte aux lettres.

---

## 3. Modèle de données

### 3.1 Message

```jsonc
{
  "id": "msg_00042",          // identifiant séquentiel, généré par le broker
  "from": "server",           // projet expéditeur
  "to": "frontend",           // projet destinataire | "*" (diffusion) | "#canal" (sujet nommé)
  "subject": "Contrat /orders",// optionnel, peut être ""
  "body": "…",                // contenu (texte libre)
  "createdAt": "2026-06-23T10:40:00.000Z", // ISO 8601 UTC
  "status": "unread",         // "unread" | "read" — voir ci-dessous
  "readAt": null,             // ISO 8601 de la lecture, sinon null
  "threadId": "msg_00042",    // id du message racine du fil (== id si racine)
  "replyTo": null             // id du message parent (réponse dans le fil), sinon null
}
```

**Sens de `status` / `readAt`** (un message de groupe a plusieurs destinataires) :
- dans **`GET /inbox/:project`** : statut **pour ce projet** (a-t-il lu ce message ?) ;
- dans les **vues globales** (`/thread`, `/conversation`, `/threads`, `/conversations`,
  `/health`) : indicateur de monitoring, `"read"` quand **tous les destinataires connus**
  l'ont lu (ou après « Marquer vu » dans l'UI).

Les vues `/thread/:id` et `/conversation` ajoutent deux champs de monitoring :
`readBy` (projets qui l'ont lu ; `"*"` = acquittement global hérité) et `pending`
(destinataires connus du registre qui ne l'ont pas encore lu).

> **Rétro-compat** : un message d'avant les fils (sans `threadId`) est traité comme sa
> propre racine — au chargement, `threadId` est initialisé à son propre `id` et `replyTo` à `null`.

### 3.2 Entrée de registre

```jsonc
{
  "project": "frontend",
  "host": "PC-FRONT",         // nom machine (best-effort), ou null
  "role": null,               // libre, ou null
  "channels": ["#auth"],      // canaux déclarés par ce projet (préfixe # normalisé)
  "firstSeen": "2026-06-23T09:00:00.000Z",
  "lastSeen":  "2026-06-23T10:41:00.000Z"
}
```

### 3.3 État persistant (`data/store.db` — SQLite)

Stockage **SQLite** via `better-sqlite3` (mode WAL, `synchronous` FULL), encapsulé dans
`broker/store.js` :
- `messages(id, sender, recipient, subject, body, createdAt, status, readAt, threadId, replyTo)`
  — `sender`/`recipient` portent `from`/`to` (mots réservés SQL), remappés dans le JSON de
  l'API. Index sur `recipient`, `threadId`, `status`, `createdAt`.
- `receipts(messageId, project, readAt)` — **accusés de lecture par projet** (clé
  `messageId + project`). `project = "*"` signifie « lu pour tous » (acquittement hérité
  sans projet, cf. §4 `/ack`).
- `registry(project, host, role, channels /*JSON*/, firstSeen, lastSeen, cursor)` —
  `cursor` est interne (absent du JSON) : rowid jusqu'auquel le projet n'a plus rien de non
  lu, pour ne pas rebalayer tout l'historique à chaque relève.
- `meta(key, value)` — compteur `seq` des ids, marqueurs de migration.

**Durabilité** : transactions SQLite/WAL. La création d'un message (`seq` + insertion +
registre) est une transaction unique.

**Migrations automatiques au démarrage** :
1. base vide et ancien `store.json` présent (chemin `MAILBOX_DATA` en `.json`, ou
   `store.json` voisin du `.db`) → import unique (messages, registre, `seq`, rétro-compat
   threads) puis renommage en `store.json.migrated` ;
2. base 0.1 sans `receipts` → chaque message déjà `read` reçoit l'accusé équivalent à
   l'ancien comportement (direct → son destinataire, groupe → `"*"`) : rien de déjà lu
   n'est remis une seconde fois ;
3. registre 0.1 sans `cursor` → colonne ajoutée (valeur 0).

**Rétention** (`MAILBOX_RETENTION_DAYS`, défaut 0 = jamais) : purge horaire des messages
**entièrement remis** (`status = read`) plus vieux que N jours, avec leurs accusés. Un
message encore attendu par un destinataire n'est jamais purgé. Le dernier message n'est
jamais purgé non plus, pour que SQLite ne réattribue pas son rowid (les curseurs supposent
des rowid croissants).

### 3.4 Config projet (`.mailbox.json`)

```jsonc
{
  "project":  "server",                  // requis
  "broker":   "http://192.168.1.10:7777",// requis
  "token":    "",                         // optionnel, doit matcher MAILBOX_TOKEN
  "channels": ["sujet-x", "sujet-y"]      // optionnel : canaux abonnés (# implicite)
}
```

---

## 4. API HTTP du broker

Base : `http://<hôte>:<port>` (défaut `7777`, écoute IPv4 + IPv6). Corps et réponses en
JSON UTF-8. Si `MAILBOX_TOKEN` est défini côté broker, **toutes les routes sauf `/health`
et la page `/`** exigent l'en-tête `X-Mailbox-Token: <jeton>` (sinon `401`).

**Noms de projet** (`from`, `project`, `:project`) : chaîne non vide d'au plus 100
caractères, qui ne vaut pas `*`, ne commence ni par `#` ni par `@` et ne contient pas `|`
(préfixes et séparateur réservés) → sinon `400`.

### `GET /health`
→ `200 { "ok": true, "service": "mailbox-broker", "version": "0.2.0", "messages": <n>, "unread": <n> }`
(`unread` = messages pas encore remis à tous leurs destinataires connus.)

### `POST /messages`
Corps : `{ "from", "to", "body", "subject?", "replyTo?", "threadId?" }`. `to` = nom de projet,
`"*"`, ou `"#canal"`. Résolution du fil : si `replyTo` → hérite du `threadId` du parent ; sinon
si `threadId` fourni → utilisé ; sinon le message est racine (`threadId == id`).
- `201 { "ok": true, "id": "msg_00042", "threadId": "msg_00042" }`
- `400` si `from`/`to`/`body` manquant ou nom réservé ; `404` si `replyTo` désigne un message inconnu.

### `POST /reply`
Corps : `{ "from", "replyTo", "body", "subject?" }` — répond **dans le fil** du message `replyTo`.
Le broker fixe `to` = expéditeur du parent, `threadId` = celui du parent, et `subject` hérite
(`"Re: …"`) s'il n'est pas fourni.
- `201 { "ok": true, "id", "threadId", "to" }`
- `400` si champ requis manquant ; `404` si `replyTo` inconnu.

### `GET /thread/:threadId`
Retourne tous les messages du fil (lus + non-lus, tous participants), triés par `createdAt`
croissant, avec `readBy` et `pending`.
→ `200 { "threadId", "count", "messages": Message[] }`

### `GET /inbox/:project`
Query :
- `status=unread` | `status=read` | *(absent = tous)* — statut **pour ce projet** ;
- `channels=a,b` — canaux abonnés (`#` implicite), transmis par le client ;
- `limit=N` — au plus N messages (max 500), les plus anciens d'abord.

**Règles de remise** — la boîte d'un projet P contient :
- les messages `to == P` (directs), quelle que soit leur date ;
- les messages `to == "*"` ou `to ∈ channels`, **sauf** ceux envoyés par P lui-même et ceux
  créés avant la première apparition de P (`firstSeen`) : un nouveau venu n'hérite pas de
  tout l'historique des groupes.

Un message est lu pour P s'il existe un accusé `(id, P)` ou `(id, "*")`.

→ `200 { "project", "count", "total", "messages": Message[] }` — `total` = nombre de
messages correspondants sans la limite (`total > count` : il en reste).

Effets de bord : met à jour `lastSeen` (et `channels` si fournis) du projet, et avance son
curseur de lecture (`status=unread` uniquement).

> **Filtrage sans état** : le broker ne mémorise pas l'appartenance aux canaux pour
> filtrer, c'est le client qui transmet sa liste `channels` à chaque appel. Le registre
> stocke les canaux pour la visibilité (`GET /registry`, `pending` du monitoring). Le
> curseur est un cache de l'état de lecture : un canal ajouté plus tard ne fait remonter
> que les messages postérieurs au curseur.

### `POST /ack`
Corps : `{ "ids": ["msg_00042", …], "project?": "frontend", "monitorOnly?": true }` —
acquittement groupé idempotent.
- avec `project` (**cas normal**, envoyé par les hooks et la façade MCP 0.2) : accusé au nom
  de ce projet. Les autres destinataires d'une diffusion ou d'un canal le recevront encore ;
- sans `project` (clients 0.1) : un message direct est attribué à son destinataire, une
  diffusion ou un message de canal est marqué lu **pour tous** (`"*"`). C'est le
  comportement d'origine, conservé pour la compatibilité ;
- `monitorOnly: true` (« Marquer vu » de l'UI) : passe seulement l'indicateur global à
  `read`, **sans aucun accusé** : la remise aux agents n'est pas affectée.

→ `200 { "ok": true, "acked": <n> }` (nombre de nouveaux accusés, ou de messages marqués vus).

### `POST /messages/:id/ack`
Corps ou query optionnels : `project`. Même logique que `/ack` pour un seul message.
- `200 { "ok": true, "id" }`
- `404` si id inconnu.

### `POST /register`
Corps : `{ "project", "host?", "role?", "channels?" }` — crée/rafraîchit l'entrée
registre (les `channels` sont normalisés avec préfixe `#` et dédoublonnés).
→ `200 { "ok": true, "registry": <entrée> }`

### `GET /registry`
→ `200 { "projects": Entrée[] }` (triés par nom)

### `GET /conversations`
Vue « boîte mail » de l'UI : un objet par conversation. Une conversation regroupe un
**canal** (`key = "#x"`), la **diffusion** (`key = "*"`), ou une **paire de projets** en
direct (`key = "@a|b"`, membres triés). Champs : `key`, `kind` (`chan`|`bcast`|`dir`),
`label`, `members`, `count`, `unread`, `participants`, `lastAt`, `lastFrom`, `subject`
(dernier sujet non vide), `snippet`. Tri : la plus récemment active d'abord.
→ `200 { "conversations": [ … ] }`

### `GET /conversation?key=…`
Tous les messages d'une conversation, chronologiques, avec `readBy` et `pending`.
→ `200 { "key", "count", "messages": Message[] }`

### `GET /threads`
Liste les fils pour le monitoring : un objet par `threadId` avec `count`, `unread`, `subject`,
`to`, `participants`, `lastAt` et le dernier message (`last`). Trié du fil le plus récemment
actif au plus ancien.
→ `200 { "threads": [ … ] }`

### `GET /` et `GET /ui`
Servent la page de monitoring (`broker/ui.html`, HTML autonome). Pas de jeton requis pour la page
elle-même ; ses appels d'API portent le jeton si l'utilisateur le saisit.

### `GET /admin/status`, `POST /admin/service/install`, `POST /admin/service/remove`
Gestion du **service Windows** (via `broker/service.js` + `vendor/nssm/nssm.exe`), pilotée par
la vue « Serveur & service » de l'UI. **Réservées à `localhost`** (403 sinon) car elles
exécutent `nssm` avec les droits du process. `status` renvoie `{ service: { isWindows, admin,
nssm, serviceName, state }, broker: { version, port, dataFile, retentionDays } }`.
`install` exige que le broker tourne **élevé** (Admin) ; il enregistre le service en démarrage
automatique (avec les mêmes port, jeton, base et rétention) **sans le démarrer** (le port est
occupé par le broker courant) → bascule au prochain boot ou via `net start MailboxBroker` après
arrêt du broker manuel.

### Erreurs
- `400` corps JSON invalide, champ requis manquant ou nom réservé.
- `401` jeton manquant/invalide.
- `403` route d'administration appelée hors `localhost`.
- `404` route ou ressource inconnue.
- `413` corps > 1 Mo.
- `500` erreur interne (détail dans la console du broker, message générique au client).

---

## 5. Cycle de vie d'un message

```
[Agent A] /msg B "…"
   → mailbox-send.ps1  → POST /messages                → message créé (aucun accusé)
                                                           │
[Agent B] prise de main (prompt / session)                │
   → hook mailbox-check                                    │
       → GET /inbox/B?status=unread&limit=20  ─────────────┘  (non-lus POUR B)
       → injecte additionalContext dans B
       → POST /ack { ids, project: "B" }      ──────────────►  accusé (id, B)
                                                              status global = read quand
                                                              tous les destinataires connus ont lu
```

**Garantie de remise** : *au moins une prise de main* par destinataire. Si l'`ack` échoue
(broker indisponible juste après la lecture), le message reste non lu pour ce projet et
sera remis à nouveau à la prochaine prise de main. Une **double remise** est donc possible,
une perte silencieuse jamais. Les messages doivent rester idempotents côté lecture (ce sont
des notes d'alignement).

---

## 6. Intégration Claude Code (hooks)

Branchés par `install.ps1` dans `~/.claude/settings.json`, avec des **chemins absolus**
résolus à l'installation (le lanceur de hooks n'expanse pas toujours `%USERPROFILE%`) :

```jsonc
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command",
        "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\<toi>\\.claude\\mailbox-check.js\"" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command",
        "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\<toi>\\.claude\\mailbox-check.js\"" } ] } ]
  }
}
```

**Deux implémentations équivalentes** (même sortie, mêmes règles) :
- `mailbox-check.js` (Node, environ 100 ms par appel) : choisi par défaut (`-HookRuntime auto`)
  quand Node est dans le PATH ;
- `mailbox-check.ps1` (Windows PowerShell 5.1, environ 400 ms) : repli pour les machines
  sans Node (`-HookRuntime powershell`). Forme : `powershell -NoProfile -File "<chemin>"`.

Le hook lit le JSON d'événement sur **stdin** (pour `hook_event_name`) et le dossier
projet via `CLAUDE_PROJECT_DIR`. Il émet sur **stdout** :

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "…" } }
```

Comportement :
- sans `.mailbox.json` dans le projet → sortie silencieuse (code 0) ;
- au plus **20 messages** par prise de main (le reliquat est annoncé, puis livré aux prompts
  suivants) ; un corps de plus de **4000 caractères** est tronqué, avec un renvoi à
  `mailbox_thread` ;
- acquittement **au nom du projet** (`/ack { ids, project }`) ;
- une adresse `localhost` est réécrite en `127.0.0.1` ;
- **broker injoignable** → note de contexte, puis **coupe-circuit de 60 s**
  (`%TEMP%\mailbox-handoff\down-<broker>.txt`, partagé par les deux versions) : pendant ce
  délai, les prompts ne retentent pas la connexion (sous Windows, une connexion refusée coûte
  environ 2 s), et seul `SessionStart` rappelle la note ;
- **broker qui refuse** (401, 400…) → note explicite invitant à vérifier `project`/`token` ;
- le hook ne fait **jamais** échouer la session (code de sortie 0).

> **Encodage** : tous les `.ps1` sont enregistrés en **UTF-8 avec BOM**. Sans BOM, Windows
> PowerShell 5.1 les lit dans la page de code ANSI, et certains caractères (`—`, `📬`)
> deviennent des guillemets parasites qui empêchent le script de se parser.

---

## 7. Conventions de nommage des projets

- Minuscules, sans espace : `server`, `frontend`, `automate`, `erp`, `gateway`…
- Unique par broker. C'est l'adresse → un renommage casse les messages en transit.
- **Réservés** (refusés en `400`) : `*` (diffusion), préfixe `#` (canaux), préfixe `@`
  (clés de conversation) et le caractère `|` (séparateur des paires directes).
- **Canaux** : préfixe `#` (normalisé automatiquement), ex. `#auth`, `#billing`. Un
  nom de canal et un nom de projet vivent dans des espaces distincts grâce au `#` :
  pas de collision possible entre le projet `auth` et le canal `#auth`.

---

## 8. Choix techniques (et pourquoi)

| Décision                         | Raison                                                        |
|----------------------------------|---------------------------------------------------------------|
| Broker Node.js minimaliste       | Une seule dépendance (`better-sqlite3`) ; sinon API standard   |
| Stockage SQLite (`better-sqlite3`) | Gros volumes, requêtes indexées, transactions/WAL ; migrations automatiques |
| Accusés de lecture par projet    | Un message de groupe a plusieurs destinataires : un statut unique faisait « voler » le message par le premier lecteur |
| Curseur de lecture par projet    | La relève (à chaque prompt) coûte en fonction des non-lus, plus de tout l'historique |
| Hook Node par défaut, PowerShell en repli | Le hook tourne à chaque prompt : environ 100 ms contre 400 ms ; le repli PowerShell couvre les postes sans Node (ex. automate) |
| Coupe-circuit dans le hook       | Broker arrêté : ne pas faire payer environ 2 s à chaque prompt |
| Écoute double pile (`::`)         | `localhost` résout d'abord `::1` : en IPv4 seul, chaque appel perdait environ 2 s |
| Réception par hook (pull auto)   | Un agent ne peut pas écouter en continu → pull à la prise de main |
| Fire-and-forget + fils           | Couvre l'alignement et le question/réponse asynchrone         |
| `.mailbox.json` par projet       | Découple identité/transport du code ; hook global réutilisable |

---

## 9. Façade MCP

Serveur MCP minimal (`mcp/mailbox-mcp.js`), **JSON-RPC 2.0 sur stdio**, un message
par ligne (`\n`), **sans dépendance** (modules `http`/`https` natifs, pas de fetch).

**Configuration** (priorité) : variables d'env `MAILBOX_PROJECT` / `MAILBOX_BROKER` /
`MAILBOX_TOKEN` / `MAILBOX_CHANNELS` (liste séparée par des virgules, renseignées dans
`.mcp.json`), sinon lecture du `.mailbox.json` (`CLAUDE_PROJECT_DIR` puis `cwd`).
`mailbox_inbox` transmet automatiquement ces canaux au broker.

**Méthodes JSON-RPC supportées** : `initialize` (renvoie `protocolVersion` reçu ou
`2025-06-18`, `capabilities.tools`, `serverInfo`), `notifications/initialized`,
`ping`, `tools/list`, `tools/call`.

**Tools exposés** :

| Tool               | Arguments                                  | Effet broker                  |
|--------------------|--------------------------------------------|-------------------------------|
| `mailbox_send`     | `to` (req), `body` (req), `subject?`, `replyTo?` | `POST /messages`         |
| `mailbox_inbox`    | `status?` (`unread` par défaut \| `read` \| `all`), `markRead?`, `limit?` (défaut 50) | `GET /inbox/:me` (+ `POST /ack {ids, project}` si `markRead`) |
| `mailbox_reply`    | `replyTo` (req), `body` (req), `subject?`   | `POST /reply`                 |
| `mailbox_thread`   | `threadId` (req)                            | `GET /thread/:id`             |
| `mailbox_ack`      | `ids` (req, array)                          | `POST /ack {ids, project}`    |
| `mailbox_registry` | —                                          | `GET /registry`               |

**Robustesse** :
- erreur applicative d'un tool → résultat `{ content:[…], isError:true }` (l'agent
  peut réagir), erreur protocole → erreur JSON-RPC.
- les appels broker se font en **connexion fraîche** (`agent: false` : sans lui, l'agent
  HTTP global de Node ≥ 19 garderait les sockets ouverts), avec **un retry** sur erreur
  transitoire (`ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`/`EPIPE`) et un timeout de 6 s. Les
  erreurs 4xx/5xx du broker ne sont pas retentées.
- arrêt propre : ne quitte pas tant qu'une requête est en vol (stdin clos → exit
  une fois `pending == 0`).

**Déclaration `.mcp.json`** (fusion non destructive par `install.ps1`) :

```jsonc
{
  "mcpServers": {
    "mailbox": {
      "command": "node",
      "args": ["C:\\Users\\<toi>\\.claude\\mailbox-mcp.js"],
      "env": { "MAILBOX_PROJECT": "server", "MAILBOX_BROKER": "http://192.168.1.10:7777", "MAILBOX_TOKEN": "" }
    }
  }
}
```

---

## 10. Tests d'acceptation

Automatisés dans `test/acceptance.test.js` : **`npm test`** (`node:test`, sans dépendance ;
chaque groupe lance un vrai broker sur un port libre et une base temporaire). Toute
évolution doit les garder verts.

1. **Vie** : `GET /health` → `200 ok:true`, `version` présente.
2. **Envoi/réception** : `POST /messages {to:"frontend"}` puis
   `GET /inbox/frontend?status=unread` contient le message (accents/emojis intacts).
3. **Ack** : après `POST /ack {ids, project:"frontend"}`, le même `GET …?status=unread` ne le
   retourne plus.
4. **Diffusion** : `to:"*"` est remis **à chaque** projet connu, même après l'ack d'un autre ;
   jamais à l'expéditeur.
4b. **Canal** : `to:"#auth"` n'est remis qu'aux projets dont la query `channels` contient
    `auth`, chacun indépendamment ; `pending`/`readBy` reflètent la remise.
4c. **Nouveau venu** : pas de messages de groupe antérieurs à son `firstSeen`, mais ses
    messages directs en attente.
4d. **Ack sans projet** (client 0.1) : direct attribué au destinataire, groupe lu pour tous.
4e. **« Marquer vu »** (`monitorOnly`) : n'empêche aucune remise.
4f. **Lot** : `limit` borne la réponse (plus anciens d'abord), `total` signale le reliquat.
4g. **Validation** : noms réservés, champs manquants et JSON invalide → `400`.
5. **Hook silencieux** : projet sans `.mailbox.json` → hook ne produit rien (Node et PowerShell).
6. **Résilience** : broker arrêté → note « broker injoignable », puis coupe-circuit (prompts
   suivants silencieux, rappel au `SessionStart`) ; jeton refusé → note « HTTP 401 ».
   Lot de 20 + reliquat annoncé, troncature des longs messages.
7. **Jeton** : avec `MAILBOX_TOKEN`, requête sans en-tête → `401` ; `/health` reste libre.
8. **MCP handshake** : `initialize` → `serverInfo.name = "mailbox"` ; `tools/list`
   liste les 6 tools.
9. **MCP envoi/lecture** : `mailbox_inbox markRead:true` renvoie le message de canal et
   l'acquitte au nom du projet ; `mailbox_send` remet le message (UTF-8) ; une adresse
   invalide → `isError`.
10. **MCP résilience** : un retry absorbe une erreur de connexion transitoire.
    *(Non automatisé : à vérifier à la main en relançant le broker pendant un appel.)*
11. **Threads** : `POST /messages` (racine) puis `POST /reply {replyTo}` ; `GET /thread/:id`
    renvoie les deux messages ordonnés, la réponse a `to` = expéditeur du parent, le même
    `threadId` et un `subject` en `"Re: …"`.
12. **Migrations** : un `store.json` 0.1 (messages sans `threadId`) et une base SQLite 0.1
    (sans `receipts` ni `cursor`) démarrent sans erreur ; rien de déjà lu n'est remis à
    nouveau ; la séquence d'ids reprend ; la rétention ne purge que les messages remis.
13. **Encodage** : chaque `.ps1` commence par un BOM UTF-8.
