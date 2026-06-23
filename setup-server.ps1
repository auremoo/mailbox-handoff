# setup-server.ps1 — Installation « facile » du BROKER sur la machine serveur.
#
# Fait tout en une commande :
#   1. vérifie Node.js + installe les dépendances du broker (better-sqlite3)
#   2. détecte l'IP LAN de la machine (à donner aux clients)
#   3. ouvre le port dans le pare-feu Windows  (nécessite un terminal Admin)
#   4. lance le broker — avant-plan, VRAI service Windows (-Service), ou tâche planifiée (-Persist)
#   5. affiche la commande exacte à lancer sur chaque client
#
# Exemples :
#   .\setup-server.ps1                          # port 7777, broker en avant-plan
#   .\setup-server.ps1 -Service -DownloadNssm   # installe un VRAI service Windows (auto-démarrage)
#   .\setup-server.ps1 -RemoveService           # désinstalle le service
#   .\setup-server.ps1 -Port 7777 -Persist      # repli : tâche planifiée à l'ouverture de session
#   .\setup-server.ps1 -Token monjeton          # exige un jeton partagé
#
# Astuce : pour le pare-feu, -Service et -Persist, ouvre PowerShell « en tant qu'administrateur ».
# Le monitoring web est ensuite disponible sur http://<ip>:<port>/

param(
    [int]$Port = 7777,
    [string]$Token = "",
    [switch]$Service,        # installe le broker comme VRAI service Windows (NSSM) : auto-démarrage sans session ouverte
    [switch]$RemoveService,  # désinstalle le service Windows MailboxBroker
    [switch]$DownloadNssm,   # autorise le téléchargement de nssm.exe s'il est absent de vendor/nssm
    [switch]$Persist,        # (repli sans-admin) tâche planifiée qui lance le broker à l'ouverture de session
    [switch]$NoFirewall,     # ne touche pas au pare-feu
    [switch]$NoStart         # n'allume pas le broker maintenant (utile avec -Persist/-Service seul)
)

$ServiceName = 'MailboxBroker'

$ErrorActionPreference = 'Stop'
$srcDir    = $PSScriptRoot
$brokerJs  = Join-Path $srcDir 'broker\server.js'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

# Retourne le chemin de nssm.exe (vendor/nssm/nssm.exe). Le télécharge depuis le
# site officiel si absent ET -DownloadNssm fourni. NSSM sert de wrapper de service :
# Node n'est pas un service Windows natif, NSSM l'enveloppe (arrêt propre, redémarrage auto).
function Get-NssmPath {
    $nssmDir = Join-Path $srcDir 'vendor\nssm'
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
    $nssm = Join-Path $nssmDir 'nssm.exe'
    if (Test-Path $nssm) { return $nssm }
    if (-not $DownloadNssm) {
        Write-Error ("nssm.exe introuvable dans $nssmDir. Relance avec -DownloadNssm pour le " +
            "récupérer automatiquement, ou place-le toi-même (https://nssm.cc/download).")
        return $null
    }
    Write-Host "→ Téléchargement de NSSM (https://nssm.cc)..."
    New-Item -ItemType Directory -Force -Path $nssmDir | Out-Null
    $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
    $tmp = Join-Path $env:TEMP ('nssm-extract-' + [guid]::NewGuid().ToString('N'))
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        Copy-Item (Join-Path $tmp "nssm-2.24\$arch\nssm.exe") $nssm -Force
        Write-Host "✅ nssm.exe installé dans $nssmDir ($arch)."
    } catch {
        Write-Error "Échec du téléchargement de NSSM : $($_.Exception.Message)"
        return $null
    } finally {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $nssm) { return $nssm } else { return $null }
}

Write-Host "=== Installation du broker mailbox ===" -ForegroundColor Cyan

# --- Désinstallation du service (court-circuite tout le reste) ----------------
if ($RemoveService) {
    if (-not (Test-Admin)) { Write-Error "-RemoveService requiert le mode Administrateur."; exit 1 }
    $nssm = Get-NssmPath
    if (-not $nssm) { exit 1 }
    & $nssm stop $ServiceName 2>$null | Out-Null
    & $nssm remove $ServiceName confirm 2>$null | Out-Null
    Write-Host "✅ Service « $ServiceName » désinstallé (s'il existait)."
    exit 0
}

# --- 1. Node.js ---------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Write-Error "Node.js introuvable. Installe-le (https://nodejs.org, LTS) puis relance."
    exit 1
}
Write-Host "✅ Node.js : $(node --version)"
if (-not (Test-Path $brokerJs)) { Write-Error "broker/server.js introuvable dans $srcDir"; exit 1 }

# Dépendances du broker (better-sqlite3) : installées une fois si absentes.
if (-not (Test-Path (Join-Path $srcDir 'node_modules\better-sqlite3'))) {
    Write-Host "→ Installation des dépendances du broker (npm install)..."
    Push-Location $srcDir
    try { npm install --omit=dev | Out-Null; Write-Host "✅ Dépendances installées." }
    catch { Write-Error "npm install a échoué : $($_.Exception.Message)"; Pop-Location; exit 1 }
    Pop-Location
} else {
    Write-Host "✅ Dépendances déjà présentes (node_modules)."
}

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

# --- 4b. Service Windows (NSSM) ----------------------------------------------
if ($Service) {
    if (-not (Test-Admin)) {
        Write-Error "-Service requiert le mode Administrateur (création d'un service Windows)."
        exit 1
    }
    $nssm = Get-NssmPath
    if (-not $nssm) { exit 1 }
    $nodeExe = (Get-Command node).Source

    # Réinstallation propre si le service existe déjà.
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "• Service existant détecté, réinstallation."
        & $nssm stop $ServiceName 2>$null | Out-Null
        & $nssm remove $ServiceName confirm 2>$null | Out-Null
        Start-Sleep -Milliseconds 500
    }

    & $nssm install $ServiceName $nodeExe $brokerJs | Out-Null
    & $nssm set $ServiceName AppDirectory $srcDir | Out-Null
    & $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
    & $nssm set $ServiceName DisplayName "Mailbox Broker (messagerie inter-agents)" | Out-Null
    # Variables d'environnement du service (une chaîne, séparées par des retours ligne).
    $envLines = @("MAILBOX_PORT=$Port")
    if ($Token) { $envLines += "MAILBOX_TOKEN=$Token" }
    & $nssm set $ServiceName AppEnvironmentExtra ($envLines -join "`n") | Out-Null
    # Journalise la sortie du broker dans data\ (pratique pour diagnostiquer).
    $logDir = Join-Path $srcDir 'data'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    & $nssm set $ServiceName AppStdout (Join-Path $logDir 'broker.out.log') | Out-Null
    & $nssm set $ServiceName AppStderr (Join-Path $logDir 'broker.err.log') | Out-Null

    & $nssm start $ServiceName | Out-Null
    Start-Sleep -Milliseconds 800
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    Write-Host "✅ Service « $ServiceName » installé (démarrage automatique). État : $($svc.Status)"
    Write-Host "   Monitoring : $brokerUrl/   |   Arrêt/désinstallation : .\setup-server.ps1 -RemoveService"
    Write-Host "`n   Sur chaque CLIENT, lance :" -ForegroundColor Cyan
    $tokenArgS = if ($Token) { " -Token $Token" } else { "" }
    Write-Host "   .\setup-client.ps1 -Project <nom> -Broker $brokerUrl$tokenArgS -ProjectDir <chemin-du-projet>" -ForegroundColor Cyan
    exit 0
}

# --- 5. Lancement immédiat ----------------------------------------------------
if (-not $NoStart) {
    $env:MAILBOX_PORT = "$Port"
    if ($Token) { $env:MAILBOX_TOKEN = $Token }
    Write-Host "`n🚀 Lancement du broker (Ctrl+C pour arrêter)...`n" -ForegroundColor Green
    Write-Host "   👉 Interface web (tout se pilote ici) : http://localhost:$Port/" -ForegroundColor Cyan
    Write-Host "      (onglet « Serveur » pour installer le service, « Config client » pour brancher les machines)`n"
    # Ouvre la page web dans le navigateur par défaut (l'UI prend le relais).
    try { Start-Process "http://localhost:$Port/" | Out-Null } catch { }
    node $brokerJs
} else {
    Write-Host "`n(broker non démarré : -NoStart)"
    Write-Host "Commande client : .\setup-client.ps1 -Project <nom> -Broker $brokerUrl -ProjectDir <chemin>"
}
