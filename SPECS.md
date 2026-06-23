# SPECS — mailbox-handoff

Spécification technique du système de messagerie inter-agents Claude Code.

---

## 1. Objectif et périmètre

Permettre à N agents Claude Code, exécutés sur des **machines distinctes** d'un même
réseau, ouverts sur des **projets liés**, d'échanger des messages **asynchrones et
fire-and-forget** pour s'aligner.

**Hors périmètre (v0.1)** : temps réel / push instantané, question-réponse synchrone,
fils de discussion, authentification par utilisateur, chiffrement de bout en bout.

---

## 2. Acteurs et composants

| Composant         | Localisation                       | Rôle                                                |
|-------------------|------------------------------------|-----------------------------------------------------|
| **Broker**        | 1 machine du LAN                   | Stocke les messages et le registre, expose l'API    |
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
  "readAt": null              // ISO 8601 quand acquitté, sinon null
}
```

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

### 3.3 État persistant (`data/store.json`)

```jsonc
{
  "seq": 42,                  // compteur d'ids
  "messages": [ /* Message[] */ ],
  "registry": { "frontend": { /* entrée */ }, /* … */ }
}
```

Écriture **atomique** : sérialisation dans `store.json.tmp` puis `rename`.
Les écritures rapprochées sont coalescées (`setImmediate`).

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
Corps : `{ "from", "to", "body", "subject?" }`. `to` = nom de projet, `"*"`, ou `"#canal"`.
- `201 { "ok": true, "id": "msg_00042" }`
- `400` si `from`/`to`/`body` manquant.

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
| Broker Node.js sans dépendance   | Démarrage immédiat, pas de `npm install`, déjà dans l'écosystème |
| Stockage JSON fichier            | Volume faible (quelques agents) ; SQLite = évolution future   |
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
| `mailbox_send`     | `to` (req), `body` (req), `subject?`        | `POST /messages`              |
| `mailbox_inbox`    | `status?` (`unread`\|`read`\|`all`), `markRead?` | `GET /inbox/:me` (+ `POST /ack` si `markRead`) |
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
