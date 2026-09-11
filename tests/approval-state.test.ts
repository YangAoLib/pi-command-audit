import { test } from "node:test";
import assert from "node:assert/strict";
import { createApproval } from "../approval-state.ts";
import { acceptDesktopMessage, focusSequence } from "../desktop-approval.ts";
import { readFileSync } from "node:fs";
const hash = "a".repeat(64);
const create = (signal?: AbortSignal, ms = 2000) => createApproval("session-a", hash, Date.now() + ms, signal);

test("首个有效决定胜出，拒绝后的桌面允许无效", async () => {
  const state = create(); const binding = state.delivery();
  assert.equal(state.reply({ ...binding, action: "deny" }), true);
  assert.equal(state.reply({ ...binding, action: "allow" }), false);
  assert.equal(await state.result, "user_denied"); assert.equal(state.signal.aborted, true);
});
test("绑定 ID、会话、操作哈希、随机凭据，错误请求不消耗真正请求", async () => {
  const state = create(); const binding = state.delivery();
  for (const patch of [{ id: "wrong" }, { sessionId: "wrong" }, { operationHash: "b".repeat(64) }, { nonce: "0".repeat(64) }]) {
    assert.equal(state.reply({ ...binding, ...patch, action: "allow" }), false);
  }
  assert.equal(state.reply({ ...binding, action: "allow" }), true);
  assert.equal(await state.result, "approved");
});
test("过期检查不依赖定时器是否已经执行", async () => {
  const state = create(undefined, -1);
  assert.equal(state.reply({ ...state.delivery(), action: "allow" }), false);
  assert.equal(await state.result, "timeout");
});
test("取消、dispose 和迟到的回调均不能批准", async () => {
  for (const dispose of [true, false]) {
    const controller = new AbortController(); const state = create(controller.signal);
    if (dispose) state.dispose(); else controller.abort();
    assert.equal(state.reply({ ...state.delivery(), action: "allow" }), false);
    assert.equal(await state.result, "cancelled");
  }
});
test("自动到期完成等待，公共快照无凭据，多请求互相隔离", async () => {
  const a = create(undefined, 20), b = create();
  assert.ok(!JSON.stringify(a.snapshot()).includes(a.delivery().nonce));
  assert.equal(b.reply({ ...a.delivery(), action: "deny" }), false);
  assert.equal(await a.result, "timeout");
  assert.equal(b.reply({ ...b.delivery(), action: "allow" }), true);
  assert.equal(await b.result, "approved");
});
test("返回终端只触发 focus，不改变批准状态；关闭后不再 focus", async () => {
  const state = create(); let focused = 0;
  const message = { kind: "action", ...state.delivery(), action: "focus" };
  assert.equal(acceptDesktopMessage(state, message, () => focused++), true);
  assert.equal(state.snapshot().outcome, "pending"); assert.equal(focused, 1);
  assert.equal(acceptDesktopMessage(state, { ...message, action: "allow" }, () => focused++), true);
  assert.equal(await state.result, "approved");
  assert.equal(acceptDesktopMessage(state, message, () => focused++), false); assert.equal(focused, 1);
});
test("桌面允许按钮在拒绝之前，焦点消息不包含审批凭据", () => {
  const source = readFileSync(new URL("../integrations/windows/ApprovalToast.cs", import.meta.url), "utf8");
  assert.ok(source.indexOf('arguments=\\"allow\\"') < source.indexOf('arguments=\\"deny\\"'));
  const state = create();
  const sequence = focusSequence(state.snapshot().id, state.deadline);
  assert.ok(!sequence.includes(state.delivery().nonce));
  assert.throws(() => focusSequence("injection\\n", state.deadline));
  state.dispose();
});
test("未知桌面事件和任意命令都不能执行", () => {
  const state = create();
  assert.equal(acceptDesktopMessage(state, { kind: "execute", command: "anything" }, () => assert.fail()), false);
  assert.equal(acceptDesktopMessage(state, { kind: "action", ...state.delivery(), action: "execute" }, () => assert.fail()), false);
  state.dispose();
});
