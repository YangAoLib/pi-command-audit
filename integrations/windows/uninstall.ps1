# 先关闭 Pi 和待审批窗口，再卸载通知辅助程序；不修改系统通知权限。
$ErrorActionPreference = 'Stop'
$Unregister = [scriptblock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot '../unregister-wezterm-notifications.ps1')))
& $Unregister -AppId 'Pi.CommandAudit'
$Binary = Join-Path $PSScriptRoot 'bin/ApprovalToast.exe'
if (Test-Path -LiteralPath $Binary) { Remove-Item -LiteralPath $Binary }
Write-Output '已移除桌面按钮辅助程序与独立快捷方式；Pi /reload 后仍可使用原生终端审批和 WezTerm 提醒。'
