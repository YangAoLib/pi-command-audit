import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type ApprovalResult = "approved" | "user_denied" | "cancelled" | "timeout" | "headless" | "error";
export interface ApprovalBinding { id: string; sessionId: string; operationHash: string; nonce: string }
export interface ApprovalReply extends ApprovalBinding { action: "allow" | "deny" | "focus" }

/** 每次审批独立存活，没有可跨请求复用的批准缓存。只向可信通知子进程交付 binding。 */
export function createApproval(sessionId: string, operationHash: string, deadline: number, parent?: AbortSignal) {
  if (!sessionId || !/^[a-f0-9]{64}$/.test(operationHash) || !Number.isFinite(deadline)) throw new Error("无效审批绑定");
  const binding: ApprovalBinding = { id: randomUUID(), sessionId, operationHash, nonce: randomBytes(32).toString("hex") };
  const controller = new AbortController();
  let outcome: ApprovalResult | undefined;
  let resolve!: (value: ApprovalResult) => void;
  const result = new Promise<ApprovalResult>(r => { resolve = r; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  function settle(value: ApprovalResult): boolean {
    if (outcome) return false;
    // 即使事件循环延迟、定时器尚未触发，截止时间和父取消仍优先。
    outcome = parent?.aborted ? "cancelled" : Date.now() >= deadline ? "timeout" : value;
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    resolve(outcome);
    controller.abort();
    return outcome === value;
  }
  function cancel() { settle("cancelled"); }
  function matches(reply: ApprovalBinding): boolean {
    if (outcome) return false;
    if (parent?.aborted || Date.now() >= deadline) { settle("timeout"); return false; }
    if (!reply || reply.id !== binding.id || reply.sessionId !== sessionId || reply.operationHash !== operationHash ||
        typeof reply.nonce !== "string" || !/^[a-f0-9]{64}$/.test(reply.nonce)) return false;
    return timingSafeEqual(Buffer.from(reply.nonce), Buffer.from(binding.nonce));
  }
  parent?.addEventListener("abort", cancel, { once: true });
  const remaining = deadline - Date.now();
  if (parent?.aborted) cancel();
  else if (remaining <= 0) settle("timeout");
  else timer = setTimeout(() => settle("timeout"), Math.min(remaining, 2147483647));
  return {
    result, signal: controller.signal, deadline,
    snapshot: () => ({ id: binding.id, sessionId, operationHash, deadline, outcome: outcome ?? "pending" }),
    // 随机凭据不进入通知文本、命令行参数、环境变量或公共快照。
    delivery: (): ApprovalBinding => ({ ...binding }),
    matches,
    reply(reply: ApprovalReply): boolean {
      if (!matches(reply) || !["allow", "deny"].includes(reply.action)) return false;
      return settle(reply.action === "allow" ? "approved" : "user_denied");
    },
    settle,
    dispose: cancel,
  };
}
export type ApprovalState = ReturnType<typeof createApproval>;
