// ============================================================================
// dsh-media-caption —— 点名面（DSH 工具的实现体）
//
// 用户 m00308：做成 DSH 工具。「一体两面」：
//   批处理面：哨兵发现 → 排队 → processNote() → 落盘 → 删队列行
//   点名面  ：调用方指名 → processNote() → 落盘 → **返回取货单**
//   两边调的是同一个 processNote()，产物落的是同一处盘。
//
// 用户 m00309：盘上产物已齐 → 直接返回，不重算（from_cache = true）。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { processNote } from './process.js'
import { buildManifest } from './manifest.js'

/**
 * 点名处理一篇。
 *
 * @param {string} noteDir 笔记目录（输入侧的绝对路径，或不带根的名字）
 * @param {object} cfg     { inputRoot, outRoot }
 * @param {(m:string)=>void} log
 * @returns {Promise<object>} 取货单
 */
export async function processOne(noteDir, cfg, log = () => {}) {
  // 允许只给「笔记名」或「名字的一部分」—— 调用方不一定知道完整路径
  let resolved = noteDir
  if (!fs.existsSync(resolved) && cfg.inputRoot) {
    const cand = path.join(cfg.inputRoot, path.basename(noteDir))
    if (fs.existsSync(cand)) resolved = cand
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`找不到笔记目录：${noteDir}（输入根 ${cfg.inputRoot || '未配置'}）`)
  }

  const outDir = path.join(cfg.outRoot, path.basename(resolved))
  const manifestPath = path.join(outDir, '字幕.json')

  // 盘上已经齐了 → 直接返回，不重算（用户 m00309）
  if (fs.existsSync(manifestPath)) {
    log(`  [点名] 盘上已有产物，直接返回`)
    return buildManifest(path.basename(resolved), cfg.outRoot, { fromCache: true })
  }

  log(`  [点名] 开始处理 ${path.basename(resolved)}`)
  // processNote(outDir, outRoot, {srcDir})：产物落 outDir，但媒体从输入目录 resolved 里找
  // （签名改造后「产物在哪」和「源在哪」必须显式分开，不能合并成一个参数）
  const r = processNote(outDir, cfg.outRoot, { srcDir: resolved, log, cfg })
  if (r.status === 'skipped') throw new Error(`这篇没有媒体文件：${path.basename(resolved)}`)

  return buildManifest(path.basename(resolved), cfg.outRoot, { fromCache: r.status === 'done' })
}
