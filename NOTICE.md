# NOTICE · 来源与致谢

本项目（`dsh-media-eye`）自身代码以 **MIT** 许可发布（见 `LICENSE`）。

---

## 师承

本项目的**抽帧算法**、**ffmpeg 调用方式**、**工具的组织形态**直接学自：

| 项目 | 许可 | 学到了什么 |
|---|---|---|
| **[dsh-bili-whale](../dsh-bili-whale)** | MIT © 2026 ALTERSSSS | 抽帧：等间隔骨架 + 吸附画面变化点（`tools/commands/bili-watch.mjs`）；一次 ffmpeg 调用解码全量再切帧；命令分层的写法 |

---

## 构想上的前身

这个想法的起点，可以追溯到 [AI-Media2Doc-Local](https://github.com/CleranceWang/AI-Media2Doc-Local) —— 它证明了一件事：**视频是能在本地处理的**。把语音识别和文件存储从云端搬回自己的机器，不必上传、不必联网、没有时长限制。

本项目沿着这个方向往前走了一步，停在了更前面：**不替使用者下判断**。

> 血统：`AI-Media2Doc-Local` 基于 [hanshuaikang/AI-Media2Doc](https://github.com/hanshuaikang/AI-Media2Doc) v0.8.0 的本地化改造（MIT © 2025 韩数）。

---

## 它依赖这些第三方

| 名称 | 用途 | 许可 / 说明 |
|---|---|---|
| **ffmpeg / ffprobe** | 抽音轨、抽帧、拼九宫格 | **LGPL v2.1+**（若用 GPL 构建则为 GPL）。本项目**不打包** ffmpeg，请自行安装：https://ffmpeg.org |
| **faster-whisper-xxl** | ASR 转写 | **不打包**，请自行安装（本项目只调用其命令行） |
| **large-v3 模型** | 转写模型 | **不打包**，约 3 GB，需自行下载 |
| **Node.js** | 运行环境 | MIT |

---

## 免责

- 本项目是**个人自用工具的公开版**：视频/音频在你的本机处理，**不出网**。
- 「不出 md、不调 AI」是**设计选择**：本工具只交出原料（字幕 JSON + 画面 JPG），判断与成稿交给调用它的 agent 或人。
- 转写结果由 `faster-whisper` + `large-v3` 生成，**可能有识别错误**（专有名词尤甚），请以原始音视频为准。
