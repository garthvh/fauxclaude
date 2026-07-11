# claude-local.ps1 — run Claude Code against your local Ollama via FauxClaude (Windows).
# Starts FauxClaude in the background if it isn't already running, then launches claude.
#
#   .\claude-local.ps1                # interactive session
#   .\claude-local.ps1 -p "fix bug"   # any claude args pass through
#
# Env overrides: SHIM_PORT, OLLAMA_URL, OLLAMA_MODEL, MODEL_MAP, NUM_CTX, MOCK

$ErrorActionPreference = "Stop"
$ShimPort = if ($env:SHIM_PORT) { $env:SHIM_PORT } else { "11435" }
$ShimUrl = "http://127.0.0.1:$ShimPort"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Shim {
    try { Invoke-RestMethod -Uri "$ShimUrl/health" -TimeoutSec 1 | Out-Null; return $true }
    catch { return $false }
}

if (-not (Test-Shim)) {
    Write-Host "[claude-local] starting FauxClaude on :$ShimPort..."
    $env:PORT = $ShimPort
    Start-Process -WindowStyle Hidden -FilePath "node" `
        -ArgumentList "`"$Dir\server.mjs`"" `
        -RedirectStandardOutput "$Dir\shim.log" -RedirectStandardError "$Dir\shim.err.log"
    for ($i = 0; $i -lt 20 -and -not (Test-Shim); $i++) { Start-Sleep -Milliseconds 250 }
}

$OllamaUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL } else { "http://localhost:11434" }
if ($env:MOCK -ne "1") {
    try { Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -TimeoutSec 2 | Out-Null }
    catch { Write-Warning "[claude-local] Ollama doesn't appear to be running (ollama serve)." }
}

Write-Host "[claude-local] dashboard: $ShimUrl/"
# No credential env vars: your claude.ai login rides through to the shim.
Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
$env:ANTHROPIC_BASE_URL = $ShimUrl
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

& claude @args
exit $LASTEXITCODE
