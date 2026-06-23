# install.ps1 — Déploie le client mailbox sur la machine courante et rattache un projet.
#
# À lancer une fois par machine (pour installer les scripts + hooks), puis autant
# de fois que de projets à rattacher (crée le .mailbox.json de chaque projet).
#
# Exemples :
#   # Machine "server" : installe le client + rattache le projet
#   .\install.ps1 -Project server -Broker http://192.168.1.10:7777 -ProjectDir C:\dev\mon-server
#
#   # Machine "frontend" :
#   .\install.ps1 -Project frontend -Broker http://192.168.1.10:7777 -ProjectDir C:\dev\mon-front
#
#   # Avec jeton partagé (si le broker tourne avec MAILBOX_TOKEN défini) :
#   .\install.ps1 -Project automate -Broker http://192.168.1.10:7777 -Token monjeton -ProjectDir C:\dev\auto
#
#   # Réinstaller seulement les scripts/hooks, sans rattacher de projet :
#   .\install.ps1 -SkipProject

param(
    [string]$Project,
    [string]$Broker,
    [string]$Token = "",
    [string[]]$Channels = @(),   # canaux/sujets auxquels ce projet s'abonne (ex: sujet-x, sujet-y)
    [string]$ProjectDir = (Get-Location).Path,
    [switch]$SkipProject
)

# Normalise les canaux : préfixe "#" garanti.
$Channels = @($Channels | ForEach-Object { $_.Trim() } | Where-Object { $_ } |
    ForEach-Object { if ($_.StartsWith('#')) { $_ } else { "#$_" } })

$ErrorActionPreference = 'Stop'
$claudeDir   = Join-Path $env:USERPROFILE '.claude'
$commandsDir = Join-Path $claudeDir 'commands'
$srcDir      = $PSScriptRoot

New-Item -ItemType Directory -Force -Path $claudeDir   | Out-Null
New-Item -ItemType Directory -Force -Path $commandsDir | Out-Null

# --- 1. Copie des scripts client + commande + serveur MCP --------------------
Copy-Item (Join-Path $srcDir 'client\mailbox-check.ps1') (Join-Path $claudeDir 'mailbox-check.ps1') -Force
Copy-Item (Join-Path $srcDir 'client\mailbox-send.ps1')  (Join-Path $claudeDir 'mailbox-send.ps1')  -Force
Copy-Item (Join-Path $srcDir 'commands\msg.md')          (Join-Path $commandsDir 'msg.md')          -Force
$mcpTarget = Join-Path $claudeDir 'mailbox-mcp.js'
Copy-Item (Join-Path $srcDir 'mcp\mailbox-mcp.js')       $mcpTarget                                  -Force
Write-Host "✅ Scripts client + serveur MCP copiés dans $claudeDir"

# --- 2. Branchement des hooks dans settings.json (fusion non destructive) ----
$settingsPath = Join-Path $claudeDir 'settings.json'
if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
} else {
    $settings = [PSCustomObject]@{}
}
if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([PSCustomObject]@{})
}

# Chemin ABSOLU (pas %USERPROFILE%) : le lanceur de hooks de Claude Code n'expanse
# pas toujours les variables d'environnement style cmd -> %USERPROFILE% resterait
# littéral et le hook échouerait silencieusement. On résout le chemin à l'install.
$hookScript = Join-Path $claudeDir 'mailbox-check.ps1'
$hookCommand = "powershell -NoProfile -File `"$hookScript`""

function Add-MailboxHook {
    param($Hooks, [string]$EventName, [string]$Command)
    # Récupère la liste existante pour l'événement (ou crée).
    $existing = @()
    if ($Hooks.PSObject.Properties[$EventName]) {
        $existing = @($Hooks.$EventName)
    }
    # Purge toute entrée mailbox-check.ps1 préexistante (y compris l'ancienne forme
    # %USERPROFILE%) pour éviter les doublons lors d'une mise à jour, puis ré-ajoute
    # la forme canonique (chemin absolu).
    $kept = @()
    foreach ($entry in $existing) {
        $isMailbox = $false
        foreach ($h in @($entry.hooks)) {
            if ($h.command -and $h.command -like '*mailbox-check.ps1*') { $isMailbox = $true }
        }
        if (-not $isMailbox) { $kept += $entry }
    }
    $newEntry = [PSCustomObject]@{
        hooks = @([PSCustomObject]@{ type = 'command'; command = $Command })
    }
    $updated = @($kept) + $newEntry
    if ($Hooks.PSObject.Properties[$EventName]) {
        $Hooks.$EventName = $updated
    } else {
        $Hooks | Add-Member -NotePropertyName $EventName -NotePropertyValue $updated
    }
    Write-Host "   • Hook $EventName ajouté."
    return $Hooks
}

$settings.hooks = Add-MailboxHook -Hooks $settings.hooks -EventName 'SessionStart'     -Command $hookCommand
$settings.hooks = Add-MailboxHook -Hooks $settings.hooks -EventName 'UserPromptSubmit' -Command $hookCommand

$settings | ConvertTo-Json -Depth 10 | Out-File -FilePath $settingsPath -Encoding utf8
Write-Host "✅ Hooks branchés dans $settingsPath"

# --- 3. Rattachement du projet (.mailbox.json) -------------------------------
if ($SkipProject) {
    Write-Host "↪ Étape projet ignorée (-SkipProject)."
    Write-Host "`n🎉 Client mailbox installé."
    exit 0
}

if (-not $Project -or -not $Broker) {
    Write-Error "Pour rattacher un projet, fournis -Project <nom> et -Broker <url>. (ou -SkipProject)"
    exit 1
}

$mailboxConfig = [ordered]@{
    project = $Project
    broker  = $Broker
}
if ($Token) { $mailboxConfig['token'] = $Token }
if ($Channels.Count -gt 0) { $mailboxConfig['channels'] = $Channels }

$configPath = Join-Path $ProjectDir '.mailbox.json'
# -AsArray indispo en PS 5.1 : on garantit un tableau JSON même pour 1 canal.
$mailboxConfig | ConvertTo-Json | Out-File -FilePath $configPath -Encoding utf8
$chanLabel = if ($Channels.Count -gt 0) { ", channels=$($Channels -join ',')" } else { "" }
Write-Host "✅ Projet rattaché : $configPath  (project=$Project, broker=$Broker$chanLabel)"

# --- 3b. Branchement du serveur MCP dans le .mcp.json du projet --------------
# Fusion non destructive : on préserve les autres serveurs MCP existants.
$mcpConfigPath = Join-Path $ProjectDir '.mcp.json'
if (Test-Path $mcpConfigPath) {
    $mcpJson = Get-Content $mcpConfigPath -Raw | ConvertFrom-Json
} else {
    $mcpJson = [PSCustomObject]@{}
}
if (-not $mcpJson.PSObject.Properties['mcpServers']) {
    $mcpJson | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{})
}

$envObj = [ordered]@{ MAILBOX_PROJECT = $Project; MAILBOX_BROKER = $Broker }
if ($Token) { $envObj['MAILBOX_TOKEN'] = $Token }
if ($Channels.Count -gt 0) { $envObj['MAILBOX_CHANNELS'] = ($Channels -join ',') }

$serverEntry = [PSCustomObject]@{
    command = 'node'
    args    = @($mcpTarget)
    env     = [PSCustomObject]$envObj
}
if ($mcpJson.mcpServers.PSObject.Properties['mailbox']) {
    $mcpJson.mcpServers.mailbox = $serverEntry
} else {
    $mcpJson.mcpServers | Add-Member -NotePropertyName mailbox -NotePropertyValue $serverEntry
}
$mcpJson | ConvertTo-Json -Depth 10 | Out-File -FilePath $mcpConfigPath -Encoding utf8
Write-Host "✅ Serveur MCP 'mailbox' branché dans $mcpConfigPath"
Write-Host "   (les tools mailbox_send / mailbox_inbox / mailbox_ack / mailbox_registry seront dispos après reload)"

# --- 4. Enregistrement auprès du broker (best-effort) ------------------------
try {
    $headers = @{}
    if ($Token) { $headers['X-Mailbox-Token'] = $Token }
    $regObj = @{ project = $Project; host = $env:COMPUTERNAME }
    if ($Channels.Count -gt 0) { $regObj['channels'] = $Channels }
    $body = $regObj | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$($Broker.TrimEnd('/'))/register" -Method Post -Headers $headers `
        -Body $body -ContentType 'application/json' -TimeoutSec 4 | Out-Null
    Write-Host "✅ Projet enregistré auprès du broker."
} catch {
    Write-Host "⚠ Broker injoignable pour l'enregistrement (pas bloquant) : $($_.Exception.Message)"
}

Write-Host "`n🎉 Terminé. Pense à AJOUTER .mailbox.json au .gitignore du projet rattaché."
Write-Host "   Teste l'envoi :  powershell -NoProfile -File `"$claudeDir\mailbox-send.ps1`" -To <autre-projet> -Body `"hello`""
