---
name: command-audit-subagent-upgrade
description: 在安装 pi-command-audit 命令审核扩展的环境中升级 pi-subagents，并保留原生子代理强制审核、外部 runner 人工确认。用户要求更新/升级 subagent、升级后补丁失效、适配新版本或回滚升级时使用。包含版本检查、备份、源码差异审查、补丁迁移和回归验证；禁止直接更新后跳过补丁验证。
---

# 带命令审核的 Subagent 升级

全程使用中文。此 Skill 是维护流程，不授予权限、不自动运行命令，也不代表用户批准了实际外部 runner 的启动。

## 路径与前提

- 本 Skill 所在目录记为 `SKILL_DIR`，扩展根目录 `EXT = SKILL_DIR/../..`，操作前解析为绝对路径。
- Pi 全局目录 `AGENT_DIR` 使用 `PI_CODING_AGENT_DIR`，未设置时为用户主目录下的 `.pi/agent`。不要把业务仓库当作插件目录。
- 默认依赖位于 `AGENT_DIR/npm/node_modules/pi-subagents`。以 `EXT/compat/installed.json`、Pi settings 和实际 package.json 交叉确认；若实际使用的是项目安装、Git 安装或其它路径，停止套用默认命令，先确定生效来源。
- 原文件备份、校验哈希和测试才是依据，不凭本 Skill 里列出的历史版本认定兼容。
- 所有占位符必须替换为已验证的绝对路径/精确版本，不能直接运行含 `<目标版本>` 的命令。

## 必须保留的行为

1. 所有原生子代理（含自定义、项目级代理）在共享启动计划和实际创建会话时注入审核器。
2. 审核器加载失败或 `denyExtensions` 冲突时拒绝启动，不静默降级。
3. 外部 CLI 和 external-job 在实际执行入口等待人工确认；拒绝、取消、超时或通道不可用时不启动。不能恢复为无条件拒绝，也不能改成自动批准。
4. 最终外部 CLI 环境不携带 `PI_COMMAND_AUDIT_APPROVAL`。
5. 保留当前 MCP 审批、主题配色、最终审批结果统计，不改动与升级无关的策略。
6. 不削弱上游新增的工具权限、进程清理、取消或恢复约束。

## 1. 只读预检

先读取：

- `EXT/README.md`
- `EXT/compat/install.mjs`、`EXT/compat/uninstall.mjs`
- `EXT/compat/installed.json`（存在时）
- `EXT/subagent-bridge.ts`、`EXT/external-approval.ts`
- `EXT/tests/integration.mjs`
- 当前 pi-subagents 的 package.json，以及匹配此次改动的文档。
- 当前 Pi 的官方 `docs/packages.md`；若调整扩展接口，读取 `docs/extensions.md` 相关说明。路径从已安装 Pi 包确定，不在业务目录猜测。

查询目标版本，例如：

```bash
npm view pi-subagents version dist.integrity --json
```

用户指定版本时以指定版本为准。记录当前版本、目标版本、包来源及是否已打补丁；目标等于当前版本且补丁有效时，不重复更新。

使用 `subagent` 的只读 `status`/`view:fleet` 检查本会话活动任务，并提醒用户确认其它 Pi 窗口没有正在使用该全局安装的子任务。当前会话无活动任务不代表其它窗口也没有。存在任务时等待用户处理，不擅自终止。

检查当前业务仓库 `git status --short` 作为前后对照，不清理或更改用户工作区。

**权限限制**：当前审核器可能拒绝 AI 编辑 Pi 全局目录。遇到拒绝应停止并请求用户手动执行相关步骤；不能换成 Shell、MCP、无扩展 Pi 或其它 CLI 绕过。不要读取 auth.json、令牌、手机号等敏感内容，不输出完整环境变量。

## 2. 暂存新版，先审查再替换

在 `AGENT_DIR/command-audit-backups/upgrade-<目标版本>-<唯一时间戳>/` 创建本次独立备份目录，禁止覆盖旧备份。

下载到其 `staging/`，不安装、不执行包脚本：

```bash
npm pack pi-subagents@<目标版本> --ignore-scripts --pack-destination "<staging绝对路径>" --json
```

检查包名、版本和 npm 报告的 integrity，安全解压到 staging。用新源码与旧版本的**未打补丁原文件**比较，不要只对比已打补丁文件。

旧原文件位置以 installed.json 每条记录的 `backupPath` 为准；兼容旧记录的 `compat/originals/<文件名>`。当前安装器通常使用 `compat/originals/<版本>/<文件名>`。

重点审查：

| 上游文件 | 必须验证 |
|---|---|
| `src/runs/shared/child-tool-plan.ts` | runtimeExtensions、能力上限、宿主工具过滤是否改变 |
| `src/runs/shared/child-session.ts` | 创建入口、加载检查位置、主题和 prompt/runtime 顺序是否改变 |
| `src/runs/shared/external-cli-runner.ts` | 确认发生在执行之前，取消处理和环境剔除仍有效 |
| `src/runs/shared/external-job-runner.ts` | start、follow-up、恢复是否仍经过确认入口 |

还需检查 changelog 中本次版本范围、`docs/extension-api.md`、package.json 依赖差异及上述入口的调用方，确认新路径没有绕过现有补丁。不能仅因文本锚点仍匹配就判定兼容。

如果上游已有正式的强制扩展/执行前审批接口，先说明迁移方案与范围，不趁升级静默重构。依赖版本大幅变化或测试基础设施不兼容时，先解决适配再替换在用版本。

## 3. 完整备份与补丁适配

至少备份到本次独立目录：

- 整个 `EXT`，包括补丁记录、原文件和测试；
- 当前已安装的 pi-subagents 包目录（含当前补丁）；
- `AGENT_DIR/npm/package.json`、package-lock.json（存在时）；
- `AGENT_DIR/settings.json`。

仅备份必要配置，保护本地文件权限，不上传。若目标版本修改传递依赖，需要额外准备可恢复的依赖方案；只恢复锁文件不能恢复 node_modules。

适配 `compat/install.mjs`：

1. 保留已支持版本的哈希，为审查过的目标版本新增精确原文件 SHA-256。
2. 若上游结构改变，修改或按版本区分锚点/补丁，不把新哈希加入列表后直接假定旧补丁安全。
3. 保留版本限制、完整文件哈希检查、唯一锚点、幂等校验和写入失败回滚。
4. 原文件备份按版本存放，卸载器按安装记录恢复对应版本，禁止拿旧源码覆盖新版。
5. 不手工伪造 installed.json 的 installedHash 来“通过验证”。

## 4. 切换安装

再次确认没有活动任务。以下步骤之间不要启动子代理或其它依赖审核桥的任务。

1. 若旧补丁有效，运行：

```bash
node "<EXT>/compat/uninstall.mjs"
```

2. 使用 Pi 官方单包管理命令更新，只更新 pi-subagents：

```bash
pi update npm:pi-subagents
```

若此命令只能跟随 latest 而用户指定了精确版本，按当前 Pi 文档选择 `pi install npm:pi-subagents@<目标版本>`，并明确告知这会修改 settings 为版本锁定。不要升级所有扩展或 Pi 本身。升级后立即核对实际版本；若与已审查目标不一致，不给未知版本打补丁。

3. 运行已适配安装器：

```bash
node "<EXT>/compat/install.mjs"
```

4. 检查 installed.json 的 packageVersion 与实际版本一致、每个文件哈希正确；再运行安装器确认幂等性。

**旧补丁已被外部更新覆盖时**：旧卸载器会拒绝，应保留证据，核对新版确为未修改的上游源码，审查后按新版本安装流程处理。不要强制恢复旧备份，也不要用删除记录的办法掩盖校验不一致。

## 5. 必须通过的验证

列出 `EXT/tests/*.test.ts` 后，使用 Node 测试运行器执行全部测试；Shell 不展开通配符时逐个传入绝对路径：

```bash
node --test "<EXT>/tests/approval-ui.test.ts" "<EXT>/tests/audit.test.ts" "<EXT>/tests/external-approval.test.ts"
node "<EXT>/tests/integration.mjs"
node "<EXT>/compat/install.mjs"
```

以实际目录为准，不能漏掉新增测试。集成检查要覆盖：

- Pi 真实加载器能够加载审核扩展；
- 内置、自定义、空 extensions 的代理均注入；
- denyExtensions 冲突和加载缺失时拒绝；
- 旧恢复描述进入实际创建工厂时仍注入；
- 两种外部 runner 实际入口请求确认，拒绝后不继续；
- MCP 逐次审批，不缓存会话级授权。

测试中的 `PI_AUDIT_HOST_ROOT` / `PI_AUDIT_PLUGIN_ROOT` 应指向实际依赖。需要时复用当前上游 runner 的依赖 alias 解析，不能因缺失模块而绕过测试或换运行协议。修改 TypeScript 时补充类型检查，复用本机 Pi 和 TypeScript，不在业务仓库安装依赖。

这些测试使用模拟 SDK/确认回调，不等于完成在线代理验证。如需真实冒烟测试，须用户同意可能的模型费用和外部启动；子代理执行遵守当前 subagent 工具的发现、编排及失败处理协议。失败不切换为其它 CLI/前台代理“继续验证”。

## 6. 失败处理与回滚

任一步失败，停止后续启动，报告：失败命令/错误、当前磁盘版本、补丁状态、当前会话仍加载旧模块的可能性、备份路径、业务仓库状态。未启动真实子代理时明确说明“没有代理 run”。不要把失败解释为可无审核继续执行。

回滚先确认没有新任务，使用本次备份恢复一致的一组“旧包 + 旧审核器 + 安装记录”。保留失败现场；优先移到本次备份目录而不是直接删除。若更新改变了 npm 清单或传递依赖，还必须恢复与旧版本匹配的依赖状态，不能只复制旧包或只恢复 lockfile 就宣称完成。

恢复配置前比较升级前后差异，保护期间用户新增的设置。先验证恢复后的哈希和测试，再完整重启 Pi。若无法安全恢复，应请求用户处理，不反复盲装。

## 7. 交付

更新 `EXT/README.md` 的已验证版本和升级记录，不固定编造测试数量。最终说明：

- 当前版本 → 目标版本，实际安装版本；
- 修改的补丁及保留的审核行为；
- 测试结果、是否有真实在线验证；
- 备份目录、残余风险及回滚入口；
- **必须完整退出并重启 Pi，不能只 `/reload`**；旧后台进程不会自动获得新代码。

升级任务结束前再次检查业务仓库状态，确认没有顺带修改业务代码。
