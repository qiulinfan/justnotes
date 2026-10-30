# justnotes

> Why do I need any closed-source editor and any cloud service for note taking and personal knowledge base?

I just don't think I need any cloud service for personal knowledge base (why do I even need a database? I don't want to look stuff up for like 1 million times a sec.) I just need a local notetaking tool with live-preview, a local tool to search for stuff and a local tool to automatically upload stuff to my cloud drive, so that if I switch device, I can restore it.

## 运行

需要 [Bun](https://bun.sh).

```bash
git clone https://github.com/qiulinfan/justnotes.git
cd justnotes
bun install
bun run start --vault /path/to/your/vault
```

vault 就是一个放 Markdown 文件的文件夹. 已有的 Obsidian vault 可以直接打开, 里面装的社区插件会被加载.

## 这是一个对 Obsidian 的 reverse engineering 吗

不是. 这是一个 reimplementation of (most) APIs. 用 Electron 做一个 md 编辑器本质上是一个很简单的事情. 甚至在无 AI 时代就很容易做了 (只不过很慢).

## 这个 md 编辑器特点是啥

可以接 Obsidian 的插件. (所以也可以是一个 LaTeX & Typst 编辑器, 如果你接我的插件的话.)

不过 Obsidian 有版本更新, API 可能不一样, 所以存在你用的插件接不了的情况, 那就 call 一个 agent 修一下就行了.

## 为什么我不用 Obsidian

我用 Obsidian 的体验大部分是好的. 除了偶尔 `>` 开头的部分换行总有问题, 不如 Typora 顺 (但是 Typora 要钱以及没有 AI 辅助写作的 feature), 以及少有的地方不喜欢 (比如选中文本下滑的速度不能定制).

这些本质都是小问题, 但是有一个共性就是闭源软件用的真的不爽. 何况这只是一个 md 编辑器和 previewer, 外加一些很容易做的知识库设计.

以及我真的不认为你需要为了 note taking 购买任何的云服务.

## 现在能用的

- Live Preview: 标题, 粗体斜体, 链接, `[[wikilink]]`, 图片, 任务列表, 引用, 行内和块级公式 (MathJax).
- 全文搜索 (`⌘⇧F`), 直接读文件, 没有索引.
- 命令面板 (`⌘P`), 快速切换 (`⌘O`), 设置 (`⌘,`). vault 里 `.obsidian/hotkeys.json` 的快捷键会生效.
- 测过的 Obsidian 插件: Copy Location, Quick LaTeX, Completr, YOLO Completion Only.

还没有的: 阅读视图, 反向链接, 日记和模板这类核心插件, 自动上传到云盘.

justnotes 只读 `.obsidian/` 里的配置, 不会写, 所以和 Obsidian 交替打开同一个 vault 没问题.

## License

MIT
