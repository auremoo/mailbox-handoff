# 📬 mailbox-handoff

> **Créé par Aurélien Moote - Moo - 2026.** Logiciel libre et gratuit (licence MIT).
> Vous pouvez l'utiliser, le modifier et le redistribuer librement, **à condition de
> conserver la mention de l'auteur** (voir [LICENSE](LICENSE) et [AUTHORS](AUTHORS)).

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

## 🚀 Démarrage (tout se pilote dans l'interface web)

Tout se fait dans une **page web** servie par le broker (monitoring, installation du
service, branchement des clients, guide). La **seule** action hors navigateur est **un
double-clic** pour démarrer le serveur — une page web ne peut pas se lancer toute seule.

> ### ⚙️ Prérequis (machine serveur uniquement)
> **Node.js ≥ 18** installé (https://nodejs.org, LTS). C'est tout : `start-server.cmd`
> s'occupe du reste (dépendances `npm`, pare-feu, élévation Administrateur).

### 1️⃣ Serveur — un double-clic

Sur la machine qui héberge la messagerie, dans le dossier `mailbox-handoff` :
**double-clique sur `start-server.cmd`** et accepte l'invite Windows (UAC).

→ Il installe les dépendances, ouvre le port au pare-feu, démarre le broker et **ouvre
automatiquement la page web** sur `http://localhost:7777/`.

### 2️⃣ Tout le reste, dans la page web

| Onglet            | Ce que tu y fais                                                            |
|-------------------|-----------------------------------------------------------------------------|
| **Serveur**       | Bouton **« Installer le service »** → le broker devient un vrai service Windows (démarre seul au boot, même sans session ouverte). |
| **Config client** | Remplis projet / chemin / canaux → **« Télécharger le .cmd »** (ou copie la commande) pour brancher une machine cliente. |
| **Fils / Registre / Envoyer** | Suivre les conversations, voir les projets/canaux connus, tester un envoi ou une réponse. |
| **Guide**         | Tutoriels intégrés : install & **mises à jour** (serveur + client), service, canaux, dépannage. |

### 3️⃣ Client — un double-clic

Sur chaque machine cliente (= là où un agent Claude Code travaille sur ton projet) :

1. dans l'onglet **Config client** de la page web, télécharge le **`.cmd`** (pré-rempli pour ce projet) ;
2. place-le dans le dossier `mailbox-handoff` de la machine cliente et **double-clique** ;
3. **recharge la session Claude Code** du projet → réception automatique des messages + tools MCP actifs.

> 💡 **Deux dossiers à ne pas confondre** : `mailbox-handoff` (la boîte à outils) vs **ton
> vrai projet** (ton code — c'est lui que vise le champ « chemin », et c'est là que sont
> déposés `.mailbox.json` / `.mcp.json`).

> 💡 **Un agent tourne aussi sur la machine serveur ?** Broker et client sont indépendants —
> branche le client en plus sur le serveur (dans Config client, mets le broker à `http://127.0.0.1:7777`).

> 🔄 **Mettre à jour.** Serveur : `git pull` puis re-double-clic sur `start-server.cmd` (les
> données sont migrées automatiquement). Client : re-télécharge le `.cmd` et double-clique.
> Le pas-à-pas complet est dans l'onglet **Guide** de la page web.

---

## 🧰 Alternative : en ligne de commande

Tout ce que fait l'interface web est aussi disponible en scripts (pratique pour automatiser,
ou si tu préfères le terminal). Les `.ps1` exigent d'autoriser l'exécution PowerShell une fois :
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (ou `powershell -ExecutionPolicy Bypass -File …`).

**Serveur** (PowerShell Administrateur, dossier `mailbox-handoff`) :
```powershell
.\setup-server.ps1                   # IP LAN + pare-feu + broker en avant-plan + ouvre l'UI
.\setup-server.ps1 -Service          # VRAI service Windows (auto-démarrage, sans session) — via NSSM embarqué
.\setup-server.ps1 -RemoveService    # désinstalle le service
.\setup-server.ps1 -Token monjeton   # exige un jeton partagé (clients : -Token monjeton)
.\setup-server.ps1 -Port 8080        # autre port
```

**Client** (sur la machine cliente, dossier `mailbox-handoff`) :
```powershell
.\setup-client.ps1 -Project frontend -Broker http://192.168.1.10:7777 -ProjectDir D:\dev\mon-frontend -Channels auth
.\setup-client.ps1                   # sans argument : pose les questions une par une
```
Recharge ensuite la session Claude Code du projet. Pour **mettre à jour / réparer** un client
déjà installé : `.\install.ps1 -SkipProject`.

---

## 🔧 Détail des scripts (équivalent bas niveau)

### Lancer le broker à la main

```powershell
cd mailbox-handoff
npm install   # une fois : installe better-sqlite3 (persistance SQLite du broker)
npm start     # -> [mailbox] broker à l'écoute sur http://0.0.0.0:7777
```

> Le broker persiste désormais dans une base **SQLite** (`data/store.db`). Un ancien
> `data/store.json` est **migré automatiquement** au premier démarrage (puis renommé
> `.migrated`). `npm install` n'est requis que sur la **machine broker** ; les clients
> PowerShell et la façade MCP n'ont aucune dépendance.

Note l'**IP de cette machine** (`ipconfig`) et ouvre le port `7777` au pare-feu.
Options (variables d'environnement) :

| Variable        | Défaut                | Rôle                                            |
|-----------------|-----------------------|-------------------------------------------------|
| `MAILBOX_PORT`  | `7777`                | Port d'écoute                                    |
| `MAILBOX_HOST`  | `0.0.0.0`             | Interface (laisser `0.0.0.0` pour le LAN)        |
| `MAILBOX_DATA`  | `./data/store.db`     | Base SQLite persistante (un `.json` hérité est migré) |
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

### 🧵 Répondre dans un fil (question/réponse)

Chaque message porte un `id` (affiché en tête, ex. `[msg_00042]`) et un `threadId`. Pour
**répondre dans le fil** d'un message reçu — sans avoir à retaper le destinataire :

```
/msg --reply msg_00042 Oui, je m'aligne, je passe status en enum côté frontend.
```

ou, si la façade MCP est branchée, l'agent appelle simplement le tool `mailbox_reply`
(`replyTo: "msg_00042"`). La réponse repart vers l'expéditeur d'origine, garde le même
`threadId` et hérite du sujet (`Re: …`). `mailbox_thread` permet de relire tout le fil.

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

## 🌐 Interface web (monitoring, config & service)

Le broker sert une **page web autonome** (zéro dépendance front, aucun asset externe) sur
**`http://<ip-du-broker>:<port>/`** (aussi `/ui`). Elle ne remplace pas les scripts d'install
(un navigateur ne peut ni déployer du code ni élever les privilèges), mais elle **outille**
l'installation et l'exploitation. Navigation en **barre latérale**, regroupée pour bien
**séparer la messagerie des configurations** :

| Groupe          | Vue                  | À quoi ça sert                                                                 |
|-----------------|----------------------|--------------------------------------------------------------------------------|
| **Messagerie**  | **Conversations**    | Boîte mail : liste des fils (avec canal/destination) à gauche, fil à droite, **réponse en ligne** et « marquer lu ». |
|                 | **Nouveau message**  | Composer un message (projet, `*` ou `#canal`).                                 |
| **Configuration**| **Brancher un client** | **Générateur** : projet/chemin/canaux → **télécharge un `.cmd`** (ou la commande + snippets `.mailbox.json`/`.mcp.json`). |
|                 | **Serveur & service**| **Installer/désinstaller le service Windows** (voir conditions ci-dessous).    |
|                 | **Projets & canaux** | Registre des agents connus, leurs canaux, dernière activité.                   |
| **Aide**        | **Guide**            | Tutoriels intégrés : install & màj serveur, install & màj client, service, canaux, fils. |

> 🖥️ **Installer le service depuis l'UI** (onglet Serveur) n'est possible que :
> 1. depuis la **machine serveur elle-même** (`http://localhost:<port>/` — les actions
>    d'admin sont refusées (403) depuis le LAN), et
> 2. avec le broker lancé dans un **PowerShell Administrateur** (installer un service exige
>    l'élévation). L'onglet affiche l'état (Windows / Admin / nssm / service) et te le dit.

> 🔐 Si le broker tourne avec `MAILBOX_TOKEN`, la page demande le jeton et l'ajoute à ses appels.
> Modèle de confiance LAN : la page est accessible à tout le réseau, comme l'API.

> 💡 **Le passage à une nouvelle version du broker** reste une étape en ligne de commande sur la
> machine serveur (`git pull` + `npm install` + relance / `-Service`). La migration de l'ancien
> `store.json` vers SQLite est **automatique** au 1er démarrage. Une fois le nouveau broker lancé,
> la nouvelle UI (avec ces onglets) est disponible.

---

## 🗂 Structure du dépôt

```
mailbox-handoff/
├─ broker/
│  ├─ server.js            # le broker (HTTP, Node.js)
│  ├─ store.js             # persistance SQLite (better-sqlite3) + migration
│  ├─ service.js           # install/désinstall du service Windows (NSSM) via /admin/*
│  └─ ui.html              # interface web servie sur / (monitoring, config, guide)
├─ vendor/
│  └─ nssm/nssm.exe        # wrapper de service Windows (embarqué dans le dépôt)
├─ start-server.cmd        # ▶ DOUBLE-CLIC : démarre le broker + ouvre l'UI (serveur)
├─ start-server.ps1        # lanceur auto-élevé appelé par start-server.cmd
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
| `mailbox_send`      | Envoie un message à `<projet>`, `*` (diffusion) ou `#canal`.       |
| `mailbox_inbox`     | Lit la boîte (non-lus par défaut ; `markRead:true` pour acquitter).|
| `mailbox_reply`     | Répond **dans le fil** d'un message reçu (destinataire déduit).    |
| `mailbox_thread`    | Récupère tout un fil de discussion (par `threadId`).              |
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

- Push temps réel (SSE/WebSocket) en complément du pull par hook.
- Purge/archivage automatique des vieux fils.
- Authentification par utilisateur (au-delà du jeton partagé LAN).

---

## 👤 Auteur & licence

**mailbox-handoff** est l'œuvre de **Aurélien Moote - Moo - 2026**.

Distribué sous licence **MIT** : libre, gratuit, modifiable et redistribuable — la
seule obligation est de **conserver la mention de copyright et de l'auteur** dans
toute copie ou portion substantielle du logiciel. Merci de citer l'auteur sous la
forme : **Aurélien Moote - Moo - 2026**.

Voir [LICENSE](LICENSE) · [AUTHORS](AUTHORS) · dépôt : https://github.com/auremoo/mailbox-handoff
