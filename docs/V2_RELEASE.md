# 2.0 RC 与发布验收

工程候选为 2.0.0-rc.1。它补齐任务工作台、只读诊断、旧记录导入、离线备份恢复及发布证据检查。正式版本仍为 NO-GO：上一修复候选尚无新的 Windows DSH 真机复验结论；不得把离线或浏览器夹具当作真机通过。

## 用户入口

DSH 左侧仍只有 Codex 入口。进入后点击“任务”：

- 创建目标、计划、验收条件与总预算，按用户既有模型和权限执行；可显式启用 Codex 审查。
- 查看任务、Run 历史、宿主原始原因、派生结果、验证检查、产物哈希和事件。
- 处理本次问题，取消任务、恢复对账或打开原生审批会话。
- REVIEW_REQUIRED 的人工接受需要勾选核对确认，并绑定当前 Run、revision 与 evidenceHash；旧 Run 和旧记录只读。
- “诊断”检查宿主能力和存储，不调用模型、不改政策、不读取或展示令牌。
- “导入旧记录”只在没有活动任务时导入旧台账及归档的只读快照。重复导入忽略既有记录，不生成假 Run、父任务或验收结论，也不会重放旧任务。

任务提交结果不明时保留提交编号并以同一内容重试；修复重试也保留操作编号。同目录真实路径、Windows 大小写和目录联接按同一项目约束；这仍不是操作系统级隔离。

## 只读诊断

```text
node bin/doctor.mjs
node bin/doctor.mjs --online
node bin/doctor.mjs --directory <TASK_DATA_DIRECTORY>
```

默认只读检查，不修复尾部、不删除 writer.lock、不启动 Codex。`--online` 读取现有发现文件和令牌，对严格 loopback 做一次有界状态查询，不跟随重定向；输出分别标记外部 Node 与宿主 Node。诊断缺失数据目录时不创建它。

## 备份 回退与恢复

先停止接纳任务并结束/核对在途工作，关闭插件，确认写入者已退出。不要直接删除仍有归属的锁，也不要将私人任务库或令牌公开上传。

```text
node bin/task-data.mjs backup <TASK_DATA_DIRECTORY> <NEW_BACKUP_DIRECTORY>
node bin/task-data.mjs restore <BACKUP_DIRECTORY> <NEW_RESTORE_DIRECTORY>
```

工具获取独占锁、校验日志链和备份 manifest，只写入不存在的新目录，拒绝覆盖现有数据、复制活跃写入者或从损坏备份恢复。不会复制令牌、政策、旧 1.x 台账或修改宿主安装；这些由用户原有备份流程保留。

回退 1.x 时停用 2.0 候选并重新安装已备份的 1.x 代码；保留 tasks-v2 目录，1.x 继续读原来的独立政策与台账。恢复 2.0 时先将备份恢复到新的目录，人工核对后再由已停止的宿主切换目录。离线恢复演练不等于真实 DSH 回退运行通过。

## 自动验证

```text
npm test
npm pack --ignore-scripts --dry-run
```

Windows Node 22/24 运行回归与安装包检查。Ubuntu CI 使用临时目录安装 React/ReactDOM 18.3.1 与 Playwright，运行真实 Chromium 夹具页面，检查亮暗主题、390px 窄屏、键盘焦点、当前问题和人工验收，并保留截图。它们不加入插件运行时依赖，也不读取真实 DSH 数据。

浏览器脚本也可在有 Chromium 的开发环境执行：配置 BRIDGE_PLAYWRIGHT_MODULE、BRIDGE_REACT_MODULES、BRIDGE_CHROMIUM_PATH 和 BRIDGE_UI_OUTPUT 后运行 `node tools/test-browser-workbench.mjs`。

## 正式发布门槛

复制 docs/release-gates.json 为本机验收文件，填写固定候选完整 sourceCommit、每项 PASS 与证据位置。缺失、重复、过期或非 PASS 项均阻止发布：

```text
node tools/release-check.mjs --evidence <ACCEPTANCE_JSON> --commit <FULL_CANDIDATE_SHA>
```

默认清单刻意保持未验证；`npm run release:check` 当前必须退出非零。检查器验证证据结构与提交绑定，不替人判断日志是否真实，也不自动创建标签、合并 PR 或发布版本。

必须在同一固定 RC 上完成：

1. R01/R02/R03：用户取消 + 原生 aborted 的归因、运行/待答预算先持久化意图、取消发送前崩溃后的补发与队列约束。
2. 一项真实文件 profile 产物和独立哈希 + Codex approve 的完整 M3 流程；受控命令能力未提供时保持 unavailable。
3. 连续问题和原生审批、真实长命令停止、实际宿主崩溃/重载、升级回退运行。
4. 当前 Windows DSH 的亮暗主题、窄屏、键盘与原生导航，特别检查新任务工作台。
5. 对应提交的 Windows CI、浏览器夹具截图和完整回归。

复验缺陷继续在原 PR 跟踪；全部证据确认前维持草稿和 NO-GO。通用 DAG、自动并行 worktree 集成、长期记忆与智能路由仍在后续版本范围。
