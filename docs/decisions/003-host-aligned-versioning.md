# ADR-003：插件版本跟随 DSH 主、次、补丁号

状态：采纳；2026-10-26；用户明确要求仅取DSH前面的`0.2.1`。

## 决策

插件公开包版本取已实际验收的官方DSH版本的`major.minor.patch`，不带预发布或构建后缀。2026-10-26 曾将插件由`0.30.0`切换为`0.2.1`，对应官方宿主`0.2.1-rc.3`；这是编号规则切换，没有回退代码或重置用户数据。2026-11-07 本次版本为插件`0.2.2`与官方宿主`0.2.2-rc.1`；交付验收绑定[本次归档哈希](../../integration/verification-0.2.2.md)。

| 项目 | 当前值 | 规则 |
| --- | --- | --- |
| 插件包及lockfile根version | `0.2.2` | 取已验收DSH的主、次、补丁号 |
| `engines.dsh` | `0.2.2-rc.1` | 保留实际验收的完整宿主版本 |
| 官方基线与全部DSH runtime peer | `0.2.2-rc.1` | 精确匹配实际宿主，不放宽为任意0.2.2发行版 |
| Cordis等非DSH依赖 | 各自真实版本 | 不伪装成DSH版本 |

本次DSH`0.2.2-rc.1`对应插件版本`0.2.2`，兼容声明仍精确为`0.2.2-rc.1`。插件数字版本不表示DSH已稳定，也不消除本项目的验收保留项。

## 可执行约束

构建和npm prepack执行`npm run check:version`；检查包的core版本、完整宿主声明、DSH peers及lockfile根元数据。npm不包含根package-lock文件，因此另随包提供根版本元数据快照；开发环境同时核对真实根锁与快照，解压包明确仅检查该快照，不声称完整依赖锁验收。版本一致性不等同于接口存在、原版兼容或完整卸载通过。

## 后续更新

1. 确认官方发行版与目标Web/Desktop实际版本，研究公开API和变更。
2. 更新插件实现与声明，维护根锁/版本快照，不修改宿主程序。
3. 在干净官方发行版和独立profile完成类型、核心功能、归档安装/卸载/重装、数据保留及宿主文件哈希验证。
4. 按该DSH的core命名包，交付新的SHA和绑定该归档的验收记录；未验收版本不自动放行。

## 同一core版本的独立修订

插件包版本继续为同一个core；使用独立GitHub构建标签。首发例如`v0.2.1`，同宿主插件修订用`v0.2.1-plugin.1`等；若未来只把宿主更新到同core的rc.4，可用`v0.2.1-dsh-rc.4`。各构建以完整宿主版本、代码提交和不可变SHA识别，旧标签、包及验收记录不覆盖。

安装来源必须包含不同构建身份或哈希路径，不能覆盖曾被包管理器缓存的同一本地路径后假定已更新；须核对实际安装。当前方案针对GitHub tgz交付，npm registry不允许重发同版本；未来如增加registry发布，需要先另行决定版本方案。

## 一次性迁移

旧0.30.0用户须明确安装`dsh-plugin-composable-workforce-0.2.1.tgz`并重启，不能依赖SemVer发现“更高版本”。旧发布保留，新README明确链接当前构建；知识、岗位/团队、工作流和会话历史保持。

## English

The plugin version uses only major.minor.patch from the officially verified DSH version. The current migration targets plugin 0.2.2 with exactly DSH 0.2.2-rc.1; publication requires acceptance bound to the new archive hash. Historical plugin 0.2.1 remains tied to DSH 0.2.1-rc.3. Runtime peers and engine declarations retain the complete verified host version; omitting the plugin suffix does not broaden compatibility or imply a stable host release.

Build/prepack guards check the core plugin version, full host declarations and root-lock metadata. Same-core builds use immutable GitHub tags, commits and checksums with distinct installation sources. Historical releases remain unchanged. This renumbers the existing 0.30.0 feature baseline; future host builds still require fresh official archive verification.
