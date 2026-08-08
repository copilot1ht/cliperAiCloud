param(
  [string]$AdminEmail = "admin@cliperaicloud.com",
  [SecureString]$AdminPassword,
  [switch]$Force,
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$cloudRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$examplePath = Join-Path $cloudRoot ".env.example"
$envPath = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $cloudRoot ".env" }
$taskResults = New-Object 'System.Collections.Generic.List[object]'

function Add-TaskResult([string]$Name, [string]$Status, [string]$Detail) {
  $taskResults.Add([PSCustomObject]@{ Task = $Name; Status = $Status; Detail = $Detail })
  Write-Host "[$Status] $Name - $Detail"
}

function Get-CommandVersion([string]$Command, [string[]]$Arguments = @("--version")) {
  $found = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $found) { return $null }
  try {
    $output = (& $Command @Arguments 2>$null | Select-Object -First 1 | Out-String).Trim()
    if ($output) { return $output }
  } catch {}
  return $found.Source
}

function Convert-SecurePassword([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Convert-BytesToHex([byte[]]$Bytes) {
  $toHexString = [Convert].GetMethod("ToHexString", [Type[]]@([byte[]]))
  if ($toHexString) { return [Convert]::ToHexString($Bytes).ToLowerInvariant() }
  return ([BitConverter]::ToString($Bytes)).Replace("-", "").ToLowerInvariant()
}

function New-LocalSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $fill = [Security.Cryptography.RandomNumberGenerator].GetMethod("Fill", [Type[]]@([byte[]]))
  if ($fill) {
    [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  } else {
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) }
    finally { $generator.Dispose() }
  }
  return Convert-BytesToHex $buffer
}

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
  $pattern = "^$([regex]::Escape($Name))="
  $found = $false
  $lines = New-Object 'System.Collections.Generic.List[string]'
  foreach ($line in ($Content -split "`r?`n")) {
    if ($line -match $pattern) {
      $lines.Add("$Name=$Value")
      $found = $true
    } else {
      $lines.Add($line)
    }
  }
  if (-not $found) { $lines.Add("$Name=$Value") }
  return ($lines -join [Environment]::NewLine)
}

function Add-MissingEnvValue([string]$Content, [string]$Name, [string]$Value) {
  if ([regex]::IsMatch($Content, "(?m)^$([regex]::Escape($Name))=")) { return $Content }
  return "$Content$([Environment]::NewLine)$Name=$Value"
}

function Get-EnvValue([string]$Content, [string]$Name) {
  $match = [regex]::Match($Content, "(?m)^$([regex]::Escape($Name))=(.*)$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ""
}

function Test-DatabaseReachable([string]$DatabaseUrl) {
  if (-not $DatabaseUrl) { return $false }
  try {
    $uri = [Uri]$DatabaseUrl
    $port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    $client = New-Object Net.Sockets.TcpClient
    try {
      $result = $client.BeginConnect($uri.Host, $port, $null, $null)
      if (-not $result.AsyncWaitHandle.WaitOne(900)) { return $false }
      $client.EndConnect($result)
      return $true
    } finally {
      $client.Dispose()
    }
  } catch { return $false }
}

Write-Host "[BOOTSTRAP] Cliper AI Cloud local environment"
Write-Host "[BOOTSTRAP] Directory: $cloudRoot"
Write-Host "[BOOTSTRAP] PowerShell $($PSVersionTable.PSVersion) | .NET $([Environment]::Version) | $([Environment]::OSVersion.VersionString) | 64-bit OS: $([Environment]::Is64BitOperatingSystem)"

$nodeVersion = Get-CommandVersion "node"
$pnpmVersion = Get-CommandVersion "pnpm"
$gitVersion = Get-CommandVersion "git"
$opensslVersion = Get-CommandVersion "openssl"
$dockerVersion = Get-CommandVersion "docker"
Add-TaskResult "Node" $(if ($nodeVersion) { "PASS" } else { "FAILED" }) $(if ($nodeVersion) { $nodeVersion } else { "Node.js tidak ditemukan di PATH." })
Add-TaskResult "pnpm" $(if ($pnpmVersion) { "PASS" } else { "FAILED" }) $(if ($pnpmVersion) { $pnpmVersion } else { "pnpm tidak ditemukan di PATH." })
Add-TaskResult "Git" $(if ($gitVersion) { "PASS" } else { "WARNING" }) $(if ($gitVersion) { $gitVersion } else { "Git tidak ditemukan; bootstrap tetap dapat berjalan." })
Add-TaskResult "OpenSSL" $(if ($opensslVersion) { "PASS" } else { "WARNING" }) $(if ($opensslVersion) { $opensslVersion } else { "OpenSSL tidak ditemukan di PATH; image Docker memasangnya sendiri." })

if (-not $nodeVersion -or -not $pnpmVersion) {
  Add-TaskResult "Bootstrap" "FAILED" "Node.js dan pnpm wajib tersedia sebelum membuat environment."
  $taskResults | Format-Table -AutoSize
  exit 1
}

if (-not $dockerVersion) {
  Add-TaskResult "Docker" "WARNING" "Docker Desktop belum ditemukan. Task Docker dan Redis lokal dilewati."
  Add-TaskResult "Redis" "SKIPPED" "Redis lokal tidak diperiksa karena Docker tidak tersedia."
} else {
  try {
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) {
      Add-TaskResult "Docker" "PASS" $dockerVersion
      Add-TaskResult "Redis" "SKIPPED" "Gunakan docker compose untuk menyalakan Redis bila dibutuhkan."
    } else {
      Add-TaskResult "Docker" "WARNING" "Docker Desktop ditemukan tetapi daemon belum berjalan. Task Docker dilewati."
      Add-TaskResult "Redis" "SKIPPED" "Menunggu Docker Desktop berjalan."
    }
  } catch {
    Add-TaskResult "Docker" "WARNING" "Docker Desktop ditemukan tetapi daemon belum berjalan. Task Docker dilewati."
    Add-TaskResult "Redis" "SKIPPED" "Menunggu Docker Desktop berjalan."
  }
}

if (-not (Test-Path $examplePath)) {
  Add-TaskResult "Environment" "FAILED" ".env.example tidak ditemukan di $cloudRoot"
  $taskResults | Format-Table -AutoSize
  exit 1
}

$creatingEnvironment = -not (Test-Path $envPath)
$content = if ($creatingEnvironment) { Get-Content -Raw -LiteralPath $examplePath } else { Get-Content -Raw -LiteralPath $envPath }
Add-TaskResult "Environment" "PASS" $(if ($creatingEnvironment) { "Membuat $envPath dari template." } else { "Menggunakan $envPath tanpa menimpa nilai yang sudah ada." })

$password = $null
try {
  if ($creatingEnvironment -or $Force) {
    if (-not $AdminPassword) {
      $AdminPassword = Read-Host "Password untuk $AdminEmail (minimal 12 karakter)" -AsSecureString
    }
    $password = Convert-SecurePassword $AdminPassword
    if ($password.Length -lt 12) {
      Add-TaskResult "Admin password" "FAILED" "Panjang password $($password.Length); minimum 12 karakter. Jalankan ulang dengan password lebih panjang."
      $taskResults | Format-Table -AutoSize
      exit 1
    }

    $env:ADMIN_PASSWORD = $password
    $hashOutput = (& pnpm --dir $cloudRoot --filter @cliper/api exec tsx src/config/hash-password.ts | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Gagal membuat hash Argon2id untuk admin lokal." }
    $adminHash = [regex]::Match($hashOutput, '\$argon2id\$[^\s]+').Value
    if (-not $adminHash) { throw "Hash Argon2id admin lokal tidak terbentuk." }

    $values = [ordered]@{
      "WEB_ORIGIN" = "http://127.0.0.1:3000"
      "API_PUBLIC_URL" = "http://127.0.0.1:4100"
      "NODE_ENV" = "development"
      "AUTH_STORAGE" = "postgresql"
      "ANALYSIS_BILLING_STORAGE" = "postgres"
      "JWT_SECRET" = New-LocalSecret
      "REFRESH_TOKEN_SECRET" = New-LocalSecret
      "ADMIN_API_KEY" = "local_$(New-LocalSecret 24)"
      "PROVIDER_ENCRYPTION_KEY" = New-LocalSecret
      "LICENSE_KEY_PEPPER" = New-LocalSecret
      "PAYMENT_SANDBOX_WEBHOOK_SECRET" = New-LocalSecret
      "DEV_ADMIN_EMAIL" = $AdminEmail.Trim().ToLowerInvariant()
      "DEV_ADMIN_PASSWORD_HASH" = $adminHash
      "BOOTSTRAP_ADMIN_EMAIL" = ""
      "BOOTSTRAP_ADMIN_PASSWORD_HASH" = ""
    }
    foreach ($entry in $values.GetEnumerator()) {
      $content = Set-EnvValue $content $entry.Key ([string]$entry.Value)
    }
    Add-TaskResult "Secrets" "PASS" "Secret lokal dibuat aman tanpa menampilkan nilainya."
  } else {
    foreach ($name in @("WEB_ORIGIN", "API_PUBLIC_URL", "NODE_ENV", "AUTH_STORAGE", "ANALYSIS_BILLING_STORAGE", "DATABASE_URL", "JWT_SECRET", "REFRESH_TOKEN_SECRET", "PROVIDER_ENCRYPTION_KEY")) {
      $content = Add-MissingEnvValue $content $name ""
    }
    Add-TaskResult "Secrets" "PASS" "Nilai .env yang sudah ada dipertahankan; hanya key yang hilang ditambahkan."
  }
  [IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
} catch {
  Add-TaskResult "Secrets" "FAILED" $_.Exception.Message
} finally {
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $password = $null
}

$databaseUrl = Get-EnvValue $content "DATABASE_URL"
# `prisma.config.ts` reads DATABASE_URL from the child process environment. Set
# it explicitly so -OutputPath is fully testable without creating a root .env.
if ($databaseUrl) { $env:DATABASE_URL = $databaseUrl }
if (Test-DatabaseReachable $databaseUrl) {
  Add-TaskResult "Database" "PASS" "PostgreSQL lokal dapat dijangkau."
} else {
  Add-TaskResult "Database" "WARNING" "PostgreSQL belum dapat dijangkau. Prisma migration akan dilewati."
}

try {
  & pnpm --dir $cloudRoot db:validate
  if ($LASTEXITCODE -ne 0) { throw "Prisma validate gagal." }
  Add-TaskResult "Prisma validate" "PASS" "Schema valid."
  & pnpm --dir $cloudRoot db:generate
  if ($LASTEXITCODE -ne 0) { throw "Prisma generate gagal." }
  Add-TaskResult "Prisma generate" "PASS" "Prisma Client dibuat."
} catch {
  Add-TaskResult "Prisma" "FAILED" $_.Exception.Message
}

if (Test-DatabaseReachable $databaseUrl) {
  try {
    & pnpm --dir $cloudRoot exec prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { throw "Prisma migrate deploy gagal." }
    Add-TaskResult "Prisma migrate" "PASS" "Migration lokal diterapkan."
  } catch {
    Add-TaskResult "Prisma migrate" "FAILED" $_.Exception.Message
  }
} else {
  Add-TaskResult "Prisma migrate" "SKIPPED" "Menunggu PostgreSQL lokal tersedia."
}

Write-Host "[SUMMARY] Bootstrap Diagnostics"
$taskResults | Format-Table -AutoSize
$failed = @($taskResults | Where-Object { $_.Status -eq "FAILED" }).Count
$warnings = @($taskResults | Where-Object { $_.Status -in @("WARNING", "SKIPPED") }).Count
if ($failed -gt 0) {
  Write-Host "[SUMMARY] FAILED - perbaiki task FAILED lalu jalankan ulang."
  exit 1
}
if ($warnings -gt 0) {
  Write-Host "[SUMMARY] SUCCESS WITH WARNINGS - Docker atau database lokal belum siap."
  exit 0
}
Write-Host "[SUMMARY] SUCCESS - local environment siap."
