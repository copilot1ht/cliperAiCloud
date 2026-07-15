param(
    [switch]$InstallFFmpeg
)

$ErrorActionPreference = "Stop"

Write-Host "Cliper Studio Plus - Runtime Setup" -ForegroundColor Cyan

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw "Python tidak ditemukan. Install Python x64 lalu aktifkan PATH."
}

& $python.Source --version
& $python.Source -m pip install --upgrade pip
& $python.Source -m pip install --user -r (Join-Path $PSScriptRoot "..\requirements-runtime.txt")

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if ((-not $ffmpeg -or -not $ffprobe) -and $InstallFFmpeg) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "WinGet tidak ditemukan. Install FFmpeg manual dan tambahkan folder bin ke PATH."
    }
    & $winget.Source install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements
    Write-Host "FFmpeg dipasang. Tutup terminal dan buka kembali agar PATH diperbarui." -ForegroundColor Yellow
} elseif (-not $ffmpeg -or -not $ffprobe) {
    Write-Host "FFmpeg/FFprobe belum ditemukan." -ForegroundColor Yellow
    Write-Host "Jalankan ulang dengan: .\install-runtime.ps1 -InstallFFmpeg"
} else {
    & $ffmpeg.Source -version | Select-Object -First 1
    & $ffprobe.Source -version | Select-Object -First 1
}

& $python.Source -c "import yt_dlp, faster_whisper, cv2, mediapipe; print('Python runtime: OK')"
Write-Host "Setup selesai. Buka Cliper Studio Plus lalu jalankan Settings > Check ulang." -ForegroundColor Green
