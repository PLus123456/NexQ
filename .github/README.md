<div align="center">

<img src="../src-tauri/icons/nexq-clean.png" alt="NexQ Plus" width="112">

# NexQ Plus

**中文优先、模型和服务都由自己配置的 AI 会议与面试助手。**<br>
基于开源项目 [NexQ](https://github.com/naxhq/NexQ) 改造：同时听你和对方两路声音，实时转写和翻译，在只有你看得见的窗口里给出回答。

[![Release](https://img.shields.io/github/v/release/PLus123456/NexQ-Plus?style=flat-square&color=2f81f7)](https://github.com/PLus123456/NexQ-Plus/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey?style=flat-square)](https://github.com/PLus123456/NexQ-Plus/releases/latest)
[![Upstream](https://img.shields.io/badge/upstream-naxhq%2FNexQ-blue?style=flat-square)](https://github.com/naxhq/NexQ)

**[下载](https://github.com/PLus123456/NexQ-Plus/releases/latest)** ·
**[更新日志](../CHANGELOG.plus.md)** ·
**[试用说明](../docs/fork/TRIAL_GUIDE.md)** ·
**[反馈问题](https://github.com/PLus123456/NexQ-Plus/issues/new/choose)** ·
**[English](README.en.md)**

</div>

---

## 这是什么

NexQ 是一个开源的 AI 会议和面试助手。它把麦克风（“我”）和电脑里播放的声音（“对方”）分成两路，各自转写；对方一提问，悬浮窗里就流式给出回答，而且可以对屏幕共享隐藏。

NexQ Plus 是我在它的基础上给自己改的版本。我开会、面试、听讲座基本都在中文和英文之间切换，模型也大多跑在自己的机器上或者用自己挑的服务，所以重点改了三块：中文界面和中文场景，所有模型和服务都能自己配，以及实时字幕和翻译。

## 我的想法

- **中文是第一语言。** 界面、托盘菜单、首次设置都是中文，随时可以切回英文。中文问题检测、导出文件名里的中文、中文字数统计这些原版容易出错的地方，都单独修过。
- **模型我自己选，程序不替我选。** 不内置“推荐模型”，模型列表里只有我自己填的和从接口拉到的。Base URL 原样使用，不会偷偷补 `/v1`；Key、请求头、思考参数都能改。实时翻译、会议总结和每个 AI 动作可以各用各的模型。
- **服务可以放在别的机器上。** 语音识别可以接另一台机器上的 Whisper（OpenAI 兼容接口）；知识库的 embedding 和 rerank 也填自己的地址。
- **能调的都给开关。** 断句灵敏度、每一路的识别语言、翻译方向、字幕条的字号和背景、回声消除，都在设置里。
- **能合回官方的先合回官方。** 通用的修复先以小 PR 提给 naxhq/NexQ，合并以后这边就不用单独维护。已经合进官方的有：[Windows 测试门控](https://github.com/naxhq/NexQ/pull/56)、[macOS CI 跑 Rust 测试](https://github.com/naxhq/NexQ/pull/60)、[中日文问题检测](https://github.com/naxhq/NexQ/pull/61)、[导出文件名保留中文](https://github.com/naxhq/NexQ/pull/62)、[中文字数统计](https://github.com/naxhq/NexQ/pull/63)、[回声消除](https://github.com/naxhq/NexQ/pull/83)和它的[漂移修复](https://github.com/naxhq/NexQ/pull/104)。

## 比官方版多了什么

| 方面 | NexQ Plus |
|---|---|
| 界面 | 简体中文，托盘菜单也是；设置里切 English，所有窗口同时生效 |
| AI 模型 | 可以建多个连接，自带 OpenAI 兼容、DeepSeek、硅基流动、Ollama、LM Studio、Anthropic、Gemini、OpenRouter、Claude 订阅等模板；输入框下面显示实际请求地址；按任务分配模型；底栏可以快速换模型 |
| 语音识别 | “我”和“对方”分别选引擎和识别语言。Soniox 实时字幕可以顺带单向或双向翻译，美国、欧盟、日本、印度四个区按延迟自动选，并发满了换下一个区。远程 Whisper 跑在别的机器上；本地 Whisper.cpp 可以开 Metal GPU |
| 字幕条 | 浮在会议上方的透明字幕条，原文下面是译文；可以拖动、改大小、调字号和背景，锁定后鼠标可以穿透 |
| 面试 | 答案窗：问题检测（规则加可选的 LLM 确认），预测对方的下一个问题并提前备好答案，书签可以跳回转写里的那句话 |
| 翻译 | LLM 翻译的提示词和术语表可改，DeepL、微软、谷歌的地址可改，可以只翻“对方”；Soniox 的译文直接上字幕，不再翻第二遍 |
| 个人知识库 | 自定义 embedding 端点；int8 向量索引加中文关键词混合检索；改了文档只重算改动的部分；可选 rerank |
| 音频 | 回声消除（WebRTC AEC3）：用外放开会时，对方的声音不会被当成你说的 |
| 首次设置 | 六步引导：语言、AI 模型、语音识别、翻译、音频测试、开会前检查；中途退出，下次接着做 |
| 更新 | 推一个版本标签，GitHub Actions 就编译并发布新版本；装好的应用自动更新 |

## 安装

目前只有 macOS Apple Silicon 版本。

1. 从 [Releases](https://github.com/PLus123456/NexQ-Plus/releases/latest) 下载 `.dmg`，把 NexQ Plus 拖进“应用程序”。
2. 应用没有经过 Apple 公证。第一次打开如果提示无法验证，右键应用选“打开”，或者运行：
   ```bash
   xattr -dr com.apple.quarantine "/Applications/NexQ Plus.app"
   ```
3. 第一次开会时按提示允许麦克风、屏幕与系统录音权限。录系统声音需要 macOS 14.2 或更新。
4. 以后有新版本会在后台下载，退出时安装。设置 → 关于 里可以关掉自动更新。

NexQ Plus 的 Bundle ID 是 `com.plus.nexq`，数据和钥匙串条目都和官方 NexQ 分开，两个可以同时装，但别同时打开：全局快捷键和会议检测会互相抢。

## 从源码构建

需要 Node.js 20 以上、Rust stable、Xcode Command Line Tools 和 CMake，详见[开发说明](../docs/DEVELOPMENT.md)。

```bash
git clone https://github.com/PLus123456/NexQ-Plus.git
cd NexQ-Plus
npm ci
./build-mac.sh --bundles app
```

`build-mac.sh` 会编译、签名并装到“应用程序”里。钥匙串里有 Apple Development 证书时就用它签名，这样重新编译以后，钥匙串和隐私权限不用再授权一遍。

## 发布新版本

```bash
npm run release:plus              # 下一个补丁版本，比如 2.41.3 → 2.41.4
npm run release:plus -- 2.42.0    # 指定版本
npm run release:plus -- --dry-run # 只看版本号和更新日志，不改任何东西
```

脚本会把上次发版以来的 `feat`、`fix`、`perf` 提交写进 [CHANGELOG.plus.md](../CHANGELOG.plus.md)，改版本号、提交、打上 `plus-v<版本>` 标签并推送。标签一到 GitHub，[Release NexQ Plus](https://github.com/PLus123456/NexQ-Plus/actions/workflows/release-plus.yml) 工作流就在 macOS 上编译，发布带安装包和自动更新文件的 Release。需要哪些 Secrets，写在 [release-plus.yml](workflows/release-plus.yml) 的开头。

## 和上游的关系

- GitHub 上只有 `custom` 一个分支，就是 NexQ Plus 的代码。
- 本地的 `main` 跟踪 naxhq/NexQ 的 `main`，定期合并进 `custom`。
- 提给官方的 PR 从 `upstream/main` 拉分支，合并后删掉。
- 改造计划和分支模型的细节见 [docs/fork/OVERHAUL_PLAN.md](../docs/fork/OVERHAUL_PLAN.md)。

## 许可与致谢

[MIT 许可证](../LICENSE)。NexQ 原作 Copyright (c) 2026 Vahid Alizadeh；NexQ Plus 的修改 Copyright (c) 2026 PLus123456。

感谢 [Vahid Alizadeh](https://github.com/VahidAlizadeh) 和 NexQ 的所有贡献者，特别是做了 macOS 移植的 [visitek](https://github.com/visitek)。
