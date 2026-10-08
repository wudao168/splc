@echo off
setlocal
rem Optional: pass the LAN host name so it is accepted, e.g. "启动局域网访问.cmd caidan.lan"
set "CAIDAN_ALLOWED_HOSTS=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Lan
if errorlevel 1 pause
