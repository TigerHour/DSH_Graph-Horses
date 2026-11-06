# Graph Horses 0.2.2 归档验收

日期：2026-11-07。归档为 `dsh-plugin-composable-workforce-0.2.2.tgz`，405 个文件、1,324,754 字节；发布标签 `v0.2.2`。机器可读结果见 [verification-0.2.2.json](verification-0.2.2.json)。

```text
SHA-256 157a4e7e6ae38d5faa9b1e6d624bab59cfc501d7b865f2c84fc83979d497e22e
```

## 官方基线与范围

- 未修改的官方 npm DSH `0.2.2-rc.1`，官方标签 `dsh-v0.2.2-rc.1`，commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
- macOS arm64、Node `24.21.0`；最低 Node 要求为官方版本的 `>=24.9.0`。
- 插件数字版本 `0.2.2`；DSH runtime peers 与 `engines.dsh` 精确为 `0.2.2-rc.1`。Cordis `4.1.0`、loader `1.1.0`。类型专用 `ui-slots` 包是开发依赖，不要求向宿主额外安装它。
- 本记录验证 npm Web。当前 Desktop、Windows 及其他架构未独立验收；旧 `0.2.1-rc.3` Desktop 保留对应旧插件归档。

## 结果

| 项目 | 结果 |
| --- | --- |
| 版本一致性、类型检查、Host/Client/Wiki 构建 | 通过 |
| 全量自动测试 | 888 项；887 通过、0 失败、1 项原有可选私有完整克隆测试跳过；241.353 秒 |
| 干净官方宿主与临时 profile | 官方 CLI 安装同哈希归档，15 组生命周期检查通过 |
| 核心能力 | 6 岗位、团队、工作流、官方模型/能力/Skill 目录、知识图谱、资料解析、任务/成果/验收与原生鉴权通过 |
| 普通卸载和重装 | bundle/API 移除、原生宿主正常；状态、ID、知识文件和历史保留，重装不重放任务 |
| 完整清理 | 随包 purge 经官方 CLI 移除插件及有归属的状态/配置，保留用户成果、共享凭据和宿主历史，宿主可重新启动 |
| 官方宿主文件 | 70,150 个程序/依赖文件前后总 SHA-256 完全一致 |
| 原生员工浏览器验证 | 9 项通过；同会话流、常驻/临时引用、附件、None、窄屏和隐藏面板清理；无页面异常 |
| 原生工作流浏览器验证 | 31 项通过；语言/主题/宽度矩阵、负责人模型、真实规划工具、验收/退回、并发对话、旧交付接管、未发送草稿/附件保护；无页面异常 |
| 上个公开包升级 | `0.2.1 / plugin.5`、DSH rc.3 升级到本包/rc.1；安装不改状态字节，启动后保留定制岗位、对象 ID、历史及 bundle 配置，原生会话列表可用 |
| 独立复核 | 修复并复核 2 处 P2：每步完整提示/工具预算快照、旧模板引用复用定制实例时的模型选择；对应真实循环回归已通过 |
| 包内容 | 无宿主补丁/构建物、用户数据/凭据、测试夹具、本机路径依赖或 source map；GPL 子程序许可、固定对应源码、依赖锁和原始证据引用完整 |

宿主前后总哈希：

```text
bbe1d40afa008e1ed9f839da65a2d32a6291e09eb465e7979fcb9664d6fd354c
```

原始测试报告、日志和截图保存在本次本地验收产物中；公开 JSON 给出检查明细、精确归档哈希和原始证据文件摘要，不发布访问令牌、凭据或个人会话内容。

## DSH 原生生成验证

独立临时 profile 仅启用官方 base/web bundle，不含 Graph Horses。公开 RPC 创建会话，通过原生 WebSocket 实时接收 DeepSeek 文本，回复 `OK`，自然 `stop` 后会话空闲、队列为空。模型为 `deepseek-official/deepseek-flash`，推理关闭，输出上限 16；报告输入 416、缓存读取 8,576、输出 1，总量 8,993 token。原始凭据和官方 CLI 文件哈希未变，临时环境已清理。

旧 Web 的显式 DeepSeek 根地址缺少 `/anthropic`，可复现 HTTP 404；修正为官方 Messages 根地址后，当前适配器和原生会话测试通过。这不追溯解释所有历史 `TRANSPORT`：官方持久化失败摘要不保留底层 cause，当时的 DNS/TLS/代理错误无法从历史摘要重建。

## 已知限制与依赖审计

- 本包为预发布。功能验证不代表真实供应商长期稳定性、回答质量、生产容量或固定缓存收益。
- PTC 咨询可能保留宿主的 `run_code` 声明；业务能力隐藏，旧/新工具调用均由守卫拒绝，测试执行次数为零。解除咨询限制后原执行器继续正常执行，不接管或替换宿主执行器。
- 主插件生产依赖与单独的 Wiki 子程序依赖审计均为 0 告警。Wiki 源码依赖 `js-yaml` 已精确更新到 `4.3.2`，26 项定向回归通过，固定上游源码哈希不变。含宿主 peer 的树为 55 项受影响依赖（53 high、2 moderate）；完整官方宿主树为 209 项（201 high、8 moderate、0 critical）。计数包含传递影响，不等于独立漏洞数。插件 peer 树的根因来自官方 `zod` / `undici` 依赖；不以补丁、override 或修改宿主 `node_modules` 绕过官方版本。安装者应同时关注上游安全更新。
- pnpm 本地归档路径过长时可触发 `ENAMETOOLONG`。验收使用短、按哈希区分的安装来源；安装指南提供同样的处理办法。
- 会话保留继续遵循 [ADR-004](../docs/decisions/004-session-archive-retention.md)：可恢复归档隐藏即可，原生日志、消息与闭轮工具历史可保留，不添加删除 backend。

## 复现入口

准备对应官方 npm 安装，并将 `DSH_INSTALLATION_MANIFEST` 指向其 `package.json`。源码检查运行 `npm ci --ignore-scripts`、`npm run check:version`、`npm run typecheck`、`npm test` 和 `npm run build`；通过 `npm pack` 生成新归档并重新绑定哈希。

对同一归档运行 `tests/plugin-lifecycle.mjs`、`tests/ui/conversation-employee-official.e2e.mjs`、`tests/ui/conversation-workflow-official.e2e.mjs`。升级检查使用 `tests/plugin-upgrade-current.mjs`，额外指定前版官方安装与不可变的 `plugin.5` 归档。所有生命周期/UI/升级测试都使用独立临时 profile；真实供应商生成验证与离线 UI/业务验证分别记录。
