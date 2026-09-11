# 手动构建通知辅助程序并注册当前用户快捷方式，不修改系统通知权限。
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$Compiler = Join-Path $Framework 'csc.exe'
if (-not (Test-Path $Compiler)) { throw '需要 Windows x64 的 .NET Framework 编译器' }
$Output = Join-Path $Root 'bin'
[void](New-Item -ItemType Directory -Path $Output -Force)
$Refs = @('System.Runtime','System.Runtime.WindowsRuntime','System.Runtime.InteropServices.WindowsRuntime','System.ObjectModel','System.Web.Extensions') | ForEach-Object { '/reference:' + (Join-Path $Framework ($_.ToString() + '.dll')) }
$Refs += @('Windows.UI','Windows.Foundation','Windows.Data') | ForEach-Object { '/reference:' + (Join-Path $env:WINDIR ('System32/WinMetadata/' + $_ + '.winmd')) }
$Target = Join-Path $Output 'ApprovalToast.exe'
& $Compiler /nologo /target:exe /platform:x64 ('/out:' + $Target) $Refs (Join-Path $Root 'ApprovalToast.cs')
if ($LASTEXITCODE -ne 0) { throw '通知辅助程序编译失败' }
$Register = [scriptblock]::Create([IO.File]::ReadAllText((Join-Path $Root '../register-wezterm-notifications.ps1')))
& $Register -Executable $Target -AppId 'Pi.CommandAudit' -BackupDirectory (Join-Path $Root '../../data/backups/shortcuts')
Write-Output 'Pi 桌面审批辅助程序已安装。请 /reload 后执行 /command-audit notify-test 验证按钮。'
