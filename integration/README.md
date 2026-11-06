# Harness 官方插件接入与生命周期

插件使用独立 npm bundle，通过官方 `sidebar.panellist` 与 `main` 注册 `graph_horses` 全局页面。项目入口、配置与任务继续使用官方对话插槽和服务。安装、运行和卸载均不修改 Harness 源码、构建物、内置插件或其 `node_modules`。本目录旧的 `harness-workspace-slots.patch` 只保留历史证据，不进入安装包，不得应用它来准备宿主。

兼容目标是官方 **0.2.2-rc.1**，要求 Node **>=24.9.0**（核查日 2026-11-06：GitHub 最新发行版、npm latest / next），声明在 `engines.dsh` 和 DSH `peerDependencies` 中。预检检查该版本的已安装官方客户端构建是否公开 `sidebar.panellist`、`main` 和 `layout.selectPanel`。预检通过只说明接口存在；发布是否验收通过，以绑定最终归档 SHA-256 的生命周期记录为准。没有验证过的版本不应改版本号直接放行。

官方依据：

| 接入点 | 官方说明 | 生命周期 |
| --- | --- | --- |
| `dsh.bundle.patch` / profile | [插件发布与打包](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/develop/basic/publish.zh.md) | 官方 CLI 管理依赖和 bundle 列表 |
| `sidebar.panellist` | [侧边栏公开面板席位](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-sidebar/README.zh.md) | 由 slots 注册清理；无宿主补丁 |
| `main` / `layout.selectPanel` | [布局公开服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-layout/README.zh.md) | Cordis 生命周期撤销贡献，刷新页面移除已加载浏览器模块 |
| `pluginNavigation.openBundle` | [原生插件导航](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-plugin-manager/README.zh.md) | 从能力选择器定位原生插件详情，MCP 仅在所属 bundle 明确时复用；只导航，不安装或启用；无额外持久资源 |
| `connection.admit()` / WebServer | [原生连接鉴权](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/connection/README.zh.md) | Host API 路由由插件 effect 注册并移除 |
| `sessionController.modelCatalog()` | [Session Controller 公开模型目录](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/index.ts) | 声明注入 `sessionController`；按需读取宿主当前目录，不另存账号/凭据，不创建会话或发起模型推理；没有额外后台任务 |
| `agent.model.select()` / `agentDefaultModel.currentSelection()` | [Agent 模型选择](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/agent/README.zh.md)、[部署默认模型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/agent-default-model/README.zh.md) | 使用精确 `dsh-agent-default-model` peer，在公开 inbox 领取事件同步选择本轮岗位路由，先于原生步骤捕获；结束或卸载只恢复本插件拥有的选择，不覆盖用户随后作出的选择；不再通过 `agent/request` 改模型 |
| `tools.register({ when })` / 每步 `tools.resolve()` | [工具注册与激活](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/tools/README.zh.md) | 业务工具在 Agent 作用域预注册，条件只等待岗位准备并判断当前租约，原生执行器拥有步骤工具集；不在激活谓词内注册工具或执行任务；作用域释放时撤销注册和守卫 |
| `sessionQuery` 只读观察 | [公开会话查询](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/session-query/session-query/README.zh.md) | 使用精确 `dsh-session-query` peer，读取当前会话事件并在 finally 释放观察句柄；不依赖已移除的 `sessionController.inspect()`，不删除或重写宿主历史 |
| 资料管理员 `llm.stream()` | [官方 LLM 服务与 GenerateOptions](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/llm/llm/src/index.ts) | 使用已声明的 `@deepseek-ai/dsh-llm@0.2.2-rc.1` peer，显式注入 `llm`；需要模型的增量分分析、生成两次受限请求，无变化及可本地完成的撤销不调用模型；传入 AbortSignal，插件 dispose 中断队列与请求；不创建原生 Session |
| 岗位 AI 智填 `llm.stream()` | 同一官方 LLM 服务及上述模型目录 | 使用当前员工草稿的模型和姓名单次生成，输入不含旧岗位、项目或知识资料；本插件 `/employee-role-draft` 接口只返回草稿，不持久化、不建立 Session 或工作单。2 并发、120 秒、4096 输出 token／64 KiB 上限；断连或前端取消传播 AbortSignal，dispose 清除计时器并中断请求，无新增数据目录 |
| 知识上下文 `Session.append` / `surfaceOp: replace` | [官方 SurfaceIntent](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/session/src/types.ts)、[官方工具结果收拢](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/compaction/compaction-tool-result-pruner/src/index.ts) | 员工作用域 pre-step 只改本插件知识工具的可见 content；先记录 compaction/prune 再替换，保留原始日志与引用；新增声明 token-meter / compaction 原版 peer，计价用公开 estimate 子路径；任务结束/卸载撤销 hook，保留原生可重放历史 |
| `agentPresets.acquireScope()` / `composeFrom` / `mount` | [公开 Agent preset registry](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/preset/agent-preset-registry/src/index.ts) | 目录查询以公开只读租约取得默认 preset 的注册目录，查询完成后释放；任务继承来源会话预设，独立任务使用默认预设，结束释放；不注册员工专属 preset |
| 原生权限与来源会话只读 | `dsh-permission-presets`、`dsh-sandbox-policy`、`dsh-user-approval`、`dsh-session-persistence` 的公开类型；详见[能力接入](../docs/architecture/native-capabilities.md) | 只读来源预设、沙箱和审批，通过公开服务写入新工作单；持久化读取句柄在 finally 关闭，不操作来源会话生命周期 |
| 独立员工交付输入保护 `conversation.blocks.set/storeFor` | [官方会话 Client 契约](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/client/ui-conversation/src/client/contract) 中的 `ComposerBlocks` | 仅在独立员工工作单执行/交接期间保护其交付会话输入，原 Chat 与其他会话不受影响，原生 Stop 保留；确认官方交接及原生恢复成功后清除。卸载注销订阅并只清除本插件自己的 block，不覆盖其他插件的 block，不拦截或重发用户消息/附件 |
| `workingDirectory` | [公开工作目录服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/session/working-directory/src/index.ts) | 原生任务作用域内绑定项目目录，随 Agent 释放，不改宿主进程 cwd |
| Agent、工具、技能、Workspace | [插件服务机制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/develop/framework/service.zh.md) | 本插件任务、中断、订阅和定时器在 dispose 时停止 |

对话工作流与历史顺序工作流使用同一个员工执行器。目录读取不建立 Agent 会话；任务执行继承原生工具、Skill 目录、沙箱与审批；员工只配置必备/优先 Skill 与工具使用偏好。Bash 和第三方工具以实际原生预设及服务约束为准。历史任务数据存放在同一个插件专属状态文件的可选 `workState`，旧状态无需迁移；安装/升级不会自动创建任务、修改已有人员或发起模型请求。参见[工作流详情与验收](../docs/architecture/project-delivery-review.md)及[能力边界](../docs/architecture/native-capabilities.md)。

岗位模型可手动选择，也可通过inherit跟随官方目录中的当前DSH默认值；默认不可用时明确失败，不另选模型。资料管理员继承负责人的模型路由，使用独立整理提示。业务准备采用available：只归档/读取已有资料，不触发或等待后台编纂；失败/取消不再自动付费整理。显式资料更新、有效验收和手动整理仍按增量处理。额外任务token限制默认关闭，已报告缓存/输出与编纂账本明确展示。具体边界见[综合修复记录](../docs/audits/2026-10-26-runtime-context-remediation.md)和[团队知识库](../docs/architecture/team-knowledge.md)，最终结果绑定当前实际归档验收，不沿用旧归档结论。

### 历史轻咨询配置的执行边界

当前姓名菜单使用员工完整能力；旧 API 或已保存的轻咨询配置继续禁止工具执行。DSH `0.2.2-rc.1` 通过 `tools.resolve()` 在提示装配前确定本步工具，`system-prompt/assemble` 的展示变换不再能增删可调用工具。插件使用作用域 `tools.restrict({ allow: [] })` 隐藏继承能力，并用单调 `tools.guard()` 拒绝全部执行。

PTC 的 `run_code` 属于宿主执行器提供的传输声明，不是可由能力 restriction 隐藏的注册工具。因此咨询时它仍可能出现在请求与原生请求头中；旧调用和新生成的调用均在执行前拒绝。插件不替换未知 preset 或自定义执行器，也不承诺 PTC 咨询的声明数量为零。解除咨询限制与守卫后继续使用原执行器及原会话历史。官方依据：[工具解析与守卫](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/tools/README.zh.md)、[PTC 执行器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/tool-executor-ptc/README.zh.md)。

<a id="deepseek-messages"></a>

## DeepSeek Messages 请求排查

官方 DeepSeek Messages 适配器的默认 `baseURL` 是 `https://api.deepseek.com/anthropic`；实际模型请求追加 `/v1/messages`。普通 Chat Completions 的 API 根地址、`/v1` 地址或仅支持 Chat Completions 的网关不能直接作为 Messages 端点。模型列表使用的路径与推理路径不同，目录加载成功不能证明推理地址正确。

从旧设置升级时，在目标 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `llm-deepseek` 条目中检查显式 `baseURL`，同时核对可能覆盖它的 home patch 与 `DEEPSEEK_BASE_URL`。保留其他模型、凭据和插件配置；使用官方默认地址时只修正对应字段，修改前备份，随后重启目标 profile。

`DeepSeek Messages transport failed` 是传输异常的外层消息，不能单凭它判断 Key、余额或插件兼容性。应查看底层 cause，区分 DNS、TLS、连接重置、代理与 HTTP 状态；浏览器访问成功不代表 DSH 的 Node 请求使用了相同代理。诊断只向用户明确选择的提供方发请求，不把凭据写入日志。

The official DeepSeek Messages adapter defaults to `https://api.deepseek.com/anthropic` and appends `/v1/messages`. Model discovery uses a different path, so a populated model list does not validate the inference URL. Check explicit `baseURL` overrides when upgrading old settings. Preserve unrelated configuration and credentials, back up before changing the field, and restart the intended profile. A generic `transport failed` message needs its underlying cause; it does not establish a key, balance, or plugin-version failure.

Official reference: [DeepSeek Messages adapter](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/llm/llm-deepseek/README.zh.md).

## 安装与保留数据卸载

先停止目标 Harness。使用你实际要管理的 `DSH_HOME` 与 profile，避免作用于另一套安装。正式使用者只需官方 DSH 和 `.tgz`，无须准备 Harness 源码仓库。

```sh
DSH_HOME=/absolute/dsh-home dsh plugin --profile web add /absolute/dsh-plugin-composable-workforce-0.2.2.tgz --config.auto-install-peers=false --config.strict-peer-dependencies=false --ignore-scripts
DSH_HOME=/absolute/dsh-home dsh plugin --profile web remove dsh-plugin-composable-workforce --config.auto-install-peers=false
```

安装、更新、卸载后重启 Harness，并刷新已打开的页面。普通 `remove` 撤销插件依赖和 bundle，但保留专属配置、职业人模板、团队、工作流、实例、项目记忆、执行记录、团队/员工知识库及工作台目标/任务/成果版本/验收历史，便于重装恢复。

本地归档路径过长时，pnpm 的存储索引文件名可能触发 `ENAMETOOLONG`。将同一归档复制到短目录后安装，并核对 SHA-256；每个构建使用独立目录，避免同版本缓存复用。也可直接使用对应不可变 GitHub Release 的归档 URL。

随包提供 `scripts/plugin.mjs`，可以在停止目标宿主后执行同等操作。`DSH_INSTALLATION_MANIFEST` 指向已安装的官方 `@deepseek-ai/dsh/package.json`，不要求源码路径。脚本未传 `--home` 时保留本仓库开发习惯，使用插件目录下 `.local/harness`；正式使用必须明确传目标 `--home`。

```sh
DSH_INSTALLATION_MANIFEST=/official/install/node_modules/@deepseek-ai/dsh/package.json node /installed/plugin/scripts/plugin.mjs uninstall --home /absolute/dsh-home --profile web
```

## 显式完整清理

完整清理使用同一个随包脚本，先预览精确范围。目标 Harness 停止后加 `--host-stopped` 执行；该参数是操作者对停止状态的声明，脚本不会猜测其他正在运行的宿主进程，也不会停止无关服务。

```sh
DSH_INSTALLATION_MANIFEST=/official/install/node_modules/@deepseek-ai/dsh/package.json node /installed/plugin/scripts/plugin.mjs purge --home /absolute/dsh-home --profile web --dry-run
DSH_INSTALLATION_MANIFEST=/official/install/node_modules/@deepseek-ai/dsh/package.json node /installed/plugin/scripts/plugin.mjs purge --home /absolute/dsh-home --profile web --host-stopped
```

`purge` 先校验归属，再通过官方 CLI `remove` 管理依赖与 bundle，成功后才删除以下内容：

- 目标 profile `cordis.patch.yml` 中准确匹配 `id: composable-workforce` 或本包名的配置行，保留其他插件、用户配置和注释。
- `$DSH_HOME/composable-workforce/state.json`。该 JSON 包含本插件的业务模板、项目实例、记忆、运行记录及项目工作台数据。仅删除实际状态文件，并在空目录时移除它的专属目录；不递归删除未知文件。
- 对应 `statePath` 的知识根：`resolve(dirname(statePath), 'knowledge', basename(statePath))`，默认 `$DSH_HOME/composable-workforce/knowledge/state.json/`。先核验 `.owner.json` 归属、文件哈希、目录树和写入锁，再逐项清理；其他状态的知识根、用户项目和原生 Session 保留。预览输出列出 `knowledgeRoots`。
- 没有其他 profile 使用时，home 级 `cordis.patch.yml` 中同样准确匹配的本插件配置行。
- 显式指定 `--service-root /original/checkout` 时，本项目按该路径哈希注册的 `local.composable-workforce.<hash>` launchd 服务及其 `.local/service/stdout.log`、`stderr.log`。未知目录内容会中止清理；不会删除共享日志目录或其他 launchd 服务。

自定义 `statePath` 需要额外传 `--owned-state-path /exact/state.json`，且必须与实际插件配置完全匹配。比如本仓库旧演示状态为 `/absolute/project/.local/workforce.json`，应先预览再显式指定该路径。脚本验证插件状态结构，拒绝状态文件/配置的符号链接、硬链接、动态表达式、正在写入的锁，以及其他 profile 对同一文件的引用。外部状态文件不能证明归属时会拒绝删除。多个历史配置指向不同外部文件时需先核实、统一配置；不会扩大删除范围。

共享 statePath 的多个 profile 不可逐个 purge 同一文件：先用普通 remove 卸载不再使用的 profile，保留数据；仅在最后一个 profile 执行显式清理。其他 DSH_HOME 也引用同一外部文件的情况无法自动枚举，操作者必须确认该外部文件独占使用；不确定时保留文件。

用户项目文件夹、交付成果、用户主动导出的 `.json`、宿主共享会话历史、凭据、模型设置和其他插件数据均保留。员工原生会话属于宿主可查看的历史，不直接改动宿主 session 存储。完整清理指本插件可执行功能与专属配置/状态/自建服务被清除，不声称抹除宿主历史中的所有痕迹。

### 原生会话保留（删除任务已结项）

用户 2026-10-26 明确接受使用 DSH 官方可恢复归档隐藏会话，不要求物理删除。原生会话日志、原始消息及闭轮工具历史由宿主保留，不再列为完整卸载未满足项或发布阻塞；持久会话删除任务已结项。归档按用户选择通过原生入口执行，默认拒绝活动会话，明确选择停止活动时才按官方规则请求停止。本次不批量归档现有会话，不改宿主数据库或会话文件，也不再安排删除接口或存储替代方案。插件运行能力、专属配置/文件及自建服务仍须清理；共享凭据和用户成果保留。见 [ADR-004](../docs/decisions/004-session-archive-retention.md)。

脚本本身没有创建缓存或专属日志目录；官方插件管理器生成的共享 pnpm 缓存、操作日志和 profile 锁文件由宿主管理并保留。构建和验收产生的仓库 `artifacts/` 是交付资料，亦不由卸载脚本删除。

## 开发与验收

`npm run setup` 可在本插件 `node_modules` 建立开发用只读来源链接；不会写 Harness。`DSH_SOURCE_PATH` 只用于开发源码定位，不能成为正式用户的安装前提。`npm start` 第一次通过官方 CLI 初始化本仓库开发 profile，以后保留现有安装、移除和其他配置状态。

`npm run test:lifecycle` 默认使用 `.local/official-validation-complete/node_modules/@deepseek-ai/dsh/package.json`，或显式 `DSH_INSTALLATION_MANIFEST`。测试要求 npm 安装目录，拒绝源码宿主。它在独立临时 `DSH_HOME` 和随机端口验证真实归档安装、模型目录、默认 preset 实际能力目录、项目目标/任务/成果版本与验收、普通卸载、宿主原生启动、重装完整保留、随包 purge 和宿主程序文件总哈希未变；不会操作现有 3081 profile，也不发送模型请求。`WORKFORCE_LIFECYCLE_UI=1` 允许暂停各阶段供浏览器检查。

发布包使用显式白名单，包含 Host/Client 构建、声明、本插件源码、技能、bundle、生命周期脚本，以及共享 LLM Wiki 的对应源码、固定版本哈希、改造说明、构建脚本、依赖锁和许可证；不含宿主源码补丁、source map、node_modules 安装目录、本机数据、凭据、测试或完整 Harness。Wiki 程序只有一份包级代码和按需启动的共享子进程；各知识空间的 `wiki/vN/` 只是派生数据。卸载时该子进程及全部队列停止；完整清理在知识根内一并移除这些数据，普通卸载保留。许可范围见随包 `LICENSES.md`。最终验收记录须重新绑定最终 `.tgz` 的 SHA-256，不能借用旧补丁宿主的结果。

<a id="desktop"></a>

## Desktop 官方接入 / Official Desktop integration

官方依据：[Desktop 运行时与自带命令](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/apps/desktop/README.zh.md#bundled-command-runtime)、[鉴权请求代理](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/apps/desktop/src/web-document.ts)。桌面端使用相同 Web 插件 bundle，`desktop` profile 由 Electron 所有；必须通过该安装自带的命令管理。App 必须与插件声明的 `0.2.2-rc.1` 一致；旧 `0.2.1-rc.3` App 应保留对应旧包。Web 验收不能替代 Desktop 实机验收，本次平台范围见[归档记录](verification-0.2.2.md)。

Desktop shares the Web plugin bundle, with its own Electron-owned `desktop` profile. Its authenticated proxy strips `Origin`, cookies and Fetch Metadata before attaching a host-issued cookie. This plugin first calls official `connection.admit()`, then validates Host, any supplied Origin and Fetch Metadata. Origin-less writes additionally require `X-DSH-Graph-Horses: 1`; cross-origin browser pages cannot attach this header without a CORS preflight, which this API does not grant. The header never replaces native authentication.

从解压的插件包或源码目录运行清理脚本时，显式提供 Desktop 的公开命令与实际数据目录；不要将 npm CLI 指向 desktop。默认数据目录是 `~/.dsh`，自定义安装以启动时的 `DSH_HOME` 为准。先退出 Desktop。

```sh
node scripts/plugin.mjs uninstall --home "$HOME/.dsh" --profile desktop \
  --dsh-command "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
node scripts/plugin.mjs purge --home "$HOME/.dsh" --profile desktop \
  --dsh-command "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --dry-run
# 核对范围后，将 --dry-run 替换为 --host-stopped 执行。
```

The same ownership and accepted native-session retention policy applies on Desktop. Official recoverable archiving is sufficient; physical deletion is not an uninstall requirement. Full cleanup does not uninstall the shared DSH Desktop app or erase its shared shell preferences, credentials, sessions, or user workspaces. See [ADR-004](../docs/decisions/004-session-archive-retention.md).

## 默认内容显式更新 / Explicit default update

新安装只创建1条软件工程流程，并持久生成6岗位及团队的来源可追溯专业知识图谱。原有安装不自动重置或静默覆盖定制。解压包中的 `lib/upgrade-software-defaults.js` 支持 `--state /absolute/plugin/state.json --dry-run`；退出使用该状态的宿主后以 `--host-stopped` 执行，备份旧文件并在一次版本校验事务中更新。只改变已知原始默认库及未执行、未定制的采用实例；员工ID/模块、记忆、会话选择与历史保留。已执行或定制对象报告跳过。完整清理会移除插件专属图谱；宿主原生会话按已接受的保留策略处理。

Fresh installs include one engineering workflow and source-backed professional graphs for the six roles and shared team. Existing profiles preserve custom definitions. The packaged explicit upgrade tool backs up state and uses a single version-checked transaction after the host stops; customized/executed adoptions remain unchanged with a skip reason. Plugin-owned graphs follow the same cleanup lifecycle.

## 版本同步规则 / Version alignment

插件版本仅取已验收DSH的主、次、补丁号，不带rc/alpha后缀。当前版本为插件`0.2.2`、宿主及runtime peer精确`0.2.2-rc.1`。构建/打包校验这些对应关系及根版本元数据；发布验收绑定[本次归档记录](verification-0.2.2.md)。历史插件`0.2.1`仍对应`0.2.1-rc.3`，其旧归档及证据保持原样。同core修订以不可变构建标签、SHA及不同安装源区分；见[ADR-003](../docs/decisions/003-host-aligned-versioning.md)。

The current migration targets plugin 0.2.2 with exactly DSH 0.2.2-rc.1 and Node >=24.9.0. The plugin uses only the host's major.minor.patch; full host compatibility declarations remain exact. Install the matching new archive explicitly. Version checks do not replace acceptance bound to its hash; historical 0.2.1 archives remain tied to DSH 0.2.1-rc.3.
