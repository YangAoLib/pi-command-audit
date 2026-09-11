import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startApprovalBroker, confirmExternalRunner, requestParentApproval, ParentApprovalError } from "../external-approval.ts";

const launch = { command: "虚拟工具", args: ["--read-only"], cwd: process.cwd(), prompt: "虚拟任务" };

test("原生子代理 ask 转发到父界面，不自动当作外部启动", async () => {
  let count = 0;
  const broker = await startApprovalBroker(async (preview, signal, kind) => {
    assert.equal(kind, "tool"); assert.match(preview, /虚拟修改/); count++; return "approved";
  }, 2000);
  try { await requestParentApproval("虚拟修改", "tool", undefined, Date.now() + 1000); assert.equal(count, 1); }
  finally { await broker.close(); }
});
test("父界面明确拒绝的原因能传回子代理", async () => {
  const broker = await startApprovalBroker(async () => "user_denied", 2000);
  try { await assert.rejects(requestParentApproval("测试", "tool"), e => e instanceof ParentApprovalError && e.outcome === "user_denied"); }
  finally { await broker.close(); }
});
test("子代理截止时间过期不能由父界面迟到批准", async () => {
  let confirms = 0;
  const broker = await startApprovalBroker(async () => { confirms++; return "approved"; }, 2000);
  try { await assert.rejects(requestParentApproval("测试", "tool", undefined, Date.now() - 1)); assert.equal(confirms, 0); }
  finally { await broker.close(); }
});
test("无确认通道时不启动", async () => {
  const old = process.env.PI_COMMAND_AUDIT_APPROVAL;
  delete process.env.PI_COMMAND_AUDIT_APPROVAL;
  try { await assert.rejects(confirmExternalRunner(launch), /没有可用/); }
  finally { if (old) process.env.PI_COMMAND_AUDIT_APPROVAL = old; }
});
test("每次启动都需要新的确认，不缓存批准", async () => {
  let count = 0;
  const broker = await startApprovalBroker(async preview => {
    assert.ok(preview.includes("虚拟工具")); count++; return true;
  }, 2000);
  try { await confirmExternalRunner(launch); await confirmExternalRunner(launch); assert.equal(count, 2); }
  finally { await broker.close(); }
});
test("后台进程通过继承通道向父进程请求确认", async () => {
  let count = 0;
  const broker = await startApprovalBroker(async () => { count++; return true; }, 2000);
  try {
    const moduleUrl = new URL("../external-approval.ts", import.meta.url).href;
    const code = `import { confirmExternalRunner } from ${JSON.stringify(moduleUrl)}; await confirmExternalRunner(${JSON.stringify(launch)});`;
    const exit = await new Promise<number | null>((resolve, reject) => {
      // 只运行确认通道测试客户端，不启动任何真实外部代理。
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore", env: process.env });
      child.on("error", reject); child.on("close", resolve);
    });
    assert.equal(exit, 0); assert.equal(count, 1);
  } finally { await broker.close(); }
});
test("人工拒绝和界面异常时不启动", async () => {
  for (const fail of [false, true]) {
    const broker = await startApprovalBroker(async () => { if (fail) throw new Error(); return false; }, 2000);
    try { await assert.rejects(confirmExternalRunner(launch), /未获人工批准/); }
    finally { await broker.close(); }
  }
});
test("确认超时即拒绝，即使 UI 回调不响应 signal", async () => {
  const broker = await startApprovalBroker(() => new Promise(() => {}), 1000);
  try { await assert.rejects(confirmExternalRunner(launch), /未获人工批准/); }
  finally { await broker.close(); }
});
test("停止 runner 可取消确认，不继续执行", async () => {
  let stop: (() => void) | undefined;
  const broker = await startApprovalBroker(() => new Promise(() => {}), 2000);
  try {
    const pending = confirmExternalRunner({ ...launch, registerStop(fn) { stop = fn; } });
    assert.ok(stop); stop!();
    await assert.rejects(pending, /未获人工批准/);
    assert.equal(stop, undefined);
  } finally { await broker.close(); }
});
test("父会话退出取消待确认请求", async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  const broker = await startApprovalBroker(() => { entered(); return new Promise(() => {}); }, 2000);
  const pending = confirmExternalRunner(launch);
  const assertion = assert.rejects(pending, /未获人工批准/);
  await ready; await broker.close(); await assertion;
});
test("错误凭据不触发确认界面", async () => {
  let count = 0;
  const broker = await startApprovalBroker(async () => { count++; return true; }, 2000);
  const original = process.env.PI_COMMAND_AUDIT_APPROVAL!;
  try {
    const endpoint = JSON.parse(original); endpoint.token = "0".repeat(64);
    process.env.PI_COMMAND_AUDIT_APPROVAL = JSON.stringify(endpoint);
    await assert.rejects(confirmExternalRunner(launch), /未获人工批准/);
    assert.equal(count, 0);
  } finally { process.env.PI_COMMAND_AUDIT_APPROVAL = original; await broker.close(); }
});
test("外部 provider 也请求确认且常见敏感字段脱敏", async () => {
  const broker = await startApprovalBroker(async preview => {
    assert.ok(preview.includes("external-job")); assert.ok(!preview.includes("虚拟密钥")); return true;
  }, 2000);
  try { await confirmExternalRunner({ cwd: launch.cwd, prompt: "虚拟任务", provider: "测试", options: { token: "虚拟密钥" } }); }
  finally { await broker.close(); }
});
