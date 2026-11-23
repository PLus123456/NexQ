# 参与 NexQ Plus

> This is a personal fork of [NexQ](https://github.com/naxhq/NexQ). For NexQ itself, please contribute upstream, following [its contributing guide](https://github.com/naxhq/NexQ/blob/main/CONTRIBUTING.md).

NexQ Plus 由我个人维护，欢迎反馈问题和想法。

## 提问题和建议

- 遇到 bug、有想要的功能，直接[开 issue](https://github.com/PLus123456/NexQ-Plus/issues/new/choose)。
- 报 bug 时附上版本号（设置 → 关于），以及 设置 → 关于 → 诊断 → 复制最近日志 的内容。日志里可能有会议内容，贴之前看一眼。
- 安全问题不要公开发 issue，见 [SECURITY.md](SECURITY.md)。

## 改代码之前先想想该提给谁

- **和 Plus 无关的通用改进**（官方版也有的 bug、通用的新功能）：请直接提给官方 [naxhq/NexQ](https://github.com/naxhq/NexQ)，合并以后这里会跟着同步。
- **NexQ Plus 自己的东西**（中文定制、可配置的模型和服务、Soniox、字幕条、知识库等）：提到这里。从 `custom` 拉分支，PR 发回 `custom`。

## 开发

- 环境和命令见[开发说明](../docs/DEVELOPMENT.md)，构建安装用 `./build-mac.sh --bundles app`。
- 提交前跑一遍 `npm test`；改了 Rust 的话在 `src-tauri` 里跑 `cargo test --lib`。
- 界面上的文字要同时加英文和简体中文（`src/i18n/locales/en`、`src/i18n/locales/zh-CN`），`node scripts/i18n-check.mjs` 会检查有没有漏翻和写死的文字。
- 提交信息用英文，按 [Conventional Commits](https://www.conventionalcommits.org/) 写，比如 `fix(captions): …`。`feat`、`fix`、`perf` 开头的提交会自动进[更新日志](../CHANGELOG.plus.md)，所以要写给用户看得懂的话。

## 许可

提交到这里的代码按本仓库的 [MIT 许可证](../LICENSE)发布。
