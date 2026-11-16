# 任务调优首版（2.0.0-beta.1.4）

## 授权与选择分离

执行模型设置新增「授权模型池」：1至2个精确provider/model，分别配置inherit/fixed/adaptive强度、允许档位和默认档位。可选用途标签quality/speed/balanced、autoAllowed及各目标的明确档位偏好。它们是用户规则，不是模型性能排行榜。旧pinned/follow-default政策原样兼容，读取时不写迁移；现有固定模型就是单路由授权，升级不会猜第二个模型或扩大权限。

自动选择只使用autoAllowed且目录仍支持的模型；按objective精确标签、balanced回退、池顺序确定。没有合格模型明确失败，不调用未授权提供商。固定模型政策不因auto请求解锁。故障后不自动换模型，已派发结果不确定时必须先对账。

## Codex提交

```json
{"goal":"修复跨模块一致性并运行指定测试","cwd":"<PROJECT>","idempotencyKey":"stage-001","reasoningEffort":"max","reason":"涉及历史兼容和多个写入路径","tuning":{"modelMode":"auto","effortMode":"manual","timeoutMode":"auto","taskClass":"backend-change","objective":"quality"}}
```

可显式provider+model（必须成对）、reasoningEffort、timeoutMs。tuning.modelMode/effortMode/timeoutMode各自manual或auto。显式参数与对应auto冲突会拒绝；manual缺值拒绝；省略模式时显式值照常使用，全省略沿用旧默认。taskClass为1~64字符小写字母数字连字符ID，不能用自由文本作隐含分类学习。

`dsh_task_preview`只读预览，共用提交解析器，不创建Task/会话或占用幂等键，不保证提交时建议不变。提交返回run.tuning四层记录；用get查看后续证据。必须重连MCP加载新增schema，否则旧调用方看不到max/provider/model字段。

## 冻结与安全边界

首次提交解析并冻结policy revision、模型/档位/权限、预算、来源、相关目录哈希、历史摘要。排队后派发前仅复查当前授权与能力，不重选；授权收紧/能力消失明确失败，不静默换模降档。同键先返回原任务，不因历史/默认/上限变化重算；旧哈希记录沿旧规则兼容。重启沿冻结值，retry继承并复查；复用会话不允许改变模型/档位/权限，新选择必须新会话。

所有继续入口包括旧同步reuse/answer均复查原会话授权；回答校验期间取消不能消费原问题。权限、审批、全局默认、并发、重试上限和验收要求不属于自动调优参数。首版不支持运行中自动延时/改档；预算仍受宿主最大值及2小时工程上限限制。

## 历史预算

只用本项目的结构化Task/Run统计，不向另一个项目泄漏原始goal/reason/补丁。按项目、精确模型/档位、profile内容指纹、taskClass分组；仅实际request/header证据匹配且无任何错配、正常completed、无取消/恢复不明的有限耗时入普通样本。没有调优证据的旧数据不伪造补齐，先冷启动。

配置示例（不是写死的算法参数）：

```yaml
tuningHistory:
  windowDays: 90
  maxFamilies: 100
  minSamples: 20
  quantile: 0.9
  margin: 0.2
  maxCensoredRatio: 0.1
```

策略为P90总墙钟耗时加20%余量，取样窗/家族数/样本门槛/分位数/余量/删失阈值可配置且严格验证。总墙钟含排队、输入与验证，不拿纯执行时间冒充。样本不足、缺taskClass或超时比例高均回退配置默认，并返回原因。completed与verification passed单独计数，未验证不宣称成功。

预算超时作为右删失下界而非正常完成值。一个Task的多次retry只算一个家族；出现超时后最终成功仍在删失分子占一次，分母为有效完成或预算超时家族并集。证据未知/错配等排除项不能稀释删失比例。仅返回统计摘要而不是历史原文。首版不学习模型/档位优劣，只执行用户偏好规则或明确policy-fallback；无隐式双模型并发写入或为学习制造额外执行。

## 四层审计

- requested：调用者原参数与模式。
- suggested：历史预算建议、样本量/分组/回退原因、模型和档位规则依据。
- resolved：最终冻结执行参数、预算、policy revision、catalog hash、来源。
- applied/observed：应用回执与实际观察。applied来自agent.model.select成功；applied.observed为agent.model.current配置读回；observed来自本Run baseline后的逐条request/header。未知明确标unknown，不复制请求伪造实际。

请求错配累计everMismatch，不会被后续匹配覆盖；错配Run不参与正常历史建议。API可核对四层，完整原生会话仍是执行事实源。当前工作台显示模型来源，完整Task调优审计通过get获取，不冒充已具备Beta2任务详情UI。

## 放行测试

显式max端到端、自动模型/档位用户规则、超界拒绝、旧政策兼容、同键并发、预算上限降低后原键返回、政策排队撤权无prompt、旧会话撤权拒绝、回答取消竞态、逐条错配证据、项目隔离/删失分母、池UI双模型保存，以及已有取消/维护/长任务回归必须通过。真机请求证据与离线模型替身应分别报告。未授权第二个真实模型时只验证池逻辑，不擅自运行第二提供商。
