param(
  [string]$ApiBase = "http://127.0.0.1:4100",
  [string]$WebBase = "http://127.0.0.1:3000",
  [string]$AdminEmail = "",
  [string]$AdminPassword = "",
  [string]$MemberEmail = "",
  [string]$MemberPassword = "",
  [switch]$ExerciseUsage
)

$ErrorActionPreference = "Stop"

function New-SignedHeaders(
  [string]$Method,
  [string]$Path,
  [string]$Body,
  [string]$AccessToken,
  [string]$Secret,
  [string]$Nonce = ""
) {
  if (-not $Nonce) {
    $bytes = New-Object byte[] 18
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $Nonce = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }
  $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $contentHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Body)))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  $canonical = [string]::Join([char]10, @($Method.ToUpper(), $Path, $timestamp, $Nonce, $contentHash))
  $hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
  try {
    $signature = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace("-", "").ToLowerInvariant()
  } finally {
    $hmac.Dispose()
  }
  return @{
    Authorization = "Bearer $AccessToken"
    "Content-Type" = "application/json"
    "X-Cliper-Timestamp" = $timestamp
    "X-Cliper-Nonce" = $Nonce
    "X-Cliper-Content-SHA256" = $contentHash
    "X-Cliper-Signature" = $signature
  }
}

$useExistingMember = -not [string]::IsNullOrWhiteSpace($MemberEmail) -and -not [string]::IsNullOrWhiteSpace($MemberPassword)
if ($useExistingMember) {
  $registered = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/login" -ContentType "application/json" -Body (@{
    email = $MemberEmail
    password = $MemberPassword
  } | ConvertTo-Json -Compress)
} else {
  $email = "qa-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())@test.local"
  $password = "QaSecure!2026"
  $registered = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/register" -ContentType "application/json" -Body (@{
    email = $email
    password = $password
    displayName = "QA Member"
  } | ConvertTo-Json -Compress)
}
$memberHeaders = @{ Authorization = "Bearer $($registered.token)" }
$keyRecord = Invoke-RestMethod -Method Post -Uri "$ApiBase/v1/keys" -Headers $memberHeaders -ContentType "application/json" -Body '{"label":"Desktop QA"}'
$device = "qa-device-$([guid]::NewGuid().ToString('N'))"
$session = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/desktop/activate" -ContentType "application/json" -Body (@{
  key = $keyRecord.rawKey
  deviceFingerprint = $device
  deviceName = "QA Workstation"
  appVersion = "1.10.0-beta.3"
} | ConvertTo-Json -Compress)

$oldAccessToken = $session.accessToken
$refreshBody = @{ refreshToken = $session.refreshToken; deviceFingerprint = $device } | ConvertTo-Json -Compress
$session = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/desktop/refresh" -ContentType "application/json" -Body $refreshBody
$oldAccessRejected = $false
try {
  $oldHeaders = New-SignedHeaders "POST" "/api/auth/desktop/heartbeat" '{}' $oldAccessToken $session.signingSecret
  Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/desktop/heartbeat" -Headers $oldHeaders -Body '{}' | Out-Null
} catch {
  $oldAccessRejected = [int]$_.Exception.Response.StatusCode -eq 401
}

$emptyBody = '{}'
$heartbeatHeaders = New-SignedHeaders "POST" "/api/auth/desktop/heartbeat" $emptyBody $session.accessToken $session.signingSecret
$heartbeat = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/desktop/heartbeat" -Headers $heartbeatHeaders -Body $emptyBody

$replayBlocked = $false
try {
  Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/desktop/heartbeat" -Headers $heartbeatHeaders -Body $emptyBody | Out-Null
} catch {
  $replayBlocked = [int]$_.Exception.Response.StatusCode -eq 401
}

$exercisePaidGateway = $ExerciseUsage -or $useExistingMember
$chat = $null
$workerResult = "SKIPPED"
if ($exercisePaidGateway) {
  $chatBody = [ordered]@{
    model = "auto"
    messages = @(
      [ordered]@{ role = "system"; content = "Reply exactly as requested." },
      [ordered]@{ role = "user"; content = "Reply only MOCK_OK" }
    )
    temperature = 0.1
    max_tokens = 40
    metadata = [ordered]@{ module = "test" }
  } | ConvertTo-Json -Compress -Depth 8
  $chatHeaders = New-SignedHeaders "POST" "/v1/chat/completions" $chatBody $session.accessToken $session.signingSecret
  $chat = Invoke-RestMethod -Method Post -Uri "$ApiBase/v1/chat/completions" -Headers $chatHeaders -Body $chatBody
  $env:QA_CLOUD_API_BASE = "$ApiBase/v1"
  $env:QA_CLOUD_ACCESS_TOKEN = $session.accessToken
  $env:QA_CLOUD_SIGNING_SECRET = $session.signingSecret
  try {
    $workerResult = (& python "$PSScriptRoot/qa-cloud-worker.py").Trim()
  } finally {
    Remove-Item Env:QA_CLOUD_API_BASE, Env:QA_CLOUD_ACCESS_TOKEN, Env:QA_CLOUD_SIGNING_SECRET -ErrorAction SilentlyContinue
  }
}
$member = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/member/overview" -Headers $memberHeaders

$adminResult = $null
if ($AdminEmail -and $AdminPassword) {
  $adminLogin = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/login" -ContentType "application/json" -Body (@{
    email = $AdminEmail
    password = $AdminPassword
  } | ConvertTo-Json -Compress)
  $adminHeaders = @{ Authorization = "Bearer $($adminLogin.token)" }
  $health = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/admin/system-health" -Headers $adminHeaders
  $security = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/admin/security" -Headers $adminHeaders
  $adminResult = @{
    healthComponents = $health.components.Count
    replayEvents = $security.eventSummary.replayBlocked
  }
}

$pages = @{}
foreach ($path in @(
  "/admin/overview", "/admin/users", "/admin/providers", "/admin/ai-router",
  "/admin/revenue", "/admin/payments", "/admin/system-health", "/admin/security",
  "/dashboard", "/usage", "/keys"
)) {
  $pages[$path] = (Invoke-WebRequest -Uri "$WebBase$path" -UseBasicParsing).StatusCode
}

$result = [ordered]@{
  accountSession = [bool]$registered.user
  keyFormat = $keyRecord.rawKey.StartsWith("clip_sk_")
  activated = $session.status
  refreshRotated = $oldAccessRejected
  heartbeat = $heartbeat.status
  usageExercise = $exercisePaidGateway
  chatContent = if ($chat) { $chat.choices[0].message.content } else { "SKIPPED" }
  workerContent = $workerResult
  responseSigned = if ($chat) { [bool]$chat.integrity.signature } else { $true }
  replayBlocked = $replayBlocked
  memberRequests = $member.usage.requests
  admin = $adminResult
  pages = $pages
}

if (-not $result.accountSession -or -not $result.keyFormat -or $result.activated -ne "active" -or
    -not $result.refreshRotated -or $result.heartbeat -ne "active" -or -not $result.replayBlocked -or
    ($exercisePaidGateway -and ($result.chatContent -ne "MOCK_OK" -or $result.workerContent -ne "MOCK_OK JOB_OK" -or
      -not $result.responseSigned -or $result.memberRequests -lt 1))) {
  $result | ConvertTo-Json -Depth 6
  throw "Signed desktop session QA gagal."
}

$result | ConvertTo-Json -Depth 6
