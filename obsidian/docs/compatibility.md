# Obsidian 编辑器兼容性

2026 年 11 月 24 日在 macOS 15.6.1（Apple Silicon）验证 Obsidian Desktop 1.15.1，宿主使用 Electron 43.8.9。插件声明 `isDesktopOnly: true` 和 `minAppVersion: 1.15.1`。兼容范围以这次实测的桌面版本为基线。

兼容性探针在源码模式下为同目录有 `paper.json` 的 `paper.md` 提供 `theorem` 补全。后续项目适配会读取章节清单来确定完整范围。扩展通过 `Plugin.registerEditorExtension` 接入原生 CodeMirror，在符合条件的编辑器内挂载补全界面和快捷键。Markdown 语法树仍由 Obsidian 提供。构建把 `obsidian`、Electron、CodeMirror 和 Lezer 标为外部依赖，运行时使用宿主模块。[Obsidian 编辑器扩展指南](https://docs.obsidian.md/Plugins/Editor/Editor%20extensions) · [官方示例插件的构建配置](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs)

## 实测结果

| 场景 | 结果 |
| --- | --- |
| 定理触发和偏移 | 在 emoji 后换行输入 `:::th`，弹出 `theorem`，按 Enter 得到 `:::theorem`。 |
| 原生 Markdown 和撤销 | 键入 `# Native heading` 后出现原生标题高亮，Cmd+Z 撤销整次输入。原生维基链接建议仍可打开。 |
| 多光标 | 两处游标同时输入 `x`，一次 Cmd+Z 恢复两行。 |
| macOS 简体拼音 | 通过 Quartz 发送按键，由系统拼音输入法处理 `nihao`。组词开始时关闭已有定理建议，按空格选中 `你好` 后文档为 `:::th你好`。 |
| Chromium 组词回归 | CDP 提供临时文本 `th`，组词期间无定理建议。更新并提交 `定理` 后，文档为 `:::定理`。 |
| 范围隔离 | 同项目的其他笔记、没有 `paper.json` 的 `paper.md` 以及 Live Preview 均无定理建议，Ctrl+Space 行为与宿主基线一致。 |
| 插件卸载 | 在建议菜单打开时停用插件，原编辑器中的菜单、补全源和快捷键即时移除。正文保留，编辑与撤销仍可用。 |

初次宿主试验确认仅提供补全源无法弹出菜单。启用整套补全后，范围外笔记的 Ctrl+Space 被 CodeMirror 的默认键位消费。改为按编辑器范围挂载补全扩展后复测通过。简体拼音测试走 macOS 的系统输入法，按键由 Quartz 生成。CDP 测试单独覆盖会触发补全的临时文本。

## 复测

使用隔离的 Obsidian 用户数据目录和专用 vault。开发检查使用 Node 26.0.0。使用 Node 22 运行标注检查时需要 22.13 或更新的补丁版本。

```sh
npm --prefix obsidian ci
npm --prefix obsidian test -- tests/editor-probe.test.ts
npm --prefix obsidian run typecheck
npm --prefix obsidian run check:types
npm --prefix obsidian run build
```

把 `obsidian/dist/main.js`、`obsidian/manifest.json` 和 `obsidian/styles.css` 复制到专用 vault 的 `.obsidian/plugins/peerpedia/`。在专用 vault 的设置中启用 Peerpedia，创建 `draft/paper.md` 和同目录的 `draft/paper.json`，切换至源码模式后复测。检查禁用插件的效果时，先让定理建议菜单保持打开。
