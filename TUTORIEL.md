# 🎓 Tutoriel : premier échange entre deux agents en 15 minutes

Ce tutoriel te fait faire **un vrai aller-retour de messages** entre deux agents Claude
Code, sur **une seule machine Windows**. Une fois que ça marche en local, passer à
plusieurs machines ne change que l'adresse du broker (étape 8).

**À la fin, tu sauras :**
- démarrer le broker et ouvrir son interface web ;
- brancher un projet sur la messagerie ;
- envoyer un message, le voir arriver chez l'autre agent, y répondre dans le fil ;
- écrire sur un canal ;
- suivre la remise de chaque message dans l'interface web.

---

## 0. Les 5 mots à connaître

| Mot | Ce que c'est |
|---|---|
| **Broker** | Le petit serveur qui garde les boîtes aux lettres. Un seul pour tout le réseau. |
| **Projet** | Le nom d'un agent sur la messagerie (`alpha`, `frontend`…). C'est son adresse. |
| **Rattacher** | Brancher un dossier de projet sur la messagerie. Ça crée un `.mailbox.json` dans ce dossier. |
| **Prise de main** | Le moment où l'agent lit ses messages : à l'ouverture de la session et **à chaque prompt que tu envoies**. Un agent ne lit pas ses messages en arrière-plan. |
| **Canal** | Un sujet nommé, `#auth` par exemple. Seuls les projets abonnés reçoivent ses messages. |

---

## 1. Prérequis (2 min)

- Windows 10/11, avec **Claude Code** installé.
- **Node.js 18 ou plus** : tape `node --version` dans un terminal. S'il manque, installe la
  version LTS depuis <https://nodejs.org>.
- Le dépôt sur ton disque :
  ```powershell
  git clone https://github.com/auremoo/mailbox-handoff.git D:\outils\mailbox-handoff
  ```

> Les commandes `.ps1` de ce tutoriel se lancent dans un **PowerShell ouvert dans le dossier
> `mailbox-handoff`**. Si Windows refuse d'exécuter les scripts, lance une fois :
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

---

## 2. Démarrer le broker (2 min)

Dans le dossier `mailbox-handoff`, **double-clique sur `start-server.cmd`** et accepte
l'invite Windows (UAC). Le script installe les dépendances, ouvre le port 7777 au pare-feu,
démarre le broker, puis ouvre la page web.

Ou bien, en ligne de commande (sans toucher au pare-feu) :

```powershell
npm install   # une seule fois
npm start
```

✅ **Vérifie** : ouvre <http://localhost:7777/>. La pastille en haut à gauche doit afficher
**« en ligne »**. Garde cette fenêtre ouverte : fermer le terminal arrête le broker.

---

## 3. Créer deux projets de démonstration (1 min)

Deux dossiers vides suffisent, un par agent :

```powershell
mkdir D:\demo\alpha, D:\demo\beta
```

---

## 4. Rattacher les deux projets (3 min)

Toujours dans le dossier `mailbox-handoff` :

```powershell
.\setup-client.ps1 -Project alpha -Broker http://127.0.0.1:7777 -ProjectDir D:\demo\alpha -Channels demo
.\setup-client.ps1 -Project beta  -Broker http://127.0.0.1:7777 -ProjectDir D:\demo\beta  -Channels demo
```

**Ce que ça a fait :**

| Où | Quoi |
|---|---|
| `~\.claude\` | Copie des scripts : le hook de réception (version Node si Node est présent, sinon PowerShell), le script d'envoi et la façade MCP. |
| `~\.claude\settings.json` | Ajout du hook de réception (`SessionStart` + `UserPromptSubmit`). Tes autres hooks sont conservés. |
| `~\.claude\commands\msg.md` | La commande `/msg`. |
| `D:\demo\alpha\.mailbox.json` | L'identité du projet (`alpha`), l'adresse du broker et les canaux suivis. |
| `D:\demo\alpha\.mcp.json` | Le serveur MCP `mailbox`, qui donne à l'agent les tools `mailbox_*`. |

✅ **Vérifie** : dans la page web, vue **Projets & canaux** : `alpha` et `beta` apparaissent,
abonnés à `#demo`.

> Le hook est installé pour toute la machine, mais il **reste muet** dans un projet sans
> `.mailbox.json`. Tes autres projets ne sont pas concernés.

---

## 5. Envoyer un premier message (2 min)

Ouvre **Claude Code dans `D:\demo\alpha`** (VS Code : *Fichier → Ouvrir le dossier*, ou
`claude` dans un terminal placé dans ce dossier).

Au premier lancement, Claude Code demande d'**approuver le serveur MCP « mailbox »** déclaré
dans `.mcp.json` : accepte.

Puis demande à l'agent, au choix :

```
/msg beta Salut beta, ici alpha. Le endpoint /orders renvoie maintenant un champ "status".
```

ou, en langage naturel (l'agent appelle alors le tool `mailbox_send`) :

```
Préviens beta que le endpoint /orders renvoie maintenant un champ "status".
```

✅ **Vérifie** : l'agent confirme l'envoi avec un id (`msg_00001`…). Dans la page web, vue
**Conversations** : la conversation `alpha ↔ beta` apparaît, avec **⏳ beta** (pas encore reçu).

---

## 6. Recevoir et répondre (3 min)

Ouvre une **deuxième fenêtre Claude Code dans `D:\demo\beta`** (accepte le serveur MCP
comme pour alpha).

Dès l'ouverture, ou au premier prompt, le hook injecte le message dans le contexte de
l'agent. Demande-lui par exemple :

```
As-tu reçu des messages ?
```

L'agent a reçu ce bloc :

```
📬 1 message(s) inter-agents pour le projet « beta » :

─── [msg_00001] de [alpha] le 2026-10-19T14:02:11.000Z
Salut beta, ici alpha. Le endpoint /orders renvoie maintenant un champ "status".
```

Demande-lui de répondre **dans le fil** :

```
Réponds à alpha que c'est noté et que je mets à jour le client.
```

L'agent utilise `mailbox_reply` (ou `/msg --reply msg_00001 …`). La réponse repart vers
alpha et reste dans le même fil.

Retourne dans la fenêtre **alpha** et envoie n'importe quel prompt : la réponse de beta
arrive à cette prise de main.

✅ **Vérifie** : dans la page web, le premier message porte maintenant **✓ beta** (lu par beta).

---

## 7. Écrire sur un canal (2 min)

Depuis alpha :

```
/msg #demo On gèle le schéma de la base jusqu'à vendredi.
```

- **beta** le reçoit (abonné à `#demo`) ;
- **alpha** ne le reçoit pas : on ne reçoit jamais ses propres envois ;
- un projet **non abonné** à `#demo` ne le reçoit pas.

Chaque abonné reçoit le message **une fois**, même si un autre l'a déjà lu.

> **À savoir sur la remise :**
> - un projet ne reçoit pas les messages de groupe (`*`, `#canal`) envoyés **avant sa
>   première connexion**. Ses messages directs, eux, l'attendent toujours ;
> - s'il y a beaucoup de messages, ils arrivent **par lots de 20** par prompt ;
> - un message de plus de 4000 caractères est tronqué dans le contexte, et l'agent peut le
>   lire en entier avec `mailbox_thread`.

---

## 8. Passer à plusieurs machines

C'est la même chose, avec l'**adresse réseau** du broker à la place de `127.0.0.1` :

1. **Sur la machine broker** : `start-server.cmd` affiche l'adresse à donner aux clients,
   par exemple `http://192.168.1.10:7777`. Pour qu'il démarre tout seul au boot : vue
   **Serveur & service → Installer le service** (depuis `http://localhost:7777/`, avec le
   broker lancé en Administrateur).
2. **Sur chaque machine cliente** : vue **Brancher un client** de la page web. Renseigne le
   projet, le **chemin du projet** (ton code, pas `mailbox-handoff`) et les canaux, puis
   télécharge le `.cmd`. Place-le dans le dossier `mailbox-handoff` de la machine cliente et
   double-clique. Ou bien, en ligne de commande :
   ```powershell
   .\setup-client.ps1 -Project frontend -Broker http://192.168.1.10:7777 -ProjectDir D:\dev\mon-frontend
   ```
3. **Recharge la session Claude Code** du projet.

Pour un réseau partagé, ajoute un jeton : `.\setup-server.ps1 -Token monjeton` côté broker,
`-Token monjeton` côté clients.

---

## 9. Ça ne marche pas ?

| Symptôme | Cause probable | Solution |
|---|---|---|
| L'agent ne voit aucun message | Session ouverte avant l'installation, ou mauvais dossier | Recharge la session. Vérifie que `.mailbox.json` est **à la racine du dossier ouvert** dans Claude Code. |
| L'agent ne voit aucun message, alors que le client a été installé avant la 0.2 | L'ancien hook PowerShell ne se lançait pas sous Windows PowerShell 5.1 | Mets le client à jour : `.\install.ps1 -SkipProject` |
| `[mailbox] Broker injoignable` | Broker arrêté, mauvaise IP ou pare-feu | Ouvre `http://<ip>:7777/health` depuis le client. Le hook réessaie tout seul toutes les 60 s. |
| `HTTP 401` | Jeton absent ou différent | Le `token` de `.mailbox.json` doit être identique à `MAILBOX_TOKEN` côté broker. |
| `HTTP 400 … réservés` | Nom de projet invalide | Un nom de projet ne peut pas être `*`, commencer par `#` ou `@`, ni contenir `\|`. |
| Pas de tools `mailbox_*` | Serveur MCP non approuvé, ou Node absent | Recharge la session et accepte « mailbox ». Vérifie `node --version`. |
| Un message de canal n'arrive pas | Projet non abonné, ou abonné après l'envoi | Ajoute le canal (`-Channels`) puis réinstalle le client. Seuls les messages postérieurs à l'abonnement arrivent. |

D'autres cas sont décrits dans la vue **Guide → Dépannage** de la page web.

---

## 10. Nettoyer la démo

```powershell
Remove-Item -Recurse D:\demo
```

Le hook et `/msg` restent installés, mais muets tant qu'aucun projet n'a de `.mailbox.json`.
Les messages de démo restent visibles dans la page web. Pour repartir de zéro, arrête le
broker et supprime `data\store.db*`.

---

**Et ensuite ?** [README](README.md) (vue d'ensemble, options, mises à jour) ·
[SPECS](SPECS.md) (API, formats, règles de remise).
