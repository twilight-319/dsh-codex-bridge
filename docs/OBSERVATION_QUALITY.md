# 等待与交付要求修复：rc.5 / Codex 0.8.0

## 已观察到的问题

一次单文件 SVG 动画对照中，桥接会话有6次 await、11次外层 wait、21条 Codex 用量记录，直接制作有5条。桥接总耗时约428秒，DSH执行约362秒，直接制作约249秒。输入 token 包含大量缓存，不能把输入总数之比换算成订阅额度之比。

这次任务走 direct，没有调用工作流调度，也没有质量审查。DSH实际模型与旧例相同，不能把单次质量差异归因于降低模型档位或并发拆解。离线调度测试通过不代表真实额度、时间或成品质量改善。

## 程序持续观察

新增仅在MCP端实现的 `dsh_task_observe`：

```json
{"taskId":"task-...","runId":"run-...","observationMs":600000,"requestWaitMs":55000}
```

一次MCP调用内使用现有HTTP await路由分段续等。只吞掉运行中任务的 `wait-expired`，不把普通等待到期逐次交回模型。首个响应绑定Run；Run改变、问题、审批、协作暂停、对账、宿主关闭或错误立即返回。总窗口到期返回 `observation-expired`，继续观察同一任务即可，不重新提交。观察时间不延长任务deadline。

取消MCP调用只终止本次HTTP观察。不会提交、回答、修复、取消或重派后台任务。网络错误不隐藏重试，返回原错误并保留凭据。防止宿主立即返回expiry造成空转；单次窗口最多10分钟。

返回 `observation.httpAwaitCalls/elapsedMs`，明确是本次观察器的HTTP调用数与耗时，不是GPT请求数、总协调时间或收费。完整任务detail=full仍可读取。

## 外层执行器是独立一层

MCP配置 `tool_timeout_sec=620` 不能设置 `functions.exec` 的yield预算。技能、工具描述和初始化说明现在同时写明两层要求：

```javascript
// @exec: {"yield_time_ms": 620000, "max_output_tokens": 2200}
const result = await tools.mcp__dsh_bridge__dsh_task_observe({
  taskId: "task-...", runId: "run-..."
});
for (const item of result.content ?? []) if (item.type === "text") text(item.text);
```

如果外层仍返回运行cell，仅对原cell使用环境支持的长 `functions.wait` yield。不要重调observe，也不要每1秒/10秒短等。客户端可以钳制或中断长调用，插件无法强制控制；status明确返回 `controlsOuterExecutor:false` 和 `clientLongWaitSupport:not-negotiated`。这不是已经验证的零唤醒能力。

已知工具超时只能短等待的客户端可继续用 `await(waitMs=55000)`，如实记录兼容开销。新的observe能兼容已有await路由的DSH宿主；新的质量参数需要rc.5宿主，两端升级仍应一致。

## 质量要求不是自动验收

新增可选 `qualityProfile=visual|implementation`，可用于单任务和工作流节点，作为幂等请求的一部分持久化。服务端将对应交付要求加入执行说明，修复仍保留原要求。所有说明合计仍受20000字符限制。

- visual：先确定构图、配色和主体比例，注意主体识别、连接关系与动画接触点，不以装饰数量代替主体效果。
- implementation：遵循已有项目约定、保留用户修改、处理相关调用与失败路径，控制修改范围。

它不会选择模型、提高档位、添加功能、运行测试、打开浏览器或调用Codex审查；用户目标和限制优先。不测试的任务仍可传递交付条件，不能把条件已传递或文件写完当成质量合格。

视觉任务需要一次简短制作说明时使用planned并提供plan和acceptance。未指定DSH的短视觉任务优先由当前Codex完成；用户明确指定DSH时照做。该路由建议不等同已经证明任何模型在所有视觉任务上更好。

工作台提供交付要求选择，并显示无plan时的acceptance。摘要返回deliveryRequirements，原verification/review状态仍是单独证据，未验证结果继续保留REVIEW_REQUIRED。

## 验证边界

离线检查覆盖多次HTTP等待到期对应一次MCP结果、Run绑定、窗口预算、取消与错误、问题/审批/工作流暂停、质量要求透传和幂等、修复继承，以及工作台行为。使用模拟HTTP和临时目录，不创建真实模型任务。

当前本机已额外完成40秒模拟长调用：显式设置外层yield后，程序内部3次HTTP观察只产生1个MCP结果，外层没有在30秒时返回；未调用真实模型。这仅验证该窗口和当前环境，未验证完整10分钟或跨客户端行为。

仍需新会话检查两端版本和新工具，真实观察外层是否维持长调用；额度与视觉质量须用相同要求的多次对照判断。不能将离线结果宣传为已证实节省比例或稳定版发布证据。
