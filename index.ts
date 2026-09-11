import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { verifySubagentBridge } from "./subagent-bridge.ts";
import { buildReviewContext, type ObservedInput } from "./review-context.ts";
import { dataRoot } from "./data-paths.ts";
import { startApprovalBroker, requestParentApproval, ParentApprovalError, type ApprovalBroker } from "./external-approval.ts";
import { approvalReason, countOutcome, formatAuditStatus, notifyBlocked, requestApproval, type AuditOutcome } from "./approval-ui.ts";
import {
  DEFAULT_CONFIG, REVIEW_PROMPT, localDecision, parseConfig, parseModelReference, parseVerdict, redact, redactText,
  type AuditRequest, type Config, type Decision,
} from "./policy.ts";

export const MCP_APPROVAL_EVENT = "pi-mcp-adapter:tool-approval-request";
interface McpApprovalRequest {
  serverName: string;
  originalToolName: string;
  prefixedToolName: string;
  args: Record<string, unknown>;
  origin: string;
  signal?: AbortSignal;
  claim(handler: () => Promise<"allow_once" | "deny">): boolean;
}

// 使用事件契约而不是导入另一个全局插件的内部模块，避免模块解析和重复加载问题。
export default function commandAudit(pi: ExtensionAPI) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const configPath = join(agentDir, "command-audit.json");
  let ctxCurrent: ExtensionContext | undefined;
  let lifetime = new AbortController();
  let config: Config = DEFAULT_CONFIG;
  let configError = false;
  let confirmationQueue: Promise<unknown> = Promise.resolve();
  let counters = { allowed: 0, denied: 0, cancelled: 0 };
  let approvalBroker: ApprovalBroker | undefined;
  let observedInput: ObservedInput | undefined;

  function loadConfig() {
    configError = false;
    try { config = parseConfig(JSON.parse(readFileSync(configPath, "utf8"))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") config = DEFAULT_CONFIG;
      else configError = true;
    }
  }

  function auditLog(r: AuditRequest, ctx: ExtensionContext, result: Decision, allowed: boolean, outcome: AuditOutcome) {
    const dir = join(dataRoot, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 不保存命令、路径、参数、模型理由或用户对话，避免日志二次泄漏。
    appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}-${process.pid}.jsonl`), JSON.stringify({
      time: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(),
      kind: r.kind, requestHash: createHash("sha256").update(JSON.stringify(r)).digest("hex"),
      decision: result.decision, allowed, outcome, source: result.source ?? "guard",
    }) + "\n", { mode: 0o600 });
  }

  async function classify(r: AuditRequest, ctx: ExtensionContext, signal: AbortSignal, registeredName?: string): Promise<Decision> {
    signal.throwIfAborted();
    if (configError) return { decision: "deny", reason: "全局审核配置无效，请用户修复后 /reload" };
    if (r.kind === "tool" && r.tool === "subagent" && !["list", "status", "guide"].includes(String(r.args.action))) {
      const bridge = verifySubagentBridge();
      if (!bridge.ok) return { decision: "deny", reason: bridge.reason };
    }
    const local = localDecision(r, config);
    if (local) return { ...local, source: "local" };
    if (r.kind === "tool" && r.tool === "subagent" &&
        (r.args.workflowScript !== undefined || r.args.workflowScriptPath !== undefined || r.args.workflow !== undefined)) {
      return { decision: "ask", reason: "子代理内部命令会分别审核；工作流还可能包含 runs.host 等主机操作，需要核对完整工作流" };
    }
    const reference = parseModelReference(config.model);
    const model = reference ? ctx.modelRegistry.find(reference.provider, reference.id) : ctx.model;
    if (!model) return { decision: "deny", reason: "审核模型不可用" };
    let tools: ReturnType<ExtensionAPI["getAllTools"]> = [];
    try { tools = pi.getAllTools(); } catch { /* 无元数据时明确保留缺失，不阻断模型判断。 */ }
    const reviewContext = buildReviewContext(ctx, tools, r, observedInput, registeredName);
    const payload = JSON.stringify(redact({ ...r, reviewContext }));
    if (payload.length > config.maxInputChars) return { decision: "deny", reason: "审核上下文过长，请拆分操作" };
    const response = await ctx.modelRegistry.complete(model, {
      systemPrompt: REVIEW_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: payload }], timestamp: Date.now() }],
    }, { signal, maxTokens: 1024, cacheRetention: "none", sessionId: randomUUID() });
    signal.throwIfAborted();
    if (response.stopReason !== "stop" || response.content.some(c => c.type === "toolCall")) throw new Error("审核未正常结束");
    return { ...parseVerdict(response.content.filter(c => c.type === "text").map(c => c.text).join("\n")), source: "model" };
  }

  async function review(r: AuditRequest, ctx: ExtensionContext, extraSignal?: AbortSignal, dryRun = false, registeredName?: string): Promise<Decision & { allowed: boolean }> {
    const active = AbortSignal.any([lifetime.signal, ...[ctx.signal, extraSignal].filter((s): s is AbortSignal => !!s)]);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
    const modelSignal = AbortSignal.any([active, timeout.signal]);
    let result: Decision;
    try {
      // 即使自定义 provider 忽略 signal，也在超时/取消时终止等待，不放行工具。
      result = await new Promise<Decision>((resolve, reject) => {
        const abort = () => reject(new Error("审核取消或超时"));
        modelSignal.addEventListener("abort", abort, { once: true });
        if (modelSignal.aborted) { abort(); return; }
        classify(r, ctx, modelSignal, registeredName).then(resolve, reject).finally(() => modelSignal.removeEventListener("abort", abort));
      });
    } catch {
      result = { decision: "deny", reason: "审核失败、超时、取消或返回格式无效，已阻止执行" };
    } finally { clearTimeout(timer); }
    let allowed = result.decision === "allow" && !active.aborted;
    let outcome: AuditOutcome = active.aborted ? "cancelled" : allowed ? "allowed" : "denied";
    let finalReason = result.reason;
    if (!dryRun && result.decision === "ask") {
      const confirm = confirmationQueue.then(async () => {
        const message = `${result.summary ? `操作：${result.summary}\n` : ""}原因：${result.reason}${result.uncertainties?.length ? `\n待确认：${result.uncertainties.join("；")}` : ""}\n\n${JSON.stringify(redact(r), null, 2)}`;
        if (!ctx.hasUI) {
          try {
            await requestParentApproval(message, "tool", active, Date.now() + config.confirmTimeoutMs);
            return "approved" as const;
          } catch (error) { return active.aborted ? "cancelled" as const : error instanceof ParentApprovalError ? error.outcome : "headless" as const; }
        }
        return requestApproval(ctx, "命令审核 · 请确认本次操作", message, active, config.confirmTimeoutMs, {
          enabled: config.weztermNotifications, summary: `${result.summary ?? `工具 ${r.tool} 请求执行`}；${result.reason}`,
          operationHash: createHash("sha256").update(JSON.stringify(r)).digest("hex") });
      });
      confirmationQueue = confirm.catch(() => undefined);
      outcome = await confirm;
      allowed = outcome === "approved" && !active.aborted;
      if (active.aborted) { outcome = "cancelled"; allowed = false; }
      finalReason = approvalReason(outcome);
    } else if (active.aborted) { finalReason = approvalReason("cancelled"); }
    if (dryRun) return { ...result, allowed };
    // 保留初审分类，同时单独记录最终结果，避免 ask 被误认为已批准。
    try { auditLog(r, ctx, result, allowed, outcome); }
    catch { allowed = false; outcome = "error"; finalReason = "无法写入审核日志，已阻止执行"; }
    countOutcome(counters, allowed, outcome);
    if (ctx.hasUI) {
      ctx.ui.setStatus("command-audit", formatAuditStatus(ctx, counters));
      if (!allowed) notifyBlocked(ctx, redactText(r.tool), finalReason, outcome);
    }
    return { ...result, reason: finalReason, allowed };
  }

  // 扩展目录不是默认技能扫描目录，通过资源发现注册随扩展维护的技能。
  pi.on("resources_discover", () => ({
    skillPaths: [fileURLToPath(new URL("./skills/command-audit-subagent-upgrade/SKILL.md", import.meta.url))],
  }));

  pi.on("input", event => { observedInput = { text: event.text, source: event.source }; });
  pi.on("session_tree", () => { observedInput = undefined; });
  loadConfig();
  pi.on("session_start", async (_event, ctx) => {
    ctxCurrent = ctx;
    observedInput = undefined;
    lifetime.abort();
    lifetime = new AbortController();
    counters = { allowed: 0, denied: 0, cancelled: 0 };
    loadConfig();
    await approvalBroker?.close();
    approvalBroker = undefined;
    if (ctx.hasUI && !configError) {
      try {
        approvalBroker = await startApprovalBroker(async (preview, signal, kind) => {
          const active = AbortSignal.any([lifetime.signal, signal]);
          const pending = confirmationQueue.then(() => requestApproval(ctx,
            kind === "tool" ? "子代理工具 · 是否允许本次操作？" : "外部 runner · 是否允许本次启动？",
            (kind === "tool" ? "子代理请求人工审批。请核对以下完整操作；父 AI 不能代替你批准。\n\n" : "此确认仅允许本次外部启动。其内部命令不经过 Pi 逐条审核，请依赖该 CLI/provider 自身的权限与沙箱。\n\n") + preview,
            active, config.confirmTimeoutMs, { enabled: config.weztermNotifications,
              summary: kind === "tool" ? "子代理工具请求人工审批，请返回终端查看完整参数。" : "启动外部 runner，内部命令不受 Pi 逐条审核；允许仅作用于本次启动。",
              operationHash: createHash("sha256").update(preview).digest("hex") }));
          confirmationQueue = pending.catch(() => undefined);
          const outcome = await pending;
          const allowed = outcome === "approved" && !active.aborted;
          countOutcome(counters, allowed, outcome);
          ctx.ui.setStatus("command-audit", formatAuditStatus(ctx, counters));
          if (!allowed) notifyBlocked(ctx, kind === "tool" ? "子代理工具" : "外部 runner", approvalReason(outcome), outcome);
          return active.aborted ? "cancelled" : outcome;
        }, config.confirmTimeoutMs);
      } catch { ctx.ui.notify("外部 runner 人工确认服务启动失败，将阻止外部启动", "warning"); }
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus("command-audit", configError ? ctx.ui.theme.fg("error", "审核配置错误：阻止执行") : formatAuditStatus(ctx, counters));
      const bridge = verifySubagentBridge();
      if (!bridge.ok) ctx.ui.notify(bridge.reason, "warning");
    }
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort(); ctxCurrent = undefined;
    await approvalBroker?.close(); approvalBroker = undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    ctxCurrent = ctx;
    // MCP 在实际调用边界审核，包含脚本动态生成的每次调用，不只审核外层代码。
    // 不根据工具名前缀跳过其它工具：直接工具会再次经过 MCP 审批，保守处理。
    if (event.toolName === "mcpScript") return;
    if (event.toolName === "mcp") {
      const input = event.input as Record<string, unknown>;
      if (!input.action || input.action === "ui-messages") return;
    }
    const original = JSON.stringify(event.input);
    const result = await review({ kind: "tool", tool: event.toolName,
      args: event.input as Record<string, unknown>, cwd: ctx.cwd }, ctx);
    if (original !== JSON.stringify(event.input)) return { block: true, reason: "审批期间参数已改变，请重新审核", terminate: true };
    if (!result.allowed) return { block: true, reason: `命令审核阻止：${result.reason}`, terminate: true };
  });

  pi.events.on(MCP_APPROVAL_EVENT, (payload: unknown) => {
    const request = payload as McpApprovalRequest;
    if (!request || typeof request.claim !== "function") return;
    // claim 必须同步调用；异步审核放在回调内。绝不 abstain 或 allow_for_session。
    request.claim(async () => {
      const ctx = ctxCurrent;
      if (!ctx || lifetime.signal.aborted) return "deny";
      const original = JSON.stringify(request.args);
      const result = await review({ kind: "mcp", tool: request.originalToolName,
        server: request.serverName, origin: request.origin, args: request.args ?? {}, cwd: ctx.cwd }, ctx, request.signal, false, request.prefixedToolName);
      return result.allowed && original === JSON.stringify(request.args) ? "allow_once" : "deny";
    });
  });

  pi.registerCommand("command-audit", {
    description: "查看审核状态；test <命令> 只审核；notify-test 测试 WezTerm 桌面审批提醒",
    handler: async (args, ctx) => {
      if (args === "notify-test") {
        const outcome = await requestApproval(ctx, "WezTerm 审批提醒测试", "这是桌面按钮与终端同步测试，不执行任何命令。可在桌面通知或当前终端选择；先完成的一端生效。",
          lifetime.signal, config.confirmTimeoutMs, { enabled: config.weztermNotifications, summary: "这是桌面按钮测试，不执行任何命令。允许/拒绝应关闭终端审批；返回终端不代表批准。" });
        ctx.ui.notify(`通知测试：${approvalReason(outcome)}（没有执行命令）`, "info");
        return;
      }
      if (args.startsWith("test ")) {
        const result = await review({ kind: "tool", tool: "bash", args: { command: args.slice(5) }, cwd: ctx.cwd }, ctx, undefined, true);
        ctx.ui.notify(`${result.decision}：${result.summary ? result.summary + "；" : ""}${result.reason}（未执行）`, result.decision === "allow" ? "info" : "warning");
        return;
      }
      ctx.ui.notify(`命令审核：${configError ? "配置错误，默认拒绝" : "已启用"}\n模型：${config.model === "current" ? "跟随当前会话" : config.model}\n配置：${configPath}\n人工确认期限：${config.confirmTimeoutMs / 1000} 秒；WezTerm 提醒：${config.weztermNotifications ? "开启（需 TUI + WezTerm）" : "关闭"}\nMCP：逐调用审批；Subagent：${verifySubagentBridge().reason}\n不拦截用户手输的 !/!!，不构成操作系统沙箱。`, "info");
    },
  });
}
