// ============================================================================
// probe9.js —— 一屏九宫格到底能读出多少？用 40 分钟 Docker 视频实测
//
// 目的（用户 m00560）：验证「N=9 固定」对长视频够不够。如果不够，再决定
// 是让 N 随时长涨，还是出「N 个九宫格」。
//
// 这一版不做取舍，只**把所有候选画面都摊开来给人眼判**：
//   A. 当前算法：9 帧（等间隔骨架 + 吸附变化点）→ 九宫格
//   B. 摊开版  ：27 帧（同一算法，N=27）→ 3 张九宫格
//   再顺手统计「变化点在不同阈值下有多少处」，看长视频的信息密度在哪。
//
// 不做转写，只做抽帧 —— 这轮问的是「眼睛够不够」，不是「字幕够不够」。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const FFMPEG = process.env.MEDIA_EYE_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.MEDIA_EYE_FFPROBE || 'ffprobe'
const TILE = 720

const SRC = process.argv[2] || 'D:/Documents/DeepSeek-Harness/OB/Obsi/剪藏/科技/2026/10/_resources/Docker实战教程笔记/40分钟的Docker实战攻略,一期视频精通Docker.30737106148.mp4'
const OUT = path.resolve(process.argv[3] || '_work/media-eye/probe9-out')

const run = (bin, args, opts = {}) => execFileSync(bin, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts,
})

const duration = Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', SRC]).trim())
console.log(`源：${path.basename(SRC)}`)
console.log(`时长：${duration.toFixed(2)}s（${(duration / 60).toFixed(1)} 分钟）`)

// ── 变化点：三级阈值各扫一次，看长视频里到底有多少处可吸
function sceneTimes(file, th) {
  try {
    const out = run(FFMPEG, ['-hide_banner', '-loglevel', 'info', '-i', file,
      '-vf', `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'])
    return [...out.matchAll(/pts_time:([\d.]+)/g)]
      .map((m) => Number(m[1])).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  } catch (e) {
    const txt = String(e.stderr || '')
    return [...txt.matchAll(/pts_time:([\d.]+)/g)]
      .map((m) => Number(m[1])).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  }
}

console.log('\n=== 变化点密度（长视频的关键指标）===')
const scenes = {}
for (const th of [0.3, 0.15, 0.08]) {
  scenes[th] = sceneTimes(SRC, th)
  console.log(`  阈值 ${th}：检出 ${scenes[th].length} 处变化点`)
}

// ── 同一套算法，分别取 N 帧
function pickTimes(file, dur, N) {
  const uniform = Array.from({ length: N }, (_, i) => (dur * (i + 0.5)) / N)
  let st = [], used = 0.3
  for (const th of [0.3, 0.15, 0.08]) { used = th; st = scenes[th]; if (st.length >= N) break }
  if (!st.length) return { times: uniform, how: `纯等间隔（每 ${(dur / N).toFixed(1)}s 一帧）`, used: 0, snapped: 0 }
  const half = dur / N / 2
  let snapped = 0
  const times = uniform.map((u) => {
    const near = st.filter((s) => Math.abs(s - u) <= half)
    if (!near.length) return u
    snapped += 1
    return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
  })
  return { times, how: `阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到`, used, snapped }
}

const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`

function sheetOf(times, dir, tag) {
  fs.mkdirSync(dir, { recursive: true })
  times.forEach((t, i) => {
    run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', SRC,
      '-frames:v', '1', '-q:v', '2', path.join(dir, `f${String(i).padStart(2, '0')}.jpg`)])
  })
  // 每 9 张拼一张九宫格
  const sheets = []
  const pages = Math.ceil(times.length / 9)
  for (let p = 0; p < pages; p++) {
    const first = p * 9
    const list = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().slice(first + 1, first + 10)
    const seq = path.join(dir, `seq${p}`)
    fs.mkdirSync(seq, { recursive: true })
    list.forEach((f, i) => fs.copyFileSync(path.join(dir, f), path.join(seq, `g${String(i + 1).padStart(2, '0')}.jpg`)))
    const out = path.join(dir, `${tag}-p${p + 1}.jpg`)
    run(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(seq, 'g%02d.jpg'),
      '-vf', `scale=${TILE}:-1,tile=3x3`, '-frames:v', '1', out])
    sheets.push(out)
  }
  return sheets
}

for (const N of [9, 27]) {
  const r = pickTimes(SRC, duration, N)
  console.log(`\n=== N=${N} ===`)
  console.log(`  ${r.how}`)
  console.log(`  时间点：${r.times.map((t, i) => `${i + 1}=${fmt(t)}`).join('  ')}`)
  const dir = path.join(OUT, `n${N}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true })
  const sheets = sheetOf(r.times, dir, `n${N}`)
  console.log(`  九宫格：${sheets.length} 张`)
  for (const s of sheets) console.log(`    ${s}`)
  fs.writeFileSync(path.join(dir, 'times.json'),
    JSON.stringify({ N, duration, how: r.how, times: r.times.map((t) => Math.round(t * 1000)) }, null, 2))
}

console.log(`\n产物目录：${OUT}`)
