$ErrorActionPreference = "Stop"
$secretFile = Join-Path $PSScriptRoot ".data\secrets.json"
if (-not (Test-Path -LiteralPath $secretFile)) { throw "Missing .data\secrets.json" }
$secrets = Get-Content -LiteralPath $secretFile -Raw | ConvertFrom-Json

function Unprotect-Text([string]$Cipher) {
  if ([string]::IsNullOrEmpty($Cipher)) { return "" }
  $secure = ConvertTo-SecureString -String $Cipher
  return [System.Net.NetworkCredential]::new("", $secure).Password
}

$env:SIS_USERNAME = $secrets.username
$env:SIS_PASSWORD = Unprotect-Text $secrets.password
$env:WXPUSHER_SPT = Unprotect-Text $secrets.wxpusherSpt
$env:PUSHPLUS_TOKEN = Unprotect-Text $secrets.pushplusToken
$env:SERVERCHAN_SENDKEY = Unprotect-Text $secrets.serverChanSendKey
$env:CHECK_INTERVAL_SECONDS = "120"
$env:HEADLESS = "true"

Set-Location -LiteralPath $PSScriptRoot
& node "webvpn-monitor.mjs" monitor
exit $LASTEXITCODE
