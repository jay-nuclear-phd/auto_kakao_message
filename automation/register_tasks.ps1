# 카톡 자동 보고 예약 작업 등록 (현재 사용자, 로그인되어 있을 때만 실행)
#   일~목 16:00 초안 (내일 현황), 월~금 07:00 최종 (오늘 현황)
#   -Test 분 : N분 뒤 초안, N+2분 뒤 최종을 한 번씩 실행하는 시험 작업만 등록
param([int]$Test = 0)
$ErrorActionPreference = 'Stop'
$py = 'C:\Users\staro\AppData\Local\Python\pythoncore-3.14-64\pythonw.exe'
$script = Join-Path $PSScriptRoot 'kakao_report.py'
$folder = '\KakaoReport\'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
# 꺼져 있던 시간은 나중에 몰아서 보내지 않음
$settings.StartWhenAvailable = $false
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

function Reg($name, $kind, $trigger) {
  $action = New-ScheduledTaskAction -Execute $py -Argument "`"$script`" --kind $kind" -WorkingDirectory $PSScriptRoot
  Register-ScheduledTask -TaskPath $folder -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  "registered $folder$name"
}

if ($Test -gt 0) {
  Reg 'Test_Draft' 'draft' (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($Test))
  Reg 'Test_Final' 'final' (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($Test + 2))
} else {
  Reg 'Draft_1600' 'draft' (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday -At '16:00')
  Reg 'Final_0700' 'final' (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At '07:00')
}
