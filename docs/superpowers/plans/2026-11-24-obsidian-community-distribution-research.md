# Peerpedia 转为 Obsidian 官方社区渠道：研究结论

日期：2026-11-24。范围：官方规则、现有依赖、隔离宿主实验、实施顺序；未提交官方目录，未发布或更改用户 Vault。

## 结论

建议以官方 Community plugins 目录为正式安装与更新渠道，网站保留介绍和指引。目标是用户安装三个标准文件后即可离线写作和预览，不下载额外运行环境。

推荐架构为 **Obsidian 原生编辑器 + 浏览器 Web Worker + 同源文章渲染包 + 内嵌 TeX/WASM/字体 + 官方 SecretStorage**。这条路线已有部分实验证据，但尚未完成整个插件的可行性验证。必须先通过 TikZ 渲染一致性和安全文件写入两个关口，不能现在就承诺可以直接上架。

此前质量计划中“共享一个独立 Node 渲染进程”不再作为确定实施方案。取消、缓存、增量更新等行为要求仍保留，资源所有权要在新的 Worker 边界上实现。

## 官方规则与含义

| 官方事实 | 对 Peerpedia 的影响 |
| --- | --- |
| 安装器只从版本一致的 GitHub Release 下载 `main.js`、`manifest.json`、可选 `styles.css` | 不能依赖额外目录随 ZIP 被解压安装；三个文件必须构成完整交付物 |
| 仓库根目录需有 README、LICENSE、manifest；release tag 与 manifest 的 `x.y.z` 一致 | 当前网站仓库的 `obsidian/` 子目录不能原样作为目录入口；发布边界需要调整 |
| 不允许插件自行安装或更新自身及依赖 | 不采用首次启动下载 Node、执行 npm install、自制更新器的方案 |
| 桌面插件允许 Node/Electron API，必须标记 `isDesktopOnly` | 官方渠道不强制支持手机，也不强制完全禁用 Node API |
| 账户要求、网络用途、Vault 外访问等需要披露 | README 明确本地写作无需账户，连接/导入/检查/发布的远程用途，以及实际文件访问范围 |
| 当前通过 Community 站点提交，连接 Obsidian 与 GitHub 账户 | 不沿用旧教程中向插件列表仓库提交 PR 的流程 |
| 官方目录检查源代码、产物和构建，并支持 Review branch | 在实际发布前做分支预检；本地 lint 不是官方通过保证 |

来源：[提交说明](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)、[插件要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[管理与预检](https://docs.obsidian.md/community-directory/manage-entry)。

三个标准文件并不表示插件不能保存用户状态或缓存；问题在于运行所需代码、引擎和资产不能依赖安装器未提供的额外文件或启动后的依赖安装。内嵌原生二进制再写盘加载是否获准，不能仅凭这几条文档作肯定或否定判断。

## 本地实验结果

使用已安装的 Obsidian 1.15.1，创建一次性 Vault、用户目录和浏览器配置；未加载用户插件或读取真实凭据。宿主报告 Node 24.22.1、Electron 43.8.9。测试结束后关闭实验进程并删除临时 Vault。

| 实验 | 结果 | 能证明什么 |
| --- | --- | --- |
| 将现有 BananaMark 核心打包进 Blob Web Worker，浏览器网络设为离线，渲染公式 | 成功，输出含 KaTeX；实验 Worker 约 1.2 MB | 核心渲染无需额外 Node 二进制；尚未证明整本论文和主题等价 |
| 将当前 TeX 引擎的压缩 WASM 以内存数据传入 Worker，解压并调用 `WebAssembly.compile` | 成功，展开 517,692 字节，19 个导入 | 引擎字节码能在该宿主编译；尚未实例化完整 TeX 环境或验证 TikZ 输出 |
| 在宿主页面通过 `node:worker_threads` 创建 Worker，准备调用现有网站 renderer | 创建时失败：V8 platform 不支持 creating Workers | 当前宿主中不能直接用 Node Worker 替换独立 Node 进程；未推断所有版本都一样 |
| 检查 `app.secretStorage.getSecret`、`app.vault.process` | 均为函数 | 目标版本提供这些官方接口；本次没有读写真实令牌 |

实验记录位于 `.preview/official-channel/host-probe.json`；实验代码仅在忽略目录中，未加入生产构建。离线设置针对浏览器网络，不代表完成整个产品的系统级网络隔离验收。

Electron 的 Node Worker、普通 Web Worker 是不同机制。也不把 `ELECTRON_RUN_AS_NODE` 当成可靠替代：它受应用 fuse 配置控制，不是 Obsidian 对插件承诺的运行时接口；本次未测试该路径。[Electron 文档](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)

## 各组件怎么迁移

### 1. 语言与文章渲染

- 保留原生 Obsidian 编辑器、现有高亮/补全宿主接入，以及已经使用的浏览器语言 Worker。
- 抽出 `@peerpedia/renderer` 的平台无关核心，网站和插件都消费它。章节顺序、编号、引用、文献及文章语义只有一份来源。
- `node:crypto`、`Buffer`、完整 cheerio/jsdom 入口、磁盘缓存、TikZ 调度属于平台边界。逐项替换为适配接口或浏览器兼容入口，避免将 Node polyfill 和整套服务端依赖盲目塞入 `main.js`。
- 插件使用 Web Worker 隔离计算；网站保留 Node 适配。不要在宿主主线程执行整书渲染或 TeX。
- 预览仍使用受限 iframe 和净化后的内容。Worker 源码是构建时确定的本地代码，不执行文稿提供的脚本。

### 2. TikZ 与交换图：需要先做完整原型

当前 `bananamark-tikz` 使用 `node:worker_threads`、磁盘读写和 jsdom；`node-tikzjax` 从磁盘加载三份引擎资源。它们不能未经改造直接放进浏览器 Worker。

建议给 BananaMark 的图形组件增加共享浏览器适配：引擎资产以字节输入，使用内存文件系统，提供浏览器 Worker 调度和可替换的 SVG/DOM 处理接口。保留相同前导定义、数学字形、公式标号、中文处理和 SVG 净化规则；尽量在上游完成，不在插件内复制一套图形语义。

现有社区插件 `obsidian-tikzjax` 已在官方列表中，源码采用内嵌引擎，0.5.2 release 的 `main.js` 为 7,861,284 字节、`styles.css` 为 4,791,190 字节，且其发布说明记载支持离线。这是分发方式的参考，不代表它的渲染语义、超时策略和我们的输出一致，也不直接复制该插件。[上游源码](https://github.com/artisticat1/obsidian-tikzjax)、[发布记录](https://github.com/artisticat1/obsidian-tikzjax/releases)

当前本地三份压缩 TeX 资源合计 4,760,336 字节。其体积远小于附带的 Node，但内嵌会增加 JS 体积和初次解码成本。采用懒初始化：没有图形时不初始化 TeX；需要时才解压，Worker 空闲后可释放。具体安装体积、峰值内存和首次图形延迟以最终原型测量为准。

### 3. 主题和字体

- 继续以 `@peerpedia/theme` 为样式唯一来源。构建增加 Obsidian 产物格式，不建立第二套 CSS。
- 将必要字体转换为内嵌资源并生成作用域受限的样式；iframe 由预先打包的文章样式初始化。不能依赖 `renderer/theme/` 目录。
- 当前主题成品约 4,729,859 字节；只移除确定未使用或重复格式，不删减支持的数学字形。
- 对生成 SVG 内的字体链接同样适配。预览 CSP 仅增加必要的内嵌字体来源，继续禁止文稿脚本和任意远程资源。
- 保留 KaTeX、TeX、字体等各自许可证和必需署名，记录构建输入与摘要。

### 4. 凭据：优先复用官方能力

改用 `app.secretStorage`，插件设置仅保存 secret 的标识，不保存 token。它从 1.11.4 提供公共 API，桌面 1.11.5 起在磁盘上使用操作系统提供的加密；当前最低支持版本 1.15.1 已覆盖这两点。[官方指南](https://docs.obsidian.md/plugins/guides/secret-storage)、[加密更新说明](https://obsidian.md/changelog/2026-01-20-desktop-v1.11.5/)

因此不再需要随包携带 Swift 钥匙串程序。需要明确：SecretStorage 按 Vault 管理，可供其他插件引用，不等同于当前按站点/账户保存的自定义 Keychain 项。先保留用户的远程绑定，迁移时重新连接或显式导入凭据；不静默删除旧钥匙串条目，不声称新接口与旧存储完全等价。

### 5. 安全写入：最大的未决边界

当前 `anchored.c` 提供 `openat`、目录锁、原子交换/排他发布及元数据处理。它已经被编码进 `main.js`，运行时写入临时 `.node` 文件后加载。这不只是一个额外 ZIP 文件问题：即使三文件安装能带上它，原生代码释放、可复现构建、平台支持及官方审查仍需验证。

普通文稿操作优先复用官方 `Vault.process`、Editor、FileManager；隐藏状态使用 Adapter。但这些 API 不能直接认定为当前多文件事务、目录身份和旧 inode 保护的等价替代。官方 `Vault.process` 描述的是单文件读改写保护，并未在该文档中承诺我们的所有跨进程、目录替换场景。[Vault 文档](https://docs.obsidian.md/Plugins/Vault)

必须比较两个方案：

1. 保留一个边界极小、公开源码、可复现的原生安全适配层，先通过官方分支预检并澄清其可接受性；保留 Mac 限制并清楚说明。不通过时不能绕过检查。
2. 以宿主 API 重构文件操作和恢复协议，逐一通过已有故障测试。若无法保留旧描述符晚写或目录替换保护，明确列出差异并重新决定保证范围，不能默默降级。

目前不把其中任何方案标为“已证明可行”。不自动删除旧恢复记录，不因要上架而放松写入验证。

## 仓库与发布方式

推荐独立插件仓库作为提交入口，根目录包含 manifest、README、LICENSE、构建脚本和插件源码。插件版本独立于网站版本，不需要为了插件更新同时改网站版本。这是工程建议，不是官方强制要求独立仓库。

共享 renderer/theme/BananaMark 通过明确版本、公开可获取的源码或包依赖复用；不能把相邻工作目录的 `file:../...` 路径作为新仓库构建的隐式前提。也不维护一个手工复制的插件发布镜像。

CI 构建标准三个文件，执行类型检查、官方 ESLint 规则、协议和故障测试、空 Vault 离线安装验收，并提供可追溯构建信息。正式发布时上传三个文件为 release 附件，tag 精确匹配 manifest；保留 `versions.json` 维护兼容版本。官方扫描与自己的测试都不能被当成对方的替代。

完成后使用用户的 Obsidian 账户登录 [Community](https://community.obsidian.md/)，连接 GitHub，登记仓库、处理预检结果并发布。研究阶段无需登录，不代为接受政策、创建仓库或提交申请。

## 下一步与验收顺序

1. **三文件原型**：只提供 `main.js`、`manifest.json`、`styles.css`，在干净 Vault 中加载；离线完成单章/多章公式、编号、引用、文献和主题渲染。
2. **图形原型**：补完 Web Worker 的 TeX 内存加载、TikZ/交换图及 SVG 处理；与网站同一组样例对照；测试无效输入、同步死循环、超时、取消、反复编辑和 Worker 回收。
3. **安全适配决策**：先验证上述原生适配与官方渠道的兼容性；如改宿主 API，要求目录替换、外部晚写、多窗口脏缓冲区、崩溃恢复和冻结发布测试通过。
4. **宿主复用**：迁移 SecretStorage、统一项目发现、生命周期和缓存边界，保持英文 UI 和紧凑双栏，不新增“下载运行环境”等步骤。
5. **恢复质量计划**：CI、增量诊断、delta 预览、恢复索引、结构化冲突和补全去重继续推进；独立 Node 进程与原安装包的任务改成新 Worker/三文件产物验证。
6. **发布准备**：确定插件仓库、固定依赖、验证版本升级和旧日志兼容，完成 README/截图/许可说明及官方预检后，再进入申请步骤。

允许替换正式文件事务层的条件：前三步有实际证据，没有通过下载依赖或减弱数据保护来满足三文件安装。共享渲染、主题和宿主凭据迁移不必等待原生组件政策答复，可以独立推进。第一阶段仅验证现有 Mac 桌面目标；其他桌面平台和移动端不自动扩入范围。

## 与已开始修改的关系

之前开始的插件 CI、发布失败拦截、共享协议样例与基准工作保留在 `codex/obsidian-quality-reuse`，尚未提交、发布或部署。其中真实宿主和安装包 CI 仍未验收完毕，不能宣称该阶段完成。独立 Node renderer 的重构暂不继续，先执行本研究提出的可行性原型。

## 原型结果（2026-11-24）

已在 `obsidian/prototype/` 实现独立三文件原型，真实 Obsidian 1.15.1 的临时 Vault
只安装这三个文件即可完成离线双章渲染，覆盖公式、定理编号、跨章引用、文献、TikZ
和交换图。与网站同一份样例的标准化 DOM、标题和引用目标一致，字体加载成功。
无效 TikZ 被拒绝，死循环约 8 秒超时，之后仍可重新编译图形；卸载后没有原型拥有的
Worker 残留。未操作用户的实际 Vault 或账户。

三个文件共 17,939,544 字节，继续复用网站 renderer 和主题源码。构建时适配上游资源
加载和 Node 计时器的代码只是实验措施，不能直接作为正式架构。原生安全写入层在三文件
安装下通过原子交换、旧描述符晚写保留、目录替换拒绝测试；SecretStorage 仅使用临时
假值验证读写，未迁移实际凭据。

**已证明三文件离线运行可行，尚未证明官方会接受原生组件。** 原型不包含完整写作与发布
流程，也未完成峰值内存、长期编辑或多消费者取消测试。正式迁移前仍需解决原生组件政策、
公开平台接口及依赖许可清单；不将原型测试当成官方审核通过。

复现命令、结果和局限见 [原型说明](../../../obsidian/prototype/README.md)。原有质量计划及
未完成的 CI 草稿仍保留，未发布或部署。

## 社区插件对照后的调整

已检查 TikZJax、Git、Remotely Save 和 Digital Garden 的源码。具体可复用方式、固定提交链接和边界见[现有插件对照](2026-11-24-obsidian-plugin-precedents.md)。先推进共享浏览器渲染接口、SecretStorage 和标准发布，同时对照验证宿主文件 API；不默认原生实现不可替代，也不因其他插件使用普通写入便放弃现有保护。
