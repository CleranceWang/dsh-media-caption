// 单文件抽帧原型 —— 交接单 §十 第 1 步
// 算法照抄 tools/dsh-bili/dsh-bili-whale/tools/commands/bili-watch.mjs:61-120
//   等间隔骨架(保覆盖) + 吸附 ±半格内最近的画面变化点
// 用法: node probe.js <视频路径> [outDir]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const FFMPEG = 'ffmpeg'
const FFPROBE = 'ffprobe'
const N = 9          // 3x3 固定（交接单 §4.2）
const TILE = 720     // 九宫格每格像素

const src = process.argv[2]
if (!src) { console.error('用法: node probe.js <视频路径> [outDir]'); process.exit(2) }
const outDir = process.argv[3] || path.join(process.cwd(), 'out')

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024, timeout: 600_000, ...opts,
  })
}

// ── 1. ffprobe 判有没有 video 流（交接单 §2.1：不信扩展名）
const streams = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', src]).trim()
const hasVideo = streams.length > 0
const dur = Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', src]).trim())

console.log(`输入   : ${path.basename(src)}`)
console.log(`时长   : ${dur.toFixed(2)}s`)
console.log(`video流: ${hasVideo ? streams : '(无 → 纯音频，跳过抽帧)'}`)
if (!hasVideo) { console.log('\n纯音频输入：不抽帧，只出转写 json。'); process.exit(0) }

// ── 2. 画面变化点（scene 阈值阶梯 0.3 → 0.15 → 0.08）
function sceneTimes(file, th) {
  try {
    const out = run(FFMPEG, ['-hide_banner', '-i', file, '-vf',
      `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
    return [...new Set(ts)].filter((t) => t > 0.2)
  } catch { return [] }
}

const uniform = Array.from({ length: N }, (_, i) => ((i + 0.5) * dur) / N)
let times = uniform
let how = `等间隔（每 ${(dur / N).toFixed(1)} 秒一帧）`

let st = [], used = 0.3
for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(src, th); if (st.length >= N) break }

if (st.length > 0) {
  const half = dur / N / 2
  let snapped = 0
  times = uniform.map((u) => {
    const near = st.filter((s) => Math.abs(s - u) <= half)
    if (!near.length) return u
    snapped += 1
    return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
  })
  how = `等间隔骨架 + 吸附变化点（阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到了）`
} else {
  how = `纯等间隔（阈值 0.08 也未检出变化 → 每 ${(dur / N).toFixed(1)} 秒一帧）`
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
console.log(`取帧方式: ${how}`)
console.log(`时间点  : ${times.map((t, i) => `f${String(i).padStart(2, '0')}=${t.toFixed(2)}s(${fmt(t)})`).join('  ')}`)

// ── 3. 抽帧 + 拼九宫格（交接单 §3.1 目录形状）
const framesDir = path.join(outDir, 'frames')
const prevDir = path.join(outDir, 'previews')
fs.mkdirSync(framesDir, { recursive: true })
fs.mkdirSync(prevDir, { recursive: true })

const t0 = Date.now()
times.forEach((t, i) => {
  run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', src,
    '-frames:v', '1', '-q:v', '2', path.join(framesDir, `f${String(i).padStart(2, '0')}.jpg`)])
})
const sheet = path.join(prevDir, 'sheet.jpg')
run(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(framesDir, 'f%02d.jpg'),
  '-vf', `scale=${TILE}:-1,tile=3x3`, '-frames:v', '1', sheet])
console.log(`\n抽帧耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// ── 4. frames.json（用户本轮拍板要）
fs.writeFileSync(path.join(outDir, 'frames.json'),
  JSON.stringify({ times: times.map((t) => Number(t.toFixed(2))) }, null, 2), 'utf8')

console.log(`\n产物目录: ${outDir}`)
for (const f of ['frames.json', 'previews/sheet.jpg', ...times.map((_, i) => `frames/f${String(i).padStart(2, '0')}.jpg`)]) {
  const p = path.join(outDir, f)
  console.log(`  ${fs.existsSync(p) ? '✓' : '✗'} ${f}  ${fs.existsSync(p) ? (fs.statSync(p).size / 1024).toFixed(0) + ' KB' : ''}`)
}
