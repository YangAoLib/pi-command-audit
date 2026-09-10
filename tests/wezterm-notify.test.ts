import { test } from "node:test";
import assert from "node:assert/strict";
import { beginWeztermApproval, safeNotificationText } from "../wezterm-notify.ts";
const context = (mode = "tui") => ({ mode, cwd: "/project/demo", ui: { notify() {} } }) as any;
function io() { const writes: string[] = []; return { writes, isTTY: true, env: { TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "12" }, write(s: string) { writes.push(s); } }; }
test("每次审批仅发送一次 Toast，结束清除相同请求的 pane 状态", () => {
  const stream = io();
  const finish = beginWeztermApproval(context(), 10000, { enabled: true }, stream);
  finish(); finish();
  assert.equal(stream.writes.length, 3);
  assert.ok(stream.writes[1].startsWith("\x1b]777;notify;"));
  const state = (s: string) => JSON.parse(Buffer.from(s.split("PI_AUDIT_APPROVAL=")[1].slice(0, -1), "base64").toString());
  assert.equal(state(stream.writes[0]).id, state(stream.writes[2]).id);
  assert.equal(state(stream.writes[2]).pending, false);
});
test("非 WezTerm、无 TTY、RPC、后台或禁用时不污染输出", () => {
  for (const mode of ["rpc", "print", "json"]) {
    const stream = io(); beginWeztermApproval(context(mode), 100, { enabled: true }, stream)(); assert.equal(stream.writes.length, 0);
  }
  for (const override of [{ isTTY: false }, { env: { TERM_PROGRAM: "other", WEZTERM_PANE: "12" } }]) {
    const stream = { ...io(), ...override }; beginWeztermApproval(context(), 100, { enabled: true }, stream)(); assert.equal(stream.writes.length, 0);
  }
  const stream = io(); beginWeztermApproval(context(), 100, { enabled: false }, stream)(); assert.equal(stream.writes.length, 0);
});
test("通知数据不能注入额外 OSC 序列或泄露常见令牌", () => {
  const text = safeNotificationText("测试;\x1b]777;notify;恶意\x07\npassword=fictional");
  assert.ok(!/[;\x00-\x1f]/.test(text)); assert.ok(!text.includes("fictional"));
});
test("输出失败不影响审批逻辑", () => {
  assert.doesNotThrow(() => beginWeztermApproval(context(), 100, { enabled: true }, { ...io(), write() { throw new Error(); } })());
});
