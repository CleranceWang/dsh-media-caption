// ============================================================================
// dsh-media-eye —— 取货单（返回值）
//
// 用户 m00305：「eye 告诉 AI 去哪取东西」。
// ⇒ 返回值不是把货全搬过去，而是一张**取货单**：货在盘上，单子告诉你
//    在哪、叫什么。字幕正文顺带带上（用户 m00308：给完整 segments）。
//
// 用户 m00308/m00309：
//   · segments 完整带回
//   · jpg 只给路径
//   · 盘上产物已齐 → 直接返回，不重算，from_cache = true
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'

/**
 * 造一张取货单。**不碰磁盘以外的任何东西**——只是把已有产物的位置和内容
 * 整理成调用方好用的形状。
 *
 * @param {string} noteDir    输入侧的笔记目录
 * @param {string} outRoot    输出根
 * @param {object} opts
 * @param {boolean} opts.fromCache  这次是盘上现成的（true）还是刚算的（false）
 * @param {string[]} [opts.frameNames]  帧文件名（不传就扫目录）
 */
export function buildManifest(noteDir, outRoot, { fromCache = false, frameNames = null } = {}) {
  // noteDir 可以是笔记目录名（"2026-..._31128420"），也可以是多段相对路径（"_direct/h_xxx"）
  const rel = path.isAbsolute(noteDir) ? path.relative(outRoot, noteDir) : noteDir
  const noteName = path.basename(rel)
  const outDir = path.join(outRoot, rel)
  const noteId = noteName.split('_').pop()

  // 字幕正文：读盘上那份（点名面和批处理面共用同一份，不另算）
  let subtitle = null
  try {
    subtitle = JSON.parse(fs.readFileSync(path.join(outDir, '字幕.json'), 'utf8'))
  } catch { /* 没转写完就没有 */ }

  const framesDir = path.join(outDir, 'frames')
  const names = frameNames ?? (() => {
    try {
      return fs.readdirSync(framesDir)
        .filter((f) => f.toLowerCase().endsWith('.jpg'))
        .sort()
    } catch { return [] }
  })()

  const abs = (p) => path.resolve(p)
  const frames = names.map((n) => abs(path.join(framesDir, n)))

  return {
    note_id: noteId,
    duration_ms: subtitle?.duration_ms ?? null,
    segments: subtitle?.segments ?? [],          // 完整字幕，毫秒整数
    // ★ speech：none 表示整片没人声（纯音乐/无解说，小红书常见）。
    //   下游看到 none 就该转向看图，而不是以为视频没内容（用户 m00642/m00643）
    speech: subtitle?.speech ?? (subtitle ? 'present' : null),
    language: subtitle?.language ?? null,
    language_reliable: subtitle?.language_reliable ?? null,
    ...(subtitle?.warning ? { warning: subtitle.warning } : {}),
    where: {
      root: abs(outRoot),
      note_dir: noteName,
      out_dir: abs(outDir),
      subtitle: subtitle ? abs(path.join(outDir, '字幕.json')) : null,
      frames,                                     // 路径，不是 base64
      // 九宫格：一屏叫 sheet.jpg，多屏叫 sheet-1..N.jpg（N 按内容密度定，上限 3）
      //   sheets 给完整列表，sheet 给第一屏（兼容老用法：只想要一张封面图的场景）
      sheet: (() => {
        const p1 = path.join(outDir, 'previews', 'sheet.jpg')
        if (fs.existsSync(p1)) return abs(p1)
        const p2 = path.join(outDir, 'previews', 'sheet-1.jpg')
        return fs.existsSync(p2) ? abs(p2) : null
      })(),
      sheets: (() => {
        try {
          return fs.readdirSync(path.join(outDir, 'previews'))
            .filter((f) => /^sheet(-\d+)?\.jpg$/i.test(f))
            .sort((a, b) => {
              const na = a.match(/(\d+)/), nb = b.match(/(\d+)/)
              return (na ? Number(na[1]) : 0) - (nb ? Number(nb[1]) : 0)
            })
            .map((f) => abs(path.join(outDir, 'previews', f)))
        } catch { return [] }
      })(),
      audio: fs.existsSync(path.join(outDir, 'audio', 'audio.wav'))
        ? abs(path.join(outDir, 'audio', 'audio.wav')) : null,
      frames_meta: fs.existsSync(path.join(outDir, 'frames.json'))
        ? abs(path.join(outDir, 'frames.json')) : null,
    },
    no_frames: !frames.length,
    from_cache: fromCache,
  }
}
