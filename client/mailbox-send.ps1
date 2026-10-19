# mailbox-send.ps1 — Envoi d'un message à un autre agent (fire-and-forget).
#
# Usage :
#   mailbox-send.ps1 -To frontend -Body "Le contrat /orders a changé, voir schéma."
#   mailbox-send.ps1 -To frontend -Subject "Contrat /orders" -Body "..."
#   mailbox-send.ps1 -To "*" -Body "Le format de date passe en ISO 8601 partout."   # diffusion
#   mailbox-send.ps1 -ReplyTo msg_00042 -Body "Oui, c'est bon pour moi."            # réponse dans le fil
#
# Avec -ReplyTo : le destinataire est déduit (l'expéditeur du message d'origine),
# inutile de fournir -To. Sans -ReplyTo : -To est requis.
#
# Lit .mailbox.json du projet courant pour connaître l'expéditeur et le broker.

param(
    [string]$To,
    [Parameter(Mandatory = $true)][string]$Body,
    [string]$Subject = "",
    [string]$ReplyTo = "",       # id d'un message auquel répondre (rattache au même fil)
    [string]$ThreadId = "",      # id de fil explicite (sans répondre à un message précis)
    [string]$ProjectDir = $(if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path })
)

if (-not $ReplyTo -and -not $To) {
    Write-Error "[mailbox] -To est requis (sauf si -ReplyTo est fourni : le destinataire est alors déduit)."
    exit 1
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # la barre de progression d'Invoke-RestMethod est lente en PS 5.1
try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy } catch { }  # broker LAN : pas de WPAD

# Corps JSON en octets UTF-8 explicites : PowerShell 5.1 n'encode pas toujours
# une chaîne en UTF-8, et les messages contiennent accents et emojis.
function ConvertTo-Utf8Body($Object) {
    [System.Text.Encoding]::UTF8.GetBytes(($Object | ConvertTo-Json -Compress))
}

$configPath = Join-Path $ProjectDir '.mailbox.json'
if (-not (Test-Path $configPath)) {
    Write-Error "[mailbox] Aucun .mailbox.json dans $ProjectDir. Lance d'abord install.ps1 pour rattacher ce projet."
    exit 1
}

$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $cfg.project -or -not $cfg.broker) {
    Write-Error "[mailbox] .mailbox.json incomplet (champs 'project' et 'broker' requis)."
    exit 1
}

$broker  = ([string]$cfg.broker).TrimEnd('/') -replace '://localhost(?=[:/]|$)', '://127.0.0.1'
$headers = @{}
if ($cfg.token) { $headers['X-Mailbox-Token'] = $cfg.token }

# Message d'erreur lisible : le broker renvoie { error } en JSON (ex. destinataire réservé).
function Get-BrokerError($Err) {
    if ($Err.ErrorDetails -and $Err.ErrorDetails.Message) {
        try { return ($Err.ErrorDetails.Message | ConvertFrom-Json).error } catch { return $Err.ErrorDetails.Message }
    }
    return $Err.Exception.Message
}

# Réponse dans un fil : route dédiée /reply (destinataire déduit côté broker).
if ($ReplyTo) {
    $payload = ConvertTo-Utf8Body @{ from = $cfg.project; replyTo = $ReplyTo; subject = $Subject; body = $Body }
    try {
        $resp = Invoke-RestMethod -Uri "$broker/reply" -Method Post -Headers $headers `
            -Body $payload -ContentType 'application/json; charset=utf-8' -TimeoutSec 5
        Write-Host "✅ Réponse envoyée à « $($resp.to) » dans le fil $($resp.threadId) (id $($resp.id))."
    } catch {
        Write-Error "[mailbox] Échec de la réponse vers $broker : $(Get-BrokerError $_)"
        exit 1
    }
    exit 0
}

$msg = @{ from = $cfg.project; to = $To; subject = $Subject; body = $Body }
if ($ThreadId) { $msg['threadId'] = $ThreadId }
$payload = ConvertTo-Utf8Body $msg

try {
    $resp = Invoke-RestMethod -Uri "$broker/messages" -Method Post -Headers $headers `
        -Body $payload -ContentType 'application/json; charset=utf-8' -TimeoutSec 5
    Write-Host "✅ Message envoyé à « $To » (id $($resp.id), fil $($resp.threadId)) depuis « $($cfg.project) »."
} catch {
    Write-Error "[mailbox] Échec de l'envoi vers $broker : $(Get-BrokerError $_)"
    exit 1
}
