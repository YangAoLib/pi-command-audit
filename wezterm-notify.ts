import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { redactText } from "./policy.ts";

export function safeNotificationText(text: string, limit = 160): string {
  return Array.from(redactText(text).replace(/[;\r\n\t]/g, " ")).slice(0, limit).join("");
}
export function stateSequence(id: string, expiresAt: number, pending: boolean): string {
  const state = { version: 1, id, expiresAt, pending };
  return `\x1b]1337;SetUserVar=PI_AUDIT_APPROVAL=${Buffer.from(JSON.stringify(state)).toString("base64")}\x07`;
}
export interface NotificationOptions { enabled: boolean; summary?: string }

/** 输出到 Pi 自身终端，绝不向 pane 粘贴/执行命令。RPC 和后台会话禁止输出 OSC。 */
export function beginWeztermApproval(
  ctx: ExtensionContext, deadline: number, options: NotificationOptions,
  io = { env: process.env, isTTY: process.stdout.isTTY, write: (s: string) => { process.stdout.write(s); } },
): () => void {
  if (!options.enabled || ctx.mode !== "tui" || !io.isTTY || io.env.TERM_PROGRAM !== "WezTerm" || !/^\d+$/.test(io.env.WEZTERM_PANE ?? "")) return () => {};
  const id = randomUUID();
  const project = safeNotificationText(basename(ctx.cwd), 50);
  const pane = io.env.WEZTERM_PANE;
  const title = safeNotificationText(`Pi 等待审批 · ${project} · pane ${pane}`, 100);
  // 默认通知不包含原始命令、模型理由或用户内容，摘要必须由调用方明确选择公开。
  const body = safeNotificationText(options.summary ?? "当前终端需要人工审批，请返回带 [审批] 标记的标签页选择允许或拒绝。通知关闭不代表已批准。");
  try {
    io.write(stateSequence(id, deadline, true));
    io.write(`\x1b]777;notify;${title};${body}\x07`);
  } catch {
    try { ctx.ui.notify("WezTerm 提醒发送失败，请在当前终端完成审批", "warning"); } catch { /* 宿主 UI 不可用时保持通知为尽力而为。 */ }
  }
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    try { io.write(stateSequence(id, 0, false)); } catch { /* 提醒失败不改变审批决定。 */ }
  };
}
