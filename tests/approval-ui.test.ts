import { test } from "node:test";
import assert from "node:assert/strict";
import { requestApproval, countOutcome, formatAuditStatus, approvalReason } from "../approval-ui.ts";

function context(select: (...args: any[]) => Promise<string | undefined>, hasUI = true) {
  return { hasUI, ui: { select, theme: { fg: (color: string, text: string) => `[${color}]${text}` } } } as any;
}
for (const [choice, outcome] of [["允许本次", "approved"], ["拒绝本次", "user_denied"], [undefined, "cancelled"]] as const) {
  test(`原生选择器保留结果：${outcome}`, async () => {
    const ctx = context(async (_title, options) => { assert.deepEqual(options, ["允许本次", "拒绝本次"]); return choice; });
    assert.equal(await requestApproval(ctx, "审核", "测试操作", new AbortController().signal, 1000), outcome);
  });
}
test("无界面、异常、取消分别识别", async () => {
  const signal = new AbortController();
  assert.equal(await requestApproval(context(async () => undefined, false), "", "", signal.signal, 1000), "headless");
  assert.equal(await requestApproval(context(async () => { throw new Error(); }), "", "", signal.signal, 1000), "error");
  signal.abort();
  assert.equal(await requestApproval(context(async () => "允许本次"), "", "", signal.signal, 1000), "cancelled");
});
test("不响应的界面也有审批超时，不误报手动拒绝", async () => {
  assert.equal(await requestApproval(context(() => new Promise(() => {})), "", "", new AbortController().signal, 20), "timeout");
});
test("审批期间取消不能被迟到的允许覆盖", async () => {
  const controller = new AbortController();
  const pending = requestApproval(context(async () => { controller.abort(); return "允许本次"; }), "", "", controller.signal, 1000);
  assert.equal(await pending, "cancelled");
});
test("最终统计使用 Pi 主题语义色，不将手动拒绝计为确认", () => {
  const counters = { allowed: 0, denied: 0, cancelled: 0 };
  countOutcome(counters, true, "approved");
  countOutcome(counters, false, "user_denied");
  countOutcome(counters, false, "timeout");
  const status = formatAuditStatus(context(async () => undefined), counters);
  assert.match(status, /\[success\]放行 1/);
  assert.match(status, /\[error\]拒绝 1/);
  assert.match(status, /\[muted\]取消 1/);
  assert.match(approvalReason("user_denied"), /用户已拒绝/);
});
