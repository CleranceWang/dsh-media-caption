// 验证 sweep 的「扫-处理-再扫」循环：连续两轮空才退。
// 做法：造一个假输入根，里面 1 个笔记（纯音频，转写很快），
// 跑 sweep --limit 1，看它扫了几轮。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const tmp = path.join(root, '.verify-tmp')

// 清空临时区
fs.rmSync(tmp, { recursive: true, force: true })
const inRoot = path.join(tmp, 'in')
const outRoot = path.join(tmp, 'out')
const dbPath = path.join(tmp, 'queue.db')

// 造一个笔记目录：拿已有的 test 音频（如果有），否则用现成的 out-run 里的 audio.wav
const srcWav = path.join(root, 'out-run', '_direct', '42952687912', 'audio', 'audio.wav')
if (!fs.existsSync(srcWav)) {
  console.error('缺少测试音频，先跑一次 dev/run-once.mjs 生成：', srcWav)
  process.exit(2)
}
const noteDir = path.join(inRoot, '2026-01-01_测试_sweeptest')
fs.mkdirSync(path.join(noteDir, 'audio'), { recursive: true })
fs.copyFileSync(srcWav, path.join(noteDir, 'audio', 'audio.wav'))

console.log('输入根:', inRoot)
console.log('输出根:', outRoot)
console.log('笔记  :', path.basename(noteDir))
console.log('')

const env = {
  ...process.env,
  MEDIA_EYE_INPUT_ROOT: inRoot,
  MEDIA_EYE_OUT_ROOT: outRoot,
  MEDIA_EYE_DB: dbPath,
}

const r = spawnSync(process.execPath, [path.join(root, 'lib', 'sweep.js')], {
  env, stdio: 'inherit', cwd: root,
})
process.exit(r.status ?? 1)
