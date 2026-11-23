# NexQ Plus changelog

What changed in each NexQ Plus release. The update dialog reads this file;
`npm run release:plus` adds an entry. Upstream NexQ's own history is in
CHANGELOG.md.

## [2.41.4](https://github.com/PLus123456/NexQ-Plus/compare/plus-v2.41.3...plus-v2.41.4) (2026-11-23)

### Features

* **release:** NexQ Plus releases built on GitHub from a plus-v tag

### Bug Fixes

* **captions:** judge the mouse right on screens scaled unlike the main one
* **captions:** center subtitles and remove the outer frame when unhovered
* **captions:** the strip says where it is when it comes up empty
* **meeting:** a muted side no longer carries over, and in person uses the mic

## [2.41.3](https://github.com/PLus123456/NexQ-Plus/releases/tag/plus-v2.41.3) (2026-11-22)

The first NexQ Plus build, on upstream NexQ 2.41.3. Built locally; releases on GitHub start after it.

### Features

* **i18n:** Simplified Chinese interface throughout, with a live switch to English
* **llm:** several LLM connections with editable base URL, key, headers and hand-typed model IDs, and a model per task
* **stt:** Soniox live captions with one-way or two-way translation, regions picked by latency, and Whisper on another machine
* **captions:** a caption strip over the meeting, each line with its translation underneath
* **interview:** an answer window with question detection, predicted questions and bookmarks
* **rag:** a personal knowledge base with your own embedding and rerank endpoints and Chinese keyword search
* **audio:** echo cancellation, so the other side heard through the speakers is not transcribed as you
* **onboarding:** a six-step first-run setup that resumes where you left it
