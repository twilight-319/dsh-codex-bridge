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

安装 DSH 插件**不等于**已经给 Codex 注册 MCP。需要在 Codex 的 MCP 设置中添加一个 stdio 服务器：

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
