param([string]$Python = $env:CAIDAN_PYTHON)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not $Python) {
    $bundled = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
    if (Test-Path '.venv/Scripts/python.exe') { $Python = (Resolve-Path '.venv/Scripts/python.exe').Path }
    elseif (Test-Path -LiteralPath $bundled) { $Python = $bundled }
    else { $Python = (Get-Command python -ErrorAction Stop).Source }
}
& npm.cmd ci --cache .data/npm-cache --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
$env:electron_config_cache = Join-Path (Get-Location) '.data/electron-cache'
& node node_modules/electron/install.js
if ($LASTEXITCODE -ne 0) { throw 'Electron download failed; check network or set ELECTRON_MIRROR to a trusted mirror.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
& $Python -m pip install --target .data/build-tools --cache-dir .data/pip-cache pyinstaller==6.22.3
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller installation failed' }
$env:PYTHONPATH = Join-Path (Get-Location) '.data/build-tools'
$clientDist = (Resolve-Path dist).Path + ':dist'
& $Python -m PyInstaller --noconfirm --onedir --name caidan-server --distpath .data/server-dist --workpath .data/server-build --specpath .data --paths . --add-data $clientDist --exclude-module numpy --exclude-module pandas --exclude-module scipy --exclude-module matplotlib --exclude-module IPython --exclude-module tkinter desktop/server-entry.py
if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
New-Item -ItemType Directory -Force .data/electron-zip | Out-Null
$version = (Get-Content package.json -Raw | ConvertFrom-Json).devDependencies.electron
Get-ChildItem .data/electron-cache -Recurse -Filter "electron-v$version-win32-x64.zip" | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination .data/electron-zip }
& npm.cmd run desktop:package
if ($LASTEXITCODE -ne 0) { throw 'Client packaging failed' }
# Chromium sandbox needs read/execute permission on public application binaries.
& icacls (Join-Path (Get-Location) 'release/Caidan-win32-x64') /grant '*S-1-15-2-1:(OI)(CI)(RX)'
if ($LASTEXITCODE -ne 0) { throw 'Client sandbox runtime permissions could not be set' }
