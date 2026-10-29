// 抽帧数量的自适应实测（A 方案）：短视频 9 帧 / 长视频 27 帧
// 只测抽帧，不跑转写 —— 这轮验的是「眼睛」够不够，不是字幕
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

for (const line of fs.readFileSync(new URL('./.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^export\s+(\w+)="?([^"]*)"?\s*$/)
  if (!m) continue
  let v = m[2].trim()
  if (v.startsWith('$(pwd)/')) v = path.resolve(v.slice(7))
  process.env[m[1]] = v
}

const { processNote } = await import('./process.js')
const { buildManifest } = await import('./manifest.js')

const OUT = path.resolve('out-n')
const cases = [
  ['短视频（195s）', 'D:/Documents/DeepSeek-Harness/OB/Obsi/.trash/3种夏天面食进阶吃法,只会泡开水太可惜了!.31128420727 - 副本.mp4'],
  ['长视频（2368s）', 'D:/Documents/DeepSeek-Harness/OB/Obsi/剪藏/科技/2026/10/_resources/Docker实战教程笔记/40分钟的Docker实战攻略,一期视频精通Docker.30737106148.mp4'],
]

for (const [label, src] of cases) {
  const slug = label.includes('短') ? 'short' : 'long'
  const outDir = path.join(OUT, slug)
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  console.log(`\n=== ${label} ===`)
  const t = Date.now()
  const r = processNote(outDir, OUT, { file: src, noteId: slug, log: (m) => console.log('  ', m) })
  const m = buildManifest(slug, OUT)
  const frames = fs.existsSync(path.join(outDir, 'frames')) ? fs.readdirSync(path.join(outDir, 'frames')).length : 0
  console.log(`  结果: status=${r.status} 帧=${frames} 屏=${m.where.sheets.length} 用时 ${((Date.now() - t) / 1000).toFixed(1)}s`)
  console.log(`  sheets: ${m.where.sheets.map((s) => path.basename(s)).join(', ')}`)
  console.log(`  frames.json: ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(outDir, 'frames.json'), 'utf8')).times.length)} 个时间点`)
}
console.log(`\n产物：${OUT}`)
