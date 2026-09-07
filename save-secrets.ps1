param(
  [Parameter(Mandatory=$true)][string]$Username,
  [Parameter(Mandatory=$true)][string]$Password,
  [string]$WxPusherSpt = "",
  [string]$PushPlusToken = "",
  [string]$ServerChanSendKey = ""
)

$ErrorActionPreference = "Stop"
$dataDir = Join-Path $PSScriptRoot ".data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Protect-Text([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return "" }
  return ConvertTo-SecureString -String $Text -AsPlainText -Force | ConvertFrom-SecureString
}

$secrets = [ordered]@{
  username = $Username
  password = Protect-Text $Password
  wxpusherSpt = Protect-Text $WxPusherSpt
  pushplusToken = Protect-Text $PushPlusToken
  serverChanSendKey = Protect-Text $ServerChanSendKey
}
$secrets | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataDir "secrets.json") -Encoding UTF8
Write-Host "Secrets saved with Windows DPAPI for the current user."
