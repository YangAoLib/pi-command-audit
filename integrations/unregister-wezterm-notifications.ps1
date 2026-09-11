# 与 register-wezterm-notifications.ps1 配套；只移除脚本生成的当前用户快捷方式。
# 不卸载 WezTerm、不修改通知开关、不删除原有快捷方式或自动恢复历史备份。
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [ValidateSet('org.wezfurlong.wezterm', 'Pi.CommandAudit')]
  [string]$AppId = 'org.wezfurlong.wezterm'
)
$ErrorActionPreference = 'Stop'
$Programs = [Environment]::GetFolderPath('Programs')
$Name = if ($AppId -eq 'Pi.CommandAudit') { 'Pi Command Audit.lnk' } else { 'WezTerm Pi Notifications.lnk' }
$Shortcut = Join-Path $Programs $Name
if (-not (Test-Path -LiteralPath $Shortcut)) {
  Write-Output ('无需卸载，快捷方式不存在：' + $Name)
  return
}
$ExpectedExe = if ($AppId -eq 'Pi.CommandAudit') { 'ApprovalToast.exe' } else { 'wezterm-gui.exe' }
$Shell = New-Object -ComObject Shell.Application
try {
  $Item = $Shell.NameSpace($Programs).ParseName($Name)
  $Identity = $Item.ExtendedProperty('System.AppUserModel.ID')
  $Target = $Item.ExtendedProperty('System.Link.TargetParsingPath')
  if ($Identity -ne $AppId -or [IO.Path]::GetFileName($Target) -ne $ExpectedExe) {
    throw '快捷方式身份或目标与注册脚本不符，拒绝删除，请人工检查'
  }
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Shell) }
if ($PSCmdlet.ShouldProcess($Shortcut, '移除通知身份快捷方式')) {
  Remove-Item -LiteralPath $Shortcut
  Write-Output ('已移除：' + $Name + '；历史 .backup-* 文件仍保留，不自动覆盖恢复。')
}
