# dsh-media-caption

> 给视频/音频生成**字幕 JSON** 和**关键帧 JPG**，只交原料，不做判断。

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件。

---

## 它做什么

给它一个视频或音频，它交出两样东西：

- **`字幕.json`** —— 逐句转写，毫秒整数时间戳，附带「有没有人声 / 什么语言」的判断
- **`frames/*.jpg` + `previews/sheet.jpg`** —— 关键帧和九宫格拼图，单帧保持原始分辨率

**它不做的事**：不调大模型、不生成 md、不替你决定哪些内容重要。

> 判断权在调用方 —— 它只交素材，不替你做判断。

---

## 为什么只交原料

视频内容有三种形态，需要的读法完全不同：

| 形态 | 例子 | 该看什么 |
|---|---|---|
| 信息在**字幕**里 | 口播科普、测评、教程 | 读 `字幕.json`，帧作辅助 |
| 信息在**画面**里 | 小红书产品图、TUI 演示、纯音乐配乐 | 读 `sheet.jpg`，字幕为空 |
| **两边互补** | 讲解 + 演示操作 | 都读，互相纠错 |

`字幕.json` 里的 `speech` 字段会直接告诉你属于哪一种 —— **0 段不等于失败**，可能是内容全是图。

---

## 快速开始

### 1. 装依赖（都要在本机）

| 依赖 | 说明 |
|---|---|
| **Node.js** ≥ 22 | 运行环境 |
| **ffmpeg / ffprobe** | 加到 PATH 即可 |
| **faster-whisper-xxl** | 命令行版，见 [发布页](https://github.com/Purfview/whisper-standalone-win) |
| **large-v3 模型** | 约 3 GB，见下方下载 |

**模型下载**（国内推荐魔搭，免代理）：

- 魔搭：[Systran/faster-whisper-large-v3](https://www.modelscope.cn/models/Systran/faster-whisper-large-v3) ← **3.09 GB，直连**
- HuggingFace：[Systran/faster-whisper-large-v3](https://huggingface.co/Systran/faster-whisper-large-v3/tree/main)

下下来是一个目录（里面是 `model.bin` / `config.json` / `tokenizer.json` 等），把**这个目录**的路径填到下面的 `modelDir`。不用改名。

> 模型的来源是 [openai/whisper-large-v3](https://huggingface.co/openai/whisper-large-v3)（MIT），由 Systran 转成 CTranslate2 格式给 faster-whisper 用。本项目不打包模型。

### 2. 配置

配置可以来自 `~/.dsh/media-caption.config.json`，也可以用环境变量（环境变量优先）。

**最小配置**（只用两个工具，不扫盘）：

```json
{
  "whisper": "D:/path/to/faster-whisper-xxl.exe",
  "modelDir": "D:/path/to/faster-whisper-large-v3",
  "outRoot": "D:/media/out"
}
```

**加上自动处理**（丢进输入目录就自己跑）：

```json
{
  "whisper": "D:/path/to/faster-whisper-xxl.exe",
  "modelDir": "D:/path/to/faster-whisper-large-v3",
  "inputRoot": "D:/media/in",
  "outRoot": "D:/media/out",
  "dbPath": "D:/media/queue.db",

  "autoSweep": true
}
```

> ⚠️ **自动扫盘默认是关的。** 装上插件，你得到的是三个工具；它不会自己去扫你的硬盘。
> 想要「丢进目录就自动处理」，显式写 `"autoSweep": true`。
> 打开后 **DSH 每次启动扫一轮**，处理完就退出，不常驻、不开定时器。

完整字段见 [`.env.example`](./.env.example)，那份里每个变量都有注释。

### 3. 装进 DSH

```bash
dshm_install id=<github-owner>/dsh-media-caption
```

或本地开发时手动软链到 profile 的 `node_modules/`（注意：**不要**在 profile 里跑 `pnpm install`，`@deepseek-ai/*` 由宿主自带，装不上）。

然后重启 DSH。

---

## 三个工具

### `media_caption_process` —— 标准面

参数 `note`（笔记目录名），在 `MEDIA_CAPTION_INPUT_ROOT` 下找。

```
<输入根>/<笔记目录>/video/xxx.mp4
                     /audio/xxx.mp3
```

**盘上已经有 `字幕.json` 就直接返回，不重算。**

### `media_caption_file` —— 直给面

参数 `file`（任意文件的绝对路径），可选 `id`。

**不用建目录、不用按命名规则** —— 丢个文件进来就行。

身份判定三档：
1. 你给了 `id` → 用它
2. 文件在某个笔记目录里 → 用笔记身份
3. 都不是 → 内容指纹 `h_<sha1前12>`

### `media_caption_sweep` —— 手动唤醒批处理

参数 `run`（默认 `false`）、`limit`（最多处理几条，0 = 不限）。

- `run: false` —— **只报告**：盘上有多少没做、队列里排了几条
- `run: true` —— **真处理**：扫一轮 → 入队 → 逐条处理 → 再扫一轮，连续两轮没新活就退出

受资源门禁约束：显存或内存不够时**不启动**，不会跟你的游戏抢显卡。

---

## 产物布局

```
<输出根>/<笔记目录名>/
├── 字幕.json          # 转写结果
├── frames.json        # 抽帧时间点（毫秒）
├── frames/
│   ├── f00.jpg … fNN.jpg
├── previews/
│   ├── sheet.jpg      # 一屏
│   └── sheet-1..N.jpg # 多屏
└── audio/
    └── audio.mp3      # 中间产物，删了会重抽；不算没做完
```

### `字幕.json` 的样子

```json
{
  "note_id": "42952687912",
  "duration_ms": 302464,
  "speech": "present",
  "language": "zh",
  "language_reliable": true,
  "segments": [
    { "start": 1200, "end": 3400, "text": "大家好" }
  ]
}
```

`speech` 三个值：

| 值 | 含义 | 下游该怎么做 |
|---|---|---|
| `present` | 有人声 | 读字幕 |
| `none` | **无人声**，`segments` 为空 | **看图** |

---

## 抽帧怎么抽的

```
N = clamp(round(变化点数 / 8), 9, 27)
```

- **等间隔骨架**：先把时长分成 N 份，取每份中点
- **吸附变化点**：ffmpeg `select='gt(scene,阈值)'` 找出画面突变处，把骨架点吸过去
- **一次解码**：单次 ffmpeg 调用抽全部帧，不循环调用
- **拼图**：每 9 帧一屏，最后一屏按实际帧数算网格

| 视频 | 变化点 | 帧数 | 屏 |
|---|---|---|---|
| 195s 短视频 | 60 | 9 | 1 |
| 2368s 长视频 | 121 | 15 | 2 |

---

## 批处理（可选功能）

**默认关闭。** 不写 `"autoSweep": true` 就完全不启动——不扫盘、不碰数据库。

打开后 **DSH 每次启动扫一轮**，处理完就退出。**不常驻、不开定时器、不留后台进程。**
想中途再来一轮，调一次 `media_caption_sweep`。

### 队列的三条铁律

1. **位置即状态** —— 队首 = 正在处理，没有 `running` 字段
2. **一轮只做一单** —— 处理完就退出，换干净进程
3. **真相在磁盘** —— `done` 不记 DB，靠「字幕在不在、九宫格在不在」判进度

### 扫-处理-再扫

```
扫一轮 → 入队 → 逐条处理 → 再扫一轮
                              ↑ 有新活就继续
连续两轮扫不到新东西 → 退出
```

这样处理 A 的时候塞进来的 B，下一轮就会被看见。

### 分步续跑

```
音轨在？没有 → 抽
字幕在？没有 → 转写
帧在？  没有 → 抽帧
```

任何一步崩了，下次从断点接上。同一个文件处理两次，第二次 0.1 秒跳过。

---

## 设计取舍

| 决定 | 为什么 |
|---|---|
| **只出 json + jpg，不出 md** | 判断权交回调用方，工具不做超出能力的事 |
| **不调大模型** | 只交素材，不做判断 |
| **SQLite 做队列** | 位置即状态、天然幂等、防两 worker 抢 |
| **DB 放本机不放网络盘** | SQLite 跨网络会锁坏 |
| **一次 ffmpeg 解码全量** | 循环调用会解码 N 遍，13 分钟视频多花十几倍时间 |
| **抽帧失败不抛** | 帧是配图副产物，转写才是主活 |

---

## 许可

MIT。见 [LICENSE](./LICENSE) 和 [NOTICE.md](./NOTICE.md)。

抽帧算法学自 [dsh-bili-whale](../dsh-bili-whale)。
