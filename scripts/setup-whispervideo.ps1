param(
    [string]$InstallDirectory = "$env:LOCALAPPDATA\Cliper Studio Plus\optional\whisperVideo",
    [switch]$Update
)

$ErrorActionPreference = "Stop"
$repository = "https://github.com/showlab/whisperVideo.git"
$target = [System.IO.Path]::GetFullPath($InstallDirectory)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git tidak ditemukan. Install Git for Windows lebih dulu."
}

if (Test-Path -LiteralPath (Join-Path $target ".git")) {
    if ($Update) {
        & git -C $target pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            throw "Update WhisperVideo gagal."
        }
    }
} elseif (Test-Path -LiteralPath $target) {
    throw "Folder target sudah ada tetapi bukan clone Git: $target"
} else {
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    & git clone --depth 1 $repository $target
    if ($LASTEXITCODE -ne 0) {
        throw "Clone WhisperVideo gagal."
    }
}

Write-Host "WhisperVideo tersedia di: $target" -ForegroundColor Green
Write-Host "Gunakan environment Python 3.10/3.11 terpisah dengan CUDA, Torch, WhisperX, Pyannote, dan HF_TOKEN." -ForegroundColor Yellow
Write-Host "Jangan install stack ini ke runtime Python 3.14 utama Cliper." -ForegroundColor Yellow
Write-Host "Setelah inference, ekspor pywork ke speaker_grounding.json memakai:" -ForegroundColor Cyan
Write-Host "python scripts/export-whispervideo-grounding.py --pywork `"<videoFolder>\pywork`" --video `"<videoFolder>\source.mp4`" --output `"<source-cache>\speaker_grounding.json`""
