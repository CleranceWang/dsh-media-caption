// 后台批处理：扫一轮输入根 → 入队 → 逐个处理 → 退出。
//
// 谁启动它：DSH 插件在 apply() 里 spawn 本文件（独立进程，DSH 不必等它）。
// 为什么独立进程：用户 m01183 —— 「6 小时批处理」不能卡住 DSH 本身。
// 生命周期：跑完就死，不留常驻定时器。下次谁想要谁再 spawn（工具 media_caption_sweep）。
//
// 用法：
//   node lib/sweep.js [--limit N]
//
//   --limit N  本轮最多处理 N 单（默认不限；autoSweepLimit 也走这个口）

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA, enqueue, claimNext, finish, fail, stats, listQueuedNoteIds } from './queue.js'
import { scan } from './sentinel.js'
import { processNote } from './process.js'
import { checkOnce, waitForResources } from './resource.js'
import { loadCfg, CFG_FILE } from './cfg.js'

const ts = () => new Date().toTimeString().slice(0, 8)
const log = (...a) => console.log(`[sweep ${ts()}]`, ...a)

const argv = process.argv.slice(2)
const i = argv.indexOf('--limit')
const limit = i >= 0 ? Number(argv[i + 1]) || 0 : 0

const cfg = loadCfg()

if (!cfg.inputRoot) {
  log(`没配输入根。配置来自 ${CFG_FILE} 或环境变量 MEDIA_CAPTION_INPUT_ROOT`)
  process.exit(2)
}
if (!fs.existsSync(cfg.inputRoot)) {
  log(`输入根不存在：${cfg.inputRoot}`)
  process.exit(2)
}
if (!cfg.outRoot) {
  log(`没配输出根（MEDIA_CAPTION_OUT_ROOT 或配置里的 outRoot）`)
  process.exit(2)
}
if (!cfg.dbPath) {
  log(`没配队列 DB（MEDIA_CAPTION_DB 或配置里的 dbPath）`)
  process.exit(2)
}

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true })
const db = new DatabaseSync(cfg.dbPath)
db.exec(SCHEMA)

let stopped = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopped = true; log(`收到 ${sig}，处理完手上这一单就退`) })
}
const t0 = Date.now()
let done = 0
let failed = 0
let scanRounds = 0
let emptyStreak = 0          // 连续几轮扫不到新东西

try {
  // ══════════════════════════════════════════════════════════════
  // 扫-处理-再扫 的循环（用户 m01172 / m01368）
  //
  //   扫一轮 → 入队 → 处理完队列 → 再扫一轮
  //     这轮有新东西 → 继续
  //     这轮没新东西 → 已经连着空了，退出
  //
  //   判据是「连续两轮都扫不出新东西」才停。这样处理 A 的时候
  //   有人往输入根塞了 B，B 会在下一轮扫盘时被看见。
  // ══════════════════════════════════════════════════════════════
  while (!stopped) {
    if (limit && done + failed >= limit) {
      log(`已达 --limit ${limit}，收工`)
      break
    }

    // ── 扫一轮（只看磁盘，不看 DB —— 用户 m00107）──────────────
    scanRounds += 1
    log(`── 第 ${scanRounds} 轮扫盘：${cfg.inputRoot}`)
    const queued = listQueuedNoteIds(db)
    const r = scan(cfg.inputRoot, cfg.outRoot, queued, (m) => log('[哨兵]', m))
    let added = 0
    for (const item of r.found) {
      if (enqueue(db, { noteId: item.noteId, noteDir: item.noteDir, queueNo: cfg.queueNo }).inserted) added += 1
    }
    log(`扫完：新增 ${added} / 已完成 ${r.skippedDone} / 已排队 ${r.skippedQueued} / 无媒体 ${r.skippedNoMedia}`)

    if (added === 0) {
      emptyStreak += 1
      if (emptyStreak >= 2) {
        log('连续两轮扫不到新东西，没有活可干了 —— 退出')
        break
      }
      // 一轮空不等于是真空：还有别人刚起的 worker / 刚落盘的单，再审一遍
      continue
    }
    emptyStreak = 0

    // ── 把队列清空 ─────────────────────────────────────────────
    log(`队列：${JSON.stringify(stats(db))}`)
    while (!stopped && (!limit || done + failed < limit)) {
      const job = claimNext(db, { queueNo: cfg.queueNo, claimTimeoutMs: cfg.claimTimeoutMin * 60_000 })
      if (!job) break   // 这一批干完了，回去再扫

      // ★ 资源门禁：whisper 要起进程前先看一眼（判据见 lib/resource.js）。
      //   实测峰值 3.3 GB 显存 / 1.5 GB 内存。不够就等，不跳过、不记失败。
      if (cfg.gate) {
        const pre = checkOnce(cfg.gateCfg)
        if (!pre.ok) {
          log(`[门禁] #${job.id} ${job.note_id} 先等一等：${pre.reason}`)
          const w = await waitForResources(cfg.gateCfg, (...a) => log(...a))
          if (!w.ok) {
            fail(db, job.id, `门禁未放行：${w.reason}`, { maxTries: cfg.maxTries })
            failed += 1
            log(`[门禁] 仍不放行，这单记失败并退出：${w.reason}`)
            stopped = true
            break
          }
          log(`[门禁] 放行：${w.reason}`)
        }
      }

      log(`取队首 #${job.id} ${job.note_id}（第 ${job.tries + 1} 次）`)
      const t = Date.now()
      try {
        const outDir = path.join(cfg.outRoot, path.basename(job.note_dir))
        const res = processNote(outDir, cfg.outRoot, {
          srcDir: job.note_dir,
          cfg,
          log: (...a) => log('  ', ...a),
        })
        finish(db, job.id)
        done += 1
        log(`✓ ${((Date.now() - t) / 1000).toFixed(1)}s ${job.note_id} → ${res.status}${res.no_frames ? '（不抽帧）' : ''}`)
      } catch (e) {
        const fr = fail(db, job.id, e.message, { maxTries: cfg.maxTries })
        failed += 1
        log(`✗ ${job.note_id} ${e.message}${fr.dropped ? `（已达上限 ${cfg.maxTries} 次，移出队列）` : `（${fr.tries}/${cfg.maxTries}，放回队首）`}`)
      }
    }
  }

  log(`结束：扫了 ${scanRounds} 轮 / 成 ${done} / 败 ${failed} / 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
} catch (e) {
  log('致命错误：', e.stack || e.message)
  process.exitCode = 1
} finally {
  try { db.close() } catch {}
}
