# Codex × DSH bridge 2.0 RC

当前源码候选 **2.0.0-rc.4 / Codex 包装 0.7.0**：增加父子任务依赖调度、最多两个DSH执行者、真实隔离worktree、统一预算和节点修复，以及内容冲突检测、统一集成与审查。见[大任务协作调度](docs/WORKFLOW_SCHEDULING.md)。尚未安装到当前运行环境或作为稳定版发布，真机及真实费用验收未完成，发布状态仍为NO-GO；下文rc.3及rc.2保留各轮背景。

本地开发候选 **2.0.0-rc.3 / Codex 包装 0.6.0**：新增 direct/planned/reviewed 执行模式、完成/待处理长等待、默认精简 MCP 结果、DSH 事件用量和阶段耗时。说明与限制见[减少协调开销](docs/EFFICIENT_EXECUTION.md)。尚未发布、安装或完成真实额度对照验收；以下 rc.2 / 0.5.0 内容保留原发布背景，不能作为新候选已上线的证明。

工程收尾候选 **2.0.0-rc.2**，发布仍为 **NO-GO，等待固定 RC 的真机复验**。新增任务工作台、只读 doctor、旧记录导入、备份恢复与发布证据检查。左侧 Codex → **任务** 即可进入。

`main` 当前为 **2.0.0-rc.4 开发候选**，合并远端任务工作台/诊断/导入与本地长任务/维护/调优能力；不是正式 2.0.0 稳定发布。复验或安装时固定完整 40 位提交 SHA。原收尾开发记录见 [`feat/task-core-beta1` / PR #1](https://github.com/twilight-319/dsh-codex-bridge/pull/1)。升级前使用 maintenance begin 排空，不要重载在途任务，并按发布验收文档备份。

- [2.0 使用 升级与发布验收](docs/V2_RELEASE.md)
- [Beta 1 阻断与复验记录](docs/BETA1_RETEST.md)
- 默认 `npm run release:check` 会拒绝发布，直至提供绑定当前提交的完整验收证据。

## 2.0 核心能力与兼容接口

Beta 1 候选实现，保留 1.x 三个 MCP 工具。新增持久化任务接口、幂等、取消与对账、验证证据，以及显式驱动的执行 → 验证 → Codex 审查流程。Windows DSH 真机联调仍是发布门槛，不能用离线测试代替。

## 合并保留的任务调优与长任务能力

新增任务调优首版：授权1～2模型池、Codex分项模型/档位/预算选择、只读preview、提交冻结与四层审计、项目隔离历史预算建议。异步submit现支持reasoningEffort（含授权max）、provider/model及tuning；模型/档位冷启动使用明确用户标签，不假称已历史学习。参见[任务调优规格与用法](docs/TASK_TUNING.md)。

在已提交修复 1593821 上增加长任务与维护保护：**复杂任务用异步submit（默认30分钟、可配上限2小时）+ wait短查询，不再用旧同步10分钟接口承接整项目**。wait超时或断线不取消后台；answer后台继续。更新前maintenance begin关闭新准入，忙时拒绝更新且不取消已有工作。详见[长任务与安全维护](docs/LONG_TASKS.md)。

旧 2.0.0-beta.1.2 修复说明：

前两轮候选真机验收仍为 NO-GO。本轮补充 R01/R02/R03：保留原生 aborted 事实，按持久化意图派生取消/超时结果；运行预算先写取消意图再中止；恢复对账补发尚未落实的取消请求。此候选修复 BETA1-01/02/03：有界宿主观察信号、派发后异常的停止证据判定、待答预算取消与资源约束，并隔离旧候选可能提前标记 FAILED 的记录。复验前仍不具备发布通过结论，详见 [复验清单](docs/BETA1_RETEST.md)。

新任务总预算包含人类等待，等待时仍计时；过期会请求取消，未确认停止时保持 RECONCILING。旧三工具的原生提问等待沿用问题 TTL，合法 dsh_answer 获得新的执行预算。观察错误保留在 run.observationError，不再静默折叠为 null。

## 任务接口

- `dsh_task_submit`：`goal`、`idempotencyKey` 必填；可传 `cwd`、`plan`、`acceptance`、`verificationProfile`、`review`、`timeoutMs`。
- `dsh_task_get / list / events`：查询快照、分页列表、增量事件。`events` 使用全局 seq 游标。
- `dsh_task_answer`：传 `taskId`、`runId`、当前 `requestId` 和 `answers`，继续同一个 Run。
- `dsh_task_cancel`：取消明确的任务，已请求与确认停止分别记录。旧 `dsh_execute` 的 MCP 取消通知也会转发。
- `dsh_task_reconcile`：核对绑定会话和本轮终止事件；存在未完成取消意图时会补发取消并再次观察，不重新派发原任务。
- `dsh_task_retry`：终结后显式创建修复 Run；传 `taskId`、新 `idempotencyKey`、可选 `goal`。最多两轮修复，历史保留在 `history`，不允许跳过未解决的对账。

```json
{"goal":"修复失败测试","cwd":"<ABSOLUTE_PROJECT_DIRECTORY>","idempotencyKey":"fix-20261116-001","plan":"先复现，再修复并验证","acceptance":["目标测试通过"],"review":true}
```

先前没有返回任务编号时，重复使用同一幂等键查询原提交；不要生成新键盲目重跑。同键不同输入明确冲突。客户端断线不等于任务失败。异步运行预算默认30分钟，允许1秒至配置上限（硬上限2小时），包含排队、准备和等待；修复 Run 继承原预算并有新deadline。旧同步工具仍最多600秒。兼容的旧 dsh_answer 按原契约重新分配本次回答后的执行预算。

## 验证与审查

在插件 `config.verificationProfiles` 中由用户预先配置验证，任务只能引用配置名称。例如：

```yaml
verificationProfiles:
  build-output:
    files:
      - path: dist/index.js
        # 可选 sha256，省略则只验证文件存在且有界
    commands:
      - argv: [npm, test]
        timeoutMs: 30000
```

文件验证限制在真实工作目录内，拒绝越界和超过 10 MiB 文件；记录字节哈希。命令仅交给可信宿主 `bridgeVerification.run` 能力，不回退到通用 shell。当前已知宿主没有确认该扩展能力，命令验证会显示 `unavailable`。模型输出不会被当成测试退出码。

未配置验证、证据不可用或审查未通过时，执行完成仍为 `REVIEW_REQUIRED`；明确失败的检查为 `FAILED`。`review:true` 使用现有 Codex 参谋进行只读审查。`plan` 与验收条件由调用方提供；后台不自动规划或无限修复。

人工接受仅开放在浏览器认证路由 `POST /api/dsh-codex-bridge.v2.tasks.review`，需要 `taskId/runId/expectedRevision/evidenceHash/decision`；decision 为 `accept` 或 `changes_requested`。它不作为 MCP 授权工具开放。当前 RC 已提供任务工作台入口。

## 存储和恢复

任务数据位于 `~/.dsh/codex-bridge/tasks-v2/`。事务逐次 fsync、校验和链、4 MiB 日志分段，快照仅为派生缓存。单写入锁拒绝多个 DSH 宿主同时使用同一任务库。异常退出残留锁时，必须先确认原宿主停止、备份目录，再移除 `writer.lock`；不自动按 PID 猜测接管。

不完整日志尾部隔离后恢复；完整记录损坏时拒绝写入。重启后所有未终结任务进入 `RECONCILING`，原问答失效。只有绑定会话本轮游标之后的终止事实能确认执行结果；不保证任意外部副作用的恰好一次执行。项目写任务在桥内串行，不阻止外部编辑器写入。

模型与权限沿用现有 DSH 策略，在实际会话接纳时记录已解析策略快照；队列期间策略变更会影响尚未接纳的任务。审批继续在 DSH 原生会话处理。旧会话日志仍作为兼容展示来源，不推测历史父子关系。新数据不会覆盖 1.x 文件。

## 验证范围

`npm test` 包含两轮验收回归、任务核心、真实 MCP stdio 到本机 HTTP 线路、实际 sessionController 适配器集成测试及原 11 组回归。CI 使用 Windows Node 22/24。安装包继续零运行时依赖、无安装和构建脚本。

Beta 1 发布前仍需在目标 Windows DSH 验证：新建/复用、取消与真实命令停止、连续问答、原生审批后对账、插件重载、日志文件持久化、Codex 审查，以及明确授权的验证能力。通用 DAG、自动并行隔离、长期记忆、智能路由和完整工作台已在 RC 提供，其 DSH 真机视觉验收仍待完成。

---

# Codex × DSH bridge

Codex 负责规划与决策，DeepSeek Harness（DSH）负责本机执行。零运行时依赖，无安装/构建脚本，不修改 DSH 或 Codex 官方文件。

## 功能

- 全局栏只保留 **Codex** 工作台，旧版「Codex 桥」页面已移除。
- 查看本机 Codex 对话（只读）、执行记录与模型来源；完整消息、工具输出和轨迹使用 **打开 DSH 原生会话**。
- `dsh_execute`：默认新建会话，可用 `sessionId` 复用上下文；不同会话并发，同会话冲突明确拒绝、不排队。
- `dsh_answer`：把 DSH 的问题交给 Codex 代理提问，支持连续问答，避免来回切软件。
- 执行模型取实时 DSH 模型目录，支持跟随默认/固定模型，以及继承/固定/允许范围内自适应思考强度。
- DSH 中通过 `codex_plan / codex_decide / codex_review / codex_ask` 咨询只读 Codex 参谋；桥接执行会话禁止反向递归。

## 前提

- 已安装并运行 DSH。已验证宿主：Windows Desktop DSH `0.2.2-rc.3`；其他版本和平台未完成真实验收。
- Node.js **22 或更新版本**，用于启动 Codex 侧的 MCP 服务。
- 要使用工作台 Codex 对话与参谋工具，需自行安装并登录 Codex CLI，确保 DSH 进程可找到原生可执行文件。Windows 自动检测常见 npm 安装；也可在 DSH 启动环境中设置 `CODEX_BRIDGE_CODEX_EXE` 为本机原生 Codex 路径。
- 使用者自行配置 DSH 模型与 Codex 认证。此仓库不包含账号、API key、代理、模型额度或 Codex App 预安装包。

## 在 DSH 插件界面安装

1. 打开 DSH → **插件** → **添加插件**。
2. 粘贴以下地址，安装：

   ```text
   https://github.com/twilight-319/dsh-codex-bridge.git
   ```
3. 检查插件安装结果；如果提示需要重启，按提示重启 DSH。
4. 左侧会出现唯一的 **Codex** 入口。

为了复现安装版本，也可以在输入框使用完整提交固定的 Git spec：

```text
git+https://github.com/twilight-319/dsh-codex-bridge.git#FULL_40_CHARACTER_COMMIT
```

将提交值替换为本仓库中的实际完整提交 SHA。分支/标签安装也由 DSH 支持，但固定提交更容易审计。GitHub 网络可达不等于安装一定成功，实际以 DSH 插件管理结果为准。

> 从旧版升级：第三方插件通常先卸载再安装新来源，以 DSH 提示为准；不要同时安装两份同名包。插件重载会取消在途、待答和待审批任务，请先停止使用执行桥再升级。升级完成后重连 Codex MCP。

## 将 MCP 接入 Codex

安装 DSH 插件**不等于**已经给 Codex 安装执行桥。推荐使用本仓库的公开 Codex marketplace（包含异步技能与自包含MCP，无作者绝对路径，无需npm发布）：

```text
codex plugin marketplace add https://github.com/twilight-319/dsh-codex-bridge.git --ref main
codex plugin add dsh-bridge@dsh-bridge
codex plugin list
```

然后完全退出并重新打开Codex App，先只调用`dsh_status`。Codex包装插件版本0.7.0，DSH源码候选为rc.4；详见[完整双端安装、升级与排错](docs/CODEX_INSTALL.md)。旧`dsh-bridge@personal`应确认后单独移除，避免重复服务器。

如果不用插件市场，也可手工在 Codex 的 MCP 设置中添加一个 stdio 服务器（此方式不自动提供技能，不要与上述插件同时注册同名服务器）：

```json
{
  "mcpServers": {
    "dsh_bridge": {
      "command": "node",
      "args": ["<ABSOLUTE_PLUGIN_DIRECTORY>/bin/mcp-server.mjs"]
    }
  }
}
```

这是通用 stdio 配置形状，按你的 Codex 客户端界面填写。`<ABSOLUTE_PLUGIN_DIRECTORY>` 是当前机器上插件的安装目录，不能照抄其他人的路径。也可以单独克隆本仓库，使用克隆目录下的 MCP 入口，无需 `npm install`。

Codex CLI 可注册：

```text
codex mcp add dsh_bridge -- node <ABSOLUTE_PLUGIN_DIRECTORY>/bin/mcp-server.mjs
```

在客户端为耗时工具配置足够的调用超时（建议至少 620 秒）。是否自动批准 MCP 工具应由用户在客户端配置，插件不改 Codex 全局配置。最后重连 MCP，先调用 `dsh_status`。

## 权限与模型

**新安装默认沿用 DSH 的默认权限，不自动提升权限。** 原本保存过的模型/权限政策保持不变，升级不会覆盖。

「Codex → 执行模型」可选：

- 沿用 DSH 权限：保留 profile 预设，可能遇到审批。
- 不询问：保留沙箱，拒绝需要人工批准的操作，不等同完全权限。
- 完全权限：需主动确认，允许当前用户账户范围的本机读写与命令。只向可信任务开放。
- Auto：只有 DSH 当前提供 `auto` 预设时可选，其 reviewer 可能拒绝操作。

审批目前不转发给 Codex；409 等待审批时打开 DSH 原生会话处理，不要重新提交原任务。Auto 预设可发现与策略调用有测试，reviewer 的所有行为不在兼容承诺内。

## 执行与问答

新建任务：

```json
{ "task": "检查仓库并补测试", "cwd": "<ABSOLUTE_PROJECT_DIRECTORY>", "timeoutMs": 300000 }
```

复用（只接受本桥创建的会话）：

```json
{ "task": "继续修复刚才的失败用例", "sessionId": "session-...", "timeoutMs": 300000 }
```

复用沿用原目录、模型和权限，勿同时传 `cwd / reasoningEffort / reason`。不同任务可不传 sessionId，以独立会话并发。

如果返回 `needsInput=true`，将 `question.questions` 原样呈现给用户，使用**本次** `question.requestId`：

```json
{
  "sessionId": "session-...",
  "requestId": "<CURRENT_QUESTION_REQUEST_ID>",
  "answers": [{ "id": "choice", "selected": ["原选项label"] }],
  "timeoutMs": 300000
}
```

也可用 `custom` 自由文本。每个问题一项；空 `selected` 且无 `custom` 表示跳过，绝不代表同意。旧 requestId、重复答案及非法选项/类型会拒绝，当前合法问题仍待答。回答后可能返回下一问，继续使用最新 requestId。

## 失败、安全与隐私

- 执行动作发生在用户本机，不是模拟。完整日志保留在 DSH 原生会话。
- `dsh_status` 只读；执行/回答失败通过 MCP `isError` 返回，已知时附 sessionId。
- 只有本次调用游标后的 `turn/end completed` 才成功。它表示会话正常结束，不保证业务验收全部通过，应在任务中明确验收标准。
- POST 不自动重试。断网可能意味着结果未知，先查原会话，不要重复执行有副作用的任务。
- 执行预算含准备阶段；15 分钟提问等待另计，回答后使用新的执行预算。
- HTTP 仅连接严格 loopback，不跟随重定向；每次重读 origin/token，不写死端口。不要把端点暴露公网或把 token 发给他人。
- 插件自有数据位于用户主目录的 `.dsh/codex-bridge/`，包含执行政策、令牌、发现文件、运行记录与台账；这些不属于发布仓库。正常顾问与执行按各自服务商的模型协议处理内容。
- 工作台读取本机 Codex 会话；只在可信本机环境使用，不适用于无隔离的多租户部署。按目录展示相关执行，不假造 Codex 父子会话关系。
- 多 DSH 实例共享发现文件，最后发布者生效；暂不提供实例选择。

## 测试与兼容范围

```text
npm test
npm pack --ignore-scripts --dry-run
```

离线测试覆盖事件游标、互斥、连续提问、防旧答案、超时/卸载竞态、模型政策、端点鉴权与发现、只读工作台和模型设置。无需下载依赖或调用模型。GitHub Actions 在 Windows 的 Node 22/24 运行这些测试；CI绿灯不等于其他操作系统已做真实验收。

真实联调已验证会话新建/复用/并发、受控文件写入与命令读回、连续两问、迟到答案拒绝和超时。当前缺少可信像素截图，因此不宣称亮暗主题及窄屏视觉验收全部通过。

## 1.0.1

- 移除旧版「Codex 桥」侧栏和页面注册，只保留新版工作台。
- 新安装权限改为 inherit，避免公开分发时静默提权；既有政策不修改。
- 独立白名单整理公开源码，排除私人记录、备份、截图与本机配置。
- 源码即安装包，无 prepare/postinstall 构建脚本。

MIT License。非 DSH 或 Codex 官方插件。
