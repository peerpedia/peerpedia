# Peerpedia：参考现有 Obsidian 插件的迁移方案

日期：2026-11-24。方法：检查官方目录登记及四个仓库的源码、文件适配和发布工作流；没有安装或执行这些插件。只借鉴边界与实现方式，本次未复制第三方实现、改动生产插件或提交官方申请。

## 结论与顺序调整

应该优先复用 Obsidian 已有能力，再保留必要的 Peerpedia 业务逻辑。无需把“原生组件先获得答复”设为所有迁移工作的前置条件。先实施无争议的共享渲染、宿主凭据、标准发布方式；文件事务单独做宿主 API 对照实验。

不能因其他插件使用普通写入就声称它们具有我们的目录身份、旧文件描述符晚写和多文件恢复保证。也不能把我们现有的原生实现预先视为唯一答案。决定保留与否应依据行为测试和实际需求，而不是已有代码量。

## 样本与证据范围

四个项目均在查询时的[官方插件登记表](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json)中。以下检查固定到仓库提交，**登记状态不表示这些最新提交或其中每一项做法均已获得官方审核认可**。

| 项目 | 检查提交 | 关注点 |
| --- | --- | --- |
| artisticat1/obsidian-tikzjax | `1d1f0844bd918e09e7eac081f86a70ba28635301` | 离线引擎内嵌、宿主渲染入口 |
| vinzent03/obsidian-git | `d3932518a42bdfc40b7a7a7417c4b0f635f5f94a` | 凭据迁移、文件适配、标准 release |
| remotely-save/remotely-save | `34db181af002f8d71ea0a87e7965abc57b294914` | 本地文件接口、计算 Worker、发布产物 |
| oleeskild/obsidian-digital-garden | `03ba9fe97aa327264d73d5542949cb6cda10db21` | 本地写作、手动发布、状态展示 |

## 具体采用什么

### TikZJax：内嵌资源，接入宿主

它通过构建插件将 `tikzjax.js` 内联进产物，用 `registerMarkdownCodeBlockProcessor` 接收代码块，在布局就绪后注册渲染资源，并处理窗口和卸载事件。[源码](https://github.com/artisticat1/obsidian-tikzjax/blob/1d1f0844bd918e09e7eac081f86a70ba28635301/main.ts)、[构建](https://github.com/artisticat1/obsidian-tikzjax/blob/1d1f0844bd918e09e7eac081f86a70ba28635301/esbuild.config.mjs)

采用资源内嵌和宿主生命周期管理。Peerpedia 继续使用已验证的 Worker 隔离和整篇文章渲染，保持网站源码与主题为唯一来源。它操作全局 CodeMirror、访问未公开的窗口字段、向宿主插入脚本的细节不作为我们的模板；其单代码块接口也不足以替代跨章编号与引用。

### Git：凭据交给宿主，发布采用三个标准附件

`GitServerPassword` 使用 `app.secretStorage`；设置只记 secret 标识，创建时避开已有名称，旧值迁移会优先保留已选择的有效 secret。[凭据源码](https://github.com/vinzent03/obsidian-git/blob/d3932518a42bdfc40b7a7a7417c4b0f635f5f94a/src/setting/gitServerPassword.ts)

采用这种边界，Peerpedia 用站点/账户区分引用，保存新凭据及设置成功后再处理旧状态。它迁移的是原有本地存储值，与我们的旧 macOS 钥匙串不同，不直接照搬删除步骤。

其 `MyAdapter` 将可见文件读写交给 Vault，隐藏文件交给 Adapter；Git 对象缓存有字节上限。这个文件是 isomorphic-git 的适配层，不能据此声称桌面 Git 的所有文件操作都走 Vault。[文件适配](https://github.com/vinzent03/obsidian-git/blob/d3932518a42bdfc40b7a7a7417c4b0f635f5f94a/src/gitManager/myAdapter.ts)

发布工作流上传 `main.js`、`manifest.json`、`styles.css`，额外 ZIP 并不替代这三个附件，还生成构建来源证明。Peerpedia 采用同样的交付边界，依赖安装和版本检查按自己的锁文件落实，不整份复制工作流。[发布流程](https://github.com/vinzent03/obsidian-git/blob/d3932518a42bdfc40b7a7a7417c4b0f635f5f94a/.github/workflows/releases.yml)

### Remotely Save：文件系统适配与同步业务分开

其本地 `writeFile`、`readFile`、`rename` 直接调用 Vault Adapter，删除使用回收站接口。加密计算由 Worker 执行，发布工作流上传三个标准文件。[本地适配](https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/fsLocal.ts)、[Worker 调度](https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/encryptRClone.ts)、[发布](https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/.github/workflows/release.yml)

采用薄文件适配层和计算隔离。先验证宿主 API 能覆盖哪些现有事务场景，不能把普通 `writeBinary` 当成原子交换、跨进程锁或目录固定的等价实现。本次未完整审计其所有同步/冲突算法，不以它作为无数据丢失的证明。

### Digital Garden：日常写作保留在 Obsidian，发布是一个明确动作

它提供发布单篇、发布变更和打开发布界面的命令；发布逻辑放在 Publisher，状态另由 PublishStatusManager 处理。[入口源码](https://github.com/oleeskild/obsidian-digital-garden/blob/03ba9fe97aa327264d73d5542949cb6cda10db21/main.ts)

采用写作与发布分工：保留 Peerpedia 紧凑双栏，常用动作通过命令和少量明确入口访问，状态只在有信息时出现。Peerpedia 已选项目本来就是用于发布，不引入它的逐篇“私人/公开”标记。也不照搬其 GitHub 后端、整套 UI 或普通设置内的 token 存储；我们使用 Peerpedia 协议和 SecretStorage。

## 对实施计划的具体修改

1. 把三文件原型的构建期替换整理为共享渲染器的正式浏览器接口；保留网站一致性样例，继续复用主题包。
2. 参考 Git 的 secret 引用方式迁移凭据，复用 Obsidian 设置组件；保留远程绑定，验证失败时保留旧凭据。
3. 在隔离 Vault 为宿主文件适配建立对照实验，依次覆盖：正常写入、用户正在编辑、多窗口、外部并发修改、目录替换、旧描述符晚写、进程中断恢复。记录每一项满足与不满足的保证，不提前删除原生层或放宽断言。
4. 只有实验表明仍有必要时，才为缩小后的原生边界准备官方预检；这不阻塞前两项。普通读写与恢复/多文件事务分别评估，不一次性机械替换所有文件调用。
5. 正式插件恢复既有质量计划，CI 围绕三个 release 附件验收；整理元数据、英文帮助、许可证与升级兼容后申请收录。

官方说明建议读改写使用 `Vault.process`，隐藏目录使用 Adapter；异步计算后的写入应在 process 回调中检查原内容是否变化。这些接口没有在该说明中承诺等价于我们的全部跨进程保护。[Vault 文档](https://docs.obsidian.md/Plugins/Vault)

本次是源码研究和计划修订，没有执行这些第三方插件，也没有把其被收录视为我们原生组件已获批准。
