import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ApprovalOutcome = "approved" | "user_denied" | "cancelled" | "timeout" | "headless" | "error";
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
): Promise<ApprovalOutcome> {
  if (signal.aborted) return "cancelled";
  if (!ctx.hasUI) return "headless";
  const timeout = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = AbortSignal.any([signal, timeout.signal]);
  let onAbort: (() => void) | undefined;
  try {
    // confirm() 将 No、Esc、超时都压成 false；原生 select() 能保留明确拒绝。
    // 默认选中拒绝，避免误按回车批准。沿用 Pi 自身的选择器和主题。
    const choice = await Promise.race([
      ctx.ui.select(`${title}\n\n${message}`, ["拒绝本次", "允许本次"], { signal: combined, timeout: timeoutMs }),
      new Promise<undefined>(resolve => {
        onAbort = () => resolve(undefined);
        combined.addEventListener("abort", onAbort, { once: true });
        if (combined.aborted) onAbort();
      }),
    ]);
    if (signal.aborted) return "cancelled";
    if (timeout.signal.aborted || Date.now() >= deadline) return "timeout";
    if (choice === "允许本次") return "approved";
    if (choice === "拒绝本次") return "user_denied";
    return "cancelled";
  } catch {
    if (signal.aborted) return "cancelled";
    if (timeout.signal.aborted || Date.now() >= deadline) return "timeout";
    return "error";
  } finally {
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener("abort", onAbort);
  }
}
