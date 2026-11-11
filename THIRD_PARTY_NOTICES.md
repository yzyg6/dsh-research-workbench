# 第三方来源与许可

界面与面板交互参考 [cinderzhan/dsh-media-workbench](https://github.com/cinderzhan/dsh-media-workbench)，本次核对 commit `551a3c55d9c7a4e0330752ccac014b1b1910a6b3`。参考内容为紧凑工具栏、面板换位／缩放／最小化恢复、保留原生会话及业务资料隔离的设计。科研项目模型与当前 DSH 承载实现保存在本项目源代码中。

参考仓库采用 MIT License，Copyright (c) 2026 cinderzhan。参考源码的完整许可快照保存在开发过程目录；许可原文为：

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

原生插件使用 DSH 提供的 React。独立浏览器版本打包 React / React DOM 19.2.0（MIT，Copyright Meta Platforms, Inc. and affiliates），构建工具为 esbuild 0.25.12（MIT）；构建产物保留对应许可证注释。

选句编辑功能使用 Tiptap 3.33.0、ProseMirror、Marked 和 KaTeX。已安装的编辑器及其运行依赖的原始许可证按包保存在 `licenses/editor/`，版本与来源清单见其中的 `manifest.json`。KaTeX 字体随 CSS 内联，沿用 KaTeX 随包许可。前端与服务器中的稿件定位和 Markdown 序列化由本项目共享模块调用这些依赖完成。


Word 编辑器嵌入 [storytold/wordcraft](https://github.com/storytold/wordcraft) v0.17.0，固定 commit `5574b32600aa7d782c64f5a6c6bb24696152220d`。采用上游未修改的 WASM（gzip 交付），官方生成 JS glue 经 esbuild 合并其本地 eframe snippet，并由独立宿主桥接文件接入 DSH。许可选择 MIT；上游 MIT、Apache、NOTICE、ATTRIBUTION 与所有随包字体 OFL 保留于 `licenses/wordcraft/`。上游资产与校验清单见 `public/wordcraft/version.json`，重制脚本见 `scripts/prepare-wordcraft.cjs`。


0.7.1 为 Wordcraft Web 单独打包 Noto Sans CJK SC 2.004（源：https://github.com/notofonts/noto-cjk）。采用保留字体字符映射的 WOFF2 压缩封装；字体及原始版权信息遵循 SIL Open Font License 1.1，完整许可与源文件SHA见 `licenses/wordcraft/OFL-noto-cjk-runtime.txt` 和 `noto-cjk-source.json`。该字体只用于编辑器显示回退。
