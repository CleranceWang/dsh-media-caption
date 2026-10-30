// ============================================================================
// dsh-media-caption —— 看视频/音频的插件（原型）
//
// 职责（交接单 01-新插件.md §零）：
//   给它一个视频或音频文件，它交出「转写 json」和「带时间线的截图」，别的什么都不做。
//
// 本文件是一个笔记目录的端到端处理，按用户 m00100 的队列语义：
//   取队首 → 处理 → 退出
//
// 分步续跑（用户 m00104「用音频、ASR、最终转写出来的成品来记录状态」）：
//   audio.mp3 存在  → 已抽音轨（mp3 不是 wav：whisper 内部自己也解码成 16k mono，留 wav 只是白占十倍空间）
//   字幕.json 存在  → 已转写
//   三项齐          → 已完工，跳过
//
// 字幕单位：毫秒整数（用户 m00119 / m00122）
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// ── 配置（外部给路径，不写死）
//   ★ 注意：模块级常量只在 import 时求值一次。插件的配置来自
//     ~/.dsh/media-caption.config.json，宿主进程环境变量里没有 MEDIA_CAPTION_*，
//     所以这里只能是「兜底默认」，真正生效的是 makeTools(opts) 的返回值。
const FFMPEG = process.env.MEDIA_CAPTION_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.MEDIA_CAPTION_FFPROBE || 'ffprobe'
const WHISPER = process.env.MEDIA_CAPTION_WHISPER || 'faster-whisper-xxl'
const WHISPER_MODEL_DIR = process.env.MEDIA_CAPTION_MODEL_DIR || ''
const WHISPER_MODEL = process.env.MEDIA_CAPTION_MODEL || 'large-v3'

/** 把一份 cfg 归一成工具链：cfg 优先，其次环境变量，最后默认值 */
export function makeTools(cfg = {}) {
  return {
    ffmpeg: cfg.ffmpeg || FFMPEG,
    ffprobe: cfg.ffprobe || FFPROBE,
    whisper: cfg.whisper || WHISPER,
    whisperModel: cfg.model || WHISPER_MODEL,
    whisperModelDir: cfg.modelDir || WHISPER_MODEL_DIR,
  }
}

/** 转写前检查工具和模型在不在，不在就说清楚「缺哪个」，而不是跑一半报一个看不懂的错 */
export function checkDeps(cfg = {}) {
  const T = makeTools(cfg)
  const problems = []
  for (const [name, bin] of [['ffmpeg', T.ffmpeg], ['ffprobe', T.ffprobe]]) {
    try { run(bin, ['-version']) } catch { problems.push(`${name} 调不动：${bin}`) }
  }
  try {
    run(T.whisper, ['--help'])
  } catch {
    problems.push(`faster-whisper 调不动：${T.whisper}` +
      (T.whisper === WHISPER ? '（没配 whisper 路径，退回了 PATH 里的裸命令）' : ''))
  }
  if (T.whisperModelDir) {
    const d = path.join(T.whisperModelDir, `faster-whisper-${T.whisperModel}`)
    if (fs.existsSync(T.whisperModelDir) && !fs.existsSync(d)) {
      problems.push(`模型目录里没有 faster-whisper-${T.whisperModel}：${T.whisperModelDir}`)
    }
  }
  return problems
}

// ── 取帧数量：按内容密度定，不按时长拍脑袋（用户 m00576 A 方案）
//   N = clamp(round(变化点数 / 8), 9, 27)
//   195s 短视频 60 处 → 8 → 取 9（一屏，不动）
//   40min Docker 266 处 → 33 → 取 27（三屏）
// 上限 27 不是拍脑袋：用户业务在 4060 上跑 large-v3，2 小时视频转写要 30 多分钟，
// 到不了那个程度，所以不需要为更长视频准备更多帧（m00581）。
const N_MIN = 9      // 一屏九宫格
const N_MAX = 27     // 三屏，4060 舒适区的上限
const PER_SHEET = 9  // 一张九宫格 3x3
const TILE = 720     // 每格像素

const MEDIA_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.ts', '.m4v',
  '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.opus', '.wma',
])

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024, timeout: 3_600_000, ...opts,
  })
}
const log = (...a) => console.log(...a)

// ── 1. 找输入：<笔记目录>/video/ 或 <笔记目录>/audio/ 或直接放根下
function findMedia(noteDir) {
  const hits = []
  for (const sub of ['video', 'audio', '']) {
    const d = sub ? path.join(noteDir, sub) : noteDir
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isFile() && MEDIA_EXT.has(path.extname(f).toLowerCase())) hits.push(p)
    }
  }
  return hits
}

// ── 2. note id：目录名末尾那串（用户 m00116）；`<日期>_<标题>_<id>` 取最后一段
function readNoteId(noteDir) {
  const name = path.basename(noteDir)
  const parts = name.split('_')
  return parts.length >= 2 ? parts[parts.length - 1] : name
}

// ── 3. ffprobe 判流（交接单 §2.1：不信扩展名）
function probe(src) {
  let streams = ''
  try {
    streams = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', src]).trim()
  } catch { streams = '' }
  const dur = Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', src]).trim()) || 0
  return { hasVideo: streams.length > 0, durationSec: dur }
}

// ── 4. 抽帧：照抄 bili-watch.mjs:61-120（等间隔骨架 + 吸附变化点）
function sceneTimes(file, th) {
  try {
    const out = run(FFMPEG, ['-hide_banner', '-i', file, '-vf',
      `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
    return [...new Set(ts)].filter((t) => t > 0.2)
  } catch { return [] }
}

function pickTimes(file, dur) {
  // 先扫变化点（0.3 就够用；不足 N_MIN 再逐级放宽，保证骨架有得吸）
  let st = [], used = 0.3
  for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(file, th); if (st.length >= N_MIN) break }

  // ★ 帧数按「变化点密度」定，不按时长线性涨（用户 m00576 A 方案）
  const N = Math.max(N_MIN, Math.min(N_MAX, Math.round(st.length / 8)))
  const sheets = Math.ceil(N / PER_SHEET)

  const uniform = Array.from({ length: N }, (_, i) => ((i + 0.5) * dur) / N)
  if (!st.length) {
    return { times: uniform, N, sheets, how: `纯等间隔 ${N} 帧（阈值 0.08 也未检出变化；每 ${(dur / N).toFixed(1)}s 一帧）` }
  }

  const half = dur / N / 2
  let snapped = 0
  const times = uniform.map((u) => {
    const near = st.filter((s) => Math.abs(s - u) <= half)
    if (!near.length) return u
    snapped += 1
    return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
  })
  return {
    times, N, sheets,
    how: `等间隔骨架 + 吸附变化点 ${N} 帧/${sheets} 屏（阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到）`,
  }
}

/**
 * 一次解码走完全片抽 N 帧（老系统教训 asr/_legacy_app.py:797-799：
 * 循环调 N 次会把视频解码 N 遍，13 分钟的视频约多花十几倍时间）。
 *
 * 做法：先用 pickTimes 定出 N 个吸附后的时间点 → 生成 select 表达式
 *       `select='between(t,a,b)+between(t,c,d)+…'` 一次 fifo 走完，出 N 帧。
 *       这样既保住「吸附变化点」（交接单 §4），又只解码一遍。
 */
function pickTimesSinglePass(file, dur) {
  const { times, how, N, sheets } = pickTimes(file, dur)
  return { list: times, how: how + ' / 单次解码', N, sheets }
}

/**
 * 读 flags.json（老系统按篇开关，交接单 HANDOFF-bili-feed.md §3）。
 *
 * ★ 语义容易看反：`no_` 前缀 = 否定。`no_frames:true` 表示「**不要**抽帧」。
 * ★ 读不到就返回空对象，不能返回 false —— 老系统血的教训
 *   （HANDOFF-bili-feed.md:99-100）：「返回 False 会让前端以为这篇明确要抽帧，
 *   从而盖掉用户关掉的全局开关。这是把判断权从人手里抢走。」
 */
export function readFlags(outDir) {
  const p = path.join(outDir, 'flags.json')
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

// ── 5. 转写 → 归一化成毫秒整数（用户 m00122：只要一份，ms）
function toMs(sec) { return Math.round(Number(sec) * 1000) }

/**
 * faster-whisper-xxl 不同版本吐的形态不同：
 *   新版: {"segments":[{start,end,text}]}        单位秒
 *   旧版: {"result":[{start_time,end_time,text}]}  单位毫秒（交接单 §3.2 记的）
 * 两种都要认，统一转成 {start,end}(ms)。
 */
function normalizeTranscript(rawJson) {
  const obj = JSON.parse(rawJson)
  const segs = obj.segments ?? obj.result ?? []
  if (!Array.isArray(segs)) throw new Error('转写产物里找不到 segments/result 数组')
  const detectedLang = typeof obj.language === 'string' ? obj.language : null

  // 判断单位：旧版 result 的 start_time 是毫秒（>1000 常见），新版 seconds 一定 < 时长
  const looksMs = segs.length > 0 && segs.some((s) => s.start_time !== undefined)

  const filtered = segs.map((s) => {
    const startRaw = s.start_time ?? s.start ?? 0
    const endRaw = s.end_time ?? s.end ?? 0
    return {
      start: looksMs ? Math.round(startRaw) : toMs(startRaw),
      end: looksMs ? Math.round(endRaw) : toMs(endRaw),
      text: String(s.text ?? '').trim(),
    }
  }).filter((s) => s.text)
  return { segs: filtered, language: detectedLang }
}

// ── 6. 一笔记目录的完整处理（分步续跑）
// 用户 m00371/m00376：预留非标接口 —— 任意文件直给。
//   opts.srcDir 源目录（默认 = outDir；标准面必须显式给输入目录）
//   opts.file   直接指定源文件（跳过 findMedia，用于裸文件）
//   opts.noteId 直接指定身份（跳过从目录名推）
//   opts.log    进度输出回调（默认 console.log）
// 注意：第一个参数现在是**输出目录本身**（不再由 outRoot 拼），标准面传 <outRoot>/<笔记目录名>。
// 标准面不传 opts，行为与之前一致。
export function processNote(outDir, outRoot, opts = {}) {
  const plog = opts.log || log
  const T = makeTools(opts.cfg)      // cfg 优先 > 环境变量 > 默认
  const srcDir = opts.srcDir || outDir
  const noteId = opts.noteId || readNoteId(srcDir)
  const media = opts.file ? [opts.file] : findMedia(srcDir)
  if (!media.length) { plog(`  [跳过] 没有视频/音频：${srcDir}`); return { status: 'skipped' } }

  const src = media[0]
  if (media.length > 1) plog(`  [注意] 有 ${media.length} 个媒体文件，只用第一个：${path.basename(src)}`)

  const audioDir = path.join(outDir, 'audio')
  const audioExt = path.join(audioDir, 'audio.mp3')
  const transcriptJson = path.join(outDir, '字幕.json')
  const framesDir = path.join(outDir, 'frames')
  const previewDir = path.join(outDir, 'previews')
  const framesJson = path.join(outDir, 'frames.json')
  const sheetJpg = path.join(previewDir, 'sheet.jpg')

  // 进度判定：三样齐全 = 完工（用户 m00104 的判据）
  const done = fs.existsSync(audioExt) && fs.existsSync(transcriptJson)
    && (fs.existsSync(sheetJpg) || !probe(src).hasVideo)
  if (done) { plog(`  [已完工] ${noteId}`); return { status: 'done', noteId } }

  plog(`  源文件: ${path.basename(src)}`)
  const { hasVideo, durationSec } = probe(src)
  plog(`  时长: ${durationSec.toFixed(2)}s   画面: ${hasVideo ? '有' : '无（纯音频，不抽帧）'}`)

  fs.mkdirSync(outDir, { recursive: true })
  const flags = readFlags(outDir)   // 老系统的按篇开关，读不到就是 {}（不覆盖任何决定）

  // ── 阶段 1：音轨（不存在才抽）
  if (!fs.existsSync(audioExt)) {
    fs.mkdirSync(audioDir, { recursive: true })
    // 取 16k 单声道给 ASR（whisper 内部也这么解），编码用 mp3 128k —— 体积约为 wav 的 1/8
    run(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-vn',
      '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', audioExt])
    plog(`  ✓ 音轨已抽：${(fs.statSync(audioExt).size / 1024 / 1024).toFixed(1)} MB`)
  } else plog(`  · 音轨已在，跳过`)

  // ── 阶段 2：转写（不存在才跑）
  if (!fs.existsSync(transcriptJson)) {
    const tmpOut = path.join(outDir, '.asr-tmp')
    fs.mkdirSync(tmpOut, { recursive: true })
    plog(`  … 转写中（${T.whisperModel}）`)
    run(T.whisper, [audioExt, '--model', T.whisperModel, '--model_dir', T.whisperModelDir,
      '--output_format', 'json', '--output_dir', tmpOut], { stdio: ['ignore', 'pipe', 'pipe'] })

    const raws = fs.readdirSync(tmpOut).filter((f) => f.endsWith('.json'))
    if (!raws.length) throw new Error('转写完成但没找到 json')
    const { segs: segments, language } = normalizeTranscript(
      fs.readFileSync(path.join(tmpOut, raws[0]), 'utf8'))

    // ★ 用户 m00642/m00643：0 段不是失败，是一种**结果**。
    //   小红书那类「信息全在图里、背景音是首歌」的内容，ASR 必然 0 段，
    //   而且 whisper 会先听 30 秒纯音乐、随便挑个语言（中文视频被判 en），
    //   所以 0 段时 language 一并标成不可信 —— 否则下游会拿错语言去误导判断。
    const speech = segments.length > 0 ? 'present' : 'none'

    const out = {
      note_id: noteId,
      source: path.basename(srcDir),
      source_file: path.basename(src),
      duration_ms: Math.round(durationSec * 1000),
      speech,
      language: speech === 'none' ? null : language,
      language_reliable: speech !== 'none',
      segments,
      ...(speech === 'none' ? {
        warning: '未检出人声：whisper 返回 0 段。该视频可能是纯音乐/无解说（小红书常见形态），'
          + '内容在图里 —— 请以 frames/sheet 为准，不要据此认为视频没有内容。',
      } : {}),
    }
    fs.writeFileSync(transcriptJson, JSON.stringify(out, null, 2), 'utf8')
    fs.rmSync(tmpOut, { recursive: true, force: true })
    plog(speech === 'none'
      ? `  ⚠ 转写 0 段（未检出人声）—— 这条要看图`
      : `  ✓ 转写完成：${segments.length} 段（毫秒整数）`)
  } else plog(`  · 字幕已在，跳过`)

  // ── 阶段 3：抽帧（有画面 + flags 允许才做）
  //   ★ 老系统教训（asr/_legacy_app.py:774-775）：抽帧是「配图副产物」，
  //     转写才是主活。抽帧失败**不抛**，整单照常算成功。
  //   ★ 幂等判据（_legacy_app.py:769-772）：**目录里有帧就算做过**，
  //     不数「是否够 N 张」—— 改了 N 之后旧的那批会永远判不够、每轮重抽。
  const wantFrames = hasVideo && !flags.no_frames
  if (wantFrames && !hasAnyFrame(framesDir)) {
    try {
      const times = pickTimesSinglePass(src, durationSec)
      plog(`  取帧: ${times.how}`)
      fs.mkdirSync(framesDir, { recursive: true })
      fs.mkdirSync(previewDir, { recursive: true })

      // 逐帧抽（单帧原始分辨率，-q:v 2）
      const names = times.list.map((t, i) => {
        const name = `f${String(i).padStart(2, '0')}.jpg`
        run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', src,
          '-frames:v', '1', '-q:v', '2', path.join(framesDir, name)])
        return name
      })

      // 拼九宫格：每 9 帧一屏。一屏时叫 sheet.jpg（沿用老名字），多屏时叫 sheet-1..N.jpg
      //   ★ 最后一屏不满 9 格时，按实际帧数算 tile 网格（3x1/3x2/3x3…），
      //     否则 ffmpeg 的 tile=3x3 会在右下留黑块，看着像出错。
      const sheets = []
      const pages = Math.ceil(names.length / PER_SHEET)
      for (let p = 0; p < pages; p++) {
        const seqDir = path.join(previewDir, `.seq${p}`)
        fs.mkdirSync(seqDir, { recursive: true })
        const chunk = names.slice(p * PER_SHEET, (p + 1) * PER_SHEET)
        chunk.forEach((n, i) => fs.copyFileSync(
          path.join(framesDir, n), path.join(seqDir, `g${String(i + 1).padStart(2, '0')}.jpg`)))
        const out = pages === 1 ? sheetJpg : path.join(previewDir, `sheet-${p + 1}.jpg`)
        const rows = Math.ceil(chunk.length / 3)
        run(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(seqDir, 'g%02d.jpg'),
          '-vf', `scale=${TILE}:-1,tile=3x${rows}`, '-frames:v', '1', out])
        fs.rmSync(seqDir, { recursive: true, force: true })
        sheets.push(path.basename(out))
      }

      // frames.json：毫秒整数（用户 m00119）+ 每帧归属哪一屏
      fs.writeFileSync(framesJson, JSON.stringify({
        times: times.list.map(toMs),
        sheets,
        how: times.how,
      }, null, 2), 'utf8')
      plog(`  ✓ 抽帧完成：${times.list.length} 帧 / ${sheets.length} 屏（${sheets.join(', ')}）`)
    } catch (e) {
      plog(`  ⚠ 抽帧失败（不影响转写成果）：${e.message}`)
    }
  } else if (flags.no_frames) {
    plog(`  · flags.json 说 no_frames，跳过抽帧`)
  } else if (hasVideo) plog(`  · 帧已在，跳过`)

  return { status: 'ok', noteId, hasVideo, no_frames: !!flags.no_frames }
}

/** 目录里有任何 jpg 就算抽过帧（老系统判据：不看够不够 N 张） */
function hasAnyFrame(framesDir) {
  try {
    return fs.readdirSync(framesDir).some((f) => f.toLowerCase().endsWith('.jpg'))
  } catch { return false }
}

