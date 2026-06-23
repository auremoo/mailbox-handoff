# SPECS — mailbox-handoff

Spécification technique du système de messagerie inter-agents Claude Code.

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
| **Broker**        | 1 machine du LAN                   | Stocke les messages (SQLite) et le registre, expose l'API + la page de monitoring |
| **Hook réception**| `~/.claude/mailbox-check.ps1`      | Récupère et injecte les non-lus à chaque prise de main |
| **Script envoi**  | `~/.claude/mailbox-send.ps1`       | Dépose un message (via `/msg`)                       |
| **Commande**      | `~/.claude/commands/msg.md`        | Interface `/msg` pour l'agent                        |
| **Façade MCP**    | `~/.claude/mailbox-mcp.js`         | Tools `mailbox_*` (envoi/lecture sans script)        |
| **Config projet** | `<projet>/.mailbox.json`           | Identité du projet + URL broker (+ jeton)            |
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
  "status": "unread",         // "unread" | "read"
  "readAt": null,             // ISO 8601 quand acquitté, sinon null
  "threadId": "msg_00042",    // id du message racine du fil (== id si racine)
  "replyTo": null             // id du message parent (réponse dans le fil), sinon null
}
```

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

Stockage **SQLite** via `better-sqlite3` (mode WAL), encapsulé dans `broker/store.js`.
Trois tables :
- `messages(id, sender, recipient, subject, body, createdAt, status, readAt, threadId, replyTo)`
  — `sender`/`recipient` portent `from`/`to` (mots réservés SQL), remappés dans le JSON de
  l'API. Index sur `recipient`, `threadId`, `status`.
- `registry(project, host, role, channels /*JSON*/, firstSeen, lastSeen)`.
- `meta(key, value)` — porte le compteur `seq` des ids.

**Durabilité** : transactions SQLite/WAL (remplace l'ancien remplacement atomique JSON).

**Migration** : au 1er démarrage, si la base est vide et qu'un ancien `store.json` est présent
(chemin `MAILBOX_DATA` en `.json`, ou `store.json` voisin du `.db`), il est importé une fois
(messages + registre + `seq`, avec rétro-compat threads) puis renommé `store.json.migrated`.

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

Base : `http://<hôte>:<port>` (défaut `7777`). Corps et réponses en JSON UTF-8.
Si `MAILBOX_TOKEN` est défini côté broker, **toutes les routes sauf `/health`**
exigent l'en-tête `X-Mailbox-Token: <jeton>` (sinon `401`).

### `GET /health`
→ `200 { "ok": true, "service": "mailbox-broker", "messages": <n> }`

### `POST /messages`
Corps : `{ "from", "to", "body", "subject?", "replyTo?", "threadId?" }`. `to` = nom de projet,
`"*"`, ou `"#canal"`. Résolution du fil : si `replyTo` → hérite du `threadId` du parent ; sinon
si `threadId` fourni → utilisé ; sinon le message est racine (`threadId == id`).
- `201 { "ok": true, "id": "msg_00042", "threadId": "msg_00042" }`
- `400` si `from`/`to`/`body` manquant ; `404` si `replyTo` désigne un message inconnu.

### `POST /reply`
Corps : `{ "from", "replyTo", "body", "subject?" }` — répond **dans le fil** du message `replyTo`.
Le broker fixe `to` = expéditeur du parent, `threadId` = celui du parent, et `subject` hérite
(`"Re: …"`) s'il n'est pas fourni.
- `201 { "ok": true, "id", "threadId", "to" }`
- `400` si champ requis manquant ; `404` si `replyTo` inconnu.

### `GET /thread/:threadId`
Retourne tous les messages du fil (lus + non-lus, tous participants), triés par `createdAt` croissant.
→ `200 { "threadId", "count", "messages": Message[] }`

### `GET /inbox/:project`
Query : `status=unread` | `status=read` | *(absent = tous)* ; et
`channels=a,b` (canaux abonnés, `#` implicite, transmis par le client).
Retourne les messages où `to == :project`, **ou** `to == "*"` (diffusion), **ou**
`to` est un canal (`#…`) présent dans `channels`.
→ `200 { "project", "count", "messages": Message[] }`
Effet de bord : met à jour `lastSeen` (et `channels` si fournis) du projet.

> **Filtrage sans état** : le broker ne mémorise pas l'appartenance aux canaux pour
> filtrer — c'est le client qui transmet sa liste `channels` à chaque appel. Le
> registre stocke les canaux uniquement pour la visibilité (`GET /registry`).

### `POST /messages/:id/ack`
Marque le message `read` (`readAt` horodaté).
- `200 { "ok": true, "id" }`
- `404` si id inconnu.

### `POST /ack`
Corps : `{ "ids": ["msg_00042", …] }` — acquittement groupé idempotent.
→ `200 { "ok": true, "acked": <n> }`

### `POST /register`
Corps : `{ "project", "host?", "role?", "channels?" }` — crée/rafraîchit l'entrée
registre (les `channels` sont normalisés avec préfixe `#`).
→ `200 { "ok": true, "registry": <entrée> }`

### `GET /registry`
→ `200 { "projects": Entrée[] }`

### `GET /threads`
Liste les fils pour le monitoring : un objet par `threadId` avec `count`, `unread`, `subject`,
`participants`, `lastAt` et le dernier message (`last`). Trié du fil le plus récemment actif au plus ancien.
→ `200 { "threads": [ … ] }`

### `GET /` et `GET /ui`
Servent la page de monitoring (`broker/ui.html`, HTML autonome). Pas de jeton requis pour la page
elle-même ; ses appels d'API portent le jeton si l'utilisateur le saisit.

### `GET /admin/status`, `POST /admin/service/install`, `POST /admin/service/remove`
Gestion du **service Windows** (via `broker/service.js` + `vendor/nssm/nssm.exe`), pilotée par
l'onglet « Serveur » de l'UI. **Réservées à `localhost`** (403 sinon) car elles exécutent `nssm`
avec les droits du process. `status` renvoie `{ isWindows, admin, nssm, serviceName, state }`.
`install` exige que le broker tourne **élevé** (Admin) ; il enregistre le service en démarrage
automatique **sans le démarrer** (le port est occupé par le broker courant) → bascule au prochain
boot ou via `net start MailboxBroker` après arrêt du broker manuel.

### Erreurs
- `400` corps JSON invalide ou champ requis manquant ou corps > 1 Mo.
- `401` jeton manquant/invalide.
- `404` route ou ressource inconnue.

---

## 5. Cycle de vie d'un message

```
[Agent A] /msg B "…"
   → mailbox-send.ps1  → POST /messages         → status=unread
                                                    │
[Agent B] prise de main (prompt / session)         │
   → hook mailbox-check.ps1                         │
       → GET /inbox/B?status=unread  ───────────────┘  (lit les unread)
       → injecte additionalContext dans B
       → POST /ack { ids }            ──────────────►  status=read
```

**Garantie de remise** : *au moins une prise de main*. Si l'`ack` échoue (broker
indisponible juste après lecture), le message reste `unread` et sera re-surfacé à la
prochaine prise de main → possible **double remise**, jamais de perte silencieuse.
Les messages doivent donc être idempotents côté lecture (ce sont des notes d'alignement).

---

## 6. Intégration Claude Code (hooks)

Branchés par `install.ps1` dans `~/.claude/settings.json` :

```jsonc
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command",
        "command": "powershell -NoProfile -File \"%USERPROFILE%\\.claude\\mailbox-check.ps1\"" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command",
        "command": "powershell -NoProfile -File \"%USERPROFILE%\\.claude\\mailbox-check.ps1\"" } ] } ]
  }
}
```

Le hook lit le JSON d'événement sur **stdin** (pour `hook_event_name`) et le dossier
projet via `CLAUDE_PROJECT_DIR`. Il émet sur **stdout** :

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "…" } }
```

Sans `.mailbox.json` dans le projet → le hook sort en silence (code 0). Le hook
n'échoue jamais bloquant la session : broker injoignable → simple note de contexte.

---

## 7. Conventions de nommage des projets

- Minuscules, sans espace : `server`, `frontend`, `automate`, `erp`, `gateway`…
- Unique par broker. C'est l'adresse → un renommage casse les messages en transit.
- `*` est réservé à la diffusion, ne pas l'utiliser comme nom de projet.
- **Canaux** : préfixe `#` (normalisé automatiquement), ex. `#auth`, `#billing`. Un
  nom de canal et un nom de projet vivent dans des espaces distincts grâce au `#` —
  pas de collision possible entre le projet `auth` et le canal `#auth`.

---

## 8. Choix techniques (et pourquoi)

| Décision                         | Raison                                                        |
|----------------------------------|---------------------------------------------------------------|
| Broker Node.js minimaliste       | Une seule dépendance (`better-sqlite3`) ; sinon API standard   |
| Stockage SQLite (`better-sqlite3`) | Gros volumes de messages, requêtes indexées, transactions/WAL ; migration auto depuis l'ancien JSON |
| Hooks PowerShell                  | Machines Windows (dont l'automate/TIA Portal)                 |
| Réception par hook (pull auto)   | Un agent ne peut pas écouter en continu → pull à la prise de main |
| Fire-and-forget                  | Couvre 90 % des cas d'alignement ; threads = évolution future |
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
| `mailbox_inbox`    | `status?` (`unread`\|`read`\|`all`), `markRead?` | `GET /inbox/:me` (+ `POST /ack` si `markRead`) |
| `mailbox_reply`    | `replyTo` (req), `body` (req), `subject?`   | `POST /reply`                 |
| `mailbox_thread`   | `threadId` (req)                            | `GET /thread/:id`             |
| `mailbox_ack`      | `ids` (req, array)                          | `POST /ack`                   |
| `mailbox_registry` | —                                          | `GET /registry`               |

**Robustesse** :
- erreur applicative d'un tool → résultat `{ content:[…], isError:true }` (l'agent
  peut réagir), erreur protocole → erreur JSON-RPC.
- les appels broker se font en connexion fraîche (pas de pool keep-alive), avec
  **un retry** sur erreur transitoire (`ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`/`EPIPE`)
  et un timeout de 6 s. Les erreurs 4xx/5xx du broker ne sont pas retentées.
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

## 10. Tests d'acceptation

1. **Vie** : `GET /health` → `200 ok:true`.
2. **Envoi/réception** : `POST /messages {to:"frontend"}` puis
   `GET /inbox/frontend?status=unread` contient le message.
3. **Ack** : après `POST /ack`, le même `GET …?status=unread` ne le retourne plus.
4. **Diffusion** : `to:"*"` apparaît dans l'inbox de *tout* projet interrogé.
4b. **Canal** : `to:"#auth"` n'apparaît que dans l'inbox des projets dont la query
    `channels` contient `auth` ; absent pour les autres (étanchéité des sous-groupes).
5. **Hook silencieux** : projet sans `.mailbox.json` → hook ne produit rien.
6. **Résilience** : broker arrêté → hook injecte une note « broker injoignable »,
   la session continue normalement.
7. **Jeton** : avec `MAILBOX_TOKEN`, requête sans en-tête → `401`.
8. **MCP handshake** : `initialize` → `serverInfo.name = "mailbox"` ; `tools/list`
   liste les 4 tools.
9. **MCP envoi/lecture** : `tools/call mailbox_send` puis `mailbox_inbox` renvoie le
   message ; `mailbox_inbox markRead:true` le retire des non-lus au prochain appel.
10. **MCP résilience** : appels séquentiels sans timeout ; un retry absorbe une
    erreur de connexion transitoire.
11. **Threads** : `POST /messages` (racine) puis `POST /reply {replyTo}` ; `GET /thread/:id`
    renvoie les deux messages ordonnés, la réponse a `to` = expéditeur du parent, le même
    `threadId` et un `subject` en `"Re: …"`. `mailbox_reply` puis `mailbox_thread` : idem.
12. **Rétro-compat threads** : un `store` v0.1 (messages sans `threadId`) démarre sans erreur,
    chaque message reçoit `threadId = son id`.
