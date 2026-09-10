// 本机集成检查：不启动子代理、不连接 MCP、不调用在线模型。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// 优先显式指定宿主目录；其次使用 Node 全局路径或标准 npm 全局安装目录。
const hostRoot = process.env.PI_AUDIT_HOST_ROOT || process.env.NODE_PATH?.split(process.platform === "win32" ? ";" : ":")[0]
  || execFileSync(process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", "npm root -g"] : ["root", "-g"], { encoding: "utf8" }).trim();
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const pluginRoot = process.env.PI_AUDIT_PLUGIN_ROOT || join(agentDir, "npm", "node_modules");
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const host = join(hostRoot, "@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")).href);
const dir = mkdtempSync(join(tmpdir(), "pi-audit-integration-"));
try {
  const loaded = await loadExtensions([entry], dir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].handlers.has("tool_call"));
  console.log("通过：Pi 真实加载器加载全局扩展，无加载错误");
  const discover = loaded.extensions[0].handlers.get("resources_discover");
  assert.equal(discover?.length, 1);
  const resources = await discover[0]({ type: "resources_discover", reason: "reload", cwd: dir }, {});
  const { loadSkills } = await import(pathToFileURL(join(host, "dist/core/skills.js")).href);
  const skillResult = loadSkills({ cwd: dir, agentDir: dir, skillPaths: resources.skillPaths, includeDefaults: false });
  assert.deepEqual(skillResult.diagnostics, []);
  assert.equal(skillResult.skills.length, 1);
  assert.equal(skillResult.skills[0].name, "command-audit-subagent-upgrade");
  assert.equal(skillResult.skills[0].disableModelInvocation, false);
  console.log("通过：升级技能经 resources_discover 注册，真实 Pi 技能解析器加载无警告");

  const { createJiti } = await import(pathToFileURL(join(pluginRoot, "jiti/lib/jiti.mjs")).href);
  const aliasLoader = createJiti(import.meta.url);
  const { resolveHostPeerAliases } = await aliasLoader.import(join(pluginRoot, "pi-subagents/src/runs/background/runner-aliases.ts"));
  const peers = resolveHostPeerAliases(host);
  assert.deepEqual(peers.missing, []);
  const jiti = createJiti(import.meta.url, { alias: peers.aliases });
  const { discoverAgents } = await jiti.import(join(pluginRoot, "pi-subagents/src/agents/agents.ts"));
  mkdirSync(join(dir, ".pi/agents"), { recursive: true });
  writeFileSync(join(dir, ".pi/agents/custom.md"), "---\nname: audit-custom-test\ndescription: 虚拟测试代理\ntools: read, bash\nextensions:\n---\n仅用于配置发现测试，不执行任务。\n");
  const discovered = discoverAgents(dir, "both");
  const { resolvePiLaunchToolPlan } = await jiti.import(join(pluginRoot, "pi-subagents/src/runs/shared/child-tool-plan.ts"));
  for (const name of ["scout", "researcher", "worker", "reviewer", "oracle", "delegate", "audit-custom-test"]) {
    const agent = discovered.agents.find(a => a.name === name);
    assert.ok(agent, `未发现 ${name}`);
    const plan = resolvePiLaunchToolPlan({ tools: agent.tools, extensions: agent.extensions, subagentOnlyExtensions: agent.subagentOnlyExtensions, cwd: dir });
    assert.ok(plan.extensionArgs.some(p => p.replaceAll("\\", "/") === entry.replaceAll("\\", "/")), `${name} 启动计划缺少审核器`);
  }
  const { requiredAuditExtensions, assertAuditLoaded, verifySubagentBridge } = await import(new URL("../subagent-bridge.ts", import.meta.url));
  assert.equal(verifySubagentBridge().ok, true);
  assertAuditLoaded(loaded);
  assert.throws(() => assertAuditLoaded({ extensions: [], errors: [] }), /未成功加载/);
  assert.throws(() => requiredAuditExtensions({ denyExtensions: true }), /冲突/);
  assert.throws(() => resolvePiLaunchToolPlan({ capabilityCeiling: { denyExtensions: true, sources: ["测试"] } }), /冲突/);
  console.log("通过：内置及自定义代理（包括 extensions 空列表）统一注入；加载缺失和能力冲突时拒绝");

  const { createDefaultChildSessionFactory } = await jiti.import(join(pluginRoot, "pi-subagents/src/runs/shared/child-session.ts"));
  let loaderOptions;
  let promptCalls = 0;
  const session = {
    bindExtensions: async () => {}, dispose() {}, subscribe() { return () => {}; },
    prompt: async () => { promptCalls++; }, messages: [], sessionId: "fixture",
    extensionRunner: { hasHandlers() { return false; } },
  };
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
    ModelRuntime: { create: async () => ({}) }, SettingsManager: { create: () => ({ getTheme: () => "dark" }) },
    DefaultResourceLoader: class {
      loaded = false;
      constructor(options) { loaderOptions = options; }
      async reload() {}
      getExtensions() { return { ...loaded, runtime: {} }; }
    },
    SessionManager: { inMemory: () => ({}) }, createAgentSession: async () => ({ session }),
  }) });
  const child = await factory.create({ cwd: dir, storage: { kind: "memory" }, extensionPaths: [],
    ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true,
    runtime: { depth: 1, fanoutChild: false, fast: false, waitTool: { enabled: false } },
  });
  assert.ok(loaderOptions.additionalExtensionPaths.some(p => p.replaceAll("\\", "/") === entry.replaceAll("\\", "/")));
  assert.equal(promptCalls, 0);
  await child.dispose(); await factory.dispose();
  console.log("通过：旧恢复描述/空扩展列表进入真实创建工厂时仍注入（SDK 使用测试替身，没有启动代理）");

  const { runExternalCli } = await jiti.import(join(pluginRoot, "pi-subagents/src/runs/shared/external-cli-runner.ts"));
  const { runExternalJob } = await jiti.import(join(pluginRoot, "pi-subagents/src/runs/shared/external-job-runner.ts"));
  const { startApprovalBroker } = await import(new URL("../external-approval.ts", import.meta.url));
  let confirmations = 0;
  const broker = await startApprovalBroker(async () => { confirmations++; return false; }, 2000);
  try {
    await assert.rejects(runExternalCli({ command: "不会启动的虚拟命令", cwd: dir, prompt: "测试" }), /未获人工批准/);
    await assert.rejects(runExternalJob({ provider: "不会启动的虚拟服务", cwd: dir, prompt: "测试" }), /未获人工批准/);
    assert.equal(confirmations, 2);
  } finally { await broker.close(); }
  console.log("通过：两个实际外部 runner 入口逐次请求确认，拒绝后不执行");

  const { ensureToolCallApproved } = await jiti.import(join(pluginRoot, "pi-mcp-adapter/tool-approval.ts"));
  let claims = 0;
  const state = {
    config: { mcpServers: { fixture: { url: "https://example.invalid", approveTools: false } } },
    approvalEvents: { emit(event, request) {
      assert.equal(event, "pi-mcp-adapter:tool-approval-request");
      assert.equal(request.claim(async () => { claims++; return request.args.block ? "deny" : "allow_once"; }), true);
    } },
  };
  for (const origin of ["proxy", "direct", "script", "resource", "iframe"]) {
    assert.equal((await ensureToolCallApproved(state, "fixture", { name: "fixture_inspect", originalName: "inspect" }, {}, undefined, origin)).ok, true);
    assert.equal((await ensureToolCallApproved(state, "fixture", { name: "fixture_inspect", originalName: "inspect" }, { block: true }, undefined, origin)).ok, false);
  }
  assert.equal(claims, 10);
  assert.equal(state.approvedToolCalls.size, 0);
  console.log("通过：MCP 实际审批实现逐调用执行 broker，allow_once 不写会话授权缓存");
} finally { rmSync(dir, { recursive: true, force: true }); }
