// 用户手动卸载；依赖已升级或被再次修改时拒绝用旧文件覆盖。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const own = dirname(fileURLToPath(import.meta.url));
const receiptPath = join(own, "installed.json");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const hash = data => createHash("sha256").update(data).digest("hex");
const changes = receipt.files.map(file => {
  const target = join(receipt.packageRoot, file.path);
  const current = readFileSync(target);
  const original = readFileSync(file.backupPath ? join(own, file.backupPath) : join(own, "originals", basename(file.path)));
  if (hash(current) !== file.installedHash || hash(original) !== file.originalHash) {
    throw new Error(`校验不符，未恢复任何文件：${file.path}；请人工检查依赖版本`);
  }
  return { target, current, original };
});
try {
  for (const c of changes) writeFileSync(c.target, c.original);
  unlinkSync(receiptPath);
} catch (error) {
  for (const c of changes) writeFileSync(c.target, c.current);
  throw error;
}
console.log("已恢复四个上游原文件。若停用审核，请再移走 pi-command-audit 扩展目录并完整重启 Pi。");
