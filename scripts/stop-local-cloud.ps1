param(
  [string]$CloudRoot
)

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspaceRoot = Split-Path -Parent $desktopRoot
$canonicalCloudRoot = Join-Path $workspaceRoot "Cliper Ai Cloud"
$legacyCloudRoot = Join-Path $desktopRoot "WEB PRODUCTION SAAS"

if ($CloudRoot) {
  $cloudRoot = (Resolve-Path $CloudRoot).Path
  $statePath = Join-Path $cloudRoot ".runtime\local-cloud-processes.json"
} else {
  $cloudRoot = $null
  $statePath = $null
  foreach ($candidate in @($canonicalCloudRoot, $legacyCloudRoot)) {
    $candidateState = Join-Path $candidate ".runtime\local-cloud-processes.json"
    if (Test-Path $candidateState) {
      $cloudRoot = $candidate
      $statePath = $candidateState
      break
    }
  }
}

if (-not $statePath -or -not (Test-Path $statePath)) {
  Write-Host "Tidak ada proses Local Cloud yang direkam oleh starter. Service yang dijalankan manual tidak disentuh."
  exit 0
}

$state = Get-Content -Raw $statePath | ConvertFrom-Json
foreach ($entry in @($state.processes)) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.pid)" -ErrorAction SilentlyContinue
  if (-not $process) { continue }
  $commandLine = [string]$process.CommandLine
  if ($commandLine -notlike "*$desktopRoot*" -and $commandLine -notlike "*$cloudRoot*") {
    Write-Warning "Melewati PID $($entry.pid): bukan proses workspace yang direkam."
    continue
  }
  Stop-Process -Id $entry.pid -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped $($entry.name) (PID $($entry.pid))."
}

Remove-Item $statePath -Force -ErrorAction SilentlyContinue
Write-Host "Local Cloud processes recorded by the starter have stopped."
