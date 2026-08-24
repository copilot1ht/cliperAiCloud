param(
  [switch]$NoElectron,
  [switch]$SkipDatabaseSetup,
  [string]$CloudRoot,
  [switch]$StopLegacy
)

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspaceRoot = Split-Path -Parent $desktopRoot
$canonicalCloudRoot = Join-Path $workspaceRoot "Cliper Ai Cloud"
$legacyCloudRoot = Join-Path $desktopRoot "WEB PRODUCTION SAAS"

if ($CloudRoot) {
  $cloudRoot = (Resolve-Path $CloudRoot).Path
} elseif (Test-Path (Join-Path $canonicalCloudRoot "package.json")) {
  $cloudRoot = $canonicalCloudRoot
} elseif (Test-Path (Join-Path $legacyCloudRoot "package.json")) {
  Write-Warning "Cloud kanonis tidak ditemukan. Memakai worktree legacy sementara: $legacyCloudRoot"
  $cloudRoot = $legacyCloudRoot
} else {
  throw "Cloud workspace tidak ditemukan. Harapkan: $canonicalCloudRoot"
}

$runtimeDir = Join-Path $cloudRoot ".runtime"
$logDir = Join-Path $cloudRoot ".runtime-logs"
$statePath = Join-Path $runtimeDir "local-cloud-processes.json"
$apiUrl = "http://127.0.0.1:4100/health/live"
$webUrl = "http://127.0.0.1:3000"

function Get-Listener([int]$Port) {
  return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Assert-WorkspacePort([int]$Port, [string]$ServiceName) {
  $listener = Get-Listener $Port
  if (-not $listener) { return $null }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  $commandLine = [string]$process.CommandLine
  if ($commandLine -notlike "*$cloudRoot*") {
    throw "Port $Port sedang dipakai $ServiceName dari workspace lain. Hentikan proses lama terlebih dahulu; starter tidak akan mencampur $cloudRoot dengan worktree lain."
  }
  return $listener
}

function Stop-LegacyCloudServices {
  if (-not (Test-Path $legacyCloudRoot)) { return }

  $legacyProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.CommandLine -like "*$legacyCloudRoot*" }

  foreach ($legacyProcess in @($legacyProcesses)) {
    Stop-Process -Id $legacyProcess.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped legacy Cloud process (PID $($legacyProcess.ProcessId))."
  }

  if ($legacyProcesses) {
    Start-Sleep -Milliseconds 500
  }
}

function Get-HttpOk([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Wait-ForHttp([string]$Url, [string]$Name, [int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Get-HttpOk $Url) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name tidak siap pada $Url. Periksa log di $logDir."
}

function Start-ManagedService([string]$Name, [string]$Command, [string]$WorkingDirectory, [string]$LogFile) {
  $commandLine = "$Command 1>> `"$LogFile`" 2>>&1"
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/c", $commandLine) `
    -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
  Write-Host "Starting $Name..."
}

if (-not (Test-Path (Join-Path $cloudRoot "package.json"))) {
  throw "Cloud workspace tidak ditemukan: $cloudRoot"
}
if (-not (Test-Path (Join-Path $cloudRoot ".env"))) {
  throw "Cloud kanonis belum dikonfigurasi. Jalankan `pnpm env:local` dari $cloudRoot terlebih dahulu, lalu tambahkan ulang provider melalui Admin > Providers."
}

if ($StopLegacy) {
  Stop-LegacyCloudServices
}

New-Item -ItemType Directory -Force -Path $runtimeDir, $logDir | Out-Null
$started = @()

$postgres = Get-Listener 5432
if (-not $postgres) {
  throw "PostgreSQL tidak berjalan pada port 5432. Jalankan service PostgreSQL lalu ulangi perintah ini."
}

if (-not $SkipDatabaseSetup) {
  Write-Host "Checking Prisma schema..."
  & pnpm --dir $cloudRoot db:generate
  if ($LASTEXITCODE -ne 0) { throw "Prisma generate gagal." }
  & pnpm --dir $cloudRoot exec prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw "Prisma migration gagal." }
  & pnpm --dir $cloudRoot accounts:sync-bootstrap
  if ($LASTEXITCODE -ne 0) { throw "Sinkronisasi admin lokal gagal." }
  & pnpm --dir $cloudRoot config:check
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Cloud belum AI-ready. Control plane tetap dijalankan agar admin dapat menyimpan ulang provider key."
  }
}

$apiListener = Assert-WorkspacePort 4100 "Cliper Cloud API"
if ($apiListener) {
  if (-not (Get-HttpOk $apiUrl)) {
    throw "Port 4100 dipakai proses lain dan bukan Cliper Cloud API. Hentikan proses tersebut terlebih dahulu."
  }
  Write-Host "Reusing Cliper Cloud API on port 4100."
} else {
  $apiLog = Join-Path $logDir "api.log"
  Start-ManagedService "Cliper Cloud API" "pnpm dev:api" $cloudRoot $apiLog
  Wait-ForHttp $apiUrl "Cliper Cloud API"
  $listener = Get-Listener 4100
  $started += [pscustomobject]@{ name = "api"; pid = $listener.OwningProcess; reused = $false }
}

$ready = Invoke-RestMethod -Uri "http://127.0.0.1:4100/health/ready" -Method Get -TimeoutSec 10
if (-not $ready.ok) {
  Write-Warning "Cliper Cloud API hidup dalam setup mode. Buka Admin > Providers lalu simpan dan uji minimal satu provider."
}

$webListener = Assert-WorkspacePort 3000 "Cliper Cloud web"
if ($webListener) {
  if (-not (Get-HttpOk $webUrl)) {
    throw "Port 3000 dipakai proses lain dan bukan Cliper Cloud web. Hentikan proses tersebut terlebih dahulu."
  }
  Write-Host "Reusing Cliper Cloud web on port 3000."
} else {
  $webLog = Join-Path $logDir "web.log"
  Start-ManagedService "Cliper Cloud web" "pnpm dev:web" $cloudRoot $webLog
  Wait-ForHttp $webUrl "Cliper Cloud web"
  $listener = Get-Listener 3000
  $started += [pscustomobject]@{ name = "web"; pid = $listener.OwningProcess; reused = $false }
}

if (-not $NoElectron) {
  $env:CLIPER_CLOUD_URL = "http://127.0.0.1:4100/v1"
  $electronLog = Join-Path $logDir "electron.log"
  Start-ManagedService "Cliper Studio Electron" "npm run start" $desktopRoot $electronLog
  Start-Sleep -Seconds 2
  $electron = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$desktopRoot*" } | Select-Object -First 1
  if ($electron) {
    $started += [pscustomobject]@{ name = "electron"; pid = $electron.ProcessId; reused = $false }
  }
}

[pscustomobject]@{
  startedAt = (Get-Date).ToString("o")
  desktopRoot = $desktopRoot
  cloudRoot = $cloudRoot
  processes = @($started)
} | ConvertTo-Json -Depth 4 | Set-Content -Path $statePath -Encoding utf8

Write-Host ""
Write-Host "Local Cloud ready"
Write-Host "  Web:      http://127.0.0.1:3000"
Write-Host "  API:      http://127.0.0.1:4100"
Write-Host "  Endpoint: http://127.0.0.1:4100/v1"
Write-Host "  Stop:     npm run stop:local-cloud"
