#!/usr/bin/env node
// 把老系统的 transcript.json 搬成新插件的 字幕.json（不重跑 ASR）。
//
// 老格式（AI-Media2Doc 时期）:
//   { note_id, note_dir, video_key, filename, language,
//     duration: <秒, float>,
//     audio_key,
//     result: [{ start_time, end_time, text }]   ← 毫秒整数 }
//
// 新格式（media-eye）:
//   { note_id, source, source_file, duration_ms, speech, language,
//     language_reliable, segments: [{ start, end, text }] }
//
// 用法：
//   node dev/migrate-transcripts.mjs <outputRoot>            # 只报告
//   node dev/migrate-transcripts.mjs <outputRoot> --write    # 真写
//
// 注意：老格式没有「无人声」的记录 —— 当时没人声就没 result，那批早失败了。
//       所以凡是有 result 的，speech 一律 present。

import fs from 'node:fs'
import path from 'node:path'

const outRoot = process.argv[2]
const write = process.argv.includes('--write')

if (!outRoot) {
  console.error('用法: node dev/migrate-transcripts.mjs <outputRoot> [--write]')
  process.exit(2)
}

const dirs = fs.readdirSync(outRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(outRoot, e.name))

let ok = 0
let skippedHasNew = 0
let skippedNoLegacy = 0
let bad = 0

for (const dir of dirs) {
  const legacy = path.join(dir, 'transcript.json')
  const next = path.join(dir, '字幕.json')

  if (!fs.existsSync(legacy)) { skippedNoLegacy += 1; continue }
  if (fs.existsSync(next)) { skippedHasNew += 1; continue }

  let old
  try {
    old = JSON.parse(fs.readFileSync(legacy, 'utf8'))
  } catch (e) {
    console.log(`✗ 读不动 ${path.basename(dir)}: ${e.message}`)
    bad += 1
    continue
  }

  const result = Array.isArray(old.result) ? old.result : []
  const segments = result.map((s) => ({
    start: Math.round(Number(s.start_time) || 0),
    end: Math.round(Number(s.end_time) || 0),
    text: String(s.text ?? ''),
  }))

  const noteId = old.note_id || path.basename(dir).split('_').pop()
  const file = {
    note_id: noteId,
    source: noteId,
    source_file: old.filename || null,
    duration_ms: Math.round((Number(old.duration) || 0) * 1000),
    // 老系统只有「有人声」才会有 result；无人声的那批当时直接失败了
    speech: segments.length ? 'present' : 'none',
    language: segments.length ? (old.language || null) : null,
    language_reliable: segments.length ? true : null,
    segments,
  }

  if (!write) {
    console.log(`· ${path.basename(dir).slice(0, 40)}… ${segments.length} 段`)
    ok += 1
    continue
  }

  fs.writeFileSync(next, JSON.stringify(file, null, 2), 'utf8')
  console.log(`✓ ${path.basename(dir).slice(0, 40)}… ${segments.length} 段 → 字幕.json`)
  ok += 1
}

console.log('')
console.log(`目录 ${dirs.length} 个`)
console.log(`  转换 ${ok}${write ? '（已写）' : '（仅报告）'}`)
console.log(`  已有新字幕 ${skippedHasNew}`)
console.log(`  无老 transcript ${skippedNoLegacy}`)
if (bad) console.log(`  失败 ${bad}`)
