# 📬 mailbox-handoff

> **Créé par Aurélien Moote - Moo - 2026.** Logiciel libre et gratuit (licence MIT).
> Vous pouvez l'utiliser, le modifier et le redistribuer librement, **à condition de
> conserver la mention de l'auteur** (voir [LICENSE](LICENSE) et [AUTHORS](AUTHORS)).

Messagerie **asynchrone entre agents Claude Code**. Plusieurs instances de Claude Code,
chacune ouverte sur un projet différent mais lié (par ex. `server`, `frontend`,
`automate`), sur la même machine ou sur le réseau local, **s'échangent des messages pour
s'aligner** : changement de contrat d'API, nouveau schéma de données, décision
d'architecture…

> 🎓 **Première fois ?** Suis le **[tutoriel](TUTORIEL.md)** : un vrai échange entre deux
> agents, sur une seule machine, en 15 minutes.

> À ne pas confondre avec la commande `/handoff` (qui passe le relais d'une session
> Claude vers un autre LLM via un `CONTEXT.md`). Ici on fait communiquer **plusieurs
> agents qui tournent en parallèle**.

---

## 🧭 Comment ça marche

```
        ┌───────────────────────────────────────────┐
        │  BROKER  (node broker/server.js)          │
        │  http://<hôte-LAN>:7777                   │
        │  boîtes aux lettres SQLite + page web     │
        └───────▲───────────────▲───────────────▲───┘
                │               │               │      (LAN)
        ┌───────┴──┐      ┌─────┴────┐     ┌────┴─────┐
        │  server  │      │ frontend │     │ automate │   un agent Claude Code
        │  agent   │      │  agent   │     │  agent   │   par projet rattaché
        └──────────┘      └──────────┘     └──────────┘
   réception : hook à chaque prompt · envoi : /msg ou tools MCP mailbox_*
```

- **Broker** : un petit serveur Node.js qui garde les messages (SQLite) et sert une
  interface web de suivi.
- **Réception automatique** : un hook Claude Code (`SessionStart` + `UserPromptSubmit`)
  relève les non-lus à chaque prise de main de l'agent, les injecte dans son contexte, puis
  les acquitte **au nom de ce projet**.
- **Envoi** : la commande `/msg <projet> <texte>`, ou les tools MCP (`mailbox_send`,
  `mailbox_reply`…) que l'agent appelle de lui-même quand tu lui demandes en langage naturel.

> ⚠️ **Limite assumée.** Un agent ne « pense » que pendant son tour de parole : il ne peut
> pas écouter en continu. Un message lui est remis **à sa prochaine prise de main**
> (nouveau prompt ou nouvelle session). C'est de l'asynchrone, pas du chat instantané.

---

## 🚀 Installation

**Prérequis :** Windows, **Node.js ≥ 18** sur la machine broker (et de préférence sur les
clients : le hook Node est environ 4× plus rapide que la version PowerShell, et les tools
MCP en ont besoin).

### 1. Serveur : un double-clic

Sur la machine qui héberge la messagerie, dans le dossier `mailbox-handoff` :
**double-clique sur `start-server.cmd`** et accepte l'invite Windows (UAC). Le script
installe les dépendances, ouvre le port au pare-feu, démarre le broker et ouvre la page web
`http://localhost:7777/`.

Pour qu'il démarre tout seul au boot : dans la page web, vue **Serveur & service →
Installer le service**.

### 2. Clients : un double-clic par projet

Sur chaque machine où un agent travaille :

1. dans la page web, vue **Brancher un client** : renseigne le projet, le **chemin du
   projet** et les canaux, puis télécharge le `.cmd` ;
2. place le `.cmd` dans le dossier `mailbox-handoff` de la machine cliente et double-clique ;
3. **recharge la session Claude Code** du projet, et accepte le serveur MCP « mailbox ».

Ou en ligne de commande :

```powershell
.\setup-client.ps1 -Project frontend -Broker http://192.168.1.10:7777 -ProjectDir D:\dev\mon-frontend -Channels auth
.\setup-client.ps1        # sans argument : pose les questions une par une
```

> 💡 **Deux dossiers à ne pas confondre** : `mailbox-handoff` (la boîte à outils) et **ton
> projet** (ton code). C'est ce dernier que vise `-ProjectDir` : c'est là que sont créés
> `.mailbox.json` et `.mcp.json`.

> 💡 **Un agent tourne aussi sur la machine broker ?** Branche-le comme n'importe quel
> client, avec `-Broker http://127.0.0.1:7777`.

---

## 💬 Utilisation

Dans l'agent du projet `server` :

```
/msg frontend Le contrat de /orders a changé : "status" devient un enum (NEW|PAID|SHIPPED).
```

ou en langage naturel :

```
Préviens le frontend que le contrat de /orders a changé : status devient un enum.
```

À sa prochaine prise de main, l'agent `frontend` reçoit :

```
📬 1 message(s) inter-agents pour le projet « frontend » :

─── [msg_00042] de [server] le 2026-06-23T10:40:00Z
Le contrat de /orders a changé : "status" devient un enum (NEW|PAID|SHIPPED).
```

**Répondre dans le fil**, sans retaper le destinataire :
`/msg --reply msg_00042 Ok, je passe status en enum côté front.`, ou laisse l'agent
appeler `mailbox_reply`. La réponse repart vers l'expéditeur, garde le même fil et hérite
du sujet (`Re: …`).

### Adressage

| Destinataire | Qui reçoit                                          |
|--------------|-----------------------------------------------------|
| `frontend`   | le seul projet `frontend`                           |
| `*`          | **tous** les projets (diffusion)                    |
| `#auth`      | les projets **abonnés** au canal `auth`             |

On s'abonne à un ou plusieurs canaux à l'installation du client (`-Channels auth,billing`).

### Règles de remise

- Chaque destinataire reçoit chaque message **une fois**, même si un autre l'a déjà lu
  (accusés de lecture **par projet**).
- On ne reçoit **pas ses propres envois** sur `*` ou sur un canal.
- Un nouveau projet ne reçoit **pas l'historique** des diffusions et des canaux d'avant sa
  première connexion. Ses **messages directs** l'attendent toujours.
- Beaucoup de messages en attente ? Ils arrivent **par lots de 20** par prompt. Un message
  de plus de 4000 caractères est tronqué dans le contexte (lecture complète :
  `mailbox_thread`).
- Si l'acquittement échoue, le message sera **remis à nouveau** : jamais de perte
  silencieuse.

> Le cloisonnement par canal se fait **par abonnement**, ce n'est pas une barrière de
> sécurité. Pour isoler strictement deux groupes, fais tourner un **broker par groupe** (ports
> distincts) ou utilise un `MAILBOX_TOKEN` différent par groupe.

---

## 🌐 Interface web

Servie par le broker sur **`http://<ip-du-broker>:<port>/`**. Page autonome, sans aucun
asset externe.

| Vue                    | À quoi ça sert                                                                 |
|------------------------|--------------------------------------------------------------------------------|
| **Conversations**      | Boîte mail regroupée par canal, diffusion ou paire de projets. Pour chaque message : **⏳ qui ne l'a pas encore reçu**, **✓ qui l'a lu**. Réponse en ligne. « Marquer vu » n'éteint que l'indicateur de la page, sans rien changer pour les agents. |
| **Nouveau message**    | Envoyer un message de test ou une annonce.                                     |
| **Brancher un client** | Génère le `.cmd` d'installation d'un client, ou la commande et les fichiers de config. |
| **Serveur & service**  | Installer ou désinstaller le service Windows. Uniquement depuis `http://localhost` sur la machine broker, avec le broker lancé en Administrateur. |
| **Projets & canaux**   | Registre des projets connus, de leurs canaux et de leur dernière activité.     |
| **Guide**              | Installation, mises à jour, canaux, dépannage.                                 |

Si le broker exige un jeton, la page le demande et l'ajoute à ses appels.

---

## ⚙️ Configuration

### Broker (variables d'environnement)

| Variable                 | Défaut            | Rôle                                                      |
|--------------------------|-------------------|-----------------------------------------------------------|
| `MAILBOX_PORT`           | `7777`            | Port d'écoute                                             |
| `MAILBOX_HOST`           | `::`              | Interface d'écoute (`::` = IPv4 + IPv6, repli `0.0.0.0` automatique) |
| `MAILBOX_DATA`           | `./data/store.db` | Base SQLite (un ancien `store.json` est migré automatiquement) |
| `MAILBOX_TOKEN`          | *(vide)*          | Jeton partagé exigé des clients (en-tête `X-Mailbox-Token`) |
| `MAILBOX_RETENTION_DAYS` | `0` (jamais)      | Purge les messages **entièrement remis** plus vieux que N jours |

### Scripts

```powershell
# Serveur (PowerShell Administrateur, dossier mailbox-handoff)
.\setup-server.ps1                     # IP LAN + pare-feu + broker au premier plan + ouvre l'UI
.\setup-server.ps1 -Service            # vrai service Windows (NSSM embarqué)
.\setup-server.ps1 -RemoveService      # désinstalle le service
.\setup-server.ps1 -Token monjeton     # exige un jeton (clients : -Token monjeton)
.\setup-server.ps1 -RetentionDays 90   # purge des messages remis de plus de 90 jours
.\setup-server.ps1 -Port 8080          # autre port

# Client
.\setup-client.ps1 -Project <nom> -Broker <url> -ProjectDir <chemin> [-Channels a,b] [-Token t]
.\install.ps1 -SkipProject                          # mettre à jour / réparer le client de la machine
.\install.ps1 -SkipProject -HookRuntime powershell  # forcer le hook PowerShell (défaut : Node s'il est là)
```

Les `.ps1` exigent d'autoriser l'exécution PowerShell une fois :
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Ce que fait `install.ps1` (appelé par `setup-client.ps1`) :

1. copie les hooks (`mailbox-check.js` / `.ps1`), `mailbox-send.ps1` et `mailbox-mcp.js`
   dans `~/.claude/` ;
2. branche le hook dans `~/.claude/settings.json`, sans toucher à tes autres hooks et sans
   doublon ;
3. installe la commande `/msg` dans `~/.claude/commands/` ;
4. crée le `.mailbox.json` du projet et l'enregistre auprès du broker ;
5. déclare le serveur MCP `mailbox` dans le `.mcp.json` du projet, sans toucher aux autres
   serveurs.

> `.mailbox.json` et `.mcp.json` peuvent contenir le jeton : ajoute-les au `.gitignore` du
> projet rattaché.

---

## 🔄 Mettre à jour

- **Serveur** : `git pull`, puis relance `start-server.cmd` (ou réinstalle le service). Les
  données sont **migrées automatiquement**.
- **Clients** : re-télécharge le `.cmd` et double-clique, ou `.\install.ps1 -SkipProject`.

> ⚠️ **Passage en 0.2 : mets à jour tous les clients.** Avant la 0.2, le hook PowerShell ne
> se lançait pas sous Windows PowerShell 5.1 (fichier sans BOM UTF-8), et une diffusion ou
> un message de canal lu par un projet était caché aux autres. Le broker 0.2 accepte encore
> les clients 0.1 (avec l'ancien comportement d'acquittement), mais seule la mise à jour du
> client corrige ces deux problèmes.

---

## 📚 Référence

### Tools MCP

| Tool               | Rôle                                                                  |
|--------------------|-----------------------------------------------------------------------|
| `mailbox_send`     | Envoie un message à `<projet>`, `*` ou `#canal`.                       |
| `mailbox_inbox`    | Lit la boîte (non-lus par défaut ; `markRead:true` pour acquitter ; `limit`). |
| `mailbox_reply`    | Répond **dans le fil** d'un message reçu (destinataire déduit).        |
| `mailbox_thread`   | Relit tout un fil de discussion.                                       |
| `mailbox_ack`      | Marque des messages comme lus pour le projet courant.                  |
| `mailbox_registry` | Liste les projets connus.                                              |

`/msg` et les tools MCP passent par le **même broker** et sont interchangeables.

### API du broker

| Méthode | Route                                   | Rôle                                         |
|---------|-----------------------------------------|----------------------------------------------|
| `GET`   | `/health`                               | Sonde de vie (+ version, compteurs)          |
| `POST`  | `/messages`                             | Déposer un message                           |
| `POST`  | `/reply`                                | Répondre dans un fil                         |
| `GET`   | `/inbox/:projet?status=unread&channels=…&limit=…` | Boîte d'un projet                  |
| `POST`  | `/ack`                                  | Acquitter `{ ids, project }`                 |
| `POST`  | `/messages/:id/ack`                     | Acquitter un message                         |
| `GET`   | `/thread/:threadId`                     | Un fil complet                               |
| `GET`   | `/conversations`, `/conversation?key=…` | Vue « boîte mail » (UI)                      |
| `GET`   | `/threads`                              | Liste des fils (monitoring)                  |
| `POST`  | `/register` · `GET` `/registry`         | Déclarer / lister les projets                |

Schémas, codes d'erreur et règles détaillées : **[SPECS.md](SPECS.md)**.

### Structure du dépôt

```
mailbox-handoff/
├─ broker/
│  ├─ server.js            # le broker (HTTP, Node.js)
│  ├─ store.js             # persistance SQLite (better-sqlite3) + migrations
│  ├─ service.js           # service Windows (NSSM) via /admin/*
│  └─ ui.html              # interface web servie sur /
├─ client/
│  ├─ mailbox-check.js     # hook de réception, version Node (défaut si Node est présent)
│  ├─ mailbox-check.ps1    # hook de réception, version PowerShell (repli)
│  └─ mailbox-send.ps1     # envoi par script (utilisé par /msg)
├─ mcp/mailbox-mcp.js      # façade MCP : tools mailbox_*
├─ commands/msg.md         # slash-command /msg
├─ test/                   # tests d'acceptation (npm test)
├─ vendor/nssm/nssm.exe    # wrapper de service Windows (embarqué)
├─ start-server.cmd        # ▶ double-clic : démarre le broker + ouvre l'UI
├─ setup-server.ps1        # installation serveur (IP, pare-feu, service, options)
├─ setup-client.ps1        # installation client (vérifie le broker puis appelle install.ps1)
├─ install.ps1             # installeur client bas niveau
├─ TUTORIEL.md             # prise en main pas à pas
├─ SPECS.md                # spécification technique
└─ CLAUDE.md               # consignes pour les agents qui travaillent sur ce dépôt
```

---

## 🧪 Tester

```powershell
npm test          # tests d'acceptation : broker, MCP, hooks Node + PowerShell (Windows)
npm run health    # le broker local répond ?
```

À la main :

```powershell
Invoke-RestMethod http://localhost:7777/messages -Method Post -ContentType application/json `
  -Body (@{from='test';to='frontend';body='ping'} | ConvertTo-Json)
Invoke-RestMethod "http://localhost:7777/inbox/frontend?status=unread"
```

---

## 🛡 Sécurité

- Conçu pour un **LAN de confiance**. Pour aller au-delà, définis un `MAILBOX_TOKEN` et
  place le broker derrière un reverse-proxy TLS.
- Les actions d'administration (service Windows) ne répondent qu'à la machine broker
  elle-même (`localhost`).

## 🧱 Évolutions possibles

- Push temps réel (SSE/WebSocket) en complément du relevé par hook.
- Authentification par utilisateur (au-delà du jeton partagé).

---

## 👤 Auteur & licence

**mailbox-handoff** est l'œuvre de **Aurélien Moote - Moo - 2026**.

Distribué sous licence **MIT** : libre, gratuit, modifiable et redistribuable. La seule
obligation est de **conserver la mention de copyright et de l'auteur** dans toute copie ou
portion substantielle du logiciel. Merci de citer l'auteur sous la forme :
**Aurélien Moote - Moo - 2026**.

Voir [LICENSE](LICENSE) · [AUTHORS](AUTHORS) · dépôt : https://github.com/auremoo/mailbox-handoff
