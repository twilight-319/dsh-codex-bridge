# 长任务与安全维护（2.0.0-beta.1.3）

## 为什么不继续使用旧同步调用

旧 `dsh_execute/dsh_answer` 是同步兼容接口，最多600秒，预算到期会请求取消；它不是“仅客户端等待600秒”。复杂跨模块修改、构建或多轮测试应改用异步Task接口，不能以相同内容新建任务来猜测重试。

## 推荐调用方式

1. 拆成清晰的小阶段，每阶段写明输入、不可修改区域和验收命令。规划和前端/后端并行要明确各自写文件范围，避免两个执行者同时改同一批文件。
2. `dsh_task_submit` 立即接纳，复用幂等键查询同一提交。后台总预算默认30分钟，显式timeoutMs可以更低或更高。
3. `dsh_task_wait` 短等变化；返回后按同taskId和最新revision继续等，不重派。
4. 收到WAITING_INPUT时调用`dsh_task_answer`，该工具立即返回快照，后续继续wait；别再同步等待整段执行。
5. 结束时检查验证/审查，不把模型自述当测试证据。REVIEW_REQUIRED不是验收通过。

```json
{"goal":"仅修复部门合法性规则及其JUnit测试，不改前端","cwd":"<PROJECT>","idempotencyKey":"departments-stage-001","timeoutMs":1800000,"acceptance":["指定测试通过","给出未完成项"]}
```

```json
{"taskId":"task-...","runId":"run-...","afterRevision":7,"waitMs":10000}
```

等待时间`waitMs`范围0~25000，默认10000；wait超时/断线/客户端取消只结束等待，不取消后台任务。明确停止用`dsh_task_cancel`。`dsh_task_submit/answer`的HTTP接纳时间与后台预算分离。

后台预算包括排队、准备、用户等待、执行和验证，是有限wall-clock预算，不自动续期、不无限重试。耗尽时持久化budget-exhausted并请求取消，停止未确认时仍RECONCILING，不能放行同项目新写任务。已接纳的旧任务deadline不因升级被自动延长。

插件配置（不是顾问工具的timeoutMs）：

```yaml
taskDefaultTimeoutMs: 1800000
taskMaxTimeoutMs: 7200000
```

必须满足`1000 <= taskDefaultTimeoutMs <= taskMaxTimeoutMs <= 7200000`，错误配置拒绝启用；不以静默裁剪来掩盖错误。默认上限2小时。权限和模型政策不变，延长预算不等于提权。

## 可信活动而不是假进度

`task.run.progress`记录本轮baseline后的真实事件序号seq、eventType、首次在本机观察该活动的时间lastActivityAt，以及observedAt。首次观察时间不是宿主事件的精确发生时刻。仅新事件推进，限频落盘；没有消息时不会制造百分比或“预计几分钟完成”。可用events接口看持久任务阶段，完整工具轨迹仍在原生DSH会话。

## 安全维护

更新前先运行：

```text
node tools/maintenance.mjs begin
```

begin先关闭新任务准入，再检查已有任务、队列、待答、待审批、RECONCILING及adapter准备/清理工作。忙则exit2/HTTP409并显示任务摘要和维护token；**保持draining、不取消任务**。已有排队任务继续，已有任务可回答/取消/对账。同键已接纳提交可返回原任务，但不能新建或retry。

等待用户业务自然结束或由用户决定如何处理，反复begin直到ready:true。在持有维护期间新准入保持关闭；此时才允许通过插件管理器停止/同步源码/重载。更新失败想恢复接纳时，先确认无需再重载，然后：

```text
node tools/maintenance.mjs end <TOKEN>
```

重载新manager后维护内存闸门自然结束，不需要沿用旧token。维护token不是Bearer令牌，不要混用。直接status为只读预检，只有begin能消除“检查空闲后又来了提交”的竞态。

**边界：官方plugin_manager直接toggle、升级、宿主退出或崩溃仍可绕过该握手。插件不能阻止外部卸载。** 本工具不伪装成系统级重载锁，也不自动调用插件管理器。维护脚本退出非零时必须停止更新，不能强行取消来腾空。

首次从没有维护接口的旧版本升级，只能先明确暂停Codex使用桥接、只读核对无非终态任务，再停旧插件并确认writer.lock释放；不能声称旧版本也已有准入闸门。

## 兼容性

- 旧同步执行/回答预算仍<=600秒，不偷偷延长旧工具。
- 旧dsh_answer回答异步任务时保留该Task原deadline，不得借旧入口延长或截短异步总预算。
- task_answer从“等待本轮结束”改为“后台继续并返回快照”，是Beta任务接口改进；客户端必须重连刷新工具表。
- 新增wait及maintenance工具，运行代码更新后旧MCP进程不会自动热更新工具表。
