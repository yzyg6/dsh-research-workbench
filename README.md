# DSH 科研论文工作台

面向 DSH Desktop 的科研写作插件，将项目资料、Word 编辑和论文修改对话放在同一个工作空间中。当前版本：**0.8.1**。

## 功能

- 以论文为单位管理项目，关联已有目录，浏览文稿、数据、图片和参考资料；移除项目入口时保留原文件。
- 内嵌 Wordcraft 编辑 DOCX，默认缩放 95%，按需加载中文字体。
- 逐句左右对照修改建议，以中科院蓝高亮具体改动，支持采用与撤回。
- 一篇论文对应一个 DSH 原生工作区，不同 Word 文件各自绑定独立对话；空对话也可显示，无需自动发送消息。
- 明确区分原稿与工作区版本。首次修改生成工作副本，后续持续更新同一个文件，并用本地 Git 记录文稿历史。
- 独立的格式修改对话：预览清理多余空格、设置中英文字体与字号的方案，再由作者应用；支持撤回。默认处理普通正文，复杂公式、域和代码等内容会跳过。
- 简洁圆润的中科院蓝界面，提供可调间隔的励志语句轮换；双击标语设置内容。

科研工作台直接注册为 DSH 左侧栏插件入口。外侧收纳栏的“五个常用插件”由配套的 `dsh-splitview` 插件控制，需使用已更新的配套版本；本仓库不包含整个配套插件。

## 环境与安装

需要支持插件机制的 **DSH Desktop**、**Node.js 24**、可通过 `python` 调用的 **Python 3.10+**，以及 PATH 中的 **Git**。本地 DOCX 处理使用 Python 标准库。AI 功能复用 DSH 原生模型配置，不需要把 API 密钥写进本仓库。

```bash
git clone https://github.com/yzyg6/dsh-research-workbench.git
cd dsh-research-workbench
```

通过 DSH Desktop 当前 profile 的插件管理入口，从本地目录安装该项目。仓库已经包含客户端构建和 Wordcraft Web 运行资源。插件更新后，先保存文稿，再重新加载插件或重启 DSH，使前后端同时更新。

原生会话、模型、工作区注册和侧栏显示能力依赖 DSH 宿主接口；本项目不是可独立替代 DSH 的聊天客户端。

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
