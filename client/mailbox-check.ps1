# mailbox-check.ps1 — Hook de réception des messages inter-agents.
#
# Branché sur les hooks SessionStart et UserPromptSubmit de Claude Code.
# Lit la config .mailbox.json du projet courant, récupère les messages non lus
# sur le broker, les injecte dans le contexte de l'agent (additionalContext),
# puis les acquitte (marque "read").
#
# Sans .mailbox.json dans le projet : ne fait rien (silencieux) -> on peut
# l'installer globalement sans gêner les projets non concernés.

$ErrorActionPreference = 'Stop'

# --- Entrée du hook (stdin JSON fourni par Claude Code) -----------------------
$eventName = 'UserPromptSubmit'
try {
    $stdin = [Console]::In.ReadToEnd()
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
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
} catch {
    Write-Error "[mailbox] .mailbox.json illisible : $($_.Exception.Message)"
    exit 0
}
if (-not $cfg.project -or -not $cfg.broker) { exit 0 }

$me     = $cfg.project
$broker = $cfg.broker.TrimEnd('/')
$headers = @{}
if ($cfg.token) { $headers['X-Mailbox-Token'] = $cfg.token }

# Canaux auxquels ce projet est abonné (optionnel) -> passés au broker.
$channelQuery = ""
if ($cfg.channels) {
    $list = @($cfg.channels) -join ','
    if ($list) { $channelQuery = "&channels=$([uri]::EscapeDataString($list))" }
}

# --- Récupération des non-lus -------------------------------------------------
try {
    $resp = Invoke-RestMethod -Uri "$broker/inbox/$me`?status=unread$channelQuery" -Headers $headers -TimeoutSec 4
} catch {
    # Broker injoignable : on n'interrompt pas la session, on signale discrètement.
    $ctx = "[mailbox] Broker injoignable ($broker). Messages inter-agents indisponibles pour l'instant."
    $out = @{ hookSpecificOutput = @{ hookEventName = $eventName; additionalContext = $ctx } }
    $out | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

if (-not $resp.messages -or $resp.messages.Count -eq 0) { exit 0 }  # rien de neuf

# --- Mise en forme du contexte injecté ---------------------------------------
$lines = @()
$lines += "📬 $($resp.messages.Count) message(s) inter-agents pour le projet « $me » :"
$lines += ""
$ids = @()
foreach ($m in $resp.messages) {
    $ids += $m.id
    $subj = if ($m.subject) { " — $($m.subject)" } else { "" }
    $dest = if ($m.to -eq '*') { " (diffusion)" }
            elseif ($m.to -like '#*') { " (canal $($m.to))" }
            else { "" }
    $lines += "─── de [$($m.from)]$dest le $($m.createdAt)$subj"
    $lines += $m.body
    $lines += ""
}
$lines += "Prends ces messages en compte pour t'aligner avec les autres projets. Réponds à un expéditeur avec : /msg <projet> <texte>."
$context = ($lines -join "`n")

# --- Acquittement (marque lu) -------------------------------------------------
try {
    $body = @{ ids = $ids } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$broker/ack" -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 4 | Out-Null
} catch { }  # si l'ack échoue, le message restera non lu -> re-surfacé plus tard (acceptable)

# --- Sortie du hook -----------------------------------------------------------
$out = @{ hookSpecificOutput = @{ hookEventName = $eventName; additionalContext = $context } }
$out | ConvertTo-Json -Depth 5 -Compress
