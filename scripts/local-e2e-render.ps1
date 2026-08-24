param(
  [string]$ApiBase = "http://127.0.0.1:4100",
  [string]$Email = "",
  [string]$Password = "",
  [string]$VideoUrl = "https://youtu.be/KBQzVvR4rDA?si=0RqzmpAVabRPdcYT",
  [string]$OutputRoot = "",
  [string]$CacheRoot = "",
  [int]$MinimumAcceptedScore = 70,
  [int]$MinimumManualReviewScore = 60,
  [switch]$AllowManualReviewRender,
  [switch]$KeepTemporaryKey
)

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopPackage = Get-Content -LiteralPath (Join-Path $desktopRoot "package.json") -Raw | ConvertFrom-Json
$desktopVersion = [string]$desktopPackage.version
$apiRoot = $ApiBase.TrimEnd("/")
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $desktopRoot "Local Test Builds\Beta-Stable-$timestamp"
}
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
$logsDir = Join-Path $outputRoot "logs"
$manifestsDir = Join-Path $outputRoot "manifests"
$samplesDir = Join-Path $outputRoot "rendered-samples"
$workingDir = Join-Path $outputRoot ".working"
$cacheRoot = if ($CacheRoot) { [IO.Path]::GetFullPath($CacheRoot) } else { Join-Path $workingDir "source-cache" }
New-Item -ItemType Directory -Force -Path $logsDir, $manifestsDir, $samplesDir, $workingDir, $cacheRoot | Out-Null

if (-not $Email) { $Email = $env:CLIPER_E2E_EMAIL }
if (-not $Password) { $Password = $env:CLIPER_E2E_PASSWORD }
if (-not $Email) { throw "Set CLIPER_E2E_EMAIL or pass -Email for the existing unlimited QA account." }
if (-not $Password) {
  $secure = Read-Host "Password for $Email" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-CloudJson([string]$Method, [string]$Path, [object]$Body, [hashtable]$Headers = @{}) {
  $params = @{
    Method = $Method
    Uri = "$apiRoot$Path"
    Headers = $Headers
    UseBasicParsing = $true
    TimeoutSec = 90
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 30 -Compress)
  }
  return Invoke-RestMethod @params
}

function Invoke-Worker([string]$Mode, [object]$Payload, [string]$Name) {
  $payloadPath = Join-Path $workingDir "$Name-payload.json"
  $logPath = Join-Path $logsDir "$Name.jsonl"
  $Payload | ConvertTo-Json -Depth 30 | Set-Content -Path $payloadPath -Encoding utf8
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    # Tee the JSONL stream while the Worker is running so a long YouTube
    # download/render remains observable from the QA artifact directory.
    $lines = @(& python (Join-Path $desktopRoot "worker\cliper_worker.py") --mode $Mode --payload $payloadPath 2>&1 | Tee-Object -FilePath $logPath)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
    Remove-Item $payloadPath -Force -ErrorAction SilentlyContinue
  }
  $stringLines = @($lines | ForEach-Object { $_.ToString() })
  $stringLines | Set-Content -Path $logPath -Encoding utf8
  $events = @()
  foreach ($line in $stringLines) {
    try {
      $parsed = $line | ConvertFrom-Json -ErrorAction Stop
      if ($parsed.type) { $events += $parsed }
    } catch {}
  }
  if ($exitCode -ne 0) {
    $lastError = ($events | Where-Object { $_.type -eq "error" } | Select-Object -Last 1).message
    if (-not $lastError) { $lastError = ($stringLines | Select-Object -Last 12) -join "`n" }
    throw "Worker $Mode failed: $lastError"
  }
  $done = $events | Where-Object { $_.type -eq "done" } | Select-Object -Last 1
  if (-not $done) { throw "Worker $Mode did not emit a done event. See $logPath" }
  return $done.result
}

function Copy-Artifact([string]$Source, [string]$Destination) {
  if ($Source -and (Test-Path $Source)) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    return $true
  }
  return $false
}

$createdKey = $null
$createdKeyId = ""
$accountHeaders = @{}
$report = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  videoUrl = $VideoUrl
  web = "http://127.0.0.1:3000"
  api = $apiRoot
  cloudEndpoint = "$apiRoot/v1"
  metadata = "FAIL"
  analysis = "FAIL"
  render = "FAIL"
  outputValidation = "FAIL"
  billing = "FAIL"
  temporaryKeyRevoked = $false
  selectionLane = ""
  manualReviewRender = $false
  selectedScore = $null
  selectedReviewer = ""
  samplePath = ""
  blockers = @()
}

try {
  $health = Invoke-CloudJson "GET" "/health/ready" $null
  if (-not $health.ok) { throw "Cloud API is not ready. Check /health/ready before E2E." }
  $login = Invoke-CloudJson "POST" "/api/auth/login" @{ email = $Email; password = $Password }
  if (-not $login.token) { throw "Member login failed." }
  $accountHeaders = @{ Authorization = "Bearer $($login.token)" }
  $createdKey = Invoke-CloudJson "POST" "/v1/keys" @{ label = "Local E2E $timestamp" } $accountHeaders
  if (-not $createdKey.rawKey) { throw "The server did not return a temporary desktop key." }
  $createdKeyId = [string]$createdKey.id
  if (-not $createdKeyId -and $createdKey.key) { $createdKeyId = [string]$createdKey.key.id }
  if (-not $createdKeyId) { throw "The server did not return an ID for the temporary desktop key." }

  $deviceFingerprint = "local-e2e-$([guid]::NewGuid().ToString("N"))"
  $desktopSession = Invoke-CloudJson "POST" "/api/auth/desktop/activate" @{
    key = $createdKey.rawKey
    deviceFingerprint = $deviceFingerprint
    deviceName = "Local E2E QA"
    appVersion = $desktopVersion
  }
  if (-not $desktopSession.accessToken -or -not $desktopSession.signingSecret) {
    throw "Desktop activation failed to produce a signed session."
  }

  $metadataPayload = @{
    sourceMode = "youtube"
    url = $VideoUrl
    metadataOnly = $true
    cacheRoot = $cacheRoot
    outputFolder = $samplesDir
  }
  $metadata = Invoke-Worker "analyze" $metadataPayload "metadata"
  $duration = [double]$metadata.video.duration
  if ($duration -le 0) { throw "Metadata did not return a valid source duration." }
  $report.metadata = "PASS"
  $metadata | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $manifestsDir "metadata.json") -Encoding utf8

  $analysisPayload = @{
    appVersion = $desktopVersion
    sourceMode = "youtube"
    url = $VideoUrl
    cacheRoot = $cacheRoot
    outputFolder = $samplesDir
    projectName = "Cliper Local E2E"
    providerType = "cloud"
    baseUrl = "$apiRoot/v1"
    cloudBaseUrl = "$apiRoot/v1"
    cloudAccessToken = $desktopSession.accessToken
    cloudSigningSecret = $desktopSession.signingSecret
    model = "auto"
    highlightModel = "auto"
    analysisRequestId = "local-e2e-$timestamp"
    videoDuration = $duration
    sourceDuration = $duration
    clipCount = 1
    autoClipCount = $false
    fullAutoMode = $true
    selectionMode = "full"
    minDuration = 25
    targetDuration = 55
    maxDuration = 75
    subtitleLang = "auto"
    maxTokens = 1200
    timeoutMs = 60000
    aiRetry = 2
    maxTokensByModule = @{
      highlight = 1100
      ranking = 1400
      caption = 500
      hook = 360
      title = 420
    }
    timeoutMsByModule = @{
      highlight = 90000
      ranking = 90000
      caption = 60000
      hook = 60000
      title = 60000
    }
    aiRetryByModule = @{
      highlight = 2
      ranking = 2
      caption = 1
      hook = 1
      title = 1
    }
    moduleModels = @{
      highlight = "auto"
      ranking = "auto"
      caption = "auto"
      hook = "auto"
      title = "auto"
    }
    aiRoutingMode = "balanced"
    aiFeatures = @{ highlight = $true; hook = $true; caption = $true; title = $true; tts = $false }
    addCaptions = $true
    burnSubtitle = $true
    regenerateSubtitlesFromAudio = $true
    subtitleWordHighlight = $true
    subtitleLeadSeconds = 0.08
    subtitleFontFamily = "Arial Black"
    subtitleFontSize = 56
    subtitlePrimaryColor = "#ffffff"
    subtitleActiveColor = "#19ff47"
    subtitleStrokeColor = "#000000"
    subtitleShadow = 3
    subtitleAnimation = "Scale"
    captionStyle = "TikTok style"
    addHook = $true
    faceTrack = $true
    dynamicZoom = $true
    autoVideoEnhancement = $true
    outputQualityProfile = "balanced"
    formatProfile = "9:16 YouTube Shorts"
    resolutionProfile = "1080p"
    fpsProfile = "30 FPS"
    gpuAcceleration = $true
    renderAudioBitrate = "160k"
    renderVideoBitrate = "8M"
    renderVideoMaxrate = "10M"
    renderVideoBufsize = "16M"
    writeMetadata = $true
    metadataToggle = $true
    creditText = $false
    addWatermark = $false
    logoOverlay = $false
  }
  $analysis = Invoke-Worker "analyze" $analysisPayload "analysis"
  $analysis | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $manifestsDir "analysis-result.json") -Encoding utf8
  $moments = @()
  $automaticMoments = @(
    $analysis.moments |
      Where-Object {
        $evidenceGate = if ($_.PSObject.Properties.Name -contains "ai_evidence_gate") {
          [bool]$_.ai_evidence_gate
        } else {
          [bool]$_.evidence_gate
        }
        $reviewerScore = if (
          $_.providerScores -and
          $_.providerScores.PSObject.Properties.Name -contains "reviewer"
        ) {
          [double]$_.providerScores.reviewer
        } else {
          0
        }
        [double]($_.score) -ge $MinimumAcceptedScore -and
          $_.auto_render -eq $true -and
          $evidenceGate -and
          [string]$_.reviewer_status -eq "approved" -and
          $reviewerScore -gt 0
      } |
      Sort-Object { [double]$_.score } -Descending |
      Select-Object -First 1
  )
  if ($automaticMoments.Count) {
    $moments = $automaticMoments
    $report.selectionLane = "automatic"
  } elseif ($AllowManualReviewRender) {
    $manualMoments = @(
      $analysis.moments |
        Where-Object {
          $evidenceGate = if ($_.PSObject.Properties.Name -contains "ai_evidence_gate") {
            [bool]$_.ai_evidence_gate
          } else {
            [bool]$_.evidence_gate
          }
          $reviewerStatus = [string]$_.reviewer_status
          $isManual = [bool]$_.manual_review_candidate -or [bool]$_.manualReview -or $_.auto_render -ne $true
          [double]($_.score) -ge $MinimumManualReviewScore -and
            $_.render_eligible -eq $true -and
            $evidenceGate -and
            $isManual -and
          # A local evidence-backed fallback can be selected for an explicit
          # manual-review render even when no cloud reviewer label exists.
          # It must never be reported as an automatic recommendation.
          $reviewerStatus -in @("", "approved", "missing", "unavailable") -and
            $_.rejected -ne $true
        } |
        Sort-Object { [double]$_.score } -Descending |
        Select-Object -First 1
    )
    if ($manualMoments.Count) {
      $moments = $manualMoments
      $report.selectionLane = "manual-review"
      $report.manualReviewRender = $true
    }
  }
  if (-not $moments.Count) {
    $best = @($analysis.moments | Sort-Object { [double]$_.score } -Descending | Select-Object -First 1)[0]
    $bestScore = $best.score
    $bestReview = if ($best.reviewer_status) { [string]$best.reviewer_status } else { "none" }
    $manualHint = if ($AllowManualReviewRender) {
      " or an evidence-backed manual-review candidate score >= $MinimumManualReviewScore"
    } else {
      ". Re-run with -AllowManualReviewRender only to inspect an Optional candidate; this does not certify automatic selection"
    }
    throw "Analysis completed without an automatic candidate score >= $MinimumAcceptedScore$manualHint. Best honest score: $bestScore; reviewer: $bestReview."
  }
  $report.selectedScore = [double]$moments[0].score
  $report.selectedReviewer = [string]$moments[0].reviewer_status
  $report.analysis = "PASS"
  if (-not $analysis.billing) { throw "Analysis completed without a billing settlement result." }
  $report.billing = "PASS"

  $cacheDir = [string]$analysis.video.cache_dir
  Copy-Artifact (Join-Path $cacheDir "content_profile.json") (Join-Path $manifestsDir "content_profile.json") | Out-Null
  Copy-Artifact (Join-Path $cacheDir "moments.json") (Join-Path $manifestsDir "moments.json") | Out-Null
  Copy-Artifact (Join-Path $cacheDir "transcript.json") (Join-Path $manifestsDir "transcript.json") | Out-Null
  Copy-Artifact ([string]$analysis.ai_debug_path) (Join-Path $logsDir "ai-debug-log.json") | Out-Null

  $renderPayload = @{}
  foreach ($entry in $analysisPayload.GetEnumerator()) { $renderPayload[$entry.Key] = $entry.Value }
  $renderPayload.moments = $moments
  $renderPayload.sourceDuration = $duration
  $renderPayload.videoDuration = $duration
  $render = Invoke-Worker "render" $renderPayload "render"
  $render | ConvertTo-Json -Depth 40 | Set-Content (Join-Path $manifestsDir "render-result.json") -Encoding utf8
  $report.render = "PASS"
  $sample = @($render.outputs | Select-Object -First 1)[0]
  $samplePath = if ($sample -is [string]) { [string]$sample } else { [string]$sample.video }
  if (-not $samplePath -or -not (Test-Path -LiteralPath $samplePath)) { throw "Render finished without a valid output path." }

  $ffprobeReport = & ffprobe -v error -show_entries "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate" -of json $samplePath 2>&1
  if ($LASTEXITCODE -ne 0) { throw "ffprobe failed for rendered MP4: $($ffprobeReport -join ' ')" }
  $ffprobeReport | Set-Content (Join-Path $manifestsDir "ffprobe.json") -Encoding utf8
  $probe = ($ffprobeReport -join "`n") | ConvertFrom-Json
  $videoStream = @($probe.streams | Where-Object { $_.codec_type -eq "video" })[0]
  $audioStream = @($probe.streams | Where-Object { $_.codec_type -eq "audio" })[0]
  if (-not $videoStream -or -not $audioStream -or [double]$probe.format.duration -le 0) {
    throw "Rendered MP4 is missing a required video/audio stream or duration."
  }

  $sessionDir = [string]$render.sessionDir
  if (-not $sessionDir -or -not (Test-Path -LiteralPath $sessionDir)) { throw "Render finished without a session directory." }
  if (-not [bool]$sample.enhancements.captions) { throw "Rendered sample did not keep burned captions enabled." }
  $productionQaPath = Join-Path $desktopRoot "scripts\qa-production-check.js"
  $productionQa = @(& node $productionQaPath $sessionDir 2>&1)
  $productionQa | Set-Content (Join-Path $logsDir "production-qa.log") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "Production output QA failed: $($productionQa -join ' ')" }
  $report.outputValidation = "PASS"
  $report.samplePath = $samplePath

  $internal = Join-Path $sessionDir ".cliper-internal"
  Copy-Artifact (Join-Path $internal "render_plan.json") (Join-Path $manifestsDir "render_plan.json") | Out-Null
  $subtitle = Get-ChildItem (Join-Path $sessionDir "Caption") -Filter "*.ass" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($subtitle) { Copy-Artifact $subtitle.FullName (Join-Path $manifestsDir "subtitle.ass") | Out-Null }
} catch {
  $report.blockers += $_.Exception.Message
  throw
} finally {
  if ($createdKeyId -and -not $KeepTemporaryKey -and $accountHeaders.Authorization) {
    try {
      Invoke-CloudJson "POST" "/v1/keys/$createdKeyId/revoke" @{} $accountHeaders | Out-Null
      $report.temporaryKeyRevoked = $true
    } catch {
      $report.blockers += "Temporary key revocation failed: $($_.Exception.Message)"
    }
  }
  $report.completedAt = (Get-Date).ToString("o")
  $lines = @(
    "# Local E2E Render Report",
    "",
    "- Metadata: $($report.metadata)",
    "- Analysis: $($report.analysis)",
    "- Billing settlement: $($report.billing)",
    "- Selection lane: $($report.selectionLane)",
    "- Selected score: $($report.selectedScore)",
    "- Reviewer status: $($report.selectedReviewer)",
    "- Render: $($report.render)",
    "- Output validation: $($report.outputValidation)",
    "- Temporary key revoked: $($report.temporaryKeyRevoked)",
    "- Sample: $($report.samplePath)",
    "",
    "## Blockers"
  )
  if (@($report.blockers).Count) { $lines += @($report.blockers | ForEach-Object { "- $_" }) } else { $lines += "- None" }
  $lines | Set-Content (Join-Path $outputRoot "test-report.md") -Encoding utf8
  $report | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $manifestsDir "test-report.json") -Encoding utf8
  Remove-Item (Join-Path $workingDir "*-payload.json") -Force -ErrorAction SilentlyContinue
}

if ($report.metadata -ne "PASS" -or $report.analysis -ne "PASS" -or $report.render -ne "PASS" -or $report.outputValidation -ne "PASS" -or $report.billing -ne "PASS" -or -not $report.temporaryKeyRevoked) {
  throw "Local E2E acceptance failed. Read $outputRoot\test-report.md"
}

Write-Host "Local E2E acceptance PASS"
Write-Host "Sample: $($report.samplePath)"
Write-Host "Artifacts: $outputRoot"
