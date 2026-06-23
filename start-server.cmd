@echo off
REM ============================================================================
REM  start-server.cmd  -  Demarre le broker mailbox et ouvre l'interface web.
REM  DOUBLE-CLIQUE ce fichier sur la machine serveur. Tout le reste se pilote
REM  ensuite dans la page web qui s'ouvre (service, config client, monitoring).
REM ============================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
if errorlevel 1 pause
