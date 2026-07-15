param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\backups"),
  [int]$RetentionDays = 7
)

$ErrorActionPreference = "Stop"

if (-not $env:DATABASE_URL) {
  throw "DATABASE_URL belum diset. Backup tidak dijalankan."
}

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
  throw "pg_dump tidak ditemukan. Install PostgreSQL client tools terlebih dahulu."
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $resolvedOutput "cliper-cloud-$stamp.dump"

& $pgDump.Source --dbname=$env:DATABASE_URL --format=custom --no-owner --no-privileges --file=$target
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) {
  throw "pg_dump gagal dengan exit code $LASTEXITCODE."
}

$cutoff = (Get-Date).AddDays(-[Math]::Max(1, $RetentionDays))
Get-ChildItem -LiteralPath $resolvedOutput -Filter "cliper-cloud-*.dump" -File |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  Remove-Item -Force

$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Backup: $target"
Write-Output "SHA256: $hash"
