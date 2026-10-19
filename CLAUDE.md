# CLAUDE.md — mailbox-handoff

Consignes pour les agents Claude Code travaillant **sur ce dépôt** (le système de
messagerie lui-même). Pour utiliser la messagerie depuis un *autre* projet, voir
plus bas la section « Utiliser la mailbox depuis un projet rattaché ».

## Ce qu'est ce projet

Une messagerie **asynchrone fire-and-forget** entre plusieurs agents Claude Code
ouverts sur des projets liés mais **sur des machines distinctes** (LAN). Un broker
Node.js central tient les boîtes ; des hooks PowerShell font la réception ; une
commande `/msg` fait l'envoi.

Ne pas confondre avec `/handoff` (relais Claude → autre LLM via `CONTEXT.md`) :
c'est un système **différent et indépendant**.

## Architecture

- `broker/server.js` — serveur HTTP Node.js (couche HTTP en API standard) + service de la page web.
- `broker/store.js` — couche de persistance **SQLite** (`better-sqlite3`) : isole tout
  l'accès au stockage (messages, accusés de lecture par projet, fils, registre + curseurs,
  migrations, rétention).
- `broker/service.js` — install/désinstall du **service Windows** (NSSM), via les routes
  `/admin/*` (localhost-only) pilotées par l'UI.
- `broker/ui.html` — **interface web** autonome servie sur `/` (monitoring, config client, guide,
  bouton service). HTML/CSS/JS inline, aucun asset externe.
- `client/mailbox-check.js` / `client/mailbox-check.ps1` — hook de réception, en deux
  versions **jumelles** (même sortie, mêmes règles) : Node par défaut (~100 ms/prompt),
  PowerShell 5.1 en repli sur les postes sans Node. Toute modification de l'une se
  répercute dans l'autre (les tests les exécutent toutes les deux).
- `client/mailbox-send.ps1` — envoi par script (déployé en `~/.claude/`).
- `mcp/mailbox-mcp.js` — façade MCP, tools `mailbox_*` (JSON-RPC stdio, **sans dépendance**).
- `commands/msg.md` — slash-command `/msg` (déployée en `~/.claude/commands/`).
- `install.ps1` — déploie le client par machine (hook en **chemin absolu**, dédoublonné),
  rattache un projet (`.mailbox.json`) et branche le serveur MCP (`.mcp.json`).
  `vendor/nssm/nssm.exe` (embarqué) sert au service Windows ; `setup-server.ps1`/`setup-client.ps1`
  sont les wrappers d'install conviviaux.
- `test/acceptance.test.js` — tests d'acceptation (`npm test`, `node:test`, sans dépendance).

Référence complète : [SPECS.md](SPECS.md). Vue d'ensemble : [README.md](README.md).
Prise en main : [TUTORIEL.md](TUTORIEL.md).

## Règles de conception à respecter

- **Dépendances : minimalisme strict.** Le broker a **une seule** dépendance assumée,
  `better-sqlite3` (persistance — exige `npm install` sur la machine broker uniquement).
  La **façade MCP** (`mcp/mailbox-mcp.js`) **et les scripts client restent zéro-dépendance** :
  ils parlent HTTP/JSON-RPC à la main (API Node standard `http`/`https`/`fs`/`path`/`URL`,
  pas de SDK MCP, pas de `fetch`/undici). Toute nouvelle dépendance se propose d'abord,
  ne s'ajoute pas d'office.
- **La façade MCP n'utilise pas `fetch`/undici** mais `http`/`https` avec
  `agent: false` (connexion fraîche : depuis Node 19 l'agent global garde les sockets
  ouverts, qui pourraient être périmés sur ce process long-vivant), avec un retry sur
  erreur de connexion transitoire.
- **Le broker ne doit jamais perdre de message silencieusement.** La durabilité est
  assurée par SQLite en mode WAL (transactions, `synchronous` FULL). Les écritures
  multi-lignes (création de message, migration, ack groupé, purge) passent par une
  transaction `better-sqlite3`. Tout l'accès au stockage reste confiné dans
  `broker/store.js` — `server.js` ne touche jamais au SQL directement.
- **La lecture est par projet.** Un message de groupe (`*`, `#canal`) a plusieurs
  destinataires : ne jamais revenir à un statut lu/non-lu unique pour décider de la
  remise (c'était le bug de la 0.1). `messages.status` n'est qu'un indicateur de
  monitoring ; la remise ne dépend que de `receipts`.
- **Les rowid de `messages` ne doivent jamais être réutilisés** (les curseurs de lecture
  en dépendent) : toute suppression doit épargner `MAX(rowid)` (cf. `purgeOlderThan`).
- **Les hooks ne doivent jamais bloquer ou faire échouer une session.** En cas
  d'erreur (broker down, config absente), sortir proprement (code 0) avec au plus
  une note de contexte. Tester systématiquement le cas « broker injoignable ».
- **Compatibilité Windows / PowerShell 5.1** pour les scripts client (la machine
  `automate` tourne potentiellement sous TIA Portal / Windows). Éviter la syntaxe
  PowerShell 7-only (`??`, `?.`, ternaire, `&&`/`||`).
- **Tous les `.ps1` sont enregistrés en UTF-8 AVEC BOM.** Sans BOM, PowerShell 5.1 les
  lit en ANSI : `—` ou `📬` deviennent des guillemets parasites et le script ne se parse
  plus (c'était le cas du hook en 0.1). Un test le vérifie.
- **Encodage UTF-8** à l'écriture de fichiers (`Out-File -Encoding utf8`) et pour les
  corps HTTP envoyés depuis PowerShell (`[Text.Encoding]::UTF8.GetBytes(...)`) — il y a
  des accents et des emojis dans les messages.
- **Fusion non destructive** de `settings.json` dans `install.ps1` : ne jamais
  écraser les hooks existants de l'utilisateur, dédupliquer par commande.

## Contrats à ne pas casser

- Format du **Message** et de la **config `.mailbox.json`** (voir SPECS §3) : tout
  changement doit rester rétro-compatible ou s'accompagner d'une migration.
- Les **routes de l'API** (SPECS §4) sont consommées par les scripts client ET le
  serveur MCP ; toute modification doit être répercutée dans `client/*` (hooks `.js` et
  `.ps1`, envoi), `mcp/mailbox-mcp.js`, `broker/ui.html` ET la doc.
- `*` est l'adresse de **diffusion** réservée — jamais un nom de projet valide (pas plus
  qu'un nom commençant par `#` ou `@`, ou contenant `|` : le broker les refuse).
- Les **canaux** utilisent le préfixe `#` (ex. `#auth`). Le filtrage par canal est
  **sans état côté broker** : le client transmet sa liste `channels` à chaque appel
  `GET /inbox`. Ne pas introduire de membership persistant côté broker pour le
  filtrage (source de bugs de synchro) — le registre ne stocke les canaux que pour
  la visibilité (registre, `pending` du monitoring). Le curseur de lecture est un cache
  de l'état de lecture, pas une appartenance.

## Tester localement

```powershell
npm test   # suite d'acceptation complète (broker, MCP, hooks Node + PowerShell sous Windows)
```

Chaque groupe de tests lance un vrai broker sur un port libre avec une base temporaire :
rien à démarrer à la main. Scénarios : SPECS §10. Toute évolution doit les garder verts,
et tout nouveau comportement s'accompagne d'un test.

À la main :

```powershell
npm start                     # terminal 1
npm run health                # terminal 2
Invoke-RestMethod http://localhost:7777/messages -Method Post -Body (@{from='a';to='b';body='hi'}|ConvertTo-Json) -ContentType application/json
Invoke-RestMethod "http://localhost:7777/inbox/b?status=unread"
```

## Style

- Code et commentaires **en français** (cohérent avec l'existant).
- Commentaires utiles (le *pourquoi*), pas de paraphrase du code.
- Garder le broker en un seul fichier lisible tant qu'il reste simple.

---

## Utiliser la mailbox depuis un projet rattaché

Si tu es un agent dans un projet **rattaché** (présence d'un `.mailbox.json`) :

- Tu recevras automatiquement les messages des autres agents en début de session et
  à chaque prompt (hook). Prends-les en compte pour t'aligner.
- Pour prévenir un autre projet d'un changement (contrat d'API, schéma, décision) :
  utilise le tool MCP `mailbox_send` (si la façade MCP est branchée) **ou** la
  commande `/msg <destinataire> <ton message>`. Destinataire : un nom de projet, `*`
  pour tous, ou `#canal` pour un sujet nommé (seuls les abonnés du canal reçoivent).
- Tools MCP disponibles si branchés : `mailbox_send`, `mailbox_inbox`, `mailbox_reply`,
  `mailbox_thread`, `mailbox_ack`, `mailbox_registry`.
- Pour **répondre dans un fil** (question/réponse) : `mailbox_reply` (replyTo = id du
  message reçu) ou `/msg --reply <id> <texte>`. La réponse repart vers l'expéditeur
  d'origine et conserve le `threadId` ; `mailbox_thread` relit tout le fil.
- L'envoi est fire-and-forget : n'attends pas de réponse synchrone ; l'autre agent
  réagira à sa prochaine prise de main.
- Envoie un message **quand ta modification impacte un autre projet** : signature
  d'endpoint, format de données échangé, nom de variable partagé, contrat d'événement.
