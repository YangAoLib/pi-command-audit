// 用户手动运行的版本锁定安装器；升级后不自动改写未知版本。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const own = dirname(fileURLToPath(import.meta.url));
const storage = join(own, "../data/compat");
const packageRoot = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "npm/node_modules/pi-subagents");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const verifiedHashes = {
  "0.66.0": [
    "54f8dffbfb4c7a82fd89e0e51ff33098e57c58628bdffe4e18b8db00d0dc6415",
    "5d97d6789395309b6470ecbaa58e4c3ce19c5b570ecbe2aa4dfcac9d77cdc1d7",
    "51f41fc6ee753ca3d96cfb93a083e64c62acc5d359ac4169e0f9e357967ca0e0",
    "1978d02e0cb7a7279af48acf299d9e0cd8a8e77dd4d21214845eab691c286100",
  ],
  "0.67.0": [
    "90a8135c4afa87e56ff739acea8fa83b151e56323ea8eea167d832dfd70c1ddb",
    "28863463d79b57db31c4042be5bb60020a7dfe9733a6a06e7dbb89201b070817",
    "71ae5b51854c921ab0064acbb966ac8ac6b4d3e90af651e5edc91e064e042a1c",
    "1978d02e0cb7a7279af48acf299d9e0cd8a8e77dd4d21214845eab691c286100",
  ],
};
if (!Object.hasOwn(verifiedHashes, pkg.version)) throw new Error("仅支持已验证的 pi-subagents 0.66.0/0.67.0；请先适配和测试新版本");
const bridge = join(own, "../subagent-bridge.ts");
const prefix = "src/runs/shared/";
const specs = [
  {
    name: "child-tool-plan.ts",
    imports: "requiredAuditExtensions",
    edits: [["\tconst runtimeExtensions = [\n\t\tPROMPT_RUNTIME_EXTENSION_PATH,", "\tconst runtimeExtensions = [\n\t\t...requiredAuditExtensions(capabilityCeiling),\n\t\tPROMPT_RUNTIME_EXTENSION_PATH,"]],
  },
  {
    name: "child-session.ts",
    imports: "requiredAuditExtensions, assertAuditLoaded",
    edits: [
      ["\t\tasync create(launch) {\n\t\t\tconst observeReadonly", "\t\tasync create(launch) {\n\t\t\t// 所有原生代理统一强制注入，覆盖恢复流程中的旧启动描述。\n\t\t\tlaunch = { ...launch, extensionPaths: [...new Set([...launch.extensionPaths, ...requiredAuditExtensions(launch.runtime.capabilityCeiling)])] };\n\t\t\tconst observeReadonly"],
      ["\t\t\t\tawait flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError);", "\t\t\t\tassertAuditLoaded(loader.getExtensions());\n\t\t\t\tawait flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError);"],
    ],
  },
  {
    name: "external-cli-runner.ts",
    imports: "confirmExternalRunner",
    edits: [
      ["export function runExternalCli(input: {", "export async function runExternalCli(input: {"],
      ["}): Promise<ExternalCliRunResult> {\n\tconst limits", "}): Promise<ExternalCliRunResult> {\n\tawait confirmExternalRunner(input);\n\tconst limits"],
      ["\t\tconst env = externalEnvironment(input.environment?.allowlist, input.environment?.values);", "\t\tconst env = externalEnvironment(input.environment?.allowlist, input.environment?.values);\n\t\t// 外部 CLI 不需要父进程的人工确认通道凭据。\n\t\tdelete env.PI_COMMAND_AUDIT_APPROVAL;"],
    ],
  },
  {
    name: "external-job-runner.ts",
    imports: "confirmExternalRunner",
    edits: [["}): Promise<ExternalJobRunResult> {\n\tconst provider", "}): Promise<ExternalJobRunResult> {\n\tawait confirmExternalRunner(input);\n\tconst provider"]],
  },
];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const receiptFile = join(storage, "installed.json");
if (existsSync(receiptFile)) {
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  if (receipt.version === 2 && receipt.packageVersion === pkg.version && receipt.packageRoot === packageRoot && specs.every(s => {
    const f = receipt.files.find(f => f.path === prefix + s.name);
    return f && hash(readFileSync(join(packageRoot, f.path))) === f.installedHash;
  })) {
    console.log("兼容补丁已安装，校验通过，无重复修改");
    process.exit(0);
  }
}
// 在任何写入之前校验全部文件；已有部分补丁或未知内容时不覆盖。
const changes = specs.map((s, index) => {
  const path = prefix + s.name;
  const fullPath = join(packageRoot, path);
  const before = readFileSync(fullPath);
  if (hash(before) !== verifiedHashes[pkg.version][index]) throw new Error(`源文件校验不符：${path}，未修改任何依赖文件`);
  let after = before.toString("utf8");
  for (const [old, next] of s.edits) {
    if (after.split(old).length !== 2) throw new Error(`补丁锚点不唯一：${path}`);
    after = after.replace(old, next);
  }
  let modulePath = relative(dirname(fullPath), bridge).replaceAll("\\", "/");
  if (!modulePath.startsWith(".")) modulePath = "./" + modulePath;
  after = `// pi-command-audit 兼容补丁 v2：由用户安装，不属于上游发布内容。\nimport { ${s.imports} } from ${JSON.stringify(modulePath)};\n` + after;
  return { path, fullPath, before, after, installedHash: hash(after) };
});
const backupDir = join(storage, "originals", pkg.version);
mkdirSync(backupDir, { recursive: true });
for (const c of changes) {
  const backup = join(backupDir, c.path.split("/").at(-1));
  if (existsSync(backup)) {
    if (hash(readFileSync(backup)) !== hash(c.before)) throw new Error("原始备份校验失败，停止安装");
  } else writeFileSync(backup, c.before, { flag: "wx" });
}
try {
  for (const c of changes) writeFileSync(c.fullPath, c.after);
  writeFileSync(receiptFile, JSON.stringify({
    version: 2, packageRoot, packageVersion: pkg.version,
    files: changes.map(c => ({ path: c.path, backupPath: relative(storage, join(backupDir, c.path.split("/").at(-1))), originalHash: hash(c.before), installedHash: c.installedHash })),
  }, null, 2) + "\n");
} catch (error) {
  for (const c of changes) writeFileSync(c.fullPath, c.before);
  throw error;
}
console.log("已安装统一子代理审核补丁；原文件已备份。请完整重启 Pi，不要只 /reload。");
