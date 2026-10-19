# mailbox-check.ps1 — Hook de réception des messages inter-agents (version PowerShell).
#
# Branché sur les hooks SessionStart et UserPromptSubmit de Claude Code.
# Lit la config .mailbox.json du projet courant, récupère les messages non lus
# sur le broker, les injecte dans le contexte de l'agent (additionalContext),
# puis les acquitte AU NOM DU PROJET (une diffusion reste due aux autres projets).
#
# Sans .mailbox.json dans le projet : ne fait rien (silencieux) -> on peut
# l'installer globalement sans gêner les projets non concernés.
#
# Jumeau plus rapide : mailbox-check.js (Node, ~100 ms contre ~400 ms ici),
# choisi par install.ps1 quand Node est présent. Les deux doivent rester alignés.

$ErrorActionPreference = 'Stop'
# La barre de progression d'Invoke-RestMethod coûte cher en PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'

# Sortie en UTF-8 : le contexte injecté contient accents et emojis. En PowerShell
# 5.1 la sortie console n'est pas UTF-8 par défaut -> Claude Code lirait des
# caractères cassés. On force l'encodage de sortie (sans incidence ailleurs).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
# Broker sur le LAN : pas de détection de proxy système (WPAD), qui peut coûter
# plusieurs secondes au premier appel.
try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy } catch { }

$MaxMessages = 20      # messages injectés par prise de main (le reliquat suit au prompt suivant)
$MaxBodyChars = 4000   # au-delà, le corps est tronqué (lecture complète via mailbox_thread)
$RetrySeconds = 60     # broker injoignable : pas de nouvel essai avant ce délai

function Write-HookContext([string]$Event, [string]$Text) {
    $out = @{ hookSpecificOutput = @{ hookEventName = $Event; additionalContext = $Text } }
    $out | ConvertTo-Json -Depth 5 -Compress
}

# --- Entrée du hook (stdin JSON fourni par Claude Code) -----------------------
$eventName = 'UserPromptSubmit'
try {
    $stdin = [Console]::In.ReadToEnd().TrimStart([char]0xFEFF)  # un pipe peut préfixer un BOM
    if ($stdin) {
        $hook = $stdin | ConvertFrom-Json
        if ($hook.hook_event_name) { $eventName = $hook.hook_event_name }
    }
} catch { }

# --- Localisation du projet et de sa config ----------------------------------
$projectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }
$configPath = Join-Path $projectDir '.mailbox.json'
if (-not (Test-Path $configPath)) { exit 0 }  # projet non rattaché -> silence

try {
    $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-HookContext $eventName "[mailbox] .mailbox.json illisible ($configPath) : $($_.Exception.Message)"
    exit 0
}
if (-not $cfg.project -or -not $cfg.broker) { exit 0 }

$me = [string]$cfg.project
# "localhost" peut d'abord tenter ::1 et perdre ~2 s si le broker n'écoute qu'en IPv4.
$broker = ([string]$cfg.broker).TrimEnd('/') -replace '://localhost(?=[:/]|$)', '://127.0.0.1'
$headers = @{}
if ($cfg.token) { $headers['X-Mailbox-Token'] = [string]$cfg.token }

# Canaux auxquels ce projet est abonné (optionnel) -> passés au broker.
$channelQuery = ""
if ($cfg.channels) {
    $list = (@($cfg.channels) -join ',')
    if ($list) { $channelQuery = "&channels=$([uri]::EscapeDataString($list))" }
}

# --- Coupe-circuit : broker récemment injoignable -> on ne retente pas -------
# Sous Windows une connexion refusée coûte ~2 s : sans ce garde-fou, chaque prompt
# paierait ce délai tant que le broker est arrêté.
$stateDir = Join-Path $env:TEMP 'mailbox-handoff'
$downFile = Join-Path $stateDir ('down-' + ($broker -replace '[^A-Za-z0-9]', '_') + '.txt')
$downNote = "[mailbox] Broker injoignable ($broker). Messages inter-agents indisponibles pour l'instant (nouvel essai automatique d'ici $RetrySeconds s)."
if (Test-Path $downFile) {
    $age = ((Get-Date) - (Get-Item $downFile).LastWriteTime).TotalSeconds
    if ($age -lt $RetrySeconds) {
        if ($eventName -eq 'SessionStart') { Write-HookContext $eventName $downNote }
        exit 0
    }
}

# --- Récupération des non-lus -------------------------------------------------
try {
    $uri = "$broker/inbox/$([uri]::EscapeDataString($me))?status=unread&limit=$MaxMessages$channelQuery"
    $resp = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 3
} catch {
    $httpResp = $_.Exception.Response
    if ($httpResp) {
        # Le broker a répondu mais refuse : config à corriger, pas une panne.
        $code = [int]$httpResp.StatusCode
        Write-HookContext $eventName "[mailbox] Le broker refuse la requête (HTTP $code). Vérifie « project » et « token » dans $configPath."
        exit 0
    }
    # Panne réseau : on arme le coupe-circuit et on le signale une fois.
    try {
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
        Set-Content -Path $downFile -Value (Get-Date -Format o) -Encoding ASCII
    } catch { }
    Write-HookContext $eventName $downNote
    exit 0
}
if (Test-Path $downFile) { Remove-Item $downFile -Force -ErrorAction SilentlyContinue }

$msgs = @($resp.messages)
if ($msgs.Count -eq 0) { exit 0 }  # rien de neuf

# --- Mise en forme du contexte injecté ---------------------------------------
$lines = @()
$lines += "📬 $($msgs.Count) message(s) inter-agents pour le projet « $me » :"
$lines += ""
$ids = @()
foreach ($m in $msgs) {
    $ids += $m.id
    $subj = if ($m.subject) { " — $($m.subject)" } else { "" }
    $dest = if ($m.to -eq '*') { " (diffusion)" }
            elseif ($m.to -like '#*') { " (canal $($m.to))" }
            else { "" }
    # Indique le fil : id du message (pour répondre) + fil s'il s'agit d'une réponse.
    $thread = if ($m.threadId -and $m.threadId -ne $m.id) { " [fil $($m.threadId)]" } else { "" }
    $lines += "─── [$($m.id)] de [$($m.from)]$dest le $($m.createdAt)$subj$thread"
    $body = [string]$m.body
    if ($body.Length -gt $MaxBodyChars) {
        $body = $body.Substring(0, $MaxBodyChars) + "`n[… message tronqué : lis-le en entier avec mailbox_thread (threadId=$($m.threadId))]"
    }
    $lines += $body
    $lines += ""
}
$rest = [int]$resp.total - $msgs.Count
if ($rest -gt 0) { $lines += "($rest autre(s) message(s) en attente : ils arriveront à la prochaine prise de main.)"; $lines += "" }
$lines += "Prends ces messages en compte pour t'aligner avec les autres projets."
$lines += "Pour répondre DANS LE FIL : tool MCP mailbox_reply (replyTo=<id du message>) — ou /msg --reply <id> <texte>."
$lines += "Pour un nouveau message : /msg <projet|*|#canal> <texte>."
$context = ($lines -join "`n")

# --- Acquittement (marque lu pour CE projet) ---------------------------------
try {
    $body = @{ ids = $ids; project = $me } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$broker/ack" -Method Post -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
        -ContentType 'application/json; charset=utf-8' -TimeoutSec 3 | Out-Null
} catch { }  # si l'ack échoue, le message restera non lu -> re-surfacé plus tard (acceptable)

# --- Sortie du hook -----------------------------------------------------------
Write-HookContext $eventName $context
