$taskName = "CUHKSZ SIS GEA L09 T23 Monitor"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Scheduled task removed: $taskName"
} else {
  Write-Host "Scheduled task is not installed."
}
