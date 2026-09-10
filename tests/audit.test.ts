import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import commandAudit, { MCP_APPROVAL_EVENT } from "../index.ts";
import { DEFAULT_CONFIG, localDecision, parseConfig, parseVerdict, redact, type AuditRequest } from "../policy.ts";

const request = (command: string): AuditRequest => ({ kind: "tool", tool: "bash", cwd: process.cwd(), args: { command } });
for (const command of ["pwd", "git status --short", "git diff --stat"]) {
  test(`精确规则放行：${command}`, () => assert.equal(localDecision(request(command), DEFAULT_CONFIG, tmpdir())?.decision, "allow"));
}
for (const command of ["pwd; echo unsafe", "git status $(echo unsafe)", "git diff --stat > output", "ls --help", "node -e 'process.exit()'"]) {
  test(`复合或未知命令不能命中白名单：${command}`, () => assert.notEqual(localDecision(request(command), DEFAULT_CONFIG, tmpdir())?.decision, "allow"));
}
for (const command of ["rm -rf ./build", "git push origin main", "sudo echo test", "Remove-Item ./build"]) {
  test(`风险命令需要确认：${command}`, () => assert.equal(localDecision(request(command), DEFAULT_CONFIG, tmpdir())?.decision, "ask"));
}
test("磁盘破坏直接拒绝", () => assert.equal(localDecision(request("mkfs /dev/example"), DEFAULT_CONFIG, tmpdir())?.decision, "deny"));
test("不截断审核参数后放行", () => assert.equal(localDecision(request("x".repeat(25000)), DEFAULT_CONFIG, tmpdir())?.decision, "deny"));
test("配置严格校验", () => { assert.throws(() => parseConfig({ timeoutMs: 0 })); assert.throws(() => parseConfig({ enabled: false })); assert.throws(() => parseConfig(JSON.parse('{"__proto__":{}}'))); });
test("控制字符不能在脱敏后伪装成安全命令", () => assert.equal(localDecision(request("p\u001bwd"), DEFAULT_CONFIG, tmpdir())?.decision, "deny"));
test("模型必须返回完整严格 JSON", () => {
  for (const text of ["allow", '```json\n{"decision":"allow","reason":"可读"}\n```', '{"decision":"allow"}', '{"decision":"allow","reason":"可读","other":true}']) assert.throws(() => parseVerdict(text));
});
test("字段和命令中的常见敏感格式脱敏", () => {
  // 只构造虚拟测试数据，不读取任何用户敏感数据。
  const phone = "138" + "0000" + "0000";
  const data = JSON.stringify(redact({ token: "fictional", text: `phone=${phone} password=fictional` }));
  assert.ok(!data.includes(phone)); assert.ok(!data.includes("fictional"));
});
test("全局配置不能由 AI 直接修改", () => {
  const r = { ...request(""), tool: "write", args: { path: join(tmpdir(), "settings.json"), content: "{}" } };
  assert.equal(localDecision(r, DEFAULT_CONFIG, tmpdir())?.decision, "deny");
});

function fixture(options: { ui?: boolean; answer?: string; confirm?: boolean; complete?: () => Promise<unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-command-audit-test-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, Function>();
  const bus = new Map<string, Function>();
  const calls: unknown[] = [];
  const notices: string[] = [];
  const levels: string[] = [];
  const statuses: string[] = [];
  const ctx = {
    cwd: dir, hasUI: options.ui ?? false, model: { provider: "fixture", id: "fixture" },
    sessionManager: { getSessionId: () => "fixture-session" },
    ui: {
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      setStatus(_key: string, text: string) { statuses.push(text); },
      notify(text: string, level: string) { notices.push(text); levels.push(level); },
      async select() { return options.confirm ? "允许本次" : "拒绝本次"; },
    },
    modelRegistry: {
      find() { return ctx.model; },
      async complete(...args: unknown[]) {
        calls.push(args);
        if (options.complete) return options.complete();
        return { stopReason: "stop", content: [{ type: "text", text: options.answer ?? '{"decision":"allow","reason":"明确的本地操作"}' }] };
      },
    },
  };
  commandAudit({ on(name: string, fn: Function) { handlers.set(name, fn); },
    events: { on(name: string, fn: Function) { bus.set(name, fn); } }, registerCommand() {},
  } as any);
  if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  const ready = handlers.get("session_start")!({}, ctx);
  return { dir, handlers, bus, ctx, calls, notices, levels, statuses,
    invoke: async (toolName: string, input: Record<string, unknown>) => {
      await ready;
      return handlers.get("tool_call")!({ toolName, input }, ctx);
    },
    async dispose() { await ready; await handlers.get("session_shutdown")!(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("未知工具调用模型且模型不携带工具", async () => {
  const f = fixture();
  try {
    assert.equal(await f.invoke("custom_execute", { action: "inspect" }), undefined);
    assert.equal(f.calls.length, 1);
    assert.equal((f.calls[0] as any)[1].tools, undefined);
    const files = await import("node:fs").then(fs => fs.readdirSync(join(f.dir, "command-audit-logs")));
    const log = readFileSync(join(f.dir, "command-audit-logs", files[0]), "utf8");
    assert.ok(!log.includes("inspect")); assert.ok(!log.includes("custom_execute"));
  } finally { f.dispose(); }
});
test("无 UI 的子会话拒绝 ask，不死等确认", async () => {
  const f = fixture(); try { assert.equal((await f.invoke("bash", { command: "git push origin main" })).block, true); assert.equal(f.calls.length, 0); } finally { f.dispose(); }
});
test("人工仅批准当前调用", async () => {
  const f = fixture({ ui: true, confirm: true });
  try { assert.equal(await f.invoke("bash", { command: "git push origin main" }), undefined); } finally { await f.dispose(); }
});
test("手动拒绝记录最终结果，不再重复初审理由或使用黄色告警", async () => {
  const f = fixture({ ui: true, confirm: false });
  try {
    const result = await f.invoke("bash", { command: "git clean -n" });
    assert.equal(result.block, true);
    assert.match(result.reason, /用户已拒绝/);
    assert.ok(!result.reason.includes("需要人工确认"));
    assert.equal(f.levels.at(-1), "info");
    assert.match(f.statuses.at(-1)!, /<error>拒绝 1/);
    assert.match(f.statuses.at(-1)!, /<dim>放行 0/);
    const { readdirSync } = await import("node:fs");
    const file = readdirSync(join(f.dir, "command-audit-logs"))[0];
    const entry = JSON.parse(readFileSync(join(f.dir, "command-audit-logs", file), "utf8").trim());
    assert.equal(entry.decision, "ask");
    assert.equal(entry.outcome, "user_denied");
    assert.equal(entry.allowed, false);
  } finally { await f.dispose(); }
});
test("人工批准记为放行而不是确认分类", async () => {
  const f = fixture({ ui: true, confirm: true });
  try {
    assert.equal(await f.invoke("bash", { command: "git clean -n" }), undefined);
    assert.match(f.statuses.at(-1)!, /<success>放行 1/);
    assert.match(f.statuses.at(-1)!, /<dim>拒绝 0/);
  } finally { await f.dispose(); }
});
test("无效模型输出默认拒绝", async () => {
  const f = fixture({ answer: "approved" }); try { assert.equal((await f.invoke("bash", { command: "echo hello" })).block, true); } finally { f.dispose(); }
});
test("provider 错误默认拒绝", async () => {
  const f = fixture({ complete: async () => { throw new Error("fixture"); } });
  try { assert.equal((await f.invoke("bash", { command: "echo hello" })).block, true); } finally { f.dispose(); }
});
test("取消能够中止忽略 signal 的 provider 等待", async () => {
  const f = fixture({ complete: () => new Promise(() => {}) });
  try {
    const controller = new AbortController(); (f.ctx as any).signal = controller.signal;
    const pending = f.invoke("bash", { command: "echo hello" }); controller.abort();
    assert.equal((await pending).block, true);
  } finally { f.dispose(); }
});
test("审核超时默认拒绝", async () => {
  const f = fixture({ complete: () => new Promise(() => {}) });
  try {
    writeFileSync(join(f.dir, "command-audit.json"), JSON.stringify({ timeoutMs: 1000 }));
    await f.handlers.get("session_start")!({}, f.ctx);
    assert.equal((await f.invoke("bash", { command: "echo hello" })).block, true);
  } finally { f.dispose(); }
});
test("配置损坏不回退为允许", async () => {
  const f = fixture(); try {
    writeFileSync(join(f.dir, "command-audit.json"), "invalid"); await f.handlers.get("session_start")!({}, f.ctx);
    assert.equal((await f.invoke("bash", { command: "pwd" })).block, true);
  } finally { f.dispose(); }
});
test("MCP 脚本逐次同步认领审批，没有会话级授权", async () => {
  const f = fixture(); try {
    assert.equal(await f.invoke("mcpScript", { code: "动态调用示例" }), undefined);
    for (const origin of ["proxy", "direct", "script", "resource", "iframe"]) {
      let handler: Function | undefined;
      f.bus.get(MCP_APPROVAL_EVENT)!({ serverName: "fixture", originalToolName: "inspect", args: {}, origin,
        claim(fn: Function) { handler = fn; return true; } });
      assert.ok(handler); assert.equal(await handler!(), "allow_once");
    }
    assert.equal(f.calls.length, 5);
  } finally { f.dispose(); }
});
test("MCP 内嵌危险命令被阻止", async () => {
  const f = fixture(); try {
    let handler: Function | undefined;
    f.bus.get(MCP_APPROVAL_EVENT)!({ serverName: "fixture", originalToolName: "terminal", args: { command: "git push origin main" }, origin: "script",
      claim(fn: Function) { handler = fn; return true; } });
    assert.equal(await handler!(), "deny");
  } finally { f.dispose(); }
});
test("关闭会话后 MCP 不放行", async () => {
  const f = fixture(); try {
    f.handlers.get("session_shutdown")!(); let handler: Function | undefined;
    f.bus.get(MCP_APPROVAL_EVENT)!({ claim(fn: Function) { handler = fn; } });
    assert.equal(await handler!(), "deny");
  } finally { f.dispose(); }
});
test("非内置代理同样调用审核模型，不按名称跳过", async () => {
  const f = fixture(); try {
    assert.equal(await f.invoke("subagent", { agent: "project-custom-reviewer", task: "检查本地结构" }), undefined);
    assert.equal(f.calls.length, 1);
    assert.equal((f.calls[0] as any)[1].tools, undefined);
  } finally { f.dispose(); }
});
test("自定义代理委派被模型拒绝时不能执行", async () => {
  const f = fixture({ answer: '{"decision":"deny","reason":"请求包含危险操作"}' }); try {
    assert.equal((await f.invoke("subagent", { agent: "custom-agent", task: "虚拟测试任务" })).block, true);
  } finally { f.dispose(); }
});
test("任意工作流不能静默放行", async () => {
  const f = fixture(); try { assert.equal((await f.invoke("subagent", { workflowScript: "return runs.host('x', {})" })).block, true); } finally { f.dispose(); }
});
