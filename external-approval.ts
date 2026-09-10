import { createServer, request as httpRequest } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { redact, redactText } from "./policy.ts";

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
  confirm: (preview: string, signal: AbortSignal) => Promise<boolean>,
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
      if (!value || typeof value.preview !== "string" || Object.keys(value).length !== 1) throw new Error("请求格式错误");
      const task = queue.then(async () => {
        if (controller.signal.aborted) return false;
        return await confirm(redactText(value.preview), controller.signal) === true && !controller.signal.aborted;
      });
      queue = task.catch(() => false);
      const allowed = await new Promise<boolean>((resolve) => {
        const abort = () => resolve(false);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
        task.then(resolve, () => resolve(false)).finally(() => controller.signal.removeEventListener("abort", abort));
      });
      if (!res.destroyed) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ allowed: allowed && !controller.signal.aborted }));
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
  const raw = process.env[ENV];
  if (!raw) throw new Error("外部 runner 启动需要人工确认，但没有可用的 Pi 确认界面");
  let endpoint: { port: number; token: string; timeoutMs: number };
  try {
    endpoint = JSON.parse(raw);
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(endpoint.token) || !Number.isInteger(endpoint.timeoutMs) ||
        endpoint.timeoutMs < 1000 || endpoint.timeoutMs > 300000) throw new Error();
  } catch { throw new Error("外部 runner 确认通道无效，已阻止启动"); }
  const preview = JSON.stringify(redact({
    runner: input.command ? "external-cli" : "external-job",
    command: input.command, args: input.args, provider: input.provider, options: input.options,
    cwd: input.cwd, prompt: input.prompt,
  }), null, 2);
  const body = JSON.stringify({ preview });
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("外部启动参数过长，不能完整展示，请缩小任务后再确认");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs + 2000);
  input.registerStop?.(() => controller.abort());
  input.registerTimeout?.(() => controller.abort());
  try {
    const allowed = await new Promise<boolean>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: endpoint.port, path: "/approve", method: "POST",
        signal: controller.signal, headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, res => {
        let result = "";
        res.on("data", chunk => { result += chunk.toString(); if (result.length > 1024) req.destroy(new Error("响应过长")); });
        res.on("error", reject);
        res.on("end", () => {
          try { resolve(res.statusCode === 200 && JSON.parse(result).allowed === true); } catch { resolve(false); }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
    if (!allowed || controller.signal.aborted) throw new Error();
  } catch { throw new Error("外部 runner 未获人工批准：已拒绝、取消、超时或确认界面不可用，未启动"); }
  finally {
    clearTimeout(timer);
    input.registerStop?.(undefined);
    input.registerTimeout?.(undefined);
  }
}
