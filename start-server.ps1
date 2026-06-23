# start-server.ps1 — lanceur « double-clic » du broker (appelé par start-server.cmd).
#
# 1. s'auto-élève en Administrateur (nécessaire pour le pare-feu et pour installer
#    le service Windows ensuite depuis l'interface web) ;
# 2. délègue à setup-server.ps1, qui : installe les dépendances (npm install),
#    ouvre le port au pare-feu, OUVRE LA PAGE WEB, puis lance le broker.
#
# Idée : après ce double-clic, tout se pilote dans la page web (onglet « Serveur »
# pour transformer le broker en service Windows permanent, « Config client » pour
# brancher les machines, « Guide » pour les tutos).

param([int]$Port = 7777, [string]$Token = "")

$here = $PSScriptRoot

# Auto-élévation : si on n'est pas admin, on se relance élevé (fenêtre UAC).
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $PSCommandPath + '"'), '-Port', $Port)
    if ($Token) { $args += @('-Token', $Token) }
    Start-Process powershell -Verb RunAs -ArgumentList $args
    exit
}

# Élevé : on lance l'installeur serveur (il ouvre la page web et démarre le broker).
$setup = Join-Path $here 'setup-server.ps1'
if ($Token) { & $setup -Port $Port -Token $Token } else { & $setup -Port $Port }
