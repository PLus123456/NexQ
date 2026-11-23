# 安全问题

> Please report vulnerabilities privately through [Report a vulnerability](https://github.com/PLus123456/NexQ-Plus/security/advisories/new), never as a public issue.

## 支持的版本

只有[最新的 Release](https://github.com/PLus123456/NexQ-Plus/releases/latest) 会收到修复。

## 怎么报告

1. 打开本仓库的 [Security](https://github.com/PLus123456/NexQ-Plus/security) 页面，点 **Report a vulnerability**（[直接链接](https://github.com/PLus123456/NexQ-Plus/security/advisories/new)）。报告只有你和我能看到。
2. 写清楚影响的版本、怎么复现、可能造成什么后果。

我会尽快回复。确认以后修复并发布新版本，再公开说明。

如果问题出在 NexQ 官方也有的代码里，请同时按[官方的安全说明](https://github.com/naxhq/NexQ/security/policy)私下报告给官方。

## 范围

- NexQ Plus 把 API Key 存在 macOS 钥匙串（`NexQPlus:vault`），会议记录、知识库和设置存在本机。可能让别的程序或网页读到这些数据的问题，属于安全问题。
- 你在设置里填的第三方服务（LLM、语音识别、翻译）怎么处理你发过去的数据，由那些服务决定，不在这里的范围内。
