# justnotes

> Why do I need any closed-source editor and any cloud service for note taking and personal knowledge base?

一个本地 Markdown 编辑器, 直接打开 Obsidian vault, 加载 vault 里已安装的 Obsidian 社区插件. 不联网, 不登录, 没有云服务.

justnotes 自己实现了一套与 Obsidian API 兼容的 `obsidian` 模块, 没有复用 Obsidian 的任何代码.

## 运行

需要 [Bun](https://bun.sh).

```bash
bun install
node node_modules/electron/install.js   # 第一次安装时下载 Electron
bun run build
./node_modules/.bin/electron . --vault /path/to/vault
```

不带 `--vault` 启动时会弹出文件夹选择框.

## 读写哪些文件

- 读取 vault 的 `.obsidian/app.json`, `appearance.json`, `hotkeys.json`, `community-plugins.json` 和 `plugins/`, 只读不写.
- 插件自己的 `data.json` 由插件按需写入, 与在 Obsidian 里一样.
- 布局(打开的标签页, 侧栏折叠, 文件树展开状态)存在 justnotes 自己的 localStorage 里, 不写 `.obsidian/workspace.json`, 所以和 Obsidian 交替使用同一个 vault 不会互相覆盖.

## 当前状态

已验证可用的插件: Copy Location, Quick LaTeX, Completr(包括 LaTeX 补全和占位符跳转), YOLO Completion Only(已加载, 设置页正常, 尚未实测 Tab 补全请求).

快捷键: `⌘P` 命令面板, `⌘O` 快速切换, `⌘,` 设置, `⌘N` 新笔记, `⌘S` 保存, `⌘W` 关闭标签页. `hotkeys.json` 里的自定义快捷键会生效.

尚未实现:

- Live Preview(隐藏 Markdown 语法, 渲染公式和嵌入内容). 编辑器目前是带语法高亮的源码模式.
- 阅读视图, 公式渲染(MathJax), 悬停预览, 反向链接, 搜索面板.
- Obsidian 的核心插件(日记, 模板等).
- 其余插件: latex-live, kgdistiller, background, omp-sidebar, obsidian-git, quickadd, terminal.
