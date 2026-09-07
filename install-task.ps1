$ErrorActionPreference = "Stop"
$taskName = "CUHKSZ SIS GEA L09 T23 Monitor"
$runner = Join-Path $PSScriptRoot "run-monitor.ps1"
$secretFile = Join-Path $PSScriptRoot ".data\secrets.json"
if (-not (Test-Path -LiteralPath $secretFile)) { throw "请先保存加密凭据和微信 token。" }

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Read-only CUHK(SZ) SIS monitor for GEA 2000 L09 + T23." -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Scheduled task installed and started: $taskName"
