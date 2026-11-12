# DSH 科研论文工作台

面向 DSH Desktop 的科研写作插件，将项目资料、Word 编辑和论文修改对话放在同一个工作空间中。当前版本：**0.11.0**。

## 功能

- 以论文为单位管理项目，关联已有目录，浏览文稿、数据、图片和参考资料；移除项目入口时保留原文件。
- 内嵌 Wordcraft 编辑 DOCX，默认缩放 95%，按需加载中文字体。
- 逐句左右对照修改建议，以中科院蓝高亮具体改动，支持采用与撤回。
- 对照中的改后句子可点击“编辑本句”，保存后再采用；四级修改使用绿、蓝、橙、红底色。Word 采用与撤回优先在当前文档实例更新，保留原段落和滚动位置，保存时正文持续可见。
- 连续划句复用原生对话，切换模板立即更新自动生成的提示词，并保留手写要求；建议完成后直接通知界面。“关联”按需加载，DOCX 检查复用处理进程，Git 历史批量写入，减少交互链上的等待。
- 一篇论文对应一个 DSH 原生工作区，不同 Word 文件各自绑定独立对话；空对话也可显示，无需自动发送消息。
- 明确区分原稿与工作区版本。首次修改生成工作副本，后续持续更新同一个文件，并用本地 Git 记录文稿历史。
- DSH 深入当前 Wordcraft 编辑器：在同一个文稿对话中换字体、字号、调整对齐、行距、段前段后及缩进，清理连续空格、段首空格、空段落，直接修改并保存。支持选区或全文正文范围，保留编辑器撤销、重做和 Git 历史。
- 轻透磨砂导航、工具栏与浮层，搭配圆润分段控件和短动效；Word 与对话栏顶部对齐，原生消息气泡与输入框采用统一浅色。中科院蓝保持 `#174994`，正文与四级修改底色保持清晰。支持系统减少动态效果、减少透明度设置。
- 顶部励志标语支持内容、字体、切换间隔和暂停设置，双击即可实时预览。默认“毛体”优先使用本机已安装的“草檀斋毛泽东字体”，也可输入其他本机字体名称，选择保存在本地。字体文件不随插件分发；未安装时回退到系统字体。

科研工作台直接注册为 DSH 左侧栏插件入口。外侧收纳栏的“五个常用插件”由配套的 `dsh-splitview` 插件控制，需使用已更新的配套版本；本仓库不包含整个配套插件。

## 环境与安装

需要支持插件机制的 **DSH Desktop**、**Node.js 24**、可通过 `python` 调用的 **Python 3.10+**，以及 PATH 中的 **Git**。本地 DOCX 处理使用 Python 标准库。AI 功能复用 DSH 原生模型配置，不需要把 API 密钥写进本仓库。

```bash
git clone https://github.com/yzyg6/dsh-research-workbench.git
cd dsh-research-workbench
```

通过 DSH Desktop 当前 profile 的插件管理入口，从本地目录安装该项目。仓库已经包含客户端构建和 Wordcraft Web 运行资源。插件更新后，先保存文稿，再重新加载插件或重启 DSH，使前后端同时更新。

也可从 [v0.11.0 发布页](https://github.com/yzyg6/dsh-research-workbench/releases/tag/v0.11.0) 下载 `dsh-research-workbench-v0.11.0.zip`，解压后选择内含 `package.json` 的 `dsh-research-workbench` 文件夹安装。下载包已包含构建产物，无需自行安装前端依赖或编译。

若“保存本句”提示后台尚未加载保存接口，表示客户端已更新但运行中的 Host 仍是旧版。请先保留尚未保存的输入并保存当前文稿，再重新加载插件或重启 DSH，使前后端更新到同一版本。0.11.0 已包含完整的句子建议保存接口及版本不匹配提示。

原生会话、模型、工作区注册和侧栏显示能力依赖 DSH 宿主接口；本项目不是可独立替代 DSH 的聊天客户端。

打开 Word 后，在右侧原有对话中直接说“把选中文字改为宋体、12 磅”“全文两端对齐，1.5 倍行距”或“删除全文空段落”。无需切换格式标签或点击应用。编辑器关闭、文稿更新或选区变化时，DSH 会重新读取当前状态再操作。这里的“全文”包含标题与表格正文；不包含页眉页脚。“清理连续空格”保留英文单词之间的单个空格。

## 开发与测试

```bash
npm run setup:dev
npm run build
npm test
```

`setup:dev` 根据锁文件安装 UI 与编辑器依赖到 `_scratch/tmp/`，不会把依赖目录混入发布源码。构建会校验已分发 Wordcraft 与中文字体资源的哈希。需要重新准备上游运行资源时，使用 `scripts/prepare-wordcraft.cjs` 和 `scripts/prepare-cjk-font.py`，并保留第三方声明。

```bash
npm run dev
```

独立开发界面地址为 <http://127.0.0.1:4384>，用于本地界面与资料服务调试；完整原生对话功能须在 DSH 中使用。测试使用合成 Word 与隔离目录，不向模型自动发送消息。配套侧栏插件不存在时，其两项集成测试会跳过。

## 目录与数据

| 目录 | 内容 |
| --- | --- |
| `src/client` | React 界面与原生面板适配 |
| `src/server` | 项目资料、会话关联、DOCX 编辑与历史服务 |
| `src/shared` | 公共状态和文稿处理 |
| `public/wordcraft` | 固定版本的 Wordcraft Web 资源与中文运行字体 |
| `scripts` | 构建、依赖安装与资源准备 |
| `tests`、`probes` | 自动化测试及合成样例生成器 |
| `licenses` | 第三方授权与归属声明 |

默认元数据保存在 `DSH_HOME/workbenches/research`，未设置 `DSH_HOME` 时使用 `~/.dsh/workbenches/research`。论文文件保存在各自关联的项目目录；文稿 Git 历史位于项目内的 `.research-workbench/git/`。备份时应同时保留元数据和项目目录。

本仓库不包含个人论文、用户数据库、原生会话日志、本机验收截图或凭据。`_scratch/`、`workspace/`、`validation/` 和本地环境文件已被忽略。

## 第三方组件

Wordcraft、React、Tiptap、KaTeX 及分发字体的版本、来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [licenses](licenses)。系统字体不随本项目分发。界面采用中科院蓝配色，未分发院徽。

## 性能复测

```bash
node probes/word-edit/workflow-perf.mjs --enforce
node probes/word-edit/live-browser.mjs --review --enforce
```

第二项使用 Windows 上的 Edge 无头浏览器运行真实 Wordcraft WASM 和 React，全部材料位于 `_scratch/out/`，不调用模型。记录划句到提示词、建议通知、保存及位置保持；本地性能数字不包含模型生成或外部文献检索等待。
