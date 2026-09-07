$ErrorActionPreference = "Stop"
$secretFile = Join-Path $PSScriptRoot ".data\secrets.json"
$secrets = Get-Content -LiteralPath $secretFile -Raw | ConvertFrom-Json
function Unprotect-Text([string]$Cipher) {
  if ([string]::IsNullOrEmpty($Cipher)) { return "" }
  return [System.Net.NetworkCredential]::new("", (ConvertTo-SecureString -String $Cipher)).Password
}
$env:WXPUSHER_SPT = Unprotect-Text $secrets.wxpusherSpt
$env:PUSHPLUS_TOKEN = Unprotect-Text $secrets.pushplusToken
$env:SERVERCHAN_SENDKEY = Unprotect-Text $secrets.serverChanSendKey
Set-Location -LiteralPath $PSScriptRoot
& node "webvpn-monitor.mjs" test-notify
exit $LASTEXITCODE
