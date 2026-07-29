param(
  [string]$ApiBase = "http://127.0.0.1:4100",
  [string]$Email = "usertest@cliperaicloud.com",
  [string]$Password = "",
  [string]$ApiKey = "",
  [switch]$CreateKey,
  [switch]$RequireAi
)

$ErrorActionPreference = "Stop"
$apiRoot = $ApiBase.TrimEnd("/")
$origin = if ($env:CLIPER_WEB_ORIGIN) { $env:CLIPER_WEB_ORIGIN } else { "http://localhost:3000" }

function Convert-SecurePassword([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Invoke-CloudJson([string]$Method, [string]$Path, [object]$Body, [object]$Session, [hashtable]$ExtraHeaders = @{}) {
  $headers = @{ Origin = $origin }
  foreach ($entry in $ExtraHeaders.GetEnumerator()) { $headers[$entry.Key] = $entry.Value }
  $params = @{
    UseBasicParsing = $true
    Uri = "$apiRoot$Path"
    Method = $Method
    Headers = $headers
    TimeoutSec = 30
  }
  if ($Session) { $params.WebSession = $Session }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }
  return Invoke-RestMethod @params
}

function Get-Sha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-HmacSha256([string]$Secret, [string]$Value) {
  $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
  try { return ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").ToLowerInvariant() }
  finally { $hmac.Dispose() }
}

try {
  $health = Invoke-CloudJson "GET" "/health" $null $null
  if (-not $health.ok) { throw "API health tidak siap." }

  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  if ($CreateKey -or -not $ApiKey) {
    if (-not $Password) {
      if ($env:CLIPER_TEST_PASSWORD) { $Password = $env:CLIPER_TEST_PASSWORD }
      else { $Password = Convert-SecurePassword (Read-Host "Password $Email" -AsSecureString) }
    }
    $login = Invoke-CloudJson "POST" "/api/auth/login" @{ email = $Email; password = $Password } $session
    if (-not $login.user) { throw "Login user gagal." }
    if ($CreateKey) {
      $created = Invoke-CloudJson "POST" "/v1/keys" @{ label = "Local Electron Trial" } $session
      $ApiKey = [string]$created.rawKey
      if (-not $ApiKey) { throw "API key tidak dikembalikan server." }
    }
  }

  if ($ApiKey -notmatch '^clip_sk_[A-Za-z0-9_-]{24,}$') { throw "ApiKey harus berupa Cliper key clip_sk_..." }
  $fingerprint = "local-electron-qa-device-001"
  $verify = Invoke-CloudJson "POST" "/api/auth/verify" @{ key = $ApiKey; deviceFingerprint = $fingerprint; deviceName = "Local QA"; appVersion = "local" } $null
  if (-not $verify.valid) { throw "License verify gagal: $($verify.reason)" }

  $activate = Invoke-CloudJson "POST" "/api/auth/desktop/activate" @{ key = $ApiKey; deviceFingerprint = $fingerprint; deviceName = "Local QA"; appVersion = "local" } $null
  $heartbeatBody = @{}
  $heartbeatJson = ($heartbeatBody | ConvertTo-Json -Compress)
  $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $nonceBytes = New-Object byte[] 18
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($nonceBytes) } finally { $random.Dispose() }
  $nonce = [Convert]::ToBase64String($nonceBytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")
  $contentHash = Get-Sha256 $heartbeatJson
  $signature = Get-HmacSha256 $activate.signingSecret "POST`n/api/auth/desktop/heartbeat`n$timestamp`n$nonce`n$contentHash"
  $heartbeatHeaders = @{
    Authorization = "Bearer $($activate.accessToken)"
    "X-Cliper-Timestamp" = $timestamp
    "X-Cliper-Nonce" = $nonce
    "X-Cliper-Content-SHA256" = $contentHash
    "X-Cliper-Signature" = $signature
  }
  $heartbeat = Invoke-CloudJson "POST" "/api/auth/desktop/heartbeat" $heartbeatBody $null $heartbeatHeaders
  $models = Invoke-CloudJson "GET" "/v1/models" $null $null @{ Authorization = "Bearer $ApiKey" }
  $providerCount = @($models.data | Where-Object { $_.id -ne "auto" }).Count

  $aiStatus = "NOT_RUN"
  if ($RequireAi -or $providerCount -gt 0) {
    $chat = @{
      model = "auto"
      module = "test"
      messages = @(
        @{ role = "system"; content = "Connection check. Reply only with OK." },
        @{ role = "user"; content = "Reply only with: OK" }
      )
      temperature = 0
      max_tokens = 32
      metadata = @{ requestId = "local-smoke-$([Guid]::NewGuid().ToString())"; module = "test" }
    }
    try {
      $response = Invoke-CloudJson "POST" "/v1/chat/completions" $chat $null @{ Authorization = "Bearer $ApiKey" }
      if (-not $response.choices[0].message.content) { throw "AI response kosong." }
      $aiStatus = "PASS ($($response.choices[0].message.content.Trim()))"
    } catch {
      if ($RequireAi) { throw }
      $aiStatus = "BLOCKED ($($_.Exception.Message))"
    }
  }

  [pscustomobject]@{
    health = "PASS"
    license = "PASS ($($verify.plan))"
    desktopActivation = "PASS"
    signedHeartbeat = "PASS ($($heartbeat.status))"
    providerModels = $providerCount
    aiGateway = $aiStatus
    electronEndpoint = "$apiRoot/v1"
    generatedApiKey = if ($CreateKey) { $ApiKey } else { "not generated" }
  } | ConvertTo-Json -Depth 5
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
