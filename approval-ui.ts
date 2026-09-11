import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beginWeztermApproval, type NotificationOptions } from "./wezterm-notify.ts";
import { createHash } from "node:crypto";
import { createApproval, type ApprovalResult } from "./approval-state.ts";
import { startDesktopApproval } from "./desktop-approval.ts";

export type ApprovalOutcome = ApprovalResult;
export type AuditOutcome = ApprovalOutcome | "allowed" | "denied";
export interface AuditCounters { allowed: number; denied: number; cancelled: number }

export function approvalReason(outcome: ApprovalOutcome): string {
  switch (outcome) {
    case "approved": return "用户已批准本次操作";
    case "user_denied": return "用户已拒绝本次操作，未执行。请勿自动重试或换工具绕过。";
    case "cancelled": return "本次审批已取消，未执行";
    case "timeout": return "等待人工确认超时，未执行";
    case "headless": return "本次操作需要人工确认，但当前会话没有审批界面，未执行";
    case "error": return "审批界面异常，未执行";
  }
}

export function countOutcome(counters: AuditCounters, allowed: boolean, outcome: AuditOutcome): void {
  if (allowed) counters.allowed++;
  else if (outcome === "cancelled" || outcome === "timeout") counters.cancelled++;
  else counters.denied++;
}

export function formatAuditStatus(ctx: ExtensionContext, counters: AuditCounters): string {
  const theme = ctx.ui.theme;
  const item = (label: string, n: number, color: "success" | "error" | "muted") =>
    theme.fg(n === 0 ? "dim" : color, `${label} ${n}`);
  return [theme.fg("muted", "审核"), item("放行", counters.allowed, "success"),
    item("拒绝", counters.denied, "error"), item("取消", counters.cancelled, "muted")].join(theme.fg("dim", " · "));
}

export function notifyBlocked(ctx: ExtensionContext, tool: string, reason: string, outcome: AuditOutcome): void {
  // 用户的正常选择不作为系统告警；策略拒绝和异常仍保留警告级别。
  const normal = ["user_denied", "cancelled", "timeout"].includes(outcome);
  const theme = ctx.ui.theme;
  ctx.ui.notify(`${theme.fg("accent", tool)} ${theme.fg(normal ? "muted" : "warning", reason)}`, normal ? "info" : "warning");
}

export async function requestApproval(
  ctx: ExtensionContext, title: string, message: string, signal: AbortSignal, timeoutMs: number,
  notification: NotificationOptions = { enabled: true },
): Promise<ApprovalOutcome> {
  if (signal.aborted) return "cancelled";
  if (!ctx.hasUI) return "headless";
  const deadline = Date.now() + timeoutMs;
  const operationHash = notification.operationHash ?? createHash("sha256").update(title + "\n" + message).digest("hex");
  const state = createApproval(ctx.sessionManager?.getSessionId?.() ?? "ephemeral", operationHash, deadline, signal);
  let stopDesktop: (() => void) | undefined;
  let stopFallback: (() => void) | undefined;
  let endNotification: (() => void) | undefined;
  const fallback = () => {
    if (state.signal.aborted || stopFallback) return;
    try { ctx.ui.notify("桌面按钮通知不可用，已保留终端审批", "warning"); } catch {}
    stopFallback = beginWeztermApproval(ctx, deadline, notification);
  };
  try {
    if (notification.enabled && ctx.mode === "tui" && process.stdout.isTTY) {
      // 桌面只显示脱敏摘要；通知明确提醒完整操作在终端，批准只作用于当前绑定请求。
      stopDesktop = startDesktopApproval(state, title,
        notification.summary ?? "当前终端等待审批。请先查看终端中的完整操作，再决定是否允许本次。", fallback);
    }
    endNotification = beginWeztermApproval(ctx, deadline, { ...notification, toast: !stopDesktop, approvalId: state.snapshot().id });
    // 桌面和终端共同竞争同一个状态机；完成信号关闭另一端，不产生第二次决定。
    void Promise.resolve().then(() => ctx.ui.select(`${title}\n\n${message}`, ["允许本次", "拒绝本次"],
      { signal: state.signal, timeout: Math.max(1, deadline - Date.now()) })).then(choice => {
        if (state.signal.aborted) return;
        state.settle(choice === "允许本次" ? "approved" : choice === "拒绝本次" ? "user_denied" : "cancelled");
      }, () => { state.settle("error"); });
    return await state.result;
  } finally {
    state.dispose(); stopDesktop?.(); stopFallback?.(); endNotification?.();
  }
}
