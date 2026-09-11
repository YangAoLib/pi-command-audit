using System;
using System.Collections.Generic;
using System.IO;
using System.Security;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

// 每个审批一个有限生命周期进程。凭据仅经匿名管道传入/传出，不经过网络或激活 URL。
// 仅处理仍在运行时的 Toast Activated 事件，不注册可在进程退出后启动命令的协议。
class ApprovalToast {
  [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
  static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
  static readonly object OutputLock = new object();
  static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536 };
  static Dictionary<string, object> input;
  static ManualResetEvent done = new ManualResetEvent(false);
  static string Text(string key) { return Convert.ToString(input[key]); }
  static void Emit(string kind, string action) {
    lock (OutputLock) {
      var value = new Dictionary<string, object>();
      value["kind"] = kind;
      if (action != null) {
        value["action"] = action;
        foreach (string key in new [] { "id", "sessionId", "operationHash", "nonce" }) value[key] = Text(key);
      }
      Console.Out.WriteLine(json.Serialize(value));
      Console.Out.Flush();
    }
  }
  static string Escape(string s) { return SecurityElement.Escape(s); }
  [MTAThread]
  static int Main() {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    ToastNotifier notifier = null;
    ToastNotification toast = null;
    string stage = "input";
    try {
      string line = Console.ReadLine();
      if (line == null || line.Length > 64000) return 2;
      input = json.Deserialize<Dictionary<string, object>>(line);
      long deadline = Convert.ToInt64(input["deadline"]);
      long remaining = deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      if (remaining <= 0 || remaining > 300000) return 2;
      // 应用身份由安装脚本配置为独立的 Pi 通知项，不复用 WezTerm 自身身份。
      stage = "notifier";
      SetCurrentProcessExplicitAppUserModelID("Pi.CommandAudit");
      notifier = ToastNotificationManager.CreateToastNotifier("Pi.CommandAudit");
      // 新注册的未打包应用查询 Setting 可能返回 E_NOTFOUND；以 Show/Failed 为准。
      stage = "xml";
      var xml = new XmlDocument();
      xml.LoadXml("<toast duration=\"long\" launch=\"focus\"><visual><binding template=\"ToastGeneric\"><text>" +
        Escape(Text("title")) + "</text><text>" + Escape(Text("summary")) +
        "</text><text>仅本次；过期无效。完整参数请返回终端查看。</text></binding></visual><actions>" +
        "<action content=\"允许本次\" arguments=\"allow\" activationType=\"foreground\"/>" +
        "<action content=\"拒绝本次\" arguments=\"deny\" activationType=\"foreground\"/>" +
        "<action content=\"返回终端\" arguments=\"focus\" activationType=\"foreground\"/>" +
        "</actions></toast>");
      stage = "toast";
      toast = new ToastNotification(xml);
      toast.Tag = Text("id").Replace("-", "").Substring(0, 16);
      toast.Group = "PiApproval";
      toast.ExpirationTime = DateTimeOffset.FromUnixTimeMilliseconds(deadline);
      stage = "events";
      toast.Activated += (sender, args) => {
        var activated = args as ToastActivatedEventArgs;
        if (activated == null) return;
        string action = activated.Arguments;
        if (action == "allow" || action == "deny" || action == "focus") Emit("action", action);
      };
      toast.Failed += (sender, args) => { Emit("unavailable", null); done.Set(); };
      // 关闭横幅不等于拒绝，等待终端决定/取消/截止时间。父进程关闭 stdin 会立即退出。
      var reader = new Thread(() => { try { Console.ReadLine(); } catch {} finally { done.Set(); } });
      reader.IsBackground = true;
      reader.Start();
      stage = "show";
      notifier.Show(toast);
      Emit("ready", null);
      done.WaitOne((int)remaining);
      return 0;
    } catch (Exception error) {
      // 仅诊断异常类型和 HRESULT，不输出输入、凭据或业务内容。
      Console.Error.WriteLine(stage + " " + error.GetType().Name + " HRESULT=" + error.HResult.ToString("X8"));
      try { Emit("unavailable", null); } catch {}
      return 1;
    } finally {
      try { if (notifier != null && toast != null) notifier.Hide(toast); } catch {}
      try { if (toast != null) ToastNotificationManager.History.Remove(toast.Tag, toast.Group, "Pi.CommandAudit"); } catch {}
    }
  }
}
