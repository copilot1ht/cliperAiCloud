param(
  [Parameter(Mandatory = $true)]
  [string]$SourceCacheDir,
  [string]$OutputRoot = "",
  [double]$StartSeconds = -1,
  [double]$EndSeconds = -1,
  [ValidateSet("720p", "1080p")]
  [string]$Resolution = "720p",
  [switch]$Hook,
  [switch]$CpuSafe,
  [switch]$RequireTwoPersonDirector
)

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopPackage = Get-Content -LiteralPath (Join-Path $desktopRoot "package.json") -Raw | ConvertFrom-Json
$desktopVersion = [string]$desktopPackage.version
$settingsContract = Get-Content -LiteralPath (Join-Path $desktopRoot "worker\settings-contract.json") -Raw | ConvertFrom-Json
$renderMode = if ($CpuSafe) { "cpu-safe" } else { "enhanced" }
$cacheDir = (Resolve-Path $SourceCacheDir).Path
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $desktopRoot "Local Test Builds\Real-Render-$timestamp"
}
$outputRootPath = [IO.Path]::GetFullPath($OutputRoot)
$workingDir = Join-Path $outputRootPath ".working"
$logDir = Join-Path $outputRootPath "logs"
$manifestDir = Join-Path $outputRootPath "manifests"
New-Item -ItemType Directory -Force -Path $outputRootPath, $workingDir, $logDir, $manifestDir | Out-Null

$manifestPath = Join-Path $cacheDir "source-cache.json"
$momentsPath = Join-Path $cacheDir "moments.json"
$transcriptPath = Join-Path $cacheDir "transcript.json"
$profilePath = Join-Path $cacheDir "content_profile.json"

if (-not (Test-Path -LiteralPath $momentsPath)) {
  throw "moments.json tidak ditemukan di $cacheDir"
}

$source = $null
if (Test-Path -LiteralPath $manifestPath) {
  $sourceManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($sourceManifest.source_path -and (Test-Path -LiteralPath $sourceManifest.source_path)) {
    $source = [string]$sourceManifest.source_path
  }
}
if (-not $source) {
  $source = @(
    Get-ChildItem -LiteralPath $cacheDir -File |
      Where-Object { $_.Name -match '^source\.(mp4|mkv|webm|mov)$' } |
      Sort-Object Length -Descending
  )[0].FullName
}
if (-not $source -or -not (Test-Path -LiteralPath $source)) {
  throw "Source video valid tidak ditemukan di $cacheDir"
}

$momentDocument = Get-Content -LiteralPath $momentsPath -Raw | ConvertFrom-Json
# PowerShell can unwrap a single JSON item during an if-expression assignment.
# Always materialize an array so a one-moment cache is valid QA input too.
$moments = @()
if ($momentDocument.PSObject.Properties.Name -contains "moments") {
  $moments = @($momentDocument.moments | Where-Object { $_ })
} elseif ($momentDocument) {
  $moments = @($momentDocument)
}
if (@($moments).Count -eq 0) {
  throw "Cache tidak memiliki kandidat moment."
}

if ($StartSeconds -ge 0 -and $EndSeconds -gt $StartSeconds) {
  $chosen = @(
    $moments |
      Where-Object {
        [double]$_.start -le $StartSeconds -and
        [double]$_.end -ge $EndSeconds
      } |
      Sort-Object { [double]$_.score } -Descending
  )[0]
  if (-not $chosen) {
    $chosen = [pscustomobject]@{
      id = 1
      start = $StartSeconds
      end = $EndSeconds
      duration = $EndSeconds - $StartSeconds
      score = 0
      title = "Real content render validation"
      transcript = ""
      text = ""
    }
  }
} else {
  $chosen = @(
    $moments |
      Where-Object {
        [double]$_.duration -ge 20 -and
        [double]$_.duration -le 90 -and
        ([string]$_.transcript).Trim().Length -ge 40
      } |
      Sort-Object { [double]$_.score } -Descending |
      Select-Object -First 1
  )[0]
}
if (-not $chosen) {
  $chosen = @($moments | Sort-Object { [double]$_.score } -Descending | Select-Object -First 1)[0]
}

$clipStart = if ($StartSeconds -ge 0) { $StartSeconds } else { [double]$chosen.start }
$clipEnd = if ($EndSeconds -gt $clipStart) { $EndSeconds } else { [double]$chosen.end }
$clipDuration = $clipEnd - $clipStart
if ($clipDuration -lt 4) {
  throw "Durasi benchmark terlalu pendek: $clipDuration detik."
}

$segments = @()
if (Test-Path -LiteralPath $transcriptPath) {
  $transcriptDocument = Get-Content -LiteralPath $transcriptPath -Raw | ConvertFrom-Json
  $allSegments = if ($transcriptDocument.segments) {
    @($transcriptDocument.segments)
  } elseif ($transcriptDocument.transcript) {
    @($transcriptDocument.transcript)
  } else {
    @($transcriptDocument)
  }
  $segments = @(
    $allSegments |
      Where-Object {
        [double]$_.end -gt $clipStart -and
        [double]$_.start -lt $clipEnd
      }
  )
}

$profile = $null
if (Test-Path -LiteralPath $profilePath) {
  $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
}

$moment = [ordered]@{
  id = if ($chosen.id) { $chosen.id } else { 1 }
  start = $clipStart
  end = $clipEnd
  duration = $clipDuration
  score = if ($chosen.score) { $chosen.score } else { 0 }
  title = if ($chosen.title) { [string]$chosen.title } else { "Real content render validation" }
  titleSuggestion = if ($chosen.titleSuggestion) { [string]$chosen.titleSuggestion } else { [string]$chosen.title }
  transcript = [string]$chosen.transcript
  text = if ($chosen.text) { [string]$chosen.text } else { [string]$chosen.transcript }
  transcript_segments = $segments
  source_path = $source
  auto_render = $true
  render_eligible = $true
  content_profile = $profile
}

$payload = [ordered]@{
  sourceMode = "local"
  appVersion = $desktopVersion
  localVideoPath = $source
  localVideos = @(@{ path = $source })
  cacheRoot = (Split-Path (Split-Path $cacheDir -Parent) -Parent)
  outputFolder = $outputRootPath
  projectName = "Cliper Real Content QA"
  formatProfile = "9:16 YouTube Shorts"
  resolutionProfile = $Resolution
  fpsProfile = "30 FPS"
  gpuAcceleration = -not $CpuSafe
  smartCrop = $true
  faceTrack = -not $CpuSafe
  dynamicZoom = -not $CpuSafe
  cameraDirector = -not $CpuSafe
  autoCut = -not $CpuSafe
  audioEnhance = $false
  autoVideoEnhancement = -not $CpuSafe
  colorEnhance = -not $CpuSafe
  renderMode = $renderMode
  outputQualityProfile = "balanced"
  addCaptions = $true
  burnSubtitle = $true
  regenerateSubtitlesFromAudio = $true
  subtitleWordHighlight = $true
  subtitleLeadSeconds = 0.08
  subtitlePrimaryColor = "#ffffff"
  subtitleActiveColor = "#19ff47"
  subtitleStrokeColor = "#000000"
  subtitleAnimation = "Scale"
  subtitleFontSize = if ($Resolution -eq "1080p") { 68 } else { 52 }
  captionStyle = "TikTok style"
  addHook = [bool]$Hook
  addTtsHook = $false
  logoOverlay = $false
  addWatermark = $false
  creditText = $false
  providerType = "local"
  aiFeatures = @{
    highlight = $false
    ranking = $false
    caption = $false
    hook = $false
    title = $false
    tts = $false
  }
  featureFlags = $settingsContract.featureFlags
  moments = @($moment)
}

$payloadPath = Join-Path $workingDir "render-payload.json"
$logPath = Join-Path $logDir "render.jsonl"
$payload | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $payloadPath -Encoding utf8
$payload | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $manifestDir "render-payload.json") -Encoding utf8

Write-Host "Benchmark source : $source"
Write-Host "Benchmark range  : $([math]::Round($clipStart, 2)) - $([math]::Round($clipEnd, 2)) ($([math]::Round($clipDuration, 2))s)"
Write-Host "Benchmark title  : $($moment.title)"
Write-Host "Render mode      : $renderMode"

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $lines = @(
    & python (Join-Path $desktopRoot "worker\cliper_worker.py") --mode render --payload $payloadPath 2>&1 |
      Tee-Object -FilePath $logPath
  )
  $workerExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorAction
}

$events = @()
foreach ($line in $lines) {
  try {
    $event = $line.ToString() | ConvertFrom-Json -ErrorAction Stop
    if ($event.type) { $events += $event }
  } catch {}
}
if ($workerExit -ne 0) {
  $lastError = ($events | Where-Object { $_.type -eq "error" } | Select-Object -Last 1).message
  if (-not $lastError) { $lastError = ($lines | Select-Object -Last 15) -join "`n" }
  throw "Render Worker gagal: $lastError"
}

$done = $events | Where-Object { $_.type -eq "done" } | Select-Object -Last 1
if (-not $done -or -not $done.result) {
  throw "Worker tidak mengirim hasil render. Periksa $logPath"
}
$done.result | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $manifestDir "render-result.json") -Encoding utf8

$firstOutput = @($done.result.outputs | Select-Object -First 1)[0]
$videoPath = if ($firstOutput -is [string]) { [string]$firstOutput } else { [string]$firstOutput.video }
if (-not $videoPath -or -not (Test-Path -LiteralPath $videoPath)) {
  throw "Output MP4 tidak ditemukan setelah Worker selesai."
}
if (-not $firstOutput.settingsRequested -or -not $firstOutput.settingsUsed) {
  throw "Manifest render tidak mencatat settingsRequested/settingsUsed."
}
if ($Hook) {
  if (-not [bool]$firstOutput.settingsRequested.addHook -or -not [bool]$firstOutput.settingsUsed.addHook) {
    throw "Hook diminta tetapi tidak tercatat sebagai behavior aktual."
  }
  if ([string]$firstOutput.hookTimeline.mode -ne "freeze_then_source") {
    throw "Hook V2 tidak menggunakan timeline freeze_then_source."
  }
  if ([double]$firstOutput.hookTimeline.sourceOffset -le 0) {
    throw "Hook V2 tidak menggeser source/subtitle timeline."
  }
}
if ([bool]$firstOutput.settingsUsed.addTtsHook) {
  throw "Manifest mengklaim TTS digunakan padahal QA tidak memintanya."
}

if ($RequireTwoPersonDirector) {
  $faceAnalysis = $firstOutput.enhancements.faceAnalysis
  if (-not $faceAnalysis) {
    throw "Quality gate dua pembicara tidak menemukan faceAnalysis di manifest."
  }
  if ([double]$faceAnalysis.average_faces -lt 1.5) {
    throw "Quality gate membutuhkan rata-rata sedikitnya 1.5 wajah terukur; aktual $($faceAnalysis.average_faces)."
  }
  $cameraEvents = @($faceAnalysis.camera_director)
  $cameraSubjects = @(
    $cameraEvents |
      Where-Object { $_.subject_id } |
      Select-Object -ExpandProperty subject_id -Unique
  )
  if ($cameraSubjects.Count -lt 2) {
    throw "Director tidak berpindah di antara sedikitnya dua subjek terukur."
  }
  $directorQa = $faceAnalysis.editor_plan.qa
  if (-not $directorQa -or -not [bool]$directorQa.valid) {
    throw "Editor Director QA tidak valid."
  }
  if ([int]$directorQa.rapidSubjectSwitchCount -gt 0) {
    throw "Director masih memiliki $($directorQa.rapidSubjectSwitchCount) perpindahan subjek terlalu cepat."
  }
  if ([bool]$faceAnalysis.split_screen -and -not [bool]$faceAnalysis.speaker_evidence) {
    throw "Split-screen aktif tanpa bukti speaker yang terverifikasi."
  }
}

$probeText = & ffprobe -v error -show_entries "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate" -of json $videoPath 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "ffprobe gagal: $($probeText -join ' ')"
}
$probeText | Set-Content -LiteralPath (Join-Path $manifestDir "ffprobe.json") -Encoding utf8
$probe = ($probeText -join "`n") | ConvertFrom-Json
$video = @($probe.streams | Where-Object { $_.codec_type -eq "video" })[0]
$audio = @($probe.streams | Where-Object { $_.codec_type -eq "audio" })[0]
if (-not $video -or -not $audio) {
  throw "Output tidak memiliki video dan audio stream lengkap."
}
if ([double]$probe.format.duration -lt [math]::Max(3, $clipDuration - 1.5)) {
  throw "Durasi output lebih pendek dari batas toleransi."
}
$expectedWidth = if ($Resolution -eq "1080p") { 1080 } else { 720 }
$expectedHeight = if ($Resolution -eq "1080p") { 1920 } else { 1280 }
if ([int]$video.width -ne $expectedWidth -or [int]$video.height -ne $expectedHeight) {
  throw "Resolusi output salah: $($video.width)x$($video.height), expected ${expectedWidth}x${expectedHeight}."
}

Write-Host ""
Write-Host "REAL RENDER QA PASS"
Write-Host "Output : $videoPath"
Write-Host "Report : $manifestDir"
