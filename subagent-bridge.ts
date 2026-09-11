import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const entry = join(root, "index.ts");
const receiptPath = join(root, "data", "compat", "installed.json");
import { confirmExternalRunner as requestExternalApproval, type ExternalLaunch } from "./external-approval.ts";

export async function confirmExternalRunner(input: ExternalLaunch): Promise<void> {
  const state = verifySubagentBridge();
  if (!state.ok) throw new Error(state.reason);
  await requestExternalApproval(input);
}

// 这是针对已安装版本的兼容桥，不是 pi-subagents 的官方扩展接口。
export function verifySubagentBridge(): { ok: boolean; reason: string } {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.version !== 2 || !Array.isArray(receipt.files) || receipt.files.length !== 4) throw new Error();
    const pkg = JSON.parse(readFileSync(join(receipt.packageRoot, "package.json"), "utf8"));
    if (pkg.version !== receipt.packageVersion) throw new Error();
    for (const file of receipt.files) {
      const hash = createHash("sha256").update(readFileSync(join(receipt.packageRoot, file.path))).digest("hex");
      if (hash !== file.installedHash) throw new Error();
    }
    if (!statSync(entry).isFile()) throw new Error();
    return { ok: true, reason: "所有原生子代理统一注入审核器；外部 runner 启动前逐次人工确认" };
  } catch {
    return { ok: false, reason: "Subagent 审核桥未安装或依赖已变更；请用户检查兼容补丁并重启 Pi，不能无审核启动" };
  }
}

export function requiredAuditExtensions(ceiling?: { denyExtensions?: boolean }): string[] {
  const state = verifySubagentBridge();
  if (!state.ok) throw new Error(state.reason);
  // 尊重既有能力上限，不偷偷绕过 denyExtensions。
  if (ceiling?.denyExtensions) throw new Error("子代理禁止加载扩展，与强制命令审核冲突，已阻止启动");
  return [entry];
}

function samePath(a: string, b: string): boolean {
  try {
    let left = realpathSync(a), right = realpathSync(b);
    if (process.platform === "win32") { left = left.toLowerCase(); right = right.toLowerCase(); }
    return left === right;
  } catch { return false; }
}

export function assertAuditLoaded(result: {
  extensions: Array<{ path: string; handlers: Map<string, unknown[]> }>;
  errors: Array<{ path: string; error: string }>;
}): void {
  // 不输出加载错误原文，避免其中夹带配置或环境敏感值。
  if (result.errors.length) throw new Error("子会话存在扩展加载错误，无法保证审核覆盖，已阻止启动");
  const loaded = result.extensions.find(e => samePath(e.path, entry));
  if (!loaded || !loaded.handlers.get("tool_call")?.length || !loaded.handlers.get("session_start")?.length) {
    throw new Error("子会话未成功加载命令审核器，已阻止启动");
  }
}
