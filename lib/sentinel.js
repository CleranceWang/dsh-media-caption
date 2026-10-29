// ============================================================================
// 哨兵：发现 → 投递
//
// 用户定案：
//   m00110  先有个哨兵进行发现（发现与执行分离）
//   m00113  哨兵也在插件里；扫 <输入根>/*/，看有没有新素材或缺成品
//   m00116  以 note id / BV 号记录（目录名末尾那串）
//   m00117  同一个笔记 id 就跳过，不报错
//
// 哨兵**只看磁盘**，不信 DB（用户 m00107）：
//   一个笔记目录「已完成」的判据 = 音轨在 + 字幕.json 在（有画面还要九宫格在）
//   不齐 → 投进队首
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'

const MEDIA_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.ts', '.m4v',
  '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.opus', '.wma',
])

/** 目录名末尾那串当身份（用户 m00116） */
export function readNoteId(noteDir) {
  const name = path.basename(noteDir)
  const parts = name.split('_')
  return parts.length >= 2 ? parts[parts.length - 1] : name
}

/** 这个笔记目录里有没有媒体文件 */
function hasMedia(noteDir) {
  for (const sub of ['video', 'audio', '']) {
    const d = sub ? path.join(noteDir, sub) : noteDir
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase())) return true
    }
  }
  return false
}

/**
 * 完成判据（用户 m00104）：靠产物，不靠 DB。
 *   音轨在 + 字幕.json 在 +（有画面时）九宫格在
 */
export function isFinished(noteDir, outRoot) {
  const outDir = path.join(outRoot, path.basename(noteDir))
  const audio = path.join(outDir, 'audio', 'audio.wav')
  const sub = path.join(outDir, '字幕.json')
  if (!fs.existsSync(audio) || !fs.existsSync(sub)) return false
  // 有画面却没有九宫格 → 没做完（纯音频项目根本不会有 sheet.jpg，用 frames/ 有无区分）
  const framesDir = path.join(outDir, 'frames')
  const sheet = path.join(outDir, 'previews', 'sheet.jpg')
  if (fs.existsSync(framesDir) && !fs.existsSync(sheet)) return false
  return true
}

/**
 * 扫一轮输入根，返回需要处理的笔记目录（已排除已完成、已排队的）。
 *
 * @param {string} inputRoot  输入根（本地绝对路径，UNC 也行）
 * @param {string} outRoot    输出根
 * @param {Set<string>} queuedNoteIds  队列里已有的 note id
 * @param {(msg:string)=>void} log
 */
export function scan(inputRoot, outRoot, queuedNoteIds, log = () => {}) {
  const found = []
  let entries
  try { entries = fs.readdirSync(inputRoot, { withFileTypes: true }) } catch (e) {
    log(`[哨兵] 读不到输入根 ${inputRoot}：${e.message}`)
    return { found, skippedDone: 0, skippedQueued: 0, skippedNoMedia: 0 }
  }

  let skippedDone = 0, skippedQueued = 0, skippedNoMedia = 0
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const noteDir = path.join(inputRoot, e.name)
    if (!hasMedia(noteDir)) { skippedNoMedia += 1; continue }
    if (isFinished(noteDir, outRoot)) { skippedDone += 1; continue }

    const noteId = readNoteId(noteDir)
    if (queuedNoteIds.has(noteId)) { skippedQueued += 1; continue }   // 用户 m00117：同 id 跳过

    found.push({ noteId, noteDir })
  }
  return { found, skippedDone, skippedQueued, skippedNoMedia }
}
