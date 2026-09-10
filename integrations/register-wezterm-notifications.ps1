# 为便携版/Scoop WezTerm 补充官方同名 AppUserModelID 快捷方式。
# 仅修改当前用户开始菜单中的独立快捷方式，不更改通知权限和现有快捷方式。
param(
  [string]$Executable = $env:WEZTERM_EXECUTABLE,
  [switch]$TestNotification
)
$ErrorActionPreference = 'Stop'
if (-not $Executable -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw '请使用 -Executable 指定实际 wezterm-gui.exe 路径'
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetFileName($Executable) -ne 'wezterm-gui.exe') { throw '目标必须为 wezterm-gui.exe' }

# 使用 Windows Shell 的标准属性接口设置快捷方式身份。
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace PiWeztermNotification {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink {}
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
    void GetIDList(out IntPtr pidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int command);
    void SetShowCmd(int command);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size=24)]
  struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr value;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }
  public static class Shortcut {
    public static void Create(string executable, string path) {
      object obj = new ShellLink();
      IntPtr text = IntPtr.Zero;
      try {
        var link = (IShellLinkW)obj;
        link.SetPath(executable);
        link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(executable));
        link.SetDescription("WezTerm - Pi approval notifications");
        link.SetIconLocation(executable, 0);
        var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        text = Marshal.StringToCoTaskMemUni("org.wezfurlong.wezterm");
        var value = new PropVariant { vt = 31, value = text };
        var store = (IPropertyStore)obj;
        store.SetValue(ref key, ref value);
        store.Commit();
        ((IPersistFile)obj).Save(path, true);
      } finally {
        if (text != IntPtr.Zero) Marshal.FreeCoTaskMem(text);
        Marshal.FinalReleaseComObject(obj);
      }
    }
  }
}
'@

$Programs = [Environment]::GetFolderPath('Programs')
$Shortcut = Join-Path $Programs 'WezTerm Pi Notifications.lnk'
if (Test-Path -LiteralPath $Shortcut) {
  $Backup = $Shortcut + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff')
  Copy-Item -LiteralPath $Shortcut -Destination $Backup
  Write-Output ('已备份已有通知快捷方式：' + $Backup)
}
[PiWeztermNotification.Shortcut]::Create($Executable, $Shortcut)
$Shell = New-Object -ComObject Shell.Application
try {
  $Item = $Shell.NameSpace($Programs).ParseName([IO.Path]::GetFileName($Shortcut))
  $Id = $Item.ExtendedProperty('System.AppUserModel.ID')
  if ($Id -ne 'org.wezfurlong.wezterm') { throw '快捷方式 AppUserModelID 验证失败' }
  Write-Output ('快捷方式身份验证通过：' + $Id)
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Shell) }

if ($TestNotification) {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
  $Xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $Xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Pi 审批通知测试</text><text>这是一条测试提醒，不运行命令。请确认桌面横幅或通知中心是否出现。</text></binding></visual></toast>')
  $Toast = [Windows.UI.Notifications.ToastNotification]::new($Xml)
  $Toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(1)
  $Notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('org.wezfurlong.wezterm')
  Write-Output ('Windows 通知状态：' + $Notifier.Setting)
  $Notifier.Show($Toast)
  Write-Output '已向 Windows 提交通知。API 成功不代表横幅一定展示，请用户目视确认。'
}
Write-Output ('通知快捷方式：' + $Shortcut)
