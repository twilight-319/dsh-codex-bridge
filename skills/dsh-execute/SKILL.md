---
name: dsh-execute
description: Delegates real local file edits, builds and tests to DSH. For long or multi-step work uses persistent dsh_task_submit and dsh_task_wait/get/events; reserves legacy dsh_execute for short bounded steps.
---

# DSH 执行桥

Codex 负责规划和验收判断，DSH 负责本机实际执行。使用当前工具表中 `dsh_bridge` MCP 对应的工具；先调用 `dsh_status` 核对宿主和政策，不读取或复制令牌。

## 默认走异步

跨文件修改、构建、测试、浏览器验证或时间不确定的任务，使用 `dsh_task_submit`，不要默认用旧同步 `dsh_execute`。

1. 准备自包含的 `goal`、绝对 `cwd` 和稳定 `idempotencyKey`，说明修改范围、用户约束与验收标准。
2. 根据任务显式设置足够的 `timeoutMs`，或使用 `tuning.timeoutMode=auto` 和 `taskClass`。不要机械地每次写600000。预算包含排队、准备、用户等待、执行和验证，有限且到期会取消。
3. 模型、档位只在用户授权范围内选择。可传精确 `provider/model`、`reasoningEffort` 和 `reason`；分项自动模式为 `tuning.modelMode/effortMode/timeoutMode`。显式值与同项auto冲突，不能一起传。
4. 记录返回的taskId/runId/revision；用 `dsh_task_wait` 等待变化（waitMs最多25000），之后按最新revision继续等待。短等待结束不代表后台失败；不要新建幂等键重跑。
5. `WAITING_INPUT`：将问题呈现给用户，以当前runId/requestId调用 `dsh_task_answer`，然后继续wait/get。`WAITING_APPROVAL`：请用户在DSH原生会话处理，再对账，不代替用户批准。
6. 结果不确定或连接断开：同键重放提交或查询原taskId；`RECONCILING`先对账，禁止假定原执行已停止并再次派发。
7. 仅用户要求停止时显式调用 `dsh_task_cancel`，随后确认停止事实。不要因一次wait到期自动cancel。

## 短步骤兼容

`dsh_execute/dsh_answer`保留600秒硬上限，到期会请求停止，不是仅客户端等待超时。只用在短小确定的步骤；复杂工作若异步工具缺失，报告客户端或DSH版本不匹配，不静默回退同步长任务。

## 验收与继续

- 使用 `dsh_task_preview` 可只读核对调优依据，不创建任务；preview不是执行承诺。
- 从 `run.tuning` 区分请求、建议、冻结、应用和实际请求证据；不能因为名称叫adaptive就声称已自动学习。
- `REVIEW_REQUIRED`不等于业务验证通过；核对真实文件、测试、profile和审查结果，不以模型回声代替验收。
- 旧会话复用、回答与retry沿用原模型策略；需要更换模型/档位时新建明确任务，不用自由文本假装换档。异步submit当前不暴露sessionId，不编造该字段；继续已有工作时以最新磁盘状态与已完成证据说明范围，不盲目重跑副作用。
- 汇报保留taskId/runId/sessionId、真实命令结果及未验证项。更新或关闭插件前先维护排空；不能重载在途任务。
