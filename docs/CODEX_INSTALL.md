# 给其他人安装 Codex 执行桥

此仓库同时提供 DSH 插件和 Codex marketplace，两边各安装一次。双向协作的候选版本为 DSH 桥 2.0.0-rc.6 和 Codex 插件 0.9.0。真机与稳定版发布验收仍待完成。

## 前置条件

- 同一台电脑、同一操作系统用户下运行DSH和Codex；不同用户/远程机器不会自动共享发现文件。
- Node.js22+且`node`在Codex进程PATH中；安装后重启Codex让它读到新PATH。
- 使用支持`codex plugin marketplace`的Codex版本。命令行输入`codex plugin marketplace add --help`确认；若没有plugin子命令，先更新Codex，不猜旧客户端支持此安装。
- 自备DSH模型源；要用桥中的Codex参谋，还需自行安装并登录Codex CLI。此包不含账号、token、模型额度或自动批准策略。

## 1. 安装DSH侧

DSH→插件→添加插件：

```text
https://github.com/twilight-319/dsh-codex-bridge.git
```

按DSH提示启用/重启。在Codex→执行模型配置自己的模型、允许档位与权限。新安装默认不提升权限。升级前先停止新提交并维护排空，不能重载在途任务。

## 2. 安装Codex侧

在终端执行：

```text
codex plugin marketplace add https://github.com/twilight-319/dsh-codex-bridge.git --ref main
codex plugin add dsh-bridge@dsh-bridge
codex plugin list
```

安装本轮候选后，预期出现已启用的 `dsh-bridge@dsh-bridge` 0.9.0。需要固定版本时，把 `--ref main` 替换为经过验证的完整 40 位提交 SHA。

**完全退出并重新打开Codex App**。不要同时保留旧的`dsh-bridge@personal`或手工同名`dsh_bridge` MCP配置，否则可能产生重复工具或来源歧义；确认旧来源后仅移除旧DSH桥，不删除其他marketplace或全局配置。

已有旧个人插件的用户：

```text
codex plugin remove dsh-bridge@personal
```

不要在第一次安装时盲目执行remove；也不要删整个personal市场（可能含其他插件）。

此插件内部使用`node`及安装缓存相对入口，包含完整MCP依赖，不需要填写作者电脑路径、不需要克隆额外工作仓库或运行npm install。端点和token由当前用户的DSH桥自动发现，不要互传token或将其写进公开配置。

## 3. 首次检查（不创建任务）

在新Codex会话输入：

> 请加载 DSH 执行桥技能，只调用 dsh_status 检查连接。确认 dsh_task_submit 和 dsh_task_orchestrate 支持 delivery，确认 dsh_task_observe 存在。此次检查只读取状态。

之后默认后台交办，凭回执编号在 DSH 工作台打开。用户要求在 Codex 原对话接结果时，用 `delivery=conversation` 和 `dsh_task_observe`。

宿主应可达，模型/权限应是使用者自己的政策。技能加载成功不等于端点可达，工具出现也不等于DSH已运行；分别核对。

## 4. 日后升级

先结束或核对在途任务，DSH侧按维护流程升级。Codex侧：

```text
codex plugin marketplace upgrade dsh-bridge
codex plugin add dsh-bridge@dsh-bridge
codex plugin list
```

当前CLI的`plugin add`从已刷新marketplace安装版本。如客户端拒绝覆盖已安装版本，再仅对本插件执行remove/add，然后完全重启Codex。不要手改cache；源更新时会覆盖它。

## 常见问题

- `node`找不到：安装Node22+，确认`node --version`，完全重启Codex。
- 找不到origin/token：启动同用户DSH并启用桥；不要为了修连接复制作者token。
- 没有插件命令：更新Codex，或按README手工stdio方式接入MCP并单独安装技能；后者不是本页已验收的一键插件链。
- GitHub下载失败：检查使用者网络/代理；包不内置代理也不修改系统代理。
- 任务又在10分钟停止：检查是否仍加载旧技能或调用`dsh_execute`。复杂任务应使用`dsh_task_submit`，不机械传600000；wait短超时不取消后台任务。
- 授权提示：由使用者决定批准范围；公开包装不设置全局自动批准，也不提升DSH权限。

## 数据与支持范围

目前真实验收平台为Windows，DSH0.2.2-rc.3及支持plugin命令的Codex；其他平台仅通用Node/路径逻辑可移植，未宣称已完成桌面真机验收。正式稳定版2.0门槛见V2_RELEASE.md，不把公开安装包等同稳定发布。
