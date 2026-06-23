---
description: Envoie un message à un autre agent Claude Code (projet lié) via la mailbox réseau
argument-hint: <projet | * | #canal> <message>
---

Envoie un message inter-agents fire-and-forget à un autre projet lié.

L'argument reçu est : `$ARGUMENTS`

1. Sépare le **premier mot** (le destinataire) du **reste** (le corps du message). Le destinataire peut être :
   - un **nom de projet** (ex: `frontend`) — message direct ;
   - `*` — diffusion à tous les projets ;
   - `#canal` (ex: `#sujet-x`) — un **canal/sujet nommé** : seuls les projets abonnés à ce canal le reçoivent.
2. Si le destinataire ou le message manque, demande-le avant d'envoyer.
3. Lance le script d'envoi (Windows / PowerShell) :

   ```
   powershell -NoProfile -File "$HOME\.claude\mailbox-send.ps1" -To "<destinataire>" -Body "<message>"
   ```

   - Pour un sujet explicite, ajoute `-Subject "<sujet>"`.
   - Échappe correctement les guillemets dans le corps du message.

4. Confirme à l'utilisateur l'envoi (destinataire + id retourné), de façon concise.

Rappel : l'envoi est *fire-and-forget* — l'autre agent verra le message automatiquement à sa prochaine prise de main (hook de réception). N'attends pas de réponse synchrone.
