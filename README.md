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

装成应用:

```bash
bun scripts/install.ts
```

macOS 上它从当前 checkout 打包, 装到 `/Applications/justnotes.app`; Windows 上它下载 main 最新一次 CI 构建的 release, 装到 `%LOCALAPPDATA%\Programs\justnotes`. 两边都把 `justnotes` 命令放进 `~/.local/bin`. 装之前先退出正在运行的 justnotes; vault 列表, 布局和设置在应用之外, 重装不会丢.

装好之后它会自己更新: 启动时和之后每 6 小时去 GitHub 看 main 最新的构建, 有新的就在后台下好, 提示 "Restart to update". 点它就原地换成新版并重新打开; 不点的话下次退出时换. 设置 → General 里可以关掉自动更新, 或者手动 Check for updates. 从源码跑 (`bun run start`) 时不会自己更新. 版本号从第一个正式构建 (0.1.0) 开始, 每个提交第三位加一, 超过 80 进一位到中间那位; 大版本或中版本手动升, 在那个提交上打一个 `v` tag.

Windows 更新时保留原安装目录, 只替换发布包里的应用文件, 上一版保存在 `.previous`. 替换失败会回滚; profile, vault 和已有快捷方式不变. 更新源只用 `qiulinfan/justnotes` 的 Releases, 上游源码同步单独处理.

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

- Live Preview: 标题, 粗体斜体, 链接 (包括引用式链接, 脚注, 路径带空格的 Typora 写法), `[[wikilink]]`, 图片 (包括 `<img>` 和 HTML 块), 任务列表, 引用, callout, 表格, 行内和块级公式 (MathJax), mermaid, 嵌入 (笔记, 标题段落, PDF, base) 和插件的代码块.
- 空的 `>` 行按 Enter 退出一层引用, 像 Typora.
- 代码块像 Typora: 光标在里面也不显示 ``` 行, 语言在框右下角填. 选区包住整个代码块时才显示源码, 其它时候打字和删除不会弄坏 ``` 行.
- 设置的 Editor 页有 Code blocks 和 Math blocks 两组: 代码块可以换回 Obsidian 的显示方式, 调字号, 显示行号, 语言框只在编辑时显示; 公式块可以像 Typora 那样编辑时在下面显示渲染结果, 调大小, 靠左对齐.
- 右键菜单有格式, 段落, 插入 (脚注, 表格, callout, 代码块, 公式块, 分隔线).
- 粘贴和拖进来的图片默认写成 Typora 的 `<img>`. 双击图片可以缩放, 对齐, 重命名, 移动.
- 选中文本拖到边缘时的滚动速度和笔记的行间距可以在设置的 Editor 页调.
- 阅读视图 (`⌘E`). 链接悬停预览: 阅读视图里直接悬停, Live Preview 里按住 `⌘`.
- 全文搜索 (`⌘⇧F`), 直接读文件, 没有索引. `tag:#标签` 按标签搜 (正文和 frontmatter, 含子标签).
- Bases: `.base` 文件和 `base` 代码块, 表格, 卡片和列表视图, 排序, 分组, 筛选, 公式, 在表格里改属性.
- 命令面板 (`⌘P`), 快速切换 (`⌘O`), 设置 (`⌘,`). vault 里 `.obsidian/hotkeys.json` 的快捷键会生效.
- 核心插件: 反向链接 (侧栏和笔记底部, 含未链接的提及, 可以一键改成链接), 出链, 大纲 (可搜索, 跟随光标), 标签, 关系图谱 (全局和局部), Canvas (可以从文件栏, Finder 拖文件进去), 书签 (含网址书签), 幻灯片, 录音, 日记, 模板, 笔记合并, 文件恢复, 所有属性, 字数统计. 默认开哪些跟 vault 的 `core-plugins.json` 走, 在设置的 "Core plugins" 页可以单独开关 (只存在 justnotes 里). 核心插件自己的设置 (比如模板文件夹) 要在 Obsidian 里改.
- 设置有 Obsidian 的常规, 编辑器, 文件与链接, 外观几页, 还有快捷键和插件. `.obsidian/themes` 和 `.obsidian/snippets` 里的主题和 CSS 片段可以切换, 不会下载东西.
- 不带 vault 打开时先出一个 vault 选择窗口 (最近的 vault, 打开文件夹, 新建 vault). 左下角切换 vault, 菜单栏有完整的 justnotes 菜单.
- 属性: 在 Live Preview 和阅读视图里直接改, 按类型显示 (文本, 列表, 数字, 勾选, 日期, 标签).
- 改文件名像 Obsidian: 直接改笔记顶上的标题 (内联标题, 设置的外观页可以关掉) 或标签页标题栏里的文件名, 按 Enter 生效, Esc 取消; `F2` 跳到标题并选中名字. 链接跟着更新.
- 标签页可以拖动: 重排, 换到别的组, 拖到边上分屏, 拖出窗口变成弹出窗口. 文件栏的文件可以拖进笔记 (插入链接) 或终端 (输入路径).
- 命令行 `justnotes`: Obsidian 自带的命令行命令 (同名同语法, Publish 和 Sync 除外) 加上插件注册的命令, 另外每个命令都能 `--json`, 只读的命令不开 app 也能用, 需要 app 时会自己启动它. `justnotes help` 列出全部, `justnotes completion fish` 生成补全. 放进 PATH: `ln -s "$PWD/src/cli/justnotes.ts" ~/.local/bin/justnotes` (需要 Bun).
- tex 和 txt 也是笔记: `.tex` 用内置的 LaTeX 编辑器 (就是 LaTeX Live: 补全, 实时预览, 用本机 TeX 编译, PDF 预览和 SyncTeX 双向跳转, 导出 HTML), `.txt` 用纯文本编辑器. 它们在文件栏, 快速切换, 搜索, 大纲, 图谱, 反向链接里都和 md 一样, `[[main.tex]]` 这种链接也能用. 往 `.tex` 里粘贴图片会存成附件, 弹出一个小表单选宽度, 标题, 标签. 需要装 TeX (MacTeX 或 TeX Live), 补全需要 texlab.
- 代码和数据文件 (json, yaml, cpp, py, rust, ts, js, css, html 等) 在 justnotes 里直接打开, 有语法高亮, 也能改.
- 内置终端: 在标签页里开你的登录 shell, 字体, 配色和背景图沿用 Ghostty 的配置. 命令面板 "Terminal: Open terminal" 或侧栏按钮打开.
- 不在任何 vault 里的文件 (没有上层 `.obsidian`, 也不是打开过的 vault) 会单独开一个窗口: 只有这个文件和它引用的图片, 链接, 不扫描文件夹, 不加载插件, 不进 vault 列表, 也不在文件夹里建 `.obsidian`. 能编辑保存, 有大纲; 反向链接, 搜索, 图谱这些没有. 窗口里改的设置不保存.
- 默认显示所有类型的文件.
- LaTeX 和终端在设置的 "Core plugins" 页可以关掉. 开着时 justnotes 不加载社区插件 latex-live 和 terminal (它们在 Obsidian 里照常用).
- 测过的 Obsidian 插件: Copy Location, Quick LaTeX, Completr, YOLO Completion Only, Background, kgdistiller, LaTeX Live, Git, omp, QuickAdd, Terminal, Translate.

还没有的: 设置里的 vim 键位, 拼写检查语言, 幻灯片的演讲者备注.

justnotes 在 `.obsidian/` 里只写三个文件, 都和 Obsidian 共用: `bookmarks.json`, 以及改设置时的 `app.json` 和 `appearance.json`. 只写你改的那几项, Obsidian 或 git 同时做的改动会保留. 所以和 Obsidian 交替打开同一个 vault 没问题.

## License

MIT
