import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalReply, ApprovalState } from "./approval-state.ts";
import { safeNotificationText } from "./wezterm-notify.ts";

export function acceptDesktopMessage(state: ApprovalState, value: unknown, focus: () => void): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as ApprovalReply & { kind?: string };
  if (v.kind !== "action" || !state.matches(v)) return false;
  if (v.action === "focus") { focus(); return true; }
  return state.reply(v);
}

/** 仅在用户主动点击后定位固定 pane；不接受通知传来的可执行路径或命令。 */
export function focusSequence(id: string, deadline: number): string {
  if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(deadline)) throw new Error("无效焦点请求");
  const data = Buffer.from(JSON.stringify({ version: 1, id, deadline, requestedAt: Date.now() })).toString("base64");
  return `\x1b]1337;SetUserVar=PI_AUDIT_FOCUS=${data}\x07`;
}

function focusWezterm(executable: string | undefined, pane: string | undefined, state: ApprovalState): void {
  if (!executable || !/^\d+$/.test(pane ?? "")) return;
  const cli = join(dirname(executable), "wezterm.exe");
  if (!existsSync(cli)) return;
  execFile(cli, ["cli", "--no-auto-start", "activate-pane", "--pane-id", pane!],
    { windowsHide: true, timeout: 3000 }, error => {
      // cli 只切换 mux pane，不会恢复或前置原生窗口。由该 pane 的 Lua 事件定位准确的 GUI window。
      if (!error && !state.signal.aborted && process.stdout.isTTY && process.env.TERM_PROGRAM === "WezTerm") {
        try { process.stdout.write(focusSequence(state.snapshot().id, state.deadline)); } catch { /* 不影响审批。 */ }
      }
    });
}

export function startDesktopApproval(state: ApprovalState, title: string, summary: string,
  onUnavailable: () => void): (() => void) | undefined {
  if (process.platform !== "win32") return undefined;
  const executable = fileURLToPath(new URL("./integrations/windows/bin/ApprovalToast.exe", import.meta.url));
  if (!existsSync(executable)) return undefined;
  const wezterm = process.env.WEZTERM_EXECUTABLE;
  const pane = process.env.WEZTERM_PANE;
  // 不让通知子进程继承认证与父审批服务令牌；只传 Windows 启动所需环境。
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env });
  let closed = false;
  let failed = false;
  let ready = false;
  let buffer = "";
  let total = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const startupTimer = setTimeout(() => { if (!ready) fail(); }, 5000);
  function stop() {
    if (closed) return;
    closed = true;
    clearTimeout(startupTimer);
    child.stdin.end();
    killTimer = setTimeout(() => child.kill(), 1000);
    killTimer.unref();
  }
  function fail() {
    if (closed || failed || state.signal.aborted) return;
    failed = true;
    stop();
    onUnavailable();
  }
  child.once("error", () => { fail(); clearTimeout(killTimer); });
  child.stdin.on("error", fail);
  child.once("exit", () => {
    clearTimeout(startupTimer); clearTimeout(killTimer);
    if (!closed && !state.signal.aborted) fail();
    clearTimeout(killTimer);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > 16384) { fail(); return; }
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/^\uFEFF/, ""); buffer = buffer.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.kind === "ready") { ready = true; clearTimeout(startupTimer); }
        else if (value.kind === "unavailable") fail();
        else acceptDesktopMessage(state, value, () => focusWezterm(wezterm, pane, state));
      } catch { fail(); }
    }
  });
  const label = safeNotificationText(`${title} · pane ${pane ?? "?"}`, 100);
  const delivery = { ...state.delivery(), deadline: state.deadline,
    title: label, summary: safeNotificationText(summary, 200) };
  if (!state.signal.aborted) child.stdin.write(JSON.stringify(delivery) + "\n");
  else stop();
  return stop;
}
