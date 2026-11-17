---
name: dsh-execute
description: Delegate local file edits and commands to DeepSeek Harness through persistent tasks. Use for requested DSH execution, with optional one-time planning and review.
---

# DSH 执行桥

使用当前 `dsh_bridge` MCP 工具表，先以 `dsh_status` 核对宿主和用户政策，不读取或复制令牌。

## 选择参与程度

- 简单、范围明确的任务：`executionMode=direct`，保留用户目标和约束，让 DSH 自主执行。不为了委派而先研究整个项目，也不默认添加功能。
- 确实需要 Codex 方案：先做一次必要规划，使用 `executionMode=planned`，把已有方案放入 `plan`，交给 DSH 连续完成，避免双方重复完整调查。
- 用户要求或复杂任务确实需要额外审查：`executionMode=reviewed`。它会在执行后再调用 Codex，增加用量和耗时。没有审查需要时不选该模式。

三种模式都由 DSH 执行，不会消除当前 Codex 的初始参与。用户明确不要求测试时，不增加验证命令或模型审查；如实交付未验证状态。

## 大任务协作

只有独立分工能改善耗时或质量时，Codex先做一次必要拆解，用 `dsh_task_orchestrate` 提交 `goal/cwd/idempotencyKey/nodes`。节点需自包含目标、稳定id、`dependsOn` 和 `writePaths`；不复制整个主会话，不把强关联的小步骤拆成多个执行者。Git根目录以外的任务继续使用单任务接口。

程序在独立Git worktree中运行最多两个DSH执行者，依赖满足且产物通过范围检查后启动后继，最后统一集成与验证。并行节点修改范围不得重叠；同文件修改需先后依赖。路径是明确相对文件或目录，不支持通配符，只读节点writePaths为空。必要的共同要求写在总goal中，节点目标说明分工；需要详细参数或恢复规则时，再读相对此技能的[协作调度说明](../../docs/WORKFLOW_SCHEDULING.md)。

父任务共享有限总时限，修复不续期。默认并发2、全图修复1轮（最多2）、DSH观测调用上限40；token预算可选，观测阈值可能晚于实际请求，不是计费硬限额。按需使用 `review:true` 在集成后追加一次Codex审查，不对每个节点重复审查，也不启动GPT执行子队列。模型授权沿用用户政策。

等待、回答、取消、对账都使用**父taskId**；父 `WAITING_INPUT` 用父activeRunId与当前requestId回答。`WORKFLOW_PAUSED`先看issue和节点状态，用 `dsh_task_repair_node` 携带nodeId及稳定幂等键只修复失败节点；不通过普通retry或旧session复用绕过父预算。集成冲突或未知停止事实先对账，不重新派发或强行覆盖。普通进度不需要模型轮询。

重启后先对账已有会话与原工作区，不重跑已派发任务。工作区会保留，不自动删除；不要重载在途任务。现有日志备份工具拒绝只备份含协作任务的日志，须离线保留整个workflows-v1目录、任务库及原仓库Git元数据，不能宣称仅有日志即可恢复。

## 提交与等待

使用 `dsh_task_submit`，准备绝对 `cwd`、稳定的 `idempotencyKey`、简洁自包含的 `goal`，必要时附 `plan` 和 `acceptance`。目标、计划、验收要求合计最多20000字符，三者都会传给执行者。用户要求、必要实现和可选增强要分清，可选增强按用户选择加入。

记录返回的 `taskId/activeRunId`，优先调用 `dsh_task_await`。本插件包装已配置 `tool_timeout_sec=620`，对应 `waitMs=600000`；只有实际客户端支持该时长时使用。手工配置或未知客户端用 `waitMs=55000`，并说明兼容等待仍有调用开销。

`await`忽略普通进度，只在完成、需要回答、审批、对账或等待到期时返回。等待过期继续等同一任务，禁止重新提交。取消等待、断开连接不取消后台任务；明确停止时才调用 `dsh_task_cancel` 并核对停止事实。

默认结果为精简摘要。普通等待期间不要反复调用 `get/events` 或扫描目录；仅排查异常时读取。若当前执行环境支持程序化工具编排，可以在程序内处理重复等待，将模型参与集中在需要判断时；不要假称具备未验证的后台唤醒能力。

- `WAITING_INPUT`：呈现当前问题，使用最新 `runId/requestId` 调用 `dsh_task_answer` 后继续等待。
- `WAITING_APPROVAL`：用户到 DSH 原生会话处理，再对账，不代替用户批准。
- `RECONCILING`：先对账，不推定执行已停止、不新建任务重跑。
- `WORKFLOW_PAUSED`：定位失败节点并按全图修复上限处理；集成冲突保留原文件。
- `REVIEW_REQUIRED`：检查 `executionCompleted/verification/review`。执行完成但未验证时可以如实交付，不为改变状态而额外审查或修改。

仅需完整审计、未截断结果或调优依据时用 `dsh_task_get` 的 `detail=full`。默认摘要会标明文本是否截断。`usage`来自 DSH 真实事件；外部 Codex 规划/协调用量未知，不推算订阅额度。

## 政策与兼容

模型、档位只在授权范围内选择。显式 `provider/model` 成对，`reasoningEffort/reason` 按需，`tuning` 的同项auto不能与显式值并用。预算含排队、等待和验证；按任务设置或使用授权的自动预算，不机械写600000。

不要默认用旧同步 `dsh_execute/dsh_answer` 承接长任务；其600秒到期会请求停止。异步工具缺失时报告双端版本不匹配，不静默回退。旧短等待 `dsh_task_wait` 仍兼容。

未知提交结果用原幂等键查询；同键不同内容会冲突。重试/复用不偷偷换模型或权限，修复范围以最新文件状态和失败证据为准。更新前维护排空，不重载在途任务。
