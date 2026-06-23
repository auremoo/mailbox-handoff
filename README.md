# 📬 mailbox-handoff

Messagerie **asynchrone inter-agents Claude Code**. Permet à plusieurs instances de
Claude Code — chacune ouverte sur un projet différent mais lié (par ex. `server`,
`frontend`, `automate`) — de **s'échanger des messages pour s'aligner** : changement
de contrat d'API, nouveau schéma de données, décision d'architecture, etc.

> À ne pas confondre avec la commande `/handoff` (qui passe le relais d'une session
> Claude vers un autre LLM via un `CONTEXT.md`). Ici on fait communiquer **plusieurs
> agents qui tournent en parallèle**.

---

## 🧭 Principe

Un petit **broker** réseau (Node.js, zéro dépendance) tient les boîtes aux lettres.
Chaque agent l'utilise via deux mécanismes côté client :

- **Réception (automatique)** — un hook PowerShell (`SessionStart` + `UserPromptSubmit`)
  interroge le broker à chaque prise de main de l'agent, injecte les messages non lus
  dans son contexte, puis les acquitte. Effet « push » sans rien lancer.
- **Envoi (fire-and-forget)** — deux options au choix (et cumulables) :
  - la **commande** `/msg <projet> <texte>` (script PowerShell), ou
  - la **façade MCP** : des *tools* natifs (`mailbox_send`, `mailbox_inbox`,
    `mailbox_ack`, `mailbox_registry`) que l'agent appelle directement, sans script.

```
        ┌──────────────────────────────────────┐
        │   BROKER  (node broker/server.js)      │
        │   http://<hôte-LAN>:7777               │
        │   POST /messages   GET /inbox/<proj>   │
        │   POST /ack        POST /register      │
        └───────▲───────────▲───────────▲────────┘
                │           │           │   (réseau LAN)
        ┌───────┴──┐  ┌─────┴────┐  ┌───┴──────┐
        │  server  │  │ frontend │  │ automate │
        │  agent   │  │  agent   │  │  agent   │
        └──────────┘  └──────────┘  └──────────┘
   chaque projet : .mailbox.json + hook de réception + commande /msg
```

> ⚠️ **Limite assumée.** Un agent Claude Code ne « pense » que pendant son tour de
> parole — il ne peut pas écouter en continu. Un message est donc remis à un agent
> **à sa prochaine prise de main** (nouveau prompt ou nouvelle session), pas en
> temps réel. C'est de l'asynchrone, pas du chat instantané.

---

## 🚀 Installation facile (2 commandes)

Copie/clone le dossier `mailbox-handoff` sur chaque machine concernée, puis :

> ### ⚙️ Prérequis : autoriser l'exécution de scripts PowerShell
> Par défaut Windows bloque les `.ps1` (« *l'exécution de scripts est désactivée sur
> ce système* »). Une fois par machine, autorise les scripts pour ton utilisateur
> (les scripts locaux passent, les scripts distants non signés restent bloqués) :
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # réponds O
> ```
> Alternative ponctuelle, sans rien changer au système :
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\setup-server.ps1 -Persist
> ```
> Node.js (≥ 18) doit être installé sur la machine **serveur**. Les options `-Persist`
> et l'ouverture du pare-feu requièrent un PowerShell lancé **en Administrateur**.

### 1. Sur la machine SERVEUR — lancer le broker

```powershell
# PowerShell en Administrateur (pour le pare-feu) :
cd mailbox-handoff
.\setup-server.ps1
```

Le script détecte l'**IP LAN**, ouvre le **port 7777** dans le pare-feu, démarre le
broker et affiche la **commande exacte à coller sur les clients**. Options utiles :

```powershell
.\setup-server.ps1 -Persist          # démarre le broker automatiquement à chaque ouverture de session
.\setup-server.ps1 -Token monjeton   # exige un jeton partagé (clients : -Token monjeton)
.\setup-server.ps1 -Port 8080        # autre port
```

### 2. Sur chaque machine CLIENTE — rattacher le projet

> **Deux dossiers à ne pas confondre :**
> - `mailbox-handoff` = la boîte à outils, d'où tu **lances** le script ;
> - **ton vrai projet** (ton code frontend / automate / server) = ce que `-ProjectDir`
>   doit pointer. C'est là que l'agent Claude Code travaille, et c'est là que le script
>   dépose `.mailbox.json` + `.mcp.json`.
>
> Tu n'as **pas besoin** d'avoir Claude Code ouvert pendant l'installation : tu lances
> le script dans un PowerShell normal, puis tu (r)ouvres Claude Code dans ton projet.

```powershell
cd mailbox-handoff                       # le dossier des scripts
# -ProjectDir = le chemin de TON projet (PAS mailbox-handoff) :
.\setup-client.ps1 -Project frontend -Broker http://192.168.1.10:7777 -ProjectDir D:\dev\mon-frontend
```

> 💡 Le plus simple : lance **`.\setup-client.ps1` sans aucun argument** — il pose les
> questions une par une (nom du projet, URL du broker, chemin du projet, canaux).

Le script vérifie que le broker répond, puis installe scripts, hooks, commande `/msg`,
serveur MCP et écrit `.mailbox.json` + `.mcp.json` dans ton projet.
**Ouvre ou recharge ensuite la session Claude Code de ce projet** pour activer hooks et tools MCP.

> ### 💡 Un agent Claude tourne AUSSI sur la machine serveur ?
> Broker et client sont **indépendants** : le broker ne rend pas son hôte participant.
> Installe donc le client **en plus** sur la machine serveur, en pointant vers le broker
> local :
> ```powershell
> .\setup-client.ps1 -Project server -Broker http://127.0.0.1:7777 -ProjectDir C:\dev\mon-server
> ```

---

## 🔧 Installation manuelle (équivalent, étape par étape)

### Lancer le broker à la main

```powershell
cd mailbox-handoff
npm start   # -> [mailbox] broker à l'écoute sur http://0.0.0.0:7777
```

Note l'**IP de cette machine** (`ipconfig`) et ouvre le port `7777` au pare-feu.
Options (variables d'environnement) :

| Variable        | Défaut                | Rôle                                            |
|-----------------|-----------------------|-------------------------------------------------|
| `MAILBOX_PORT`  | `7777`                | Port d'écoute                                    |
| `MAILBOX_HOST`  | `0.0.0.0`             | Interface (laisser `0.0.0.0` pour le LAN)        |
| `MAILBOX_DATA`  | `./data/store.json`   | Fichier d'état persistant                        |
| `MAILBOX_TOKEN` | *(vide)*              | Jeton partagé : si défini, exigé par les clients |

### Rattacher un projet à la main

```powershell
.\install.ps1 -Project server   -Broker http://192.168.1.10:7777 -ProjectDir C:\dev\mon-server
.\install.ps1 -Project frontend -Broker http://192.168.1.10:7777 -ProjectDir C:\dev\mon-front
.\install.ps1 -Project automate -Broker http://192.168.1.10:7777 -ProjectDir C:\dev\auto
```

L'installeur :
1. copie `mailbox-check.ps1`, `mailbox-send.ps1` et le serveur `mailbox-mcp.js` dans `~/.claude/` ;
2. branche les hooks `SessionStart` + `UserPromptSubmit` dans `~/.claude/settings.json`
   (fusion non destructive) ;
3. installe la commande `/msg` dans `~/.claude/commands/` ;
4. crée le `.mailbox.json` du projet et l'enregistre auprès du broker ;
5. branche le serveur MCP `mailbox` dans le `.mcp.json` du projet (fusion non destructive).

> Si le broker exige un jeton, ajoute `-Token <jeton>` (identique à `MAILBOX_TOKEN`).
> Après installation, **recharge la session Claude Code** du projet pour que les
> tools MCP `mailbox_*` apparaissent.

### 3. Utiliser

Dans l'agent du projet `server`, au choix :

```
# via la commande
/msg frontend Le contrat de /orders a changé : "status" devient un enum (NEW|PAID|SHIPPED).
```

ou en langage naturel si la façade MCP est branchée — l'agent appellera le tool
`mailbox_send` tout seul :

```
Préviens le frontend que le contrat de /orders a changé : status devient un enum.
```

À sa prochaine prise de main, l'agent `frontend` verra automatiquement :

```
📬 1 message(s) inter-agents pour le projet « frontend » :
─── de [server] le 2026-06-23T10:40:00Z
Le contrat de /orders a changé : "status" devient un enum (NEW|PAID|SHIPPED).
```

Diffusion à tous les projets : `/msg * Le format de date passe en ISO 8601 partout.`

## 📡 Canaux / sujets nommés

En plus de l'adressage direct (`to: projet`) et de la diffusion (`*`), un message
peut viser un **canal** nommé via la convention `#nom`. Seuls les projets **abonnés**
à ce canal le reçoivent — idéal pour faire dialoguer des sous-groupes sur des sujets
distincts.

**Exemple — 4 machines, 2 paires étanches :**

```powershell
# Paire 1 (A, B) discute sur le canal "auth"
.\setup-client.ps1 -Project A -Broker http://192.168.1.10:7777 -Channels auth -ProjectDir C:\dev\A
.\setup-client.ps1 -Project B -Broker http://192.168.1.10:7777 -Channels auth -ProjectDir C:\dev\B

# Paire 2 (C, D) discute sur le canal "billing"
.\setup-client.ps1 -Project C -Broker http://192.168.1.10:7777 -Channels billing -ProjectDir C:\dev\C
.\setup-client.ps1 -Project D -Broker http://192.168.1.10:7777 -Channels billing -ProjectDir C:\dev\D
```

Ensuite, depuis A : `/msg #auth On migre le format des tokens.` → **seuls A et B**
le voient. C et D, abonnés à `billing`, ne reçoivent rien. Un projet peut s'abonner à
**plusieurs canaux** (`-Channels auth,billing`).

| Adressage      | Qui reçoit                                   |
|----------------|-----------------------------------------------|
| `frontend`     | le seul projet `frontend`                     |
| `*`            | **tous** les projets                          |
| `#auth`        | les projets **abonnés** au canal `auth`       |

> Le cloisonnement par canal est **par convention/abonnement**, pas une barrière de
> sécurité (rien n'empêche techniquement un projet de s'abonner à un canal ou
> d'écrire dessus). Pour une isolation étanche « dure », fais tourner un **broker par
> groupe** (ports distincts) ou utilise un `MAILBOX_TOKEN` différent par groupe.

---

## 🗂 Structure du dépôt

```
mailbox-handoff/
├─ broker/
│  └─ server.js            # le broker (Node.js, sans dépendance)
├─ client/
│  ├─ mailbox-check.ps1    # hook de réception (déployé vers ~/.claude/)
│  └─ mailbox-send.ps1     # envoi par script (déployé vers ~/.claude/)
├─ mcp/
│  └─ mailbox-mcp.js       # façade MCP : tools mailbox_* (déployé vers ~/.claude/)
├─ commands/
│  └─ msg.md               # slash-command /msg (déployée vers ~/.claude/commands/)
├─ data/                   # état runtime du broker (gitignoré)
├─ setup-server.ps1        # install facile côté SERVEUR (IP + pare-feu + lancement)
├─ setup-client.ps1        # install facile côté CLIENT (sonde broker + rattachement)
├─ install.ps1             # installeur bas niveau (appelé par setup-client.ps1)
├─ .mailbox.json.example   # gabarit de config projet
├─ .mcp.json.example       # gabarit de config MCP projet
├─ package.json
├─ SPECS.md                # spécification technique (API, formats, états, MCP)
├─ CLAUDE.md               # consignes pour les agents Claude Code
└─ README.md
```

## 🧩 Façade MCP (tools natifs)

Branchée par `install.ps1` dans le `.mcp.json` du projet, elle donne à l'agent
quatre *tools* (transport stdio, identité passée via les variables d'env du `.mcp.json`) :

| Tool                | Rôle                                                              |
|---------------------|-------------------------------------------------------------------|
| `mailbox_send`      | Envoie un message à `<projet>` ou `*` (diffusion).                |
| `mailbox_inbox`     | Lit la boîte (non-lus par défaut ; `markRead:true` pour acquitter).|
| `mailbox_ack`       | Marque lus des messages par leurs ids.                            |
| `mailbox_registry`  | Liste les projets/agents connus.                                  |

> Script (`/msg`) et façade MCP utilisent le **même broker** et sont
> interchangeables — tu peux n'installer que l'un, ou les deux.

---

## 🔌 API du broker (résumé)

| Méthode | Route                          | Rôle                                   |
|---------|--------------------------------|----------------------------------------|
| `GET`   | `/health`                      | Sonde de vie                           |
| `POST`  | `/messages`                    | Déposer un message                     |
| `GET`   | `/inbox/:project?status=unread`| Lire la boîte d'un projet              |
| `POST`  | `/messages/:id/ack`            | Acquitter un message                   |
| `POST`  | `/ack`                         | Acquittement groupé (`{ ids: [...] }`) |
| `POST`  | `/register`                    | Déclarer un projet                     |
| `GET`   | `/registry`                    | Lister les projets connus              |

Détails complets, schémas et codes d'erreur : voir [SPECS.md](SPECS.md).

---

## 🧪 Vérifier rapidement

```powershell
# Le broker répond ?
npm run health

# Envoyer un message à la main
Invoke-RestMethod -Uri http://192.168.1.10:7777/messages -Method Post `
  -Body (@{from='test';to='frontend';body='ping'} | ConvertTo-Json) `
  -ContentType 'application/json'

# Lire la boîte
Invoke-RestMethod -Uri "http://192.168.1.10:7777/inbox/frontend?status=unread"
```

---

## 🛡 Sécurité

- Conçu pour un **LAN de confiance**. Pour exposer au-delà, mets un `MAILBOX_TOKEN`
  et place le broker derrière un reverse-proxy TLS.
- Le `.mailbox.json` peut contenir un jeton → il est **gitignoré** par défaut.

## 🧱 Évolutions possibles

- Mode question/réponse avec fils de discussion (threads).
- Persistance SQLite à la place du JSON pour gros volumes.
- Serveur MCP en façade du broker (l'agent appelle des *tools* au lieu d'un script).
