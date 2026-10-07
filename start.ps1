param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$bundledPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (Test-Path -LiteralPath '.venv/Scripts/python.exe') {
    $pythonExe = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
} elseif (Test-Path -LiteralPath $bundledPython) {
    $pythonExe = $bundledPython
} else {
    $pythonExe = (Get-Command python -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath 'dist/index.html')) {
    if (-not (Test-Path -LiteralPath 'node_modules')) {
        & npm.cmd ci --cache .data/npm-cache --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
}
& $pythonExe -c 'import openpyxl, pypdf, reportlab'
if ($LASTEXITCODE -ne 0) { throw 'Install Python dependencies with: python -m pip install -r requirements.txt' }
Write-Host "Open http://127.0.0.1:$Port in your browser. Press Ctrl+C to stop."
& $pythonExe -m server.app --port $Port
