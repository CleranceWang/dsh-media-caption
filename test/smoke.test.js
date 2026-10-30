// 冒烟测试 —— 验四个东西还在：
//   1. 全新笔记目录 → 完整跑一遍（音轨 + 转写 + 抽帧）
//   2. 再点一次名 → from_cache 必须是 true，不能重算
//   3. 裸视频文件直给 → 落 _direct/h_xxx/
//   4. 同一个裸文件再给一次 → 幂等
//
// 用法：
//   node test/smoke.test.js <一个真实视频文件路径>
//
// 需要先配好 whisper 路径（~/.dsh/media-caption.config.json 的 whisper / modelDir，
// 或环境变量 MEDIA_CAPTION_WHISPER / MEDIA_CAPTION_MODEL_DIR）。见 README。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { loadCfg } = await import('../lib/cfg.js')
const { processOne } = await import('../lib/oncall.js')
const { processFile } = await import('../lib/direct.js')

const src = process.argv[2]
if (!src) {
  console.error('用法: node test/smoke.test.js <视频或音频文件>')
  process.exit(2)
}
if (!fs.existsSync(src)) {
  console.error(`文件不存在: ${src}`)
  process.exit(2)
}

const base = loadCfg()
const OUT = path.join(ROOT, '.smoke', 'out')
const IN = path.join(ROOT, '.smoke', 'in')
fs.rmSync(path.join(ROOT, '.smoke'), { recursive: true, force: true })

// 造一个标准形态的笔记目录：<输入根>/<YYYY-MM-DD>_<标题>_<note_id>/video/x.mp4
const NOTE_ID = 'smoke01'
const NOTE_NAME = `2026-01-01_smoke_${NOTE_ID}`
const noteDir = path.join(IN, NOTE_NAME)
fs.mkdirSync(path.join(noteDir, 'video'), { recursive: true })
fs.copyFileSync(src, path.join(noteDir, 'video', 'x' + (path.extname(src) || '.mp4')))

const cfg = { ...base, inputRoot: IN, outRoot: OUT }
const log = (...a) => console.log('   ', ...a)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

// ── 1. 全新跑一遍
console.log('\n=== 1. 全新笔记目录 ===')
const t1 = Date.now()
const m1 = await processOne(noteDir, cfg, log)
const s1 = ((Date.now() - t1) / 1000).toFixed(1)
check('跑完', m1.duration_ms > 0, `${m1.segments?.length ?? 0} 段 / ${m1.where.sheets.length} 屏 / ${s1}s`)
check('落盘 字幕.json', fs.existsSync(path.join(OUT, NOTE_NAME, '字幕.json')))
check('落盘 audio.mp3', fs.existsSync(path.join(OUT, NOTE_NAME, 'audio', 'audio.mp3')))
check('人声判定有值', m1.speech === 'present' || m1.speech === 'none', `speech=${m1.speech}`)
if (m1.speech === 'present') {
  check('时间轴是毫秒整数', Number.isInteger(m1.segments[0]?.start), `首段 start=${m1.segments[0]?.start}`)
} else {
  check('0 段时 language 标为不可信', m1.language_reliable === false, `language=${m1.language}`)
}

// ── 2. 点名面走缓存
console.log('\n=== 2. 再点一次名（应走缓存）===')
const t2 = Date.now()
const m2 = await processOne(noteDir, cfg, log)
const s2 = ((Date.now() - t2) / 1000).toFixed(1)
check('from_cache = true', m2.from_cache === true, `${s2}s`)
check('段数与首次一致', (m2.segments?.length ?? 0) === (m1.segments?.length ?? 0))

// ── 3. 裸文件直给（复制到笔记目录之外，才走内容指纹）
console.log('\n=== 3. 裸文件直给 ===')
// 身份三档：①调用方给的 id ②文件在笔记目录里→用笔记身份 ③都不是→内容指纹。
// 想验第 ③ 档，文件必须不在 <笔记>/video|x|audio/ 里。
const bare = path.join(ROOT, '.smoke', 'bare' + (path.extname(src) || '.mp4'))
fs.copyFileSync(src, bare)
const t3 = Date.now()
const r3 = processFile(bare, cfg, null, log)
const s3 = ((Date.now() - t3) / 1000).toFixed(1)
check('身份是内容指纹', /^h_[0-9a-f]{12}$/.test(r3.id), r3.id)
check('落 _direct/<id>/', fs.existsSync(path.join(OUT, '_direct', r3.id, '字幕.json')), `${s3}s`)

// ── 3b. 笔记目录里的文件 → 沿用笔记身份，不另起 _direct/
console.log('\n=== 3b. 笔记内的文件 = 笔记身份 ===')
const inner = path.join(noteDir, 'video', fs.readdirSync(path.join(noteDir, 'video'))[0])
const r3b = processFile(inner, cfg, null, log)
check('身份沿用笔记', r3b.id === NOTE_ID, r3b.id)

// ── 4. 直给幂等
console.log('\n=== 4. 同一个裸文件再给一次 ===')
const r4 = processFile(bare, cfg, null, log)
check('幂等（同 id、走缓存）', r4.id === r3.id && r4.manifest.from_cache === true)

// ── 汇总
const bad = results.filter((r) => !r.ok)
console.log(`\n${bad.length === 0 ? '全部通过' : `${bad.length} 项失败`}  (${results.length} 项)`)
if (bad.length) {
  for (const b of bad) console.log(`  ✗ ${b.name}`)
  process.exit(1)
}
