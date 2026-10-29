// ============================================================================
// direct.js —— 非标接口：任意文件直给（用户 m00376 选定）
//
// 标准面：笔记目录（<日期>_<标题>_<id>）→ 哨兵发现 → 队列 → processNote()
// 非标面：一个音视频文件 → 直接跑一遍 → 返回取货单，不走队列、不等哨兵
//
// 两边共用 processNote() / buildManifest()，所以**产物布局完全一致**，
// 下游 agent 不用知道这笔是从哪个面进来的。
//
// identity（身份）三档：
//   1) 调用方显式给了 id
//   2) 文件在笔记目录里（<note>/video/x.mp4、<note>/audio/x.mp3）→ 用笔记目录的身份
//   3) 都不满足 → 内容指纹 h_<sha1前12>（同名不同内容不会互相覆盖）
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { processNote } from './process.js'
import { buildManifest } from './manifest.js'

const MEDIA_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.flv', '.webm', '.m4v', '.ts', '.wmv', '.mpg', '.mpeg', '.3gp', '.ogv',
  '.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.opus', '.wma', '.amr',
])

export function isMediaFile(p) {
  try { return fs.statSync(p).isFile() && MEDIA_EXT.has(path.extname(p).toLowerCase()) } catch { return false }
}

// 内容指纹：首 1MB + 文件大小。同一份文件重跑得到同一个 id，幂等由此成立。
function contentId(file, bytes = 1 << 20) {
  const h = crypto.createHash('sha1')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    h.update(buf.subarray(0, n))
    h.update(':' + fs.fstatSync(fd).size)
  } finally { fs.closeSync(fd) }
  return h.digest('hex').slice(0, 12)
}

function noteIdOf(dir) {
  const name = path.basename(dir)
  const parts = name.split('_')
  return parts.length >= 2 ? parts[parts.length - 1] : name
}

/** 文件落在某个笔记目录里吗？在 → 返回那个笔记目录名 */
function enclosingNoteDir(src) {
  const parent = path.dirname(src)
  const base = path.basename(parent).toLowerCase()
  if (base === 'video' || base === 'audio') return path.dirname(parent)
  return null
}

/**
 * 任意文件直给。
 * @param {string} file     音视频文件路径
 * @param {object} cfg      loadCfg() 结果（用 outRoot）
 * @param {string|null} id  调用方指定的身份
 * @returns {{ id: string, outDir: string, status: string, manifest: object }}
 */
export function processFile(file, cfg, id = null, log = () => {}) {
  const src = path.resolve(file)
  if (!isMediaFile(src)) throw new Error(`不是受支持的音视频文件：${src}`)

  const noteDir = enclosingNoteDir(src)
  let outDir
  let noteId

  if (noteDir) {
    // 情形 2：文件本来就在笔记目录里 —— 完全走标准面那套，产物落 <outRoot>/<笔记目录名>
    noteId = noteIdOf(noteDir)
    outDir = path.join(cfg.outRoot, path.basename(noteDir))
    log(`  文件属于笔记目录 ${path.basename(noteDir)}，按标准布局落盘`)
  } else {
    // 情形 1/3：裸文件 —— 产物落 <outRoot>/_direct/<id>/，不和笔记目录混在一起
    noteId = (id && String(id).trim()) || `h_${contentId(src)}`
    outDir = path.join(cfg.outRoot, '_direct', noteId)
    // processNote 以「目录名末尾那串」当身份，所以这里造一个名字刚好等于 id 的目录，
    // 里面放一个只含路径清单的 .src —— findMedia 不认它，因此改用 processFile 的
    // 文件级流程（见下方 processNote 的 file 参数）。
  }

  const r = processNote(outDir, cfg.outRoot, { file: src, noteId, log, cfg })
  if (r.status === 'skipped') throw new Error(`没有可处理的媒体：${src}`)
  // buildManifest 的第一参数是「产物目录名」，它内部自己拼 outRoot —— 这里必须传
  // 相对 outRoot 的那一段（_direct/<id> 或 <笔记目录名>），不能传绝对 outDir
  return {
    id: noteId,
    outDir,
    status: r.status,
    manifest: buildManifest(path.relative(cfg.outRoot, outDir), cfg.outRoot, { fromCache: r.status === 'done' }),
  }
}
