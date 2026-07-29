param(
  [string]$ApiBase = "http://127.0.0.1:4100",
  [string]$Email = "",
  [string]$Password = ""
)

$ErrorActionPreference = "Stop"
$apiRoot = $ApiBase.TrimEnd("/")
$origin = if ($env:CLIPER_WEB_ORIGIN) { $env:CLIPER_WEB_ORIGIN } else { "http://localhost:3000" }

function Get-PlainPassword([string]$Provided) {
  if ($Provided) { return $Provided }
  if ($env:CLIPER_TEST_PASSWORD) { return $env:CLIPER_TEST_PASSWORD }
  $secure = Read-Host "Password" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Invoke-CloudJson([string]$Method, [string]$Path, [object]$Body, [object]$Session) {
  $params = @{
    UseBasicParsing = $true
    Uri = "$apiRoot$Path"
    Method = $Method
    Headers = @{ Origin = $origin }
    TimeoutSec = 30
  }
  if ($Session) { $params.WebSession = $Session }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  return Invoke-RestMethod @params
}

try {
  if (-not $Email) { $Email = Read-Host "Email akun uji" }
  if (-not $Email) { throw "Email akun uji wajib diisi." }
  $passwordValue = Get-PlainPassword $Password
  $health = Invoke-CloudJson "GET" "/health/live" $null $null
  if (-not $health.ok) { throw "API lokal belum siap." }

  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-CloudJson "POST" "/api/auth/login" @{ email = $Email; password = $passwordValue } $session
  if (-not $login.user) { throw "Login akun uji gagal." }

  $before = Invoke-CloudJson "GET" "/api/payments" $null $session
  $minimum = [int]$before.topup.minIdr
  if ($before.topup.currency -ne "IDR" -or $minimum -lt 25000 -or [double]$before.topup.minUsd -lt 3) {
    throw "Konfigurasi top-up API tidak sesuai. Minimum US$3 dalam IDR belum aktif."
  }

  # This endpoint only completes the local Sandbox adapter. It never contacts Midtrans.
  $invoice = Invoke-CloudJson "POST" "/api/payments/topups" @{ amountIdr = $minimum } $session
  if ($invoice.provider -ne "sandbox") {
    throw "PAYMENT_PROVIDER bukan sandbox. Tes ini dihentikan agar tidak membuat transaksi Midtrans. Untuk tes QRIS gunakan SB-Mid-* Sandbox key dan lakukan dari UI."
  }
  $first = Invoke-CloudJson "POST" "/api/payments/sandbox/$([uri]::EscapeDataString([string]$invoice.number))/complete" $null $session
  $afterFirst = Invoke-CloudJson "GET" "/api/payments" $null $session
  $settled = @($afterFirst.invoices | Where-Object { $_.number -eq $invoice.number }) | Select-Object -First 1
  if (-not $settled -or $settled.status -ne "paid") { throw "Invoice sandbox tidak menjadi paid." }
  $balanceAfterFirst = [double]$afterFirst.wallet.availableMicro

  $second = Invoke-CloudJson "POST" "/api/payments/sandbox/$([uri]::EscapeDataString([string]$invoice.number))/complete" $null $session
  $afterSecond = Invoke-CloudJson "GET" "/api/payments" $null $session
  if ([double]$afterSecond.wallet.availableMicro -ne $balanceAfterFirst) { throw "Idempotensi gagal: saldo berubah pada callback kedua." }

  [pscustomobject]@{
    health = "PASS"
    authenticatedUser = $login.user.email
    minTopupUsd = [double]$before.topup.minUsd
    minTopupIdr = $minimum
    createdInvoice = $invoice.number
    provider = $invoice.provider
    settlement = if ($first.accepted) { "PASS" } else { "FAIL" }
    duplicateWebhook = if ($second.duplicate -or $second.accepted) { "PASS" } else { "FAIL" }
    idempotency = "PASS"
    creditDeltaMicro = $balanceAfterFirst - [double]$before.wallet.availableMicro
    note = "Sandbox internal only; no Midtrans request and no real funds."
  } | ConvertTo-Json -Depth 4
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
