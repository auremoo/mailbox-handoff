# setup-client.ps1 — Installation « facile » d'un CLIENT (un projet participant).
#
# Wrapper convivial autour de install.ps1 :
#   - demande les infos manquantes (terminal interactif),
#   - vérifie que le broker répond AVANT d'installer,
#   - délègue l'installation (scripts, hooks, /msg, .mailbox.json, .mcp.json).
#
# À lancer sur CHAQUE machine cliente — ET aussi sur la machine serveur si un
# agent Claude y travaille sur un projet (le broker et le client sont indépendants ;
# dans ce cas utilise -Broker http://127.0.0.1:7777).
#
# Exemples :
#   .\setup-client.ps1 -Project frontend -Broker http://192.168.1.10:7777 -ProjectDir C:\dev\front
#   .\setup-client.ps1            # mode interactif : pose les questions

param(
    [string]$Project,
    [string]$Broker,
    [string]$Token = "",
    [string[]]$Channels = @(),   # canaux/sujets auxquels s'abonner (ex: sujet-x, sujet-y)
    [string]$ProjectDir,
    [switch]$NoProbe   # saute la vérification de joignabilité du broker
)

$ErrorActionPreference = 'Stop'
$srcDir = $PSScriptRoot

Write-Host "=== Installation d'un client mailbox ===" -ForegroundColor Cyan

# --- Questions interactives pour les infos manquantes ------------------------
if (-not $Project)    { $Project    = Read-Host "Nom logique de ce projet (ex: server, frontend, automate)" }
if (-not $Broker)     { $Broker     = Read-Host "URL du broker (ex: http://192.168.1.10:7777)" }
if (-not $ProjectDir) {
    $def = (Get-Location).Path
    $ans = Read-Host "Chemin du projet à rattacher [$def]"
    $ProjectDir = if ($ans) { $ans } else { $def }
}
if ($Channels.Count -eq 0) {
    $ansC = Read-Host "Canaux/sujets à suivre, séparés par des virgules (optionnel, ex: sujet-x,sujet-y)"
    if ($ansC) { $Channels = $ansC.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
}

if (-not $Project -or -not $Broker -or -not $ProjectDir) {
    Write-Error "Project, Broker et ProjectDir sont requis."
    exit 1
}
if (-not (Test-Path $ProjectDir)) {
    Write-Error "Le dossier projet n'existe pas : $ProjectDir"
    exit 1
}
$Broker = $Broker.TrimEnd('/')

# --- Vérification que le broker répond ---------------------------------------
if (-not $NoProbe) {
    Write-Host "→ Test de joignabilité du broker ($Broker/health)..."
    try {
        $headers = @{}
        if ($Token) { $headers['X-Mailbox-Token'] = $Token }
        $h = Invoke-RestMethod -Uri "$Broker/health" -Headers $headers -TimeoutSec 5
        if ($h.ok) { Write-Host "✅ Broker joignable (service: $($h.service))." }
        else { Write-Host "⚠ Réponse inattendue du broker." -ForegroundColor Yellow }
    } catch {
        Write-Host "⚠ Broker injoignable : $($_.Exception.Message)" -ForegroundColor Yellow
        $go = Read-Host "Continuer quand même l'installation ? (o/N)"
        if ($go -notmatch '^(o|y)') { Write-Host "Abandon."; exit 1 }
    }
}

# --- Délégation à install.ps1 -------------------------------------------------
$installer = Join-Path $srcDir 'install.ps1'
$params = @{ Project = $Project; Broker = $Broker; ProjectDir = $ProjectDir }
if ($Token) { $params['Token'] = $Token }
if ($Channels.Count -gt 0) { $params['Channels'] = $Channels }
& $installer @params

Write-Host "`n✅ Client « $Project » prêt." -ForegroundColor Green
Write-Host "   Recharge la session Claude Code de ce projet pour activer les hooks et les tools MCP."
