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

使用隔离的 Obsidian 用户数据目录和专用 vault。开发检查使用 Node 26.0.0。项目的构建工具支持 Node 22.13 以上的 22.x，或 Node 24 及以上。

```sh
npm --prefix obsidian ci
npm --prefix obsidian test -- tests/language.test.ts tests/navigation.test.ts tests/language-worker.test.ts
npm --prefix obsidian run typecheck
npm --prefix obsidian run check:types
npm --prefix obsidian run build
```

按[安装说明](installation.md)构建并安装完整目录到专用 vault 的 `.obsidian/plugins/peerpedia/`。在专用 vault 中启用 Peerpedia，创建 `draft/paper.md` 和同目录的 `draft/paper.json`，在插件配置中启用 `draft` 文件夹并切换至源码模式。验证停用行为时，先让建议窗口保持打开。

## 离线预览渲染组件

插件安装包只有 `main.js`、`manifest.json` 和 `styles.css`。共享渲染器、TikZ 的 WebAssembly/TeX 资源，以及共享主题和字体在构建时嵌入。运行时使用浏览器 Worker，不携带 Node 可执行文件，不启动外部渲染进程，也不写旧版磁盘图表缓存。

渲染调度由插件统一管理。单次请求从提交起最多等待 40 秒；取消或超时只终止对应工作，排队的其他请求可以继续；闲置 30 秒后释放渲染 Worker，停用插件时清理队列。样式、高亮及字体继续来自网站共用的包。

```sh
npm --prefix obsidian test -- tests/render-request.test.ts tests/browser-renderer.test.ts
```

源码定位、渲染结果和诊断由请求处理测试验证；真正的离线资源加载和宿主卸载由三文件包的实机测试验证。复现完整构建及隔离宿主验收见[安装说明](installation.md)。当前浏览器渲染基准见 [基准说明](../bench/README.md)。
