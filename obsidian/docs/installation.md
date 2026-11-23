# 安装 Peerpedia 离线写作插件

此安装包版本为 **0.1.0**，面向 **Apple Silicon Mac** 上的 Obsidian Desktop 1.15.1。插件清单要求 Obsidian 至少 1.15.1，验收使用该版本。完整预览使用包内的 macOS arm64 Node.js 22.22.3。Intel Mac、Windows、Linux 和移动端无对应安装包。打开、编辑和预览本地论文无需连接账号，也无需另装 Node.js、Python 或 TeX。

## 手动安装

1. 解压得到一个 `peerpedia` 目录。确认目录内有 `manifest.json`、`main.js`、`styles.css` 和完整的 `renderer/`。保留 `renderer/bin/node` 的可执行权限及所有子目录。使用 Finder 解压可保留包内权限。
2. 在 Obsidian 打开要使用的库。按 **⌘⇧.** 在 Finder 显示隐藏项目。打开库的 `.obsidian/plugins/`，把整个 `peerpedia` 目录放入其中。若更改过库配置目录，使用当前配置目录下的 `plugins/`。必要时手动新建 `plugins/`。
3. 若已有同名插件目录，先在 Obsidian 停用原插件，并把原目录备份到 `plugins/` 之外。安装时使用空出的目录，避免合并不同版本的文件。
4. 重新打开库。在「设置 → 第三方插件」允许社区插件，然后启用 Peerpedia。

包内 `package-manifest.json` 记录适用的平台、版本以及各文件的 SHA-256。清单中的路径从 `peerpedia` 目录起算。可在终端用 `shasum -a 256 main.js` 核对单个文件。若随包提供 `.zip.sha256`，可在同一目录用 `shasum -a 256 -c peerpedia-0.1.0-darwin-arm64.zip.sha256` 核对压缩包。许可证在根目录的 `LICENSE`、`licenses/` 及 `renderer/` 内。

## 初次使用

- 打开命令面板运行「Peerpedia：新建论文」。填写库内新文件夹路径及标题，选择单文件或多章节。项目以 `paper.json` 为入口。单文件默认是 `paper.md`，多章节以清单里的次序为准，共享书目可由「管理论文」面板添加。
- 若要打开已有 Peerpedia 论文，把整个论文目录放入库内，打开正文后运行「Peerpedia：管理论文」。在 Peerpedia 设置里添加论文文件夹的库内相对路径并启用。写作辅助默认关闭，子文件夹规则可覆盖上级文件夹，单文件规则优先。切换 Obsidian 编辑器至源码模式即可使用 BananaMark 补全、高亮、诊断和引用跳转。
- 在论文章节运行「Peerpedia：打开论文预览」。预览会跟随源码光标或切换的章节。可在预览自由滚动，想回到对应位置时点击「定位源码」。无效语法会显示错误，并保留上次成功预览。修正后会重新排版。
- 预览最多处理 64 章，正文和书目合计最多 1 MiB，每篇最多 32 张 TikZ 图，每张图的源码最多 32 KiB。单次渲染最多等待 40 秒。超过预览限制时仍可保留并编辑原文件。
- 已打开的论文章节遇到外部写入时，如果修改前的内容、未保存的编辑器草稿和外部版本互有差异，点击通知中的「核对版本」可查看三个版本。重新打开库后，运行「管理论文」，点击「查看恢复文件」仍可比较。关闭某章的写作辅助也能保留该章的冲突版本。
- 每次渲染结束后，图形缓存按最近使用时间保留最多 256 个结果，总大小上限为 64 MiB。被清理的图形可在下次预览时从本地源码重新生成。

## 移除插件

在「设置 → 第三方插件」停用 Peerpedia，然后移除库内的 `.obsidian/plugins/peerpedia/`。这会移除插件设置，正文、`paper.json`、书目和论文目录中的 `.peerpedia-obsidian/recovery/` 恢复记录仍留在库中。可选地清理本机的 `~/Library/Caches/Peerpedia/Obsidian/tikz/`，清理后再次使用会重建缓存。

## 从源码构建

在 Apple Silicon Mac 安装带 Node 头文件的 Node.js（22.13 以上的 22.x，或 24 及以上）和 Xcode Command Line Tools。使用以下命令生成 `obsidian/dist/peerpedia/`。依赖安装与首次下载签名运行时需要网络或已备好的缓存。

```sh
npm --prefix obsidian ci
npm --prefix obsidian run package
```

可在 `run package --` 后提供新的输出目录。打包拒绝使用已存在的目录，包括空目录。构建完成后把生成的目录命名为 `peerpedia`，按上面的步骤手动安装。
