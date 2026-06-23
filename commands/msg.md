---
description: Envoie un message à un autre agent Claude Code (projet lié) via la mailbox réseau
argument-hint: <projet | * | #canal | --reply <id>> <message>
---

Envoie un message inter-agents fire-and-forget à un autre projet lié.

L'argument reçu est : `$ARGUMENTS`

1. Détecte d'abord le **mode réponse** : si le premier mot est `--reply`, le mot suivant est l'**id du message** auquel répondre (ex: `msg_00042`) et le reste est le corps. En mode réponse, le destinataire est déduit automatiquement (l'expéditeur du message d'origine) et la réponse reste dans le **même fil de discussion**.
2. Sinon, sépare le **premier mot** (le destinataire) du **reste** (le corps du message). Le destinataire peut être :
   - un **nom de projet** (ex: `frontend`) — message direct ;
   - `*` — diffusion à tous les projets ;
   - `#canal` (ex: `#sujet-x`) — un **canal/sujet nommé** : seuls les projets abonnés à ce canal le reçoivent.
3. Si le destinataire (ou l'id en mode réponse) ou le message manque, demande-le avant d'envoyer.
4. Lance le script d'envoi (Windows / PowerShell) :

   - Message normal :
     ```
     powershell -NoProfile -File "$HOME\.claude\mailbox-send.ps1" -To "<destinataire>" -Body "<message>"
     ```
   - Réponse dans le fil (`--reply <id>`) :
     ```
     powershell -NoProfile -File "$HOME\.claude\mailbox-send.ps1" -ReplyTo "<id>" -Body "<message>"
     ```

   - Pour un sujet explicite, ajoute `-Subject "<sujet>"`.
   - Échappe correctement les guillemets dans le corps du message.

5. Confirme à l'utilisateur l'envoi (destinataire + id retourné), de façon concise.

Rappel : l'envoi est *fire-and-forget* — l'autre agent verra le message automatiquement à sa prochaine prise de main (hook de réception). N'attends pas de réponse synchrone. (La façade MCP expose aussi `mailbox_reply` / `mailbox_thread` si elle est branchée.)
