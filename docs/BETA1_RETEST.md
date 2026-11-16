# Beta 1 修复候选复验

目标版本：2.0.0-beta.1.2。发布状态仍为 **NO-GO，等待真机复验**。

原候选 `38b10ad5281e72fc037a8e38c96968601b913dc5` 的验收报告确认三个执行核心缺陷。本次保持原草稿 PR 与分支，修复运行时逻辑并增加安全行为断言；不把候选代码更新视为验收通过。

## 第二轮复验 R01 R02 R03

上一固定候选 `44df53d3725e3f51e2dd6133dbebbb05f73c60a6` 已关闭观察 signal 与 504 互斥原路径。真机继续发现原生结束原因 aborted 的归因错误、运行期预算缺少持久意图，以及崩溃后取消请求未补发。本轮仍只交付修复候选，发布继续 NO-GO。

终止结果统一由 `task-termination.js` 映射，运行期和等待期预算都先提交取消意图，再中止执行。保存 `adapterResult`（适配器返回）、`hostResult/hostStopReason`（实际观察的宿主事实），`result/outcome` 是派生的任务结果。归因依据不再依赖宿主刚好使用 cancelled 字符串。

| 意图与事实 | state | outcome | result.stopReason | 保留的 hostStopReason |
|---|---|---|---|---|
| user + aborted + 确认停止 | CANCELLED | cancelled | cancelled | aborted |
| budget-exhausted + aborted + 确认停止 | FAILED | budget-exhausted | timeout | aborted |
| 无取消意图 + aborted + 确认停止 | FAILED | aborted | aborted | aborted |
| 取消已送达但仍运行或有待答 | RECONCILING | 尚未确认终态 | 不冒充停止 | 保留已观察事实 |
| 本轮真实 completed 与取消竞态 | 按验证结果决定 | completed | completed | completed |

恢复对账先观察。若存在持久取消意图且尚未确认停止，则记录 cancelAttempts、补发取消、再有界观察；发送失败保存 cancelError，下一次对账可重试。相同 Run 的并发对账/取消发送合并为一次在途操作。cancelSentAt 仅表示发送得到响应，不作为进程停止证据。此流程从不重新派发原任务；MCP 的 cancel/reconcile 调用等待上限相应增至 25 秒。

对于前两轮已错误归类的终态：只有持久意图和停止事实均存在时才修正；旧记录缺少预算意图时不依据“现在已经超过 deadline”猜测历史原因。原始事件和事实保留。

新增 `node tools/test-retest-regressions.mjs`：首先在上一候选上重现四条 R01/R02/R03 断言失败，修复后通过，并扩展到 12 项，包括实际 createExecutor 联合超时、aborted 映射、完成竞态、发送失败重试、并发合并、停止前排队阻塞和宿主取消忽略 signal 的有界处理。当前全部 14 组离线回归通过。这些是严格替身/线路测试，不是 Windows DSH 真机结论。

下一轮先复验：

1. 用户取消待答和运行中的实际命令，确认 CANCELLED/cancelled，hostStopReason=aborted 仍可追溯。
2. 运行中和等待中总预算耗尽，确认取消前已有 budget-exhausted 记录，停止后 FAILED/budget-exhausted、result.stopReason=timeout。
3. 在取消意图落盘后、宿主 cancel 前中断，恢复对账补发取消；失败时不释放同项目资格，再次对账可推进。
4. 取消与真实 completed 竞态保留完成事实；之后再完成文件 profile、产物哈希、Codex approve、原生审批和回退演练。

## 变更与判定

| 缺陷 | 修复 | 必须保留的安全边界 |
|---|---|---|
| BETA1-01 | state/events 都接收有效 AbortSignal；整个观察默认 5 秒有界，调用方也可取消；观察失败保存 observationError | 观察超时、契约异常、缺失数据都不是停止证据 |
| BETA1-02 | 派发后异常先观察，不凭 HTTP status 判终态；明确、已结束且未创建会话的接纳拒绝可单独判未派发 | 无停止事实时保持 RECONCILING，同项目后续任务继续 QUEUED |
| BETA1-03 | 新任务 WAITING_INPUT/WAITING_APPROVAL 的总预算继续计时；过期后先取消，再对账；过期答案不提交执行端 | 原生等待、问题或进程仍活跃时不得释放项目资格；旧 dsh_answer 保持独立执行预算 |

取消意图持久化后，即使观察失败、重载或状态变为 RECONCILING，后续观察确认停止也能收尾。`running:false` 但 `pendingInput` 非空或本桥问题仍存在时，不作为停止确认。任务真正完成与取消竞态仍优先保留本轮完成证据。

## 对旧候选数据的处理

启动时，旧 FAILED 记录如果含派发后带 status 的异常，或预算耗尽后仍保留问题，且没有保存停止事实，会隔离回 RECONCILING。旧候选只有 `run.cancel_requested` 事件而没有取消字段时，从当前 Run 事件恢复取消意图。

此处理不重新派发任务、不删除用户任务库，也不修改 DSH 模型/权限政策。没有会话标识的未知派发仍需人工核对，不能根据“未发现会话”推断没有执行过。

## 开发侧验证

```text
node tools/test-acceptance-regressions.mjs
npm test
npm pack --ignore-scripts --dry-run
```

新增 12 项回归使用临时 HOME、任务库和严格宿主替身，不读取用户令牌、不调用模型、不修改真实项目。它们根据验收报告重新构造；不是原验收目录中的私有脚本。

最初 9 项断言在原候选上运行，8 项失败、旧答案预算兼容项通过；这些失败包括报告的三类缺陷。修复后同组通过，并增加接纳拒绝和旧任务库升级保护断言。真实 sessionController 的替身要求 state/events 的第二参数支持 throwIfAborted；还覆盖忽略 signal 的宿主方法超时。

开发回归通过只能说明已覆盖这些故障窗口，不能替代 Windows DSH 真机验收。

## Windows DSH 复验清单

在隔离测试目录完成，保留原候选、旧版备份、用户政策与本机证据。使用固定修复提交安装，不混用工作区补丁。

1. 确认新版本与工具表，政策 revision、模型、权限未覆盖；旧任务库可读，无重复写入者。
2. WAITING_INPUT → 取消 → 观察确认停止；同项目排队任务仅在确认后派发。观察不可用时应看到 observationError，任务保持 RECONCILING。
3. 重载前保留一个待答任务。重载后旧 requestId 拒绝；取消意图保留，观察恢复后可以收尾，不能永久卡在 observation:null 而没有原因。
4. 派发后超时/504，以及迟到会话/迟到 prompt：仍运行或无法确认时阻塞同项目后续任务；停止确认后才允许继续。
5. 新任务先进入待答，再超过总预算：无需回答也会请求取消。恰好在预算边界回答时，不消费旧答案。分别验证立即停止和取消未确认两条路径。
6. 旧 dsh_answer 在原生问题 TTL 内长时间等待，回答后使用新的执行预算；非法或迟到答案不被当作授权。
7. 完成一项受控文件 profile：真实生成测试产物，独立核验哈希，Codex 只读审查。profile passed + 审查 approve 才能据此判该流程通过；命令验证能力未知时继续显示 unavailable。
8. 完成原生审批后的观察、真实长命令取消后的子进程停止、正常卸载和回退演练。保留运行级证据，不把本机任务库、token 或私人日志公开上传。

每项记录 PASS / FAIL / NOT VERIFIED、固定提交、宿主/Node 版本与非秘密证据位置。任何 P0/P1 复现、停止事实缺失或核心流程未验证，继续 NO-GO。完整视觉验收仍属于 Beta 2/RC 的后续门槛。
