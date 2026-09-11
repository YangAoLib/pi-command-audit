import { createServer, request as httpRequest } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { redact, redactText } from "./policy.ts";
import type { ApprovalResult } from "./approval-state.ts";

export class ParentApprovalError extends Error {
  readonly outcome: ApprovalResult;
  constructor(outcome: ApprovalResult) {
    super("外部 runner 或子代理未获人工批准：已拒绝、取消、超时或确认界面不可用，未启动");
    this.outcome = outcome;
  }
}

const ENV = "PI_COMMAND_AUDIT_APPROVAL";
const MAX_BYTES = 64000;
export interface ExternalLaunch {
  command?: string;
  args?: string[];
  provider?: string;
  options?: Record<string, unknown>;
  cwd: string;
  prompt: string;
  registerStop?: (stop: (() => void) | undefined) => void;
  registerTimeout?: (stop: (() => void) | undefined) => void;
}
export interface ApprovalBroker {
  close(): Promise<void>;
}

// 仅监听本机；随机凭据由当前 Pi 进程传给后台 runner，不写入文件或日志。
export async function startApprovalBroker(
  confirm: (preview: string, signal: AbortSignal, kind?: "tool" | "external") => Promise<boolean | ApprovalResult>,
  timeoutMs: number,
): Promise<ApprovalBroker> {
  const token = randomBytes(32).toString("hex");
  const active = new Set<AbortController>();
  let queue: Promise<unknown> = Promise.resolve();
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    if (req.method !== "POST" || req.url !== "/approve" || req.headers.origin ||
        Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      res.writeHead(403).end(); return;
    }
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res.on("close", () => controller.abort());
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("请求过大");
      }
      const value = JSON.parse(body);
      if (!value || typeof value.preview !== "string" || Object.keys(value).some(k => !["preview", "kind", "deadline"].includes(k)) ||
          (value.kind !== undefined && value.kind !== "tool" && value.kind !== "external")) throw new Error("请求格式错误");
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      if (value.deadline !== undefined) {
        if (!Number.isFinite(value.deadline) || value.deadline <= Date.now()) throw new Error("审批已过期");
        requestTimer = setTimeout(() => controller.abort(), Math.min(timeoutMs, value.deadline - Date.now()));
        controller.signal.addEventListener("abort", () => clearTimeout(requestTimer), { once: true });
      }
      const task = queue.then(async () => {
        if (controller.signal.aborted) return false;
        return await confirm(redactText(value.preview), controller.signal, value.kind ?? "external");
      });
      queue = task.catch(() => false);
      const decision = await new Promise<boolean | ApprovalResult>((resolve) => {
        const abort = () => resolve(false);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
        task.then(resolve, () => resolve(false)).finally(() => controller.signal.removeEventListener("abort", abort));
      });
      const allowed = (decision === true || decision === "approved") && !controller.signal.aborted;
      const outcome = controller.signal.aborted ? "timeout" : typeof decision === "string" ? decision : allowed ? "approved" : "user_denied";
      if (!res.destroyed) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ allowed, outcome }));
    } catch {
      if (!res.destroyed) res.writeHead(400).end(JSON.stringify({ allowed: false }));
    } finally { clearTimeout(timer); controller.abort(); active.delete(controller); }
  });
  server.requestTimeout = timeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("确认服务启动失败"); }
  const previous = process.env[ENV];
  const descriptor = JSON.stringify({ port: address.port, token, timeoutMs });
  process.env[ENV] = descriptor;
  let closed = false;
  return { async close() {
    if (closed) return;
    closed = true;
    if (process.env[ENV] === descriptor) {
      if (previous === undefined) delete process.env[ENV]; else process.env[ENV] = previous;
    }
    for (const controller of active) controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

export async function confirmExternalRunner(input: ExternalLaunch): Promise<void> {
  const preview = JSON.stringify(redact({
    runner: input.command ? "external-cli" : "external-job",
    command: input.command, args: input.args, provider: input.provider, options: input.options,
    cwd: input.cwd, prompt: input.prompt,
  }), null, 2);
  await requestParentApproval(preview, "external", undefined, undefined, input);
}

/** 子代理请求转交父会话的人类；没有 UI 通道则失败，不由父 AI 自动批准。 */
export async function requestParentApproval(preview: string, kind: "tool" | "external", signal?: AbortSignal,
  deadline?: number, input?: Pick<ExternalLaunch, "registerStop" | "registerTimeout">): Promise<void> {
  const raw = process.env[ENV];
  if (!raw) throw new Error("外部 runner 或子代理需要人工确认，但没有可用的 Pi 确认界面");
  let endpoint: { port: number; token: string; timeoutMs: number };
  try {
    endpoint = JSON.parse(raw);
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(endpoint.token) || !Number.isInteger(endpoint.timeoutMs) ||
        endpoint.timeoutMs < 1000 || endpoint.timeoutMs > 300000) throw new Error();
  } catch { throw new Error("外部 runner 确认通道无效，已阻止启动"); }
  const body = JSON.stringify({ preview: redactText(preview), kind, ...(deadline !== undefined ? { deadline } : {}) });
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("外部启动参数过长，不能完整展示，请缩小任务后再确认");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs + 2000);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  input?.registerStop?.(cancel);
  input?.registerTimeout?.(cancel);
  try {
    const decision = await new Promise<{ allowed: boolean; outcome?: ApprovalResult }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: endpoint.port, path: "/approve", method: "POST",
        signal: controller.signal, headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, res => {
        let result = "";
        res.on("data", chunk => { result += chunk.toString(); if (result.length > 1024) req.destroy(new Error("响应过长")); });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(result);
            resolve({ allowed: res.statusCode === 200 && value.allowed === true, outcome: value.outcome });
          } catch { resolve({ allowed: false }); }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
    if (!decision.allowed || controller.signal.aborted) {
      const outcome = signal?.aborted ? "cancelled" : ["user_denied", "cancelled", "timeout", "headless", "error"].includes(decision.outcome ?? "") ? decision.outcome! : "error";
      throw new ParentApprovalError(outcome);
    }
  } catch (error) {
    if (error instanceof ParentApprovalError) throw error;
    throw new ParentApprovalError(signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "error");
  }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    input?.registerStop?.(undefined);
    input?.registerTimeout?.(undefined);
  }
}
