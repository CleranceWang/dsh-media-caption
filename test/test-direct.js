// 回归 + 新功能实测
//   1. 标准面：既有产物点名 → from_cache 必须为 true（不能被签名改动搞坏）
//   2. 标准面：全新笔记目录 → 完整跑一遍
//   3. 非标面：裸视频文件直给 → 落 _direct/h_xxx/
//   4. 非标面：裸视频直给第二次 → 幂等，from_cache=true
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// 本机配置（whisper 路径、模型目录）在 .env.local 里，先加载再 import 业务模块
for (const line of fs.readFileSync(new URL('./.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^export\s+(\w+)="?([^"]*)"?\s*$/)
  if (!m) continue
  let v = m[2].trim()
  if (v === '$(pwd)/in') v = path.resolve('in')
  else if (v === '$(pwd)/out-q') v = path.resolve('out-q')
  else if (v === '$(pwd)/queue.db') v = path.resolve('queue.db')
  process.env[m[1]] = v
}

const { processOne } = await import('../lib/oncall.js')
const { processFile } = await import('../lib/direct.js')

const ROOT = path.resolve('.')
const OUT = path.join(ROOT, 'out-std')
const IN = path.join(ROOT, 'in-std')
const SRC = 'D:/Documents/DeepSeek-Harness/OB/Obsi/.trash/3种夏天面食进阶吃法,只会泡开水太可惜了!.31128420727 - 副本.mp4'
const cfg = { inputRoot: IN, outRoot: OUT }
const log = (...a) => console.log('   ', ...a)

function fresh(p) {
  if (fs.existsSync(p)) {
    for (const f of fs.readdirSync(p)) fs.rmSync(path.join(p, f), { recursive: true, force: true })
  }
  fs.mkdirSync(p, { recursive: true })
}

const NOTE = '2026-10-29_测试笔记_31128420'
fresh(IN); fresh(OUT)
fs.mkdirSync(path.join(IN, NOTE, 'video'), { recursive: true })
fs.copyFileSync(SRC, path.join(IN, NOTE, 'video', path.basename(SRC)))
console.log('已铺好测试笔记目录：', path.join(IN, NOTE))

// ── 1 + 2：标准面全新跑
console.log('\n[1] 标准面 · 全新笔记目录')
let t = Date.now()
const m1 = await processOne(NOTE, cfg, log)
console.log(`    → from_cache=${m1.from_cache} 段落=${m1.segments.length} 帧=${m1.where.frames.length} 用时 ${((Date.now()-t)/1000).toFixed(1)}s`)

// ── 2：标准面第二次 → 必须命中缓存
console.log('\n[2] 标准面 · 再点名一次（应命中缓存）')
t = Date.now()
const m2 = await processOne(NOTE, cfg, log)
console.log(`    → from_cache=${m2.from_cache} 用时 ${((Date.now()-t)/1000).toFixed(2)}s ${m2.from_cache ? '✓ 缓存命中' : '✗ 又算了一遍'}`)

// ── 3：裸文件直给
console.log('\n[3] 非标面 · 裸视频文件直给')
const bare = path.join(ROOT, 'in-bare', '一段随手拍的视频.mp4')
fs.mkdirSync(path.dirname(bare), { recursive: true })
fs.copyFileSync(SRC, bare)
t = Date.now()
const r3 = processFile(bare, cfg, null, log)
console.log(`    → id=${r3.id} 产物目录=${r3.outDir}`)
console.log(`      段落=${r3.manifest.segments.length} 帧=${r3.manifest.where.frames.length} 用时 ${((Date.now()-t)/1000).toFixed(1)}s`)
console.log(`      产物目录存在: ${fs.existsSync(r3.outDir)} / _direct 下: ${r3.outDir.includes('_direct')}`)

// ── 4：再来一次 → 幂等
console.log('\n[4] 非标面 · 同一文件再直给一次（应幂等）')
t = Date.now()
const r4 = processFile(bare, cfg, null, log)
console.log(`    → id=${r4.id}（与上次同 id: ${r4.id === r3.id}）from_cache=${r4.manifest.from_cache} 用时 ${((Date.now()-t)/1000).toFixed(2)}s`)

// ── 5：文件在笔记目录里 → 应沿用笔记身份
console.log('\n[5] 非标面 · 文件在笔记目录里（应沿用笔记身份与布局）')
const r5 = processFile(path.join(IN, NOTE, 'video', path.basename(SRC)), cfg, null, log)
console.log(`    → id=${r5.id}（期望 ${NOTE.split('_').pop()}）产物目录=${path.basename(r5.outDir)}`)
console.log(`      from_cache=${r5.manifest.from_cache}`)

console.log('\n=== 结论 ===')
const ok1i = m1.segments.length > 0 && m1.where.frames.length === 9
const ok2 = m2.from_cache === true
const ok3 = r3.id.startsWith('h_') && r3.outDir.includes('_direct') && r3.manifest.where.frames.length === 9
const ok4 = r4.id === r3.id && r4.manifest.from_cache === true
const ok5 = r5.id === NOTE.split('_').pop() && r5.manifest.from_cache === true
console.log(`[1] 标准面全新跑       ${ok1i ? 'PASS' : 'FAIL'}`)
console.log(`[2] 标准面缓存命中     ${ok2 ? 'PASS' : 'FAIL'}`)
console.log(`[3] 裸文件直给         ${ok3 ? 'PASS' : 'FAIL'}`)
console.log(`[4] 直给幂等           ${ok4 ? 'PASS' : 'FAIL'}`)
console.log(`[5] 笔记内文件沿用身份 ${ok5 ? 'PASS' : 'FAIL'}`)
process.exit(ok1i && ok2 && ok3 && ok4 && ok5 ? 0 : 1)
