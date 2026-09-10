# Pi 全局命令审核扩展

安装目录：`~/.pi/agent/extensions/pi-command-audit/`。

## 安装与仓库内容

将本仓库克隆或复制到上述目录。需要已安装 Pi，以及兼容版本的 `pi-subagents`；MCP 功能需要支持审批事件的 `pi-mcp-adapter`。此项目不自动安装依赖，也不自动给未知版本打补丁。

在启动子代理前，检查支持版本并手动执行：

```bash
node ~/.pi/agent/extensions/pi-command-audit/compat/install.mjs
```

`compat/installed.json` 和 `compat/originals/` 由安装器在本机生成，**不随仓库发布**。不要从其它机器复制安装记录，否则其中的绝对路径与实际环境不匹配。

`.gitignore` 排除了补丁安装记录、上游源码备份、运行配置、认证文件、日志、会话、升级备份、依赖及构建产物。默认配置示例见下文，真实密钥不得加入仓库。

首次安装及子代理兼容补丁变更后，必须完整退出并重启 Pi；`/reload` 不足以清理已经导入的依赖模块。先结束已有后台任务，旧进程不会自动获得新审核器。普通审核配置变更可以 `/reload`。扩展不注册 AI 可调用的关闭、授权或白名单修改工具。

## 工作方式

1. 在 Pi `tool_call` 事件执行前审核工具完整参数。
2. 精确匹配的少量低风险命令直接通过；已知磁盘破坏及部分凭据访问直接拒绝；删除、提权等风险操作请求人工确认。
3. 其它操作使用 `ctx.modelRegistry.complete()` 单独调用审核模型，没有工具权限，不递归调用 subagent，也不发送完整会话历史。
4. 模型严格返回 `allow / ask / deny`。格式错误、异常、取消、超时、配置错误、日志写入失败均不执行。
5. `ask` 在有 UI 的会话中逐次确认；关闭弹窗、超时或无 UI 均不放行。没有自动转交父代理批准的机制。

这里只给出了风险控制辅助层，不是可证明安全的 shell 解析器，也不是沙箱。模型可能误判；规则只覆盖部分已知风险。需要强隔离时使用独立账户、容器/虚拟机及网络和文件访问控制。

## 命令

```text
/command-audit
/command-audit test git status --short
/command-audit test git push origin main
```

`test` 只审核文本，不执行命令，也不弹出执行批准对话框。

## 后续 Subagent 升级技能

扩展内提供 `skills/command-audit-subagent-upgrade/SKILL.md`，通过 `resources_discover` 注册，无需另外修改全局 settings。

添加此技能后执行 `/reload`，即可使用：

```text
/skill:command-audit-subagent-upgrade
/skill:command-audit-subagent-upgrade 升级到指定版本并保留审核补丁
```

也可以直接提出“升级 pi-subagents 并适配命令审核补丁”，由 AI 按技能描述选择加载。技能规定了活动任务检查、独立备份、新版源码比较、版本锁定补丁适配、回归测试、失败回滚和完整重启流程；它本身不授予权限，也不会自动升级或跳过人工确认。

## 审批显示与结果

状态栏使用 Pi 当前主题的语义色，不写死 RGB：`审核 · 放行 N · 拒绝 N · 取消 N`。放行使用 `success`，拒绝使用 `error`，取消使用 `muted`，零值使用 `dim`。

统计按最终结果而不是初审分类：人工同意计入放行，人工拒绝计入拒绝，Esc/取消和确认超时计入取消。外部 runner 启动确认也计入当前父会话统计；委派工具审核与实际外部启动确认是两个独立审批点。重载会重置计数。

审批使用 Pi 原生选择器，选项为“拒绝本次 / 允许本次”，默认选中拒绝。明确拒绝、Esc、超时和无 UI 分别反馈。用户拒绝使用普通提示，而不是黄色 Warning，并明确说明“用户已拒绝，未执行”，不再重复“需要人工确认”的初审理由。

工具被阻止后，Pi 原生工具卡片仍可能显示错误背景，因为工具确实没有执行；插件不把拒绝伪装成成功。该卡片中的文字会说明最终原因。普通审核日志保留 `decision`，新增 `outcome`（如 `user_denied`、`timeout`），以 `allowed` 表示是否放行。外部通道的 runner 侧失败文本仍为统一的“未获人工批准”，父界面会展示具体审批结果。

本次仅修改扩展显示与结果处理，执行 `/reload` 可加载；若旧后台任务仍在使用确认通道，建议先结束它们再重载。

## 全局配置

文件：`~/.pi/agent/command-audit.json`。若设置了 `PI_CODING_AGENT_DIR`，则使用该目录。

```json
{
  "model": "current",
  "timeoutMs": 30000,
  "confirmTimeoutMs": 60000,
  "maxInputChars": 24000,
  "mcpAllow": []
}
```

- `model: "current"`：使用当前会话模型和 Pi 已配置的认证。每个子会话使用自己的当前模型。
- 可固定审核模型：`"model": {"provider":"你的 provider", "id":"你的模型 ID"}`，支持模型 ID 内含 `/`。不需要复制 API Key。
- `timeoutMs`：模型审核超时；`confirmTimeoutMs`：人工确认超时，单位毫秒。
- `maxInputChars`：参数及脱敏后的审核请求上限。超限直接拒绝，不截断后放行。
- `mcpAllow`：精确匹配服务器名和原始工具名，例如 `[{"server":"idea","tool":"get_file_problems"}]`。只有确认该工具所有允许参数都符合预期时再添加；名称像只读不代表安全。
- 配置修改后执行 `/reload`。已有后台子会话持有自己的配置快照，需要结束后重新启动才会使用新配置。

默认只有 `pwd`、`git status`（可带 `--short` 或 `--porcelain`）、`git diff --stat` 等整个命令精确匹配时免模型审核。复合命令、重定向、脚本不会因相同前缀直接通过。工作区环境、PATH、Git 配置仍属于用户信任边界。

模型审核增加延迟和 token 成本。审核是独立的 provider 请求，不计入普通工具返回的 usage；以 provider 账单为准。请求包含脱敏后的工具参数和工作目录，不包含完整会话或凭据文件内容。常见手机号、身份证格式和令牌字段会脱敏，但脱敏并不完备；不要发送不允许交给所选 provider 的数据。

## MCP 支持

已验证本机 `pi-mcp-adapter 2.32.1`、`pi-subagents 0.67.0`（兼容安装器同时保留 0.66.0 支持）。针对 MCP 适配器同步认领：

```text
pi-mcp-adapter:tool-approval-request
```

每次真实执行前审核 `serverName + originalToolName + args`，覆盖：

- `mcp({ tool, args })`
- 直接注册的 MCP 工具
- `mcpScript` 内 `tools.call()` 和直接工具调用，包括循环和并行调用
- MCP 资源及 iframe 发起的调用

只返回 `allow_once` 或 `deny`，从不返回 `abstain` 或会话级授权。外层 `mcpScript` 不进行重复审核，依赖适配器逐调用审批；普通 MCP 元数据发现不消耗审核模型。直接注册的 MCP 工具可能同时经过 Pi 通用审核和 MCP 审批，因此会额外审核一次。

**兼容前提**：适配器必须支持上述审批事件。当前本机实际审批实现已通过集成检查。不能将此扩展直接用于没有该事件的旧适配器，否则脚本/代理调用无法逐次拦截。其它先认领同一事件的权限扩展，以及已经存在的 MCP 会话审批缓存，会影响本扩展的覆盖；启用时使用 `/reload` 清理旧运行时，避免并用自动批准 broker。

本扩展不拦截 MCP 连接时由可信配置启动的服务器进程、凭据获取程序，也不控制服务器内部继续执行的子操作。`mcpScript` 自身是可信脚本环境，不是安全隔离边界。

## Subagent 支持与限制

不再维护内置代理名称名单，也不要求用户给自定义代理逐一配置。已删除第一版增加的六项 `agentOverrides`。

由于已检查的 `pi-subagents 0.66.0/0.67.0` 没有全局强制子扩展的公开接口，本实现使用**版本锁定的本地兼容补丁**，不是上游官方功能：

- `child-tool-plan.ts`：所有原生代理启动计划统一加入审核器，包含内置、用户自定义、项目代理和运行时注册代理。
- `child-session.ts`：实际创建子会话时再次确保注入，兼容没有审核器路径的旧恢复描述；加载后检查审核器及其事件处理器确实存在。加载失败时在模型运行前阻止启动。
- `external-cli-runner.ts`、`external-job-runner.ts`：实际执行入口先等待人工确认，明确同意后才继续原来的启动逻辑。普通模型审核通过不能替代这次人工确认。

前台、后台、嵌套和工作流中的原生代理使用共享创建路径；`extensions: []` 或其它白名单不移除强制审核器。`denyExtensions` 与强制审核冲突时直接拒绝启动，而不是绕过原有能力限制。后台子会话若加载 MCP 适配器，同样使用逐调用审批。

原始依赖文件按版本备份在 `compat/originals/<版本>/`（旧版备份仍保留在 `compat/originals/`）；补丁源、SHA-256 和安装记录在 `compat/install.mjs`、`compat/installed.json`。安装器在写入前检查全部原文件，不能给未知版本盲打补丁。每次原生子会话创建前核对补丁完整性；普通 `subagent` 工具入口也会检查，校验失败时阻止委派。

当前兼容补丁支持 0.66.0 和 0.67.0。升级时应按随附 Skill 建立独立的本地备份并运行测试。当前会话中已导入的旧模块不会因磁盘文件更新而替换，必须完整重启 Pi。

**升级注意**：包管理器重装/升级可能覆盖本地补丁。普通工具入口会报告校验失败，但插件无法保证已经升级且绕过该入口的可信扩展/RPC 仍受保护。升级后必须停止使用子代理，重新适配并测试兼容补丁，再完整重启；不要认为全局扩展能够约束任意第三方启动器。

当前版本首次安装兼容补丁的命令（由用户执行）：

```bash
node ~/.pi/agent/extensions/pi-command-audit/compat/install.mjs
```

再次运行会校验并保持幂等，不重复注入。当前为 v2 补丁；从 v1 手动迁移时，先使用 `compat/uninstall.mjs` 恢复原文件，再安装 v2。

### 外部 runner 人工确认

后台 runner 没有自己的交互界面，因此在有 UI 的 Pi 父会话中启动本地确认服务，后台实际执行入口通过此通道请求确认：

```text
外部 runner 准备启动 → 本机确认通道 → 父会话弹窗
                                   ├─ 同意：继续该次启动
                                   └─ 拒绝/取消/超时：不启动
```

- 弹窗展示脱敏后的可执行程序及参数或 provider/options、cwd 和任务提示，不截断后批准；过长请求直接拒绝。
- 每次实际启动都确认，包含再次调用及 external-job 的重新进入/恢复，不缓存“本会话全部允许”。批准工作流不等于批准其中的外部启动。
- 确认服务只监听 `127.0.0.1` 随机端口，以进程内生成的随机令牌鉴权；端口和令牌通过 `PI_COMMAND_AUDIT_APPROVAL` 环境变量传给后台 Pi runner，不写入配置或日志，也从最终外部 CLI 子进程环境中移除。
- 无可用确认界面、父会话退出、停止任务、超时或通道错误都不启动。确认期限使用 `confirmTimeoutMs`，从请求开始计时（包括队列等待）。多个弹窗串行展示。
- `/reload` 会关闭旧通道，已经运行的后台进程可能仍持有旧通道信息；其后续外部启动会拒绝，需要在新父会话下重新发起任务。
- 这只是**启动许可**，外部 CLI/provider 内部命令不经过本审核器，仍依赖其自身权限和沙箱；没有修改外部 CLI 的权限参数。
- 本机通道不是对同用户恶意程序的沙箱，进程环境及可信扩展仍是信任边界。外部启动的原生弹窗决定不单独写入命令审核 JSONL；原有工具审核记录及子代理运行记录保持不变。

注意：
- 任意 `workflowScript`、`workflowScriptPath`、命名 `workflow` 默认需要人工确认，不能仅批准外层脚本就认为内部全部受控。`runs.host`、acceptance gate、worktree setup hook 等扩展直接启动的主机命令不会经过子会话 `tool_call`，必须单独核对。
- 无 UI 子会话遇到需要确认的操作会被阻止，返回原因；不会把父代理视为人类批准者。
- 审核器不会尝试修复失败子代理、改变运行模式或调用外部 CLI 绕过失败。

## 其它边界

- 用户手动输入的 `!` / `!!` 命令不审核，便于用户维护配置。
- 普通 AI `write/edit` 不能直接修改 Pi 全局目录；模型规则还会检查 shell/MCP 中的配置修改，但这不是完整的自修改防御。
- 已加载的可信扩展使用 `pi.exec`、Node 文件 API 或进程 API 的内部操作不一定触发工具事件。其它后置事件处理器也可改变参数。插件不能防御同进程的恶意扩展。
- 日志只记录时间、会话 ID、类型、请求 SHA-256、初审决定、最终结果分类和是否放行，不记录原始参数、路径、工具名、理由或对话。位置为 `~/.pi/agent/command-audit-logs/YYYY-MM-DD-PID.jsonl`。日志没有自动清理，按需由用户清理；Windows 权限取决于父目录 ACL。

## 验证

```bash
node --test ~/.pi/agent/extensions/pi-command-audit/tests/*.test.ts
node ~/.pi/agent/extensions/pi-command-audit/tests/integration.mjs
```

单元测试不执行被审核的示例命令、不访问真实业务数据、不调用在线模型。集成测试使用本机真实 Pi 加载器、subagent 发现/启动计划、子会话创建工厂及 MCP 审批实现；工厂 SDK 为测试替身，不实际启动代理或连接服务器。覆盖自定义代理、空扩展列表、加载缺失、能力冲突、旧恢复描述，以及外部 runner 的逐次确认、批准、拒绝、取消、超时和鉴权失败。未真实启动 Codex/Claude/Cursor CLI，也未进行在线模型验证。

测试需要支持直接运行 TypeScript 的 Node.js（建议 24 或更高版本），集成测试还需要先在当前目录安装兼容补丁。部分单元测试依赖补丁完整性校验，因此不能在没有本机安装记录的全新克隆中直接运行整套测试。

`integration.mjs` 从 `PI_AUDIT_HOST_ROOT`、`NODE_PATH` 或 `npm root -g` 定位宿主包所在的 node_modules；插件依赖默认位于 Pi 全局目录的 `npm/node_modules`，可通过 `PI_AUDIT_PLUGIN_ROOT` 指定。非标准安装方式请显式设置这两个目录，仓库不包含任何用户机器的硬编码路径。

## 停用/卸载

先结束已有子代理，再由用户执行：

```bash
node ~/.pi/agent/extensions/pi-command-audit/compat/uninstall.mjs
```

卸载器验证当前补丁及原始备份后恢复四个依赖文件；依赖已升级或被修改时拒绝覆盖。然后移走整个 `pi-command-audit` 目录并完整重启 Pi。**不能只删除扩展目录**，否则补丁的导入路径失效会影响 pi-subagents 加载。保留或清理 `command-audit.json`、`command-audit-logs` 由用户决定。
