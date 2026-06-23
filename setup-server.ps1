# setup-server.ps1 — Installation « facile » du BROKER sur la machine serveur.
#
# Fait tout en une commande :
#   1. vérifie Node.js
#   2. détecte l'IP LAN de la machine (à donner aux clients)
#   3. ouvre le port dans le pare-feu Windows  (nécessite un terminal Admin)
#   4. lance le broker — en avant-plan, ou en tâche planifiée au démarrage (-Persist)
#   5. affiche la commande exacte à lancer sur chaque client
#
# Exemples :
#   .\setup-server.ps1                       # port 7777, broker en avant-plan
#   .\setup-server.ps1 -Port 7777 -Persist   # + démarrage auto à l'ouverture de session
#   .\setup-server.ps1 -Token monjeton       # exige un jeton partagé
#
# Astuce : pour le pare-feu et -Persist, ouvre PowerShell « en tant qu'administrateur ».

param(
    [int]$Port = 7777,
    [string]$Token = "",
    [switch]$Persist,        # enregistre une tâche planifiée qui lance le broker à l'ouverture de session
    [switch]$NoFirewall,     # ne touche pas au pare-feu
    [switch]$NoStart         # n'allume pas le broker maintenant (utile avec -Persist seul)
)

$ErrorActionPreference = 'Stop'
$srcDir    = $PSScriptRoot
$brokerJs  = Join-Path $srcDir 'broker\server.js'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

Write-Host "=== Installation du broker mailbox ===" -ForegroundColor Cyan

# --- 1. Node.js ---------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Write-Error "Node.js introuvable. Installe-le (https://nodejs.org, LTS) puis relance."
    exit 1
}
Write-Host "✅ Node.js : $(node --version)"
if (-not (Test-Path $brokerJs)) { Write-Error "broker/server.js introuvable dans $srcDir"; exit 1 }

# --- 2. Détection de l'IP LAN -------------------------------------------------
$ip = $null
try {
    $cand = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
            $_.PrefixOrigin -ne 'WellKnown'
        } |
        Sort-Object -Property SkipAsSource, InterfaceMetric |
        Select-Object -First 1
    if ($cand) { $ip = $cand.IPAddress }
} catch { }
if (-not $ip) { $ip = '<IP-de-cette-machine>' }
$brokerUrl = "http://$ip`:$Port"
Write-Host "✅ Adresse du broker pour les clients : $brokerUrl"

# --- 3. Pare-feu --------------------------------------------------------------
if (-not $NoFirewall) {
    if (Test-Admin) {
        $ruleName = "Mailbox Broker $Port"
        $exists = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if (-not $exists) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
            Write-Host "✅ Règle pare-feu ajoutée (TCP $Port entrant)."
        } else {
            Write-Host "• Règle pare-feu déjà présente."
        }
    } else {
        Write-Host "⚠ Pas en mode Administrateur : pare-feu non configuré." -ForegroundColor Yellow
        Write-Host "  Ouvre le port manuellement, ou relance ce script en Admin. Règle équivalente :"
        Write-Host "    New-NetFirewallRule -DisplayName 'Mailbox Broker $Port' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any"
    }
}

# --- 4. Persistance (tâche planifiée au démarrage de session) ----------------
if ($Persist) {
    if (-not (Test-Admin)) {
        Write-Host "⚠ -Persist requiert le mode Administrateur. Étape ignorée." -ForegroundColor Yellow
    } else {
        $taskName = "MailboxBroker"
        $envPrefix = "`$env:MAILBOX_PORT=$Port; "
        if ($Token) { $envPrefix += "`$env:MAILBOX_TOKEN='$Token'; " }
        $psCmd = "$envPrefix node `"$brokerJs`""
        $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -WindowStyle Hidden -Command `"$psCmd`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
            -Settings $settings -Force -RunLevel Highest | Out-Null
        Write-Host "✅ Tâche planifiée « $taskName » créée (broker lancé à chaque ouverture de session)."
    }
}

# --- 5. Lancement immédiat ----------------------------------------------------
if (-not $NoStart) {
    $env:MAILBOX_PORT = "$Port"
    if ($Token) { $env:MAILBOX_TOKEN = $Token }
    Write-Host "`n🚀 Lancement du broker (Ctrl+C pour arrêter)...`n" -ForegroundColor Green
    Write-Host "   Sur chaque CLIENT, lance :" -ForegroundColor Cyan
    $tokenArg = if ($Token) { " -Token $Token" } else { "" }
    Write-Host "   .\setup-client.ps1 -Project <nom> -Broker $brokerUrl$tokenArg -ProjectDir <chemin-du-projet>`n" -ForegroundColor Cyan
    node $brokerJs
} else {
    Write-Host "`n(broker non démarré : -NoStart)"
    Write-Host "Commande client : .\setup-client.ps1 -Project <nom> -Broker $brokerUrl -ProjectDir <chemin>"
}
