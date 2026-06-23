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

## Architecture (9 pièces)

- `broker/server.js` — serveur HTTP Node.js (couche HTTP en API standard) + service de la page web.
- `broker/store.js` — couche de persistance **SQLite** (`better-sqlite3`) : isole tout
  l'accès au stockage (messages, fils, registre, migration depuis l'ancien JSON).
- `broker/service.js` — install/désinstall du **service Windows** (NSSM), via les routes
  `/admin/*` (localhost-only) pilotées par l'UI.
- `broker/ui.html` — **interface web** autonome servie sur `/` (monitoring, config client, guide,
  bouton service). HTML/CSS/JS inline, aucun asset externe.
- `client/mailbox-check.ps1` — hook de réception (déployé en `~/.claude/`).
- `client/mailbox-send.ps1` — envoi par script (déployé en `~/.claude/`).
- `mcp/mailbox-mcp.js` — façade MCP, tools `mailbox_*` (JSON-RPC stdio, **sans dépendance**).
- `commands/msg.md` — slash-command `/msg` (déployée en `~/.claude/commands/`).
- `install.ps1` — déploie le client par machine (hook en **chemin absolu**, dédoublonné),
  rattache un projet (`.mailbox.json`) et branche le serveur MCP (`.mcp.json`).
  `vendor/nssm/nssm.exe` (embarqué) sert au service Windows ; `setup-server.ps1`/`setup-client.ps1`
  sont les wrappers d'install conviviaux.

Référence complète : [SPECS.md](SPECS.md). Vue d'ensemble : [README.md](README.md).

## Règles de conception à respecter

- **Dépendances : minimalisme strict.** Le broker a **une seule** dépendance assumée,
  `better-sqlite3` (persistance — exige `npm install` sur la machine broker uniquement).
  La **façade MCP** (`mcp/mailbox-mcp.js`) **et les scripts client restent zéro-dépendance** :
  ils parlent HTTP/JSON-RPC à la main (API Node standard `http`/`https`/`fs`/`path`/`URL`,
  pas de SDK MCP, pas de `fetch`/undici). Toute nouvelle dépendance se propose d'abord,
  ne s'ajoute pas d'office.
- **La façade MCP n'utilise pas `fetch`/undici** mais `http`/`https` (connexion
  fraîche, pas de pool keep-alive qui réutiliserait un socket périmé sur ce process
  long-vivant), avec un retry sur erreur de connexion transitoire.
- **Le broker ne doit jamais perdre de message silencieusement.** La durabilité est
  assurée par SQLite en mode WAL (transactions). Les écritures multi-lignes (migration,
  ack groupé) passent par une transaction `better-sqlite3`. Tout l'accès au stockage
  reste confiné dans `broker/store.js` — `server.js` ne touche jamais au SQL directement.
- **Les hooks ne doivent jamais bloquer ou faire échouer une session.** En cas
  d'erreur (broker down, config absente), sortir proprement (code 0) avec au plus
  une note de contexte. Tester systématiquement le cas « broker injoignable ».
- **Compatibilité Windows / PowerShell 5.1** pour les scripts client (la machine
  `automate` tourne potentiellement sous TIA Portal / Windows). Éviter la syntaxe
  PowerShell 7-only (`??`, `?.`, ternaire, `&&`/`||`).
- **Encodage UTF-8** à l'écriture de fichiers (`Out-File -Encoding utf8`) — il y a
  des accents et des emojis dans les messages.
- **Fusion non destructive** de `settings.json` dans `install.ps1` : ne jamais
  écraser les hooks existants de l'utilisateur, dédupliquer par commande.

## Contrats à ne pas casser

- Format du **Message** et de la **config `.mailbox.json`** (voir SPECS §3) : tout
  changement doit rester rétro-compatible ou s'accompagner d'une migration.
- Les **routes de l'API** (SPECS §4) sont consommées par les scripts client ET le
  serveur MCP ; toute modification doit être répercutée dans `client/*.ps1`,
  `mcp/mailbox-mcp.js` ET la doc.
- `*` est l'adresse de **diffusion** réservée — jamais un nom de projet valide.
- Les **canaux** utilisent le préfixe `#` (ex. `#auth`). Le filtrage par canal est
  **sans état côté broker** : le client transmet sa liste `channels` à chaque appel
  `GET /inbox`. Ne pas introduire de membership persistant côté broker pour le
  filtrage (source de bugs de synchro) — le registre ne stocke les canaux que pour
  la visibilité.

## Tester localement

```powershell
# 1. lancer le broker
npm start
# 2. dans un autre terminal : santé + aller-retour
npm run health
Invoke-RestMethod http://localhost:7777/messages -Method Post -Body (@{from='a';to='b';body='hi'}|ConvertTo-Json) -ContentType application/json
Invoke-RestMethod "http://localhost:7777/inbox/b?status=unread"
```

Scénarios d'acceptation complets : SPECS §9. Toute évolution doit les garder verts.

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
