<div align="center">

<img src="../src-tauri/icons/nexq-clean.png" alt="NexQ Plus" width="112">

# NexQ Plus

**An AI meeting and interview assistant that puts Chinese first and lets you configure every model and service yourself.**<br>
A personal fork of [NexQ](https://github.com/naxhq/NexQ): it hears both sides of a call, transcribes and translates them live, and answers in a window only you can see.

[![Release](https://img.shields.io/github/v/release/PLus123456/NexQ-Plus?style=flat-square&color=2f81f7)](https://github.com/PLus123456/NexQ-Plus/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey?style=flat-square)](https://github.com/PLus123456/NexQ-Plus/releases/latest)

**[Download](https://github.com/PLus123456/NexQ-Plus/releases/latest)** ·
**[Changelog](../CHANGELOG.plus.md)** ·
**[Report a problem](https://github.com/PLus123456/NexQ-Plus/issues/new/choose)** ·
**[中文](README.md)**

</div>

---

## What it is

NexQ splits your microphone ("You") and the sound your computer plays ("Them") into two streams and transcribes each. When the other side asks a question, an overlay streams an answer, and the overlay can hide from screen sharing.

NexQ Plus is the version I changed for my own use. My meetings, interviews and lectures switch between Chinese and English, and my models mostly run on my own machines or on services I pick. So the fork focuses on three things: a Chinese interface and Chinese-language cases, models and services you configure yourself, and live captions with translation.

## What it adds

- **Chinese interface** throughout, with a live switch to English; Chinese question detection, export file names and word counts fixed.
- **Your own models:** several LLM connections with the base URL used as typed, editable keys and headers, hand-typed model IDs (no built-in "recommended" list), and a model per task.
- **Speech services anywhere:** Soniox live captions with one-way or two-way translation and regions picked by latency; Whisper running on another machine; Metal GPU for local Whisper.cpp.
- **Caption strip** over the meeting, each line with its translation underneath.
- **Interview answer window** with question detection, predicted questions and bookmarks.
- **Personal knowledge base** with your own embedding and rerank endpoints and Chinese keyword search.
- **Echo cancellation**, so the other side heard through the speakers is not transcribed as you.
- **Releases built on GitHub** from a version tag, with in-app updates.

Generic fixes go upstream first. Already merged into NexQ: [#56](https://github.com/naxhq/NexQ/pull/56), [#60](https://github.com/naxhq/NexQ/pull/60), [#61](https://github.com/naxhq/NexQ/pull/61), [#62](https://github.com/naxhq/NexQ/pull/62), [#63](https://github.com/naxhq/NexQ/pull/63), [#83](https://github.com/naxhq/NexQ/pull/83), [#104](https://github.com/naxhq/NexQ/pull/104).

## Install

macOS on Apple Silicon only, for now. Download the `.dmg` from [Releases](https://github.com/PLus123456/NexQ-Plus/releases/latest) and drag NexQ Plus into Applications. The app is not notarized: if macOS says it can't check it, right-click the app → Open once, or run `xattr -dr com.apple.quarantine "/Applications/NexQ Plus.app"`. Later versions download in the background and install when you quit.

NexQ Plus (`com.plus.nexq`) keeps its data and keychain items apart from the official NexQ. Both can be installed, but don't run them at the same time: their global shortcuts and meeting detection collide.

## Build from source

Node.js 20+, Rust stable, the Xcode Command Line Tools and CMake (see [DEVELOPMENT.md](../docs/DEVELOPMENT.md)), then:

```bash
git clone https://github.com/PLus123456/NexQ-Plus.git
cd NexQ-Plus
npm ci
./build-mac.sh --bundles app
```

## License

[MIT](../LICENSE). NexQ: Copyright (c) 2026 Vahid Alizadeh. NexQ Plus changes: Copyright (c) 2026 PLus123456. Thanks to Vahid Alizadeh, everyone who contributed to NexQ, and [visitek](https://github.com/visitek) for the macOS port.
