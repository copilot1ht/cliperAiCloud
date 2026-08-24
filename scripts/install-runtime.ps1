param(
    [switch]$InstallFFmpeg,
    [switch]$InstallPython,
    [switch]$InstallNode
)

$ErrorActionPreference = "Stop"

Write-Host "Cliper Studio Plus - Runtime Setup" -ForegroundColor Cyan

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = @($machinePath, $userPath) -join ";"
}

function Get-Winget {
    $command = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "WinGet tidak ditemukan. Perbarui App Installer dari Microsoft Store lalu coba lagi."
    }
    return $command.Source
}

function Find-Python {
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notmatch "\\WindowsApps\\python(?:3)?\.exe$") {
        return $command.Source
    }
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        $candidate = & $launcher.Source -3.13 -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $candidate) { return ($candidate | Select-Object -First 1) }
    }
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:ProgramFiles\Python313\python.exe"
    )
    return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

$python = Find-Python
if (-not $python -and $InstallPython) {
    $winget = Get-Winget
    Write-Host "Memasang Python 3.13 x64..." -ForegroundColor Cyan
    & $winget install --id Python.Python.3.13 --exact --scope user --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Instalasi Python gagal dengan kode $LASTEXITCODE." }
    Refresh-ProcessPath
    $python = Find-Python
}
if (-not $python) {
    throw "Python tidak ditemukan. Klik Install otomatis atau pasang Python 3.13 x64."
}

& $python --version
& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Upgrade pip gagal." }
$requirements = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\requirements-runtime.txt"))
if (-not (Test-Path -LiteralPath $requirements)) { throw "requirements-runtime.txt tidak ditemukan." }
& $python -m pip install --user -r $requirements
if ($LASTEXITCODE -ne 0) { throw "Instalasi modul Python gagal." }

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if ((-not $ffmpeg -or -not $ffprobe) -and $InstallFFmpeg) {
    $winget = Get-Winget
    Write-Host "Memasang FFmpeg dan FFprobe..." -ForegroundColor Cyan
    & $winget install --id Gyan.FFmpeg --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Instalasi FFmpeg gagal dengan kode $LASTEXITCODE." }
    Refresh-ProcessPath
    $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
    $ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
} elseif (-not $ffmpeg -or -not $ffprobe) {
    Write-Host "FFmpeg/FFprobe belum ditemukan." -ForegroundColor Yellow
    Write-Host "Jalankan ulang dengan: .\install-runtime.ps1 -InstallFFmpeg"
}
if ($ffmpeg -and $ffprobe) {
    & $ffmpeg.Source -version | Select-Object -First 1
    & $ffprobe.Source -version | Select-Object -First 1
} elseif ($InstallFFmpeg) {
    throw "FFmpeg selesai dipasang tetapi belum dapat ditemukan. Restart Windows lalu jalankan Check ulang."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node -and $InstallNode) {
    $winget = Get-Winget
    Write-Host "Memasang Node.js LTS untuk kompatibilitas YouTube..." -ForegroundColor Cyan
    & $winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Instalasi Node.js gagal dengan kode $LASTEXITCODE." }
    Refresh-ProcessPath
    $node = Get-Command node -ErrorAction SilentlyContinue
}
if ($node) {
    & $node.Source --version
} elseif ($InstallNode) {
    throw "Node.js selesai dipasang tetapi belum dapat ditemukan. Restart Windows lalu jalankan Check ulang."
} else {
    Write-Host "Node.js belum ditemukan. Metadata YouTube tertentu mungkin gagal." -ForegroundColor Yellow
}

& $python -c "import yt_dlp, faster_whisper, cv2, mediapipe; print('Python runtime: OK')"
if ($LASTEXITCODE -ne 0) { throw "Validasi runtime Python gagal." }
Write-Host "Setup selesai. Buka Cliper Studio Plus lalu jalankan Settings > Check ulang." -ForegroundColor Green
