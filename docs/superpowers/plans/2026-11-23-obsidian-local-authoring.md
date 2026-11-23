# Obsidian Local Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在用户的 Mac 上交付可实际写作的 Obsidian 插件，支持 BananaMark、多章节、共享文献、外部文件修改和完整离线预览。

**Architecture:** 扩展 Obsidian 原生源码编辑器，不替换其 Markdown 解析器；使用独立 BananaMark 解析上下文辅助补全、高亮和定位。独立 Node 组件通过 stdio 执行与网站一致的渲染和 TikZ。文件是唯一正文来源，项目配置沿用 CLI 格式。

**Tech Stack:** TypeScript strict、Obsidian API、宿主 CodeMirror 6、BananaMark 0.1.0 系列、Node >=22、esbuild、Vitest、YAML 文档 API。将实际验证版本固定在 lockfile；不自动追逐新版本。

**Spec:** [已批准设计](../specs/2026-11-23-obsidian-adaptation-design.md)。本计划完成后执行[远程发布计划](2026-11-23-obsidian-remote-publishing.md)。

## Global Constraints

- 第一阶段供用户自己在 Mac 的桌面版 Obsidian 中试用。
- 使用 Obsidian 原生编辑器，源码编辑与论文预览分开。
- 全部预览在本机完成，包括 TikZ 和交换图，不向服务器发送草稿来预览。
- 一篇论文一个文件夹，允许子文件夹。只有章节清单明确列出的正文参与预览和发布。
- 插件面板管理章节、顺序和论文信息，底层兼容现有 `paper.json`。
- 所有新增或修改的函数（包括内部辅助函数）必须明确标注参数类型和返回类型，保留泛型能力。此要求也覆盖回调、测试与构建脚本；语言不允许返回类型的构造函数除外。
- 不在本计划中实现网络客户端或恢复网站编辑器，不修改当前含未提交工作的 desktop-prototype 产品文件。
- 当前服务器约束为最多 64 章、总正文与书目 UTF-8 长度最多 1 MiB、最多 32 张图，单图源码最多 32 KiB；写作可以暂时超限，但检查必须提示。

## Review Focus

- 中文输入法、代理对字符和跨行公式：输入不被抢占，源码范围以 Obsidian 的 UTF-16 坐标定位（任务 1、4）。
- 大小写不敏感磁盘、重命名和符号链接：路径唯一且不越出项目，章节身份不因文件名变化丢失（任务 3、5）。
- 编辑、外部修改与多文件写入交错：保存双方内容，失败有恢复记录，不用陈旧面板覆盖磁盘（任务 5）。
- 慢 TikZ、崩溃、无效源码与过期结果：输入保持响应，旧结果不覆盖新结果，旧预览明确标识（任务 2、7）。
- 手写 YAML 的注释、未知字段和引用键重命名：面板编辑不损失书目内容，跨章引用正确更新（任务 6）。

## 基线、文件布局和公共契约

执行时先按 worktree 工作流从最新已核对的网站分支建立 `codex/obsidian-adaptation` 隔离工作区；确认网页编辑器移除提交 `8493f5d` 在其祖先中。参考检查点为网站 `aef626c`，不要从旧 desktop-prototype 整体复制产品代码。将本设计和计划带入工作分支。执行前检查目标 worktree 的 AGENTS.md。

新增产品目录 `obsidian/`，不混入现有 `plugins/peerpedia/`（后者是 Codex 插件）。责任如下：

| 文件区域 | 责任 |
| --- | --- |
| `src/main.ts`, `src/host/` | 生命周期、Obsidian API 适配和事件 |
| `src/project/` | CLI 文件格式、启用范围、稳定章节身份与恢复式写入 |
| `src/language/` | 独立语法上下文、补全、诊断、引用索引与跳转 |
| `src/bibliography/` | 保留文档结构的 YAML 编辑 |
| `src/preview/`, `renderer/` | UI 请求调度、源码映射、本地渲染组件 |
| `src/ui/` | 项目和书目面板、冲突提示 |
| `scripts/`, `tests/` | 打包、契约测试和隔离测试 vault |

在 `src/project/types.ts` 定义：`ChapterSpec {id:string; title:string; file:string}`；`PaperConfig {title:string; authors:string; abstract:string; primary_category:string; secondary_categories:string[]; license:string; chapters?:ChapterSpec[]; bibliography?:string}`；`SourceFile {path:string; text:string; digest:string}`；`ProjectSnapshot {root:string; revision:string; config:PaperConfig; files:readonly SourceFile[]}`。所有路径相对项目根目录；`files` 包含配置、正文和书目，`revision` 是这些文件路径及原始字节的稳定摘要。合法的未完成草稿可以缺少投稿必填内容，但不能含非法结构或越界路径。

在 `src/project/store.ts` 定义 `ProjectStore` 接口：`read(root:string):Promise<ProjectSnapshot>`、`create(root:string,changes:readonly FileChange[]):Promise<ProjectSnapshot>`、`apply(root:string, expectedRevision:string, changes:readonly FileChange[]):Promise<ProjectSnapshot>`、`watch(root:string, listener:(event:ProjectEvent)=>void):()=>void`。`FileChange {path:string; beforeDigest:string|null; afterText:string|null}`；null 表示文件不存在或删除。`ProjectEvent {kind:'changed'|'conflict'|'missing'; paths:readonly string[]}`。`create` 要求目标目录不存在并独占创建；`apply` 必须考虑已打开编辑缓冲区，而不只是磁盘。

`src/project/document.ts` 导出 `PublicationDocument`（标题、作者、摘要、分类、许可、`markdown:string`、`chapters:readonly {id:string; title:string; markdown:string}[]`、`bibliography:string`）及 `toPublicationDocument(snapshot:ProjectSnapshot):PublicationDocument`。多章节的总正文严格用两个换行组合，保留文件内原始换行；单文件从 `paper.md` 读取。

测试命令在新增 `obsidian/package.json` 中定义：`test` 为 `vitest run`，`typecheck` 为 `tsc --noEmit`，`build` 为 `tsx esbuild.config.ts production`，`package` 为 `tsx scripts/package-plugin.ts`，`check:types` 使用 ESLint 的显式函数返回与参数声明规则（禁用允许未标注回调的豁免）。测试 fixture 文件提供 `projectFixture():ProjectSnapshot` 和 `editFixture(base:ProjectSnapshot,path:string,text:string):ProjectSnapshot`，后者重新计算文件摘要与修订；fixture 固定为含 `intro`、`proof` 两章、一个定理标签和一份 YAML 文献的有效论文。

## Task 0：提取共享文章主题，并让网站使用它

**Files:** 创建 `packages/peerpedia-theme/{package.json,package-lock.json,README.md,LICENSE,src/tokens.css,src/article.css,src/bananamark.css,scripts/build.mjs,tests/theme.test.mjs}`；按实际需要添加构建/视觉测试 fixture。修改网站 `editor/{package.json,package-lock.json,build.mjs}`、`static/{theme.css,brand.css,reader.css,bananamark.css}`、`templates/includes/math.html` 及实际使用正文样式的模板。若图形字体资源路径迁移，更新 `editor/render-document.mjs` 相应路径及有关验证入口。此任务路径均相对仓库根目录。

**Interfaces:** 包名 `@peerpedia/theme`，稳定入口 `@peerpedia/theme/style.css` 指向构建产物；公开资源清单明确列出 KaTeX/TikZ 字体与许可证。正文容器使用 `.peerpedia-article`，主题变量使用 `--pp-` 前缀；网站的原有变量通过网站端适配读取同一组定义。用户安装消费包不应需要 Django、网站模板或完整 Peerpedia checkout。

- [ ] 先记录当前网站 reader 与上传预览/帮助示例的样式基线，覆盖标题、正文、定理、公式、表格、代码、书目、宽图形、窄屏与打印。新建独立消费 fixture，同一页放文章容器和普通宿主元素，验证样式只能影响文章区；可使用现有 Python Playwright 环境。
- [ ] 提取正文排版、字体栈、颜色 token 和 BananaMark 外观，网站工具栏、目录、导航及 `.site-header` 保留在网站静态样式。不要复制维护两套正文样式，也不要将整份 website CSS 加前缀冒充模块化。
- [ ] 明确封装 BananaMark、KaTeX 以及字体资源依赖，构建自包含 CSS/资产目录，使用相对可搬移 URL；上游全局 `:root`、`body` 和元素选择器也须处理，必要 `@font-face` 可保留。采用 CSS 解析器处理作用域/URL，不用字符串正则粗暴改写。打包前构建，确保 tarball 包含实际可用产物；此任务不向 npm 发布。
- [ ] 网站通过本地包依赖和正常构建消费这一入口，阅读页、上传预览、帮助示例都加载共享主题；无关网站 UI 维持原视觉。若保留旧 CSS 路径作为兼容入口，应是明确适配且不能残留第二份正文实现。
- [ ] 编写有意义的包契约测试：真实解析 CSS 检查作用域和资源存在，`npm pack` 到临时目录后独立安装/加载验证相对路径；在浏览器对比基线关键 computed styles/几何和页面截图，检查普通宿主的字体、配色、按钮不受影响。异常字体路径或未构建包应让测试失败，不只检查固定字符串。
- [ ] 运行 `npm --prefix packages/peerpedia-theme test`、`npm --prefix packages/peerpedia-theme run build`、`npm --prefix editor run build` 和 `npm --prefix editor test`；运行受影响的 Django 模板/帮助测试以及针对上述范围的浏览器核验。所有新增或改动函数均显式参数和返回类型，JavaScript 使用完整 JSDoc。提交 `refactor: extract reusable Peerpedia article theme`，记录包消费例子和验证结果。

任务 2 与 7 必须依赖此模块的资源清单和 CSS 入口，不再复制网站 `reader.css`/`bananamark.css`。先完成本任务再开始 Obsidian 产品实现。

## Task 1：验证原生编辑器适配，并建立最小插件

**Files:** 创建 `obsidian/{manifest.json,package.json,package-lock.json,tsconfig.json,esbuild.config.ts,eslint.config.mjs,styles.css}`，`src/main.ts`、`src/project/{types.ts,document.ts}`、`src/language/probe.ts`、`src/host/editor-extension.ts`、`tests/editor-probe.test.ts`、`docs/compatibility.md`。本文除显式 `obsidian/` 路径外的 Files 路径都相对此目录。

**Interfaces:** 产出 `probeCompletions(source:string,offset:number,composing:boolean):readonly string[]`；`createSourceExtension(enabled:(path:string)=>boolean):Extension`。`Extension` 来自宿主 `@codemirror/state`。同时声明上文 ProjectSnapshot/PaperConfig/PublicationDocument 类型供任务 2 使用，转换函数在任务 3 实现。此阶段只验证定理触发、中文输入和无关文件隔离，不宣称已完成全部语言功能。

- [ ] 写失败测试，明确断言：`expect(probeCompletions(':::th',5,false)).toContain('theorem')`；组词时结果为空；`'😀\n:::th'` 的偏移 8 正确定位。回调标注 `():void`。
- [ ] 运行 `npm --prefix obsidian test -- tests/editor-probe.test.ts`，确认因实现缺失失败，再实现最小适配。`manifest.isDesktopOnly=true`；按实际用户安装的 Obsidian/API 测试结果设置最低版本并记录，不能随意伪造支持版本。
- [ ] 依照官方 sample plugin 将 `obsidian`、Electron、宿主 CodeMirror/Lezer 核心依赖设为 external；原生语法树不替换。BananaMark 自己的 parser 仅用于独立上下文。
- [ ] 在单独测试 vault 加载插件，验证普通 Markdown 编辑、撤销、多光标、IME、关闭插件卸载事件；不得安装到用户日常 vault 或导入其论文。将宿主版本、成功与失败项目记入兼容性记录。
- [ ] 运行该测试、`npm --prefix obsidian run typecheck`、`npm --prefix obsidian run check:types` 和 `npm --prefix obsidian run build`，全部成功且真实宿主验证通过才提交本任务文件，提交说明 `feat(obsidian): validate native editor extension`。如果宿主适配失败，先修复，不退回嵌入旧编辑器。

## Task 2：验证可搬移的完整离线渲染组件

**Files:** 创建 `renderer/{main.ts,protocol.ts}`、`src/preview/renderer-client.ts`、`scripts/package-renderer.ts`、`tests/renderer-runtime.test.ts`、`tests/fixtures/render-paper.json`，修改 `package.json`，补充 `docs/compatibility.md`。

**Interfaces:** `RenderRequest {id:string; revision:string; document:PublicationDocument}`；`RenderSuccess {id:string; revision:string; pages:readonly RenderPage[]}`；`RenderPage {id:string; title:string; html:string; targets:readonly SourceTarget[]}`；`SourceTarget {id:string; chapterId:string; source:'chapter'|'bibliography'; from:number; to:number; kind:'heading'|'theorem'|'equation'|'bibliography'}`。`chapterId` 标识承载目标的渲染页面；`source='chapter'` 的范围相对该章 Markdown（含内联书目），`source='bibliography'` 的范围相对共享 `document.bibliography`，均为 UTF-16。失败为 `RenderFailure {id:string; revision:string; error:{message:string; file?:string; line?:number; column?:number}}`。`RendererClient.render(request:RenderRequest,signal:AbortSignal):Promise<RenderSuccess|RenderFailure>`；`dispose():Promise<void>`。

- [ ] 写集成失败测试：测试 fixture 必须含两章交叉引用、KaTeX 公式、TikZ 与 tikzcd；断网环境下成功结果包含 SVG、正确全书编号，资源地址全部为本地。另测 worker 超时、进程退出与 `dispose` 后无残留子进程。
- [ ] 运行 `npm --prefix obsidian test -- tests/renderer-runtime.test.ts`，确认失败。实现 stdio JSON 行协议、请求 ID、错误归一化和异步客户端；使用 `spawn` 参数数组、`shell:false`，不经过 shell。
- [ ] 打包时从当前基线 `editor/render-document.mjs`、`dialect.js`、`chapter-title.js` 及实际模块依赖生成独立 runtime，并记录来源提交和依赖摘要。默认包含已验证的 Mac 当前架构 Node >=22 运行时、字体、TikZ 编译资产与许可证，不依赖 PATH 中的 node 或 Python。复用网站渲染逻辑，不为此重写服务器渲染器。
- [ ] 以网站现有校验范围为准。初始组件请求总超时定为 40 秒，允许取消；超时杀掉并重建工作进程。缓存放系统应用缓存目录，不放正文目录。临时目录内复制完整 runtime 后，清空 PATH 并禁止网络重新运行 fixture，验证不存在对源码 checkout 的绝对路径依赖。
- [ ] 通过上述测试和真实 Obsidian 内断网渲染测试后提交 `feat(obsidian): add portable offline renderer`。这是技术关口；未通过时不能宣称完整离线能力，也不能用服务器预览替代。

## Task 3：论文文件模型、启用范围和文档转换

**Files:** 创建 `src/project/{store.ts,paths.ts,scope.ts}`、`src/host/vault-store.ts`、`tests/{project-format.test.ts,scope.test.ts,fixtures.ts}`；修改任务 1 已声明类型的 `src/project/{types.ts,document.ts}`。

**Interfaces:** 实现上文公共类型与 `toPublicationDocument`；`resolveScope(path:string,folders:Readonly<Record<string,boolean>>,files:Readonly<Record<string,boolean>>):boolean`；`validateProject(snapshot:ProjectSnapshot):readonly ProjectIssue[]`，`ProjectIssue {path:string; message:string; severity:'warning'|'error'}`。本任务实现 store 的读取与观察，创建和写入由任务 5 实现。

- [ ] 写失败断言：`resolveScope('paper/sub/a.md',{'paper':true},{'paper/sub/a.md':false}) === false`；未配置路径为 false。单文件和章节 fixture 分别被正确转换，多章节组合正文等于按顺序 `join('\n\n')`；64 章可校验，65 章给出问题。
- [ ] 运行 `npm --prefix obsidian test -- tests/project-format.test.ts tests/scope.test.ts` 确认失败，完成读取、项目成员发现和覆盖规则。注册 `paper.json` 的 root 不允许嵌套；单篇关闭编辑扩展不删掉章节清单成员。
- [ ] 加入路径断言：拒绝 `../`、绝对路径、符号链接及同一真实文件被重复引用；Mac 大小写冲突给出诊断；改文件名不改章节 ID。未知配置字段不可静默丢弃，提供明确的不兼容提示。
- [ ] 保留 UTF-8 原始字节与换行；章节标题按网站 `inspectChapter` 规则求值。正文/书目缺失时保留配置并报告问题，不能把缺失文件当成空文档提交。
- [ ] 对照 CLI `local_document` 用同一 fixture 验证文档内容一致；运行本任务测试、类型检查，提交 `feat(obsidian): model local paper projects`。

## Task 4：完整语言能力、跨章引用和源码跳转

**Files:** 创建 `src/language/{analysis.ts,index.ts,completion.ts,diagnostics.ts,navigation.ts}`、`src/host/{suggest.ts,decorations.ts}`、`tests/{language.test.ts,navigation.test.ts}`；将任务 1 的 probe 接入正式入口。

**Interfaces:** `analyzeProject(project:ProjectSnapshot):ProjectAnalysis`，其中 `ProjectAnalysis {revision:string; labels:readonly LabelTarget[]; diagnostics:readonly Diagnostic[]}`；`LabelTarget {key:string; label:string; kind:'heading'|'theorem'|'equation'|'bibliography'; path:string; from:number; to:number}`；`Diagnostic {path:string; from:number; to:number; message:string}`。`complete(context:CompletionContext,analysis:ProjectAnalysis):Promise<readonly Suggestion[]>`；`CompletionContext {path:string; source:string; offset:number; explicit:boolean; composing:boolean}`；`Suggestion {label:string; from:number; to:number; insertText:string; cursorOffset:number}`。`findTarget(key:string,analysis:ProjectAnalysis):LabelTarget|null`。

- [ ] 写失败测试：定理、公式命令、环境闭合和引用候选来自当前论文；另一论文同名引用不进入候选；重复标签返回诊断且 `findTarget` 不任意选一个；emoji 前缀后 `from/to` 切出的文本准确。
- [ ] 运行 `npm --prefix obsidian test -- tests/language.test.ts tests/navigation.test.ts` 确认失败。复用 `bananamark-codemirror` 的命令数据、标签提取和检查；将依赖独立语法树的补全转换为统一 `Suggestion`，不要把其 view.dispatch 回调直接塞入 Obsidian 建议窗口。
- [ ] 使用 `EditorSuggest` 承载自动和手动补全，源码装饰使用官方 CM 扩展；诊断跟随项目修订，避免旧诊断落到新文字上。仅在指定范围及源码模式生效，未开启的笔记不加扩展行为。
- [ ] 监听项目和书目变化重建受影响索引；实现跨章文件打开及精确选择。未闭合语法仍尽量从库已有宽容扫描器收集标签，但完整发布校验坚持正式规则。
- [ ] 运行本任务测试、类型检查及真实宿主 IME/引用跳转用例，提交 `feat(obsidian): add BananaMark writing assistance`。

## Task 5：可恢复文件写入与论文管理面板

**Files:** 创建 `src/project/{transaction.ts,recovery.ts}`、`src/ui/{project-panel.ts,conflict-modal.ts}`、`src/host/file-events.ts`、`tests/{transactions.test.ts,project-panel.test.ts}`；实现 `vault-store.ts` 写入端并扩展 `main.ts`。

**Interfaces:** 实现 `ProjectStore.create` 与 `ProjectStore.apply`；`recoverProject(root:string):Promise<readonly RecoveryNotice[]>`，`RecoveryNotice {transactionId:string; paths:readonly string[]; message:string}`。项目面板调用 store，不直接写文件。每个写入操作记录预期修订和每文件前置摘要。

- [ ] 写失败测试：开始拖动章节后外部修改 `paper.json`，提交旧面板变更必须拒绝；第二个文件写入时模拟失败，重新打开后两份原文和恢复日志均可找到；外部修改与打开缓冲区冲突不能静默覆盖。
- [ ] 运行 `npm --prefix obsidian test -- tests/transactions.test.ts tests/project-panel.test.ts` 确认失败。写入前持久化前像、后像和操作日志，逐文件重查，使用临时文件/原子替换并标记完成；遇到不受插件锁控制的外部编辑时停止并保留双方，不声称可锁住任意第三方程序。
- [ ] 面板提供新建单文件/多章节论文、添加移除成员、排序、重命名及信息编辑；启用范围设置提供文件夹规则和单文件覆盖，并响应移动/重命名。移除章节默认只移出清单，保留正文文件；删除不是同义操作。重命名用 Obsidian 文件 API，保持章节 ID；需要更改标题时展示将修改的源码。
- [ ] 外部 file events 必须与插件自身写入去重；修订相同不循环重渲染。发现不可恢复的损坏配置时显示错误并允许打开原文件，不重新生成默认配置覆盖它。
- [ ] 通过本任务测试、类型检查和一次真正的外部编辑演练，提交 `feat(obsidian): manage papers with recoverable file writes`。

## Task 6：共享文献列表及保真 YAML 修改

**Files:** 创建 `src/bibliography/{document.ts,rename.ts}`、`src/ui/bibliography-panel.ts`、`tests/bibliography.test.ts`。

**Interfaces:** `readEntries(source:string):readonly BibliographyEntry[]`，`BibliographyEntry {key:string; fields:Readonly<Record<string,unknown>>}`；`patchEntry(source:string,key:string,patch:Readonly<Record<string,unknown>>):string`；`planCitationRename(project:ProjectSnapshot,from:string,to:string):readonly FileChange[]`。保存统一通过 `ProjectStore.apply`。

- [ ] 写失败测试：修改书目标题后注释、未知字段与其他条目仍存在；`@key` 在正文被重命名但代码块里的同样字样不变；新键已存在时拒绝重命名；格式错误 YAML 不被表单覆盖。
- [ ] 运行 `npm --prefix obsidian test -- tests/bibliography.test.ts` 确认失败。使用 YAML Document 解析/节点更新和 BananaMark 引用解析范围实现操作，不采用全文正则替换。
- [ ] 实现列表、条目编辑与新增、删除受引用条目的影响提示、原文件打开。重命名先显示引用清单，再通过任务 5 的事务同时更新书目和所有受影响章节。
- [ ] 测试外部工具在表单打开期间修改 YAML 时拒绝旧修订写入；通过本任务测试及类型检查，提交 `feat(obsidian): manage shared bibliography without data loss`。

## Task 7：论文预览、错误状态与单向定位

**Files:** 创建 `src/preview/{controller.ts,state.ts,source-map.ts}`、`src/ui/preview-view.ts`、`tests/{preview.test.ts,scroll-link.test.ts}`；完善 `styles.css` 和 `main.ts`。

**Interfaces:** `PreviewState {currentRevision:string; renderedRevision:string|null; result:RenderSuccess|null; error:RenderFailure['error']|null; busy:boolean}`；`PreviewController.update(project:ProjectSnapshot):void`、`state():PreviewState`、`dispose():Promise<void>`。`locatePreview(path:string,offset:number,result:RenderSuccess,project:ProjectSnapshot):SourceTarget|null`。

- [ ] 写失败测试：新请求 B 完成后旧请求 A 才返回，结果仍是 B；当前修订失败保留上次成功结果并标明不一致；首次失败 result 为 null；预览滚动事件不调用源码编辑器定位。
- [ ] 运行 `npm --prefix obsidian test -- tests/preview.test.ts tests/scroll-link.test.ts` 确认失败，实现 300ms 文本更新防抖、最新修订匹配与任务取消。全书上下文转换经 `toPublicationDocument`，不可按当前文件单独重置编号。
- [ ] 消费任务 0 的 `@peerpedia/theme/style.css` 和资源清单，所有预览资源通过本地资源适配器处理，不在插件内复制网站正文样式。过滤主动内容和远程自动加载源，主动外链交给系统浏览器。
- [ ] 编辑切换/定位通过 SourceTarget 使预览跟随；预览普通滚动不反向定位，只有明确点击“定位源码”才执行。目标缺失时定位最近已知结构并标注近似。
- [ ] 通过本任务测试、真实双栏阅读操作、断网预览验证及类型检查，提交 `feat(obsidian): add linked offline paper preview`。

## Task 8：本地写作版本打包与验收

**Files:** 创建 `scripts/package-plugin.ts`、`tests/offline-journey.test.ts`、`docs/{installation.md,local-acceptance.md}`；完善 package scripts 与 manifest。

**Interfaces:** `packagePlugin(outputDirectory:string):Promise<void>`，输出 `manifest.json`、`main.js`、`styles.css`、独立 runtime、资产和许可证；生成可搬移的版本/摘要清单。

- [ ] 写打包集成测试：移到含中文和空格的目录，未连接账号且网络禁用，打开两章节 fixture 可编辑并渲染 TikZ；确认初始化、修改正文和打开预览没有 HTTP 请求。
- [ ] 运行 `npm --prefix obsidian test -- tests/offline-journey.test.ts`，实现打包、路径解析、首次配置与卸载清理；安装文件只复制到专门测试 vault。不得自动覆盖用户现有同名插件。
- [ ] 运行 `npm --prefix obsidian test`、`npm --prefix obsidian run typecheck`、`npm --prefix obsidian run check:types`、`npm --prefix obsidian run build` 和 `npm --prefix obsidian run package`。成功标准为测试全部通过、可搬移包生成、离线宿主验收有记录，不用单纯单元测试替代 Obsidian 实测。
- [ ] 在验收文档记录宿主与 Mac 架构、运行时版本、IME、范围覆盖、64 章、跨章引用、书目编辑、外部冲突、无效语法、图形超时和单向定位结果。提交 `feat(obsidian): package local writing preview`。此时可交付离线版本，但完整项目需继续远程计划。

## 官方参考与自检结果

[Obsidian 官方构建样例](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs)用于宿主依赖外置；[官方 API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)用于编辑扩展、建议窗口和 vault；[Node 子进程文档](https://nodejs.org/api/child_process.html)用于 stdio 组件；[Vitest 官方指南](https://vitest.dev/guide/)用于测试运行。

设计中的本地需求均映射到任务 1–8；五类 Review Focus 已有归属测试。界面尺寸、键位细节与打包具体 Node 补丁版本由实测决定；这些不改变已确认的产品范围。此计划尚未执行，技术关口尚未验证。
