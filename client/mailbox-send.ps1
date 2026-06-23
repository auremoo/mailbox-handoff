# mailbox-send.ps1 — Envoi d'un message à un autre agent (fire-and-forget).
#
# Usage :
#   mailbox-send.ps1 -To frontend -Body "Le contrat /orders a changé, voir schéma."
#   mailbox-send.ps1 -To frontend -Subject "Contrat /orders" -Body "..."
#   mailbox-send.ps1 -To "*" -Body "Le format de date passe en ISO 8601 partout."   # diffusion
#
# Lit .mailbox.json du projet courant pour connaître l'expéditeur et le broker.

param(
    [Parameter(Mandatory = $true)][string]$To,
    [Parameter(Mandatory = $true)][string]$Body,
    [string]$Subject = "",
    [string]$ProjectDir = $(if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path })
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $ProjectDir '.mailbox.json'
if (-not (Test-Path $configPath)) {
    Write-Error "[mailbox] Aucun .mailbox.json dans $ProjectDir. Lance d'abord install.ps1 pour rattacher ce projet."
    exit 1
}

$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not $cfg.project -or -not $cfg.broker) {
    Write-Error "[mailbox] .mailbox.json incomplet (champs 'project' et 'broker' requis)."
    exit 1
}

$broker  = $cfg.broker.TrimEnd('/')
$headers = @{}
if ($cfg.token) { $headers['X-Mailbox-Token'] = $cfg.token }

$payload = @{
    from    = $cfg.project
    to      = $To
    subject = $Subject
    body    = $Body
} | ConvertTo-Json -Compress

try {
    $resp = Invoke-RestMethod -Uri "$broker/messages" -Method Post -Headers $headers `
        -Body $payload -ContentType 'application/json; charset=utf-8' -TimeoutSec 5
    Write-Host "✅ Message envoyé à « $To » (id $($resp.id)) depuis « $($cfg.project) »."
} catch {
    Write-Error "[mailbox] Échec de l'envoi vers $broker : $($_.Exception.Message)"
    exit 1
}
