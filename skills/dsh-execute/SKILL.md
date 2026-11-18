---
name: dsh-execute
description: Hand local implementation to DeepSeek Harness. Use for requested DSH execution, normally with a background receipt and optional one-time planning.
---

# DSH 执行桥

首次使用、连接异常或需要主动选模型时，调用 `dsh_status` 核对宿主和用户政策。沿用默认模型时可直接提交。

## 选择参与程度

- 简单、范围明确且交付标准客观的任务：`executionMode=direct`，保留用户目标和约束，让 DSH 自主执行。不为了委派而先研究整个项目，也不默认添加功能。
- 确实需要 Codex 方案：先做一次必要规划，使用 `executionMode=planned`，把已有方案放入 `plan`，交给 DSH 连续完成，避免双方重复完整调查。
- 用户要求或复杂任务确实需要额外审查：`executionMode=reviewed`。它会在执行后再调用 Codex，增加用量和耗时。没有审查需要时不选该模式。

短小且主要依赖视觉设计判断的任务，不承诺委派更省或更好。用户未明确指定 DSH 时优先由当前 Codex 直接完成；用户已指定 DSH 则照做，不擅自改执行者。视觉/动画即使只有一个文件，也应先用简短的一次性制作说明确定构图、主体特征与比例、动作接触关系，使用 `planned` 携带 `plan`、`qualityProfile=visual` 和几条交付条件；不要先研究整个项目。普通实现可按需用 `qualityProfile=implementation`。

“不测试”与“没有交付标准”是两件事。保留用户明确需求，不扩写成无关功能；不要把“不测试”自行扩大成额外限制。不得为了美化状态启动浏览器、命令或模型验收。`qualityProfile` 仅提供制作要求，不改变模型档位，不触发审查，也不证明审美达标。只在用户模型政策允许时调整模型/档位，不默认拉高到 max。

三种模式都由 DSH 执行，不会消除当前 Codex 的初始参与。用户明确不要求测试时，不增加验证命令或模型审查；如实交付未验证状态。

## 大任务协作

只有独立分工能改善耗时或质量时，Codex先做一次必要拆解，用 `dsh_task_orchestrate` 提交 `goal/cwd/idempotencyKey/nodes`。节点需自包含目标、稳定id、`dependsOn` 和 `writePaths`；不复制整个主会话，不把强关联的小步骤拆成多个执行者。Git根目录以外的任务继续使用单任务接口。

程序在独立Git worktree中运行最多两个DSH执行者，依赖满足且产物通过范围检查后启动后继，最后统一集成与验证。并行节点修改范围不得重叠；同文件修改需先后依赖。路径是明确相对文件或目录，不支持通配符，只读节点writePaths为空。必要的共同要求写在总goal中，节点目标说明分工；需要详细参数或恢复规则时，再读相对此技能的[协作调度说明](../../docs/WORKFLOW_SCHEDULING.md)。

父任务共享有限总时限，修复不续期。默认并发2、全图修复1轮（最多2）、DSH观测调用上限40；token预算可选，观测阈值可能晚于实际请求，不是计费硬限额。按需使用 `review:true` 在集成后追加一次Codex审查，不对每个节点重复审查，也不启动GPT执行子队列。模型授权沿用用户政策。

等待、回答、取消、对账都使用**父taskId**；父 `WAITING_INPUT` 用父activeRunId与当前requestId回答。`WORKFLOW_PAUSED`先看issue和节点状态，用 `dsh_task_repair_node` 携带nodeId及稳定幂等键只修复失败节点；不通过普通retry或旧session复用绕过父预算。集成冲突或未知停止事实先对账，不重新派发或强行覆盖。普通进度不需要模型轮询。

重启后先对账已有会话与原工作区，不重跑已派发任务。工作区会保留，不自动删除；不要重载在途任务。现有日志备份工具拒绝只备份含协作任务的日志，须离线保留整个workflows-v1目录、任务库及原仓库Git元数据，不能宣称仅有日志即可恢复。

## 交办回执与结果

使用 `dsh_task_submit`，准备绝对 `cwd`、稳定的 `idempotencyKey`、简洁自包含的 `goal`，必要时附 `plan` 和 `acceptance`。目标、计划、验收要求合计最多20000字符，三者都会传给执行者。用户要求、必要实现和可选增强要分清，可选增强按用户选择加入。

- **后台交办是默认方式。** `delivery=background` 受理后，告诉用户当前状态、`taskId` 和回执里的工作台入口。用户可以在 **DSH → Codex → 任务 → 按编号打开** 看进度、回答问题和取结果。当前回合在回执处结束，用户后续问起时按编号单次查询。
- **用户要求当前对话等结果时，用 `delivery=conversation`。** 如果回执已有终态，交付现有结果。如果还在执行，才用 `dsh_task_observe` 观察同一 `taskId/activeRunId`。协作任务使用父编号。默认总观察约十分钟，每次 HTTP 最多等待 55 秒，由程序续等。

## 当前对话等待细节

**有两层等待预算，必须都处理：** `.mcp.json` 的 `tool_timeout_sec=620` 只配置MCP调用；`functions.exec` 默认提前返回运行cell会再次唤醒模型，不能靠MCP设置消除。使用当前环境公开支持的外层等待参数，显式延长 `exec` 的 yield；若仍返回cell，后续 `functions.wait` 也显式延长，保留同一cell，不重新执行工具。支持以下参数的环境示例：

```javascript
// @exec: {"yield_time_ms": 620000, "max_output_tokens": 2200}
const result = await tools.mcp__dsh_bridge__dsh_task_observe({
  taskId: "task-原任务", runId: "run-原运行", observationMs: 600000
});
for (const item of result.content ?? []) if (item.type === "text") text(item.text);
```

若返回 `Script running with cell ID ...`，仅对该cell调用 `functions.wait`，显式设置其 `yield_time_ms` 为环境允许的长等待值（支持时620000），不要用1000/10000ms连续短等。外层可能钳制时长或中断；插件无法强制控制它，状态中 `clientLongWaitSupport=not-negotiated` 不代表已确认支持。不能声称“零唤醒”“零Codex额度”。遵守当前环境的响应/进度要求，有唤醒就如实计入开销。

`observation-expired`：继续观察同一任务，不重新提交。`run-changed`：先核对新的运行，不能无声追随。连接错误保留原凭据，不重复提交。工具取消或断开只结束本次观察，不取消后台任务；明确停止才调用 `dsh_task_cancel` 并核对停止事实。

`observe` 缺失时说明包装版本未更新，可退到已有 `dsh_task_await`，不是旧同步execute。已知客户端只能短调用时，用 `await(waitMs=55000)` 并如实说明协调开销；不要仅因不确定就默认每55秒返回模型。异步路由缺失必须报告双端不匹配。

默认结果为精简摘要。普通等待不反复调用 `get/events`、扫描目录或复述预计功能。不要在观察循环里输出每次HTTP超时的完整快照；由程序等待，把模型参与留给需要判断的状态。

- `WAITING_INPUT`：呈现当前问题，使用最新 `runId/requestId` 调用 `dsh_task_answer` 后继续等待。
- `WAITING_APPROVAL`：用户到 DSH 原生会话处理，再对账，不代替用户批准。
- `RECONCILING`：先对账，不推定执行已停止、不新建任务重跑。
- `WORKFLOW_PAUSED`：定位失败节点并按全图修复上限处理；集成冲突保留原文件。
- `REVIEW_REQUIRED`：检查 `executionCompleted/verification/review`。执行完成但未验证时可以如实交付，不为改变状态而额外审查或修改。

仅需完整审计、未截断结果或调优依据时用 `dsh_task_get` 的 `detail=full`。默认摘要会标明文本是否截断。`usage`来自 DSH 真实事件；外部 Codex 规划/协调用量未知，不推算订阅额度。交付时说明是否验证，不能把文件存在、执行完成或质量要求已传递描述成质量验收通过。

## 政策与兼容

模型、档位只在授权范围内选择。显式 `provider/model` 成对，`reasoningEffort/reason` 按需，`tuning` 的同项auto不能与显式值并用。预算含排队、等待和验证；按任务设置或使用授权的自动预算，不机械写600000。

不要默认用旧同步 `dsh_execute/dsh_answer` 承接长任务；其600秒到期会请求停止。异步工具缺失时报告双端版本不匹配，不静默回退。旧短等待 `dsh_task_wait` 仍兼容。

未知提交结果用原幂等键查询；同键不同内容会冲突。重试/复用不偷偷换模型或权限，修复范围以最新文件状态和失败证据为准。更新前维护排空，不重载在途任务。
