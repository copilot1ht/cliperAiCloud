param(
  [string]$AdminEmail = "admin@cliperaicloud.com",
  [SecureString]$AdminPassword,
  [switch]$Force,
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$cloudRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$examplePath = Join-Path $cloudRoot ".env.example"
$envPath = if ($OutputPath) {
  [IO.Path]::GetFullPath($OutputPath)
} else {
  Join-Path $cloudRoot ".env"
}

function Convert-SecurePassword([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function New-LocalSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
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

if (-not (Test-Path $examplePath)) {
  throw ".env.example tidak ditemukan di $cloudRoot"
}
if ((Test-Path $envPath) -and -not $Force) {
  throw ".env sudah ada. Gunakan -Force hanya bila Anda benar-benar ingin membuat ulang konfigurasi lokal."
}
if (-not $AdminPassword) {
  $AdminPassword = Read-Host "Password untuk $AdminEmail (minimal 12 karakter)" -AsSecureString
}

$password = Convert-SecurePassword $AdminPassword
try {
  if ($password.Length -lt 12) {
    throw "Password admin lokal minimal 12 karakter."
  }

  $env:ADMIN_PASSWORD = $password
  $hashOutput = (& pnpm --dir $cloudRoot --filter @cliper/api exec tsx src/config/hash-password.ts | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Gagal membuat hash Argon2id untuk admin lokal." }
  $adminHash = [regex]::Match($hashOutput, '\$argon2id\$[^\s]+').Value
  if (-not $adminHash) { throw "Hash Argon2id admin lokal tidak terbentuk." }

  $content = Get-Content -Raw -LiteralPath $examplePath
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
  [IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
} finally {
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $password = $null
}

Write-Host "Environment lokal dibuat: $envPath"
Write-Host "Admin lokal: $AdminEmail"
Write-Host "Selanjutnya jalankan: pnpm db:generate; pnpm exec prisma migrate deploy; pnpm config:check"
