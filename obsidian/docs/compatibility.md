# Obsidian 编辑器兼容性

2026 年 11 月 24 日在 macOS 15.6.1（Apple Silicon）验证 Obsidian Desktop 1.15.1，宿主使用 Electron 43.8.9。插件声明 `isDesktopOnly: true` 和 `minAppVersion: 1.15.1`。兼容范围以这次实测的桌面版本为基线。

插件以 Obsidian 的建议窗口提供自动补全，通过官方 CodeMirror 扩展添加 BananaMark 高亮和诊断。文件和文件夹规则默认关闭，启用后仅在源码模式生效。补全、诊断和引用跳转使用单独的 BananaMark 语法上下文，Markdown 编辑器继续使用 Obsidian 的语法树。源码分析、诊断和候选计算在插件内嵌的浏览器工作线程中进行。主窗口继续使用宿主的 Obsidian、Electron、CodeMirror 和 Lezer 模块。[Obsidian 编辑器扩展指南](https://docs.obsidian.md/Plugins/Editor/Editor%20extensions) · [官方示例插件的构建配置](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs)

源码模式下可用 Ctrl+Space 手动唤出建议。Obsidian 1.15.1 的自动建议有公开接口，手动触发使用该版本的宿主入口。该入口不可用时会提示，自动建议仍可使用。将光标移到引用上，从命令面板运行「跳转到 BananaMark 引用的定义」，可以打开对应章节并选中标签，也可以选中只读书目源码中的条目键。

## 实测结果

| 场景 | 结果 |
| --- | --- |
| 定理触发 | 在 emoji 后输入 `:::th`，按 Enter 插入带关闭围栏的定理环境，光标落在正文处。 |
| 手动补全 | Ctrl+Space 在适当位置打开建议。光标位于现有名字中间时，Enter 照常换行。 |
| 原生编辑 | 原生标题高亮、维基链接建议、多光标和 Cmd+Z 可用。 |
| 中文组词 | 系统拼音组词开始时关闭已有建议，空格可选中「你好」。CDP 组词用例也验证临时文本 `th` 不触发补全。 |
| 范围隔离 | 隔离两份论文的引用候选。Live Preview、范围外的文件和关闭覆盖的文件保留宿主的 Ctrl+Space 行为。 |
| 源码跳转 | 跨章标签与 YAML 条目选区支持 CRLF 和 emoji。外部更新 YAML 后，原键立即变为未知引用，新键可以跳转。重复标签会提示并拒绝跳转。 |
| 停用插件 | 从原来的源码编辑器移除建议、装饰和新增快捷键。 |

## 复测

使用隔离的 Obsidian 用户数据目录和专用 vault。开发检查使用 Node 26.0.0。使用 Node 22 运行标注检查时需要 22.13 或更新的补丁版本。

```sh
npm --prefix obsidian ci
npm --prefix obsidian test -- tests/language.test.ts tests/navigation.test.ts tests/language-worker.test.ts
npm --prefix obsidian run typecheck
npm --prefix obsidian run check:types
npm --prefix obsidian run build
```

将 `obsidian/dist/main.js`、`obsidian/manifest.json` 和 `obsidian/styles.css` 复制到专用 vault 的 `.obsidian/plugins/peerpedia/`。在专用 vault 中启用 Peerpedia，创建 `draft/paper.md` 和同目录的 `draft/paper.json`，在插件配置中启用 `draft` 文件夹并切换至源码模式。验证停用行为时，先让建议窗口保持打开。

## 离线预览渲染组件

Apple Silicon 版随包携带 Node.js 22.22.3、网站的 BananaMark 渲染器、TikZ 的 WebAssembly 和 TeX 资产，以及 `@peerpedia/theme` 的样式、KaTeX 和 BaKoMa 字体。开稿和预览使用随包的组件，无需安装 Node.js、Python 或 TeX。预览界面需要在组件上层接入。

构建阶段从锁文件安装依赖，从 Node.js 官方站点下载运行时并验证固定的 SHA-256。构建产物在 `obsidian/dist/renderer/`。保持该目录结构即可搬移组件。预览界面可从其中的 `theme/style.css` 和 `theme/assets.json` 读取样式及资源清单。返回的 TikZ 字体地址相对于 `theme/`，章节链接保留网站渲染器生成的查询参数与锚点。`provenance.json` 记录源码提交、源文件校验和、运行时校验和以及实际安装的依赖版本。

```sh
npm --prefix obsidian ci
npm --prefix obsidian run package:renderer
npm --prefix obsidian test -- tests/renderer-runtime.test.ts
```

Obsidian 通过独立进程异步渲染，单次请求从提交起最多等待 40 秒。取消或超时时会停止该请求占用的进程，后续请求启动新进程。TikZ 缓存写入 `~/Library/Caches/Peerpedia/Obsidian/tikz/`。

冷缓存测试将完整组件复制到另一个临时目录，清空 `PATH`，并通过 macOS 策略禁止联网、读取源码工作区和写入组件目录。两章样本的 KaTeX、TikZ、交换图、跨章引用和共享书目均成功渲染。在隔离的 Obsidian 1.15.1 中单独禁止渲染子进程联网，验证了相同样本、两种本地字体实际加载以及渲染进程退出。
