@echo off
setlocal
set "CAIDAN_DATA=%~dp0.data"
set "CAIDAN_PROFILE=%~dp0.data\desktop-profile"
set "CAIDAN_EXE=%~dp0release-invoice-receipt\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-line-remarks\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-quote-projects\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-auto-dispatch\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-billing-permissions\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-return-defaults\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-purchase-filters\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-purchase-lines\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-order-case-layout\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-delivery-date\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-import-100mb\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-customer-invoice\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-billing-info\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-customer-pagination\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-list-pagination\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-columns\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-scheduled\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-click-fix\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-download-fix\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-lifecycle\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-admin-delete\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-targeted\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-merged\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-login-fix\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-auto\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-remember-login\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoice-sync-fix\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-purchase-selection\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoices-layout\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-invoices\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-attachment-height\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-multi-attachments\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-attachment\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-picker\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-drawers\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-header\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-settings\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release-sync\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" set "CAIDAN_EXE=%~dp0release\Caidan-win32-x64\Caidan.exe"
if not exist "%CAIDAN_EXE%" (
  echo Client has not been built. Run desktop\build.ps1 first.
  pause
  exit /b 1
)
start "" "%CAIDAN_EXE%"




























