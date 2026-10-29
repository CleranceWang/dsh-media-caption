// ============================================================================
// dsh-media-eye —— 常驻主进程
//
// 用户定案 m00204 / m00207：
//
//   一个进程，两个定时器：
//     哨兵   每 SENTINEL_MS 扫一圈输入根 → 发现没做的就 INSERT 进 DB
//     传话筒 每 WATCH_MS 看 DB 的 max(id) 变了没 → 变了就叫主程序「来活了」
//   主程序被叫 → 取队首 → 处理一单 → 回到空闲
//
// 三个不变量：
//   ① 主程序同一时刻只处理一单（用户 m00098「插队并不打断当前处理」）
//   ② 通知可积压 —— 忙的时候"来活了"不丢，做完立刻接着跑下一单
//   ③ DB 只装「还没处理的」，做完删掉；真相永远在磁盘（用户 m00103）
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA, enqueue, claimNext, finish, fail, listQueuedNoteIds, stats } from './queue.js'
import { scan, readNoteId } from './sentinel.js'
import { processNote, checkDeps } from './process.js'

const CFG = {
  inputRoot: process.env.MEDIA_EYE_INPUT_ROOT || '',
  outRoot: process.env.MEDIA_EYE_OUT_ROOT || '',
  dbPath: process.env.MEDIA_EYE_DB || '',
  queueNo: Number(process.env.MEDIA_EYE_QUEUE_NO || 1),
  maxTries: Number(process.env.MEDIA_EYE_MAX_TRIES || 3),
  claimTimeoutMin: Number(process.env.MEDIA_EYE_CLAIM_TIMEOUT_MIN || 60),
  sentinelMs: Number(process.env.MEDIA_EYE_SENTINEL_SEC || 30) * 1000,
  watchMs: Number(process.env.MEDIA_EYE_WATCH_SEC || 2) * 1000,
}

const T0 = Date.now()
const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

function requireCfg() {
  const missing = []
  if (!CFG.inputRoot) missing.push('MEDIA_EYE_INPUT_ROOT')
  if (!CFG.outRoot) missing.push('MEDIA_EYE_OUT_ROOT')
  if (!CFG.dbPath) missing.push('MEDIA_EYE_DB')
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join(', ')}`)
    process.exit(2)
  }
}

function openDb() {
  fs.mkdirSync(path.dirname(CFG.dbPath), { recursive: true })
  const db = new DatabaseSync(CFG.dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 10000')
  db.exec(SCHEMA)
  return db
}

// ── 状态
let busy = false          // 主程序是否在处理
let wakeRequested = false // 「来活了」通知是否积压
let stopped = false

const db = (requireCfg(), openDb())

// ── 哨兵：定时扫输入根
let sentinelBusy = false
function runSentinel() {
  if (stopped || sentinelBusy) return
  if (!CFG.inputRoot || !fs.existsSync(CFG.inputRoot)) return
  sentinelBusy = true
  try {
    const queued = listQueuedNoteIds(db)
    const r = scan(CFG.inputRoot, CFG.outRoot, queued, (m) => log('[哨兵]', m))
    let pushed = 0
    for (const item of r.found) {
      const res = enqueue(db, { noteId: item.noteId, noteDir: item.noteDir, queueNo: CFG.queueNo })
      if (res.inserted) { pushed += 1; log(`[哨兵] + ${item.noteId}`) }
    }
    if (pushed) log(`[哨兵] 扫到 ${pushed} 条新活（已完成 ${r.skippedDone} / 已排队 ${r.skippedQueued} / 无媒体 ${r.skippedNoMedia}）`)
  } catch (e) {
    log('[哨兵] 出错：', e.message)
  } finally {
    sentinelBusy = false
  }
}

// ── 传话筒：盯 DB 的 max(id)
//   INSERT 只会让 max(id) 变大 —— 所以「变了」= 有新活进来
let lastMaxId = (() => {
  const r = db.prepare('SELECT MAX(id) AS m FROM queue').get()
  return r?.m ?? 0
})()

function runWatcher() {
  if (stopped) return
  try {
    const r = db.prepare('SELECT MAX(id) AS m FROM queue WHERE status != ?').get('claimed')
    const m = r?.m ?? 0
    // 有新 id（新插入）说明哨兵投了活 —— 注意：删除会让 max 变小，不做"变小"判断
    if (m > lastMaxId) {
      lastMaxId = m
      log('[传话筒] DB 有新活 → 叫主程序')
      requestWake()
    } else if (m !== lastMaxId && m !== 0) {
      // max 变小（前面的删了），只为同步基准，不叫醒
      lastMaxId = m
    }
  } catch (e) {
    log('[传话筒] 出错：', e.message)
  }
}

function requestWake() {
  wakeRequested = true
  if (!busy) void drain()
}

// ── 主程序：取队首处理一单
async function drain() {
  if (busy || stopped) return
  busy = true
  wakeRequested = false
  try {
    while (!stopped) {
      const job = claimNext(db, {
        queueNo: CFG.queueNo,
        claimTimeoutMs: CFG.claimTimeoutMin * 60 * 1000,
      })
      if (!job) break

      log(`[主程序] 取队首 #${job.id} ${job.note_id}（第 ${job.tries + 1} 次尝试）`)
      const t = Date.now()
      try {
        const r = processNote(path.join(CFG.outRoot, path.basename(job.note_dir)), CFG.outRoot, { srcDir: job.note_dir, log: (...a) => log('  ', ...a) })
        finish(db, job.id)
        log(`[主程序] ✓ 完成 ${((Date.now() - t) / 1000).toFixed(1)}s ${JSON.stringify(r)}`)
      } catch (e) {
        const res = fail(db, job.id, e.message, { maxTries: CFG.maxTries })
        if (res.dropped) log(`[主程序] ✗ 失败已达上限 ${CFG.maxTries} 次，移出队列：${e.message}`)
        else {
          log(`[主程序] ✗ 失败（${res.tries}/${CFG.maxTries}），已放回队首：${e.message}`)
          break // 同一单刚失败，别立刻原地重试打转；等下一条通知
        }
      }
      // 如果这期间又来了通知，继续取；否则退出循环
      if (!wakeRequested && !hasPending()) break
    }
  } finally {
    busy = false
    if (wakeRequested) void drain()
  }
}

function hasPending() {
  try {
    return !!db.prepare("SELECT 1 FROM queue WHERE status='pending' LIMIT 1").get()
  } catch { return false }
}

// ── 启动
const problems = checkDeps()
if (problems.length) {
  log('依赖检查：')
  for (const p of problems) log('  ✗', p)
  log('（ffmpeg/ffprobe 缺失时抽帧与音轨会失败；whisper 缺失时转写会失败）')
} else log('依赖检查：齐')

log(`常驻启动`)
log(`  输入根 : ${CFG.inputRoot}`)
log(`  输出根 : ${CFG.outRoot}`)
log(`  队列DB : ${CFG.dbPath}`)
log(`  哨兵   : 每 ${CFG.sentinelMs / 1000}s 扫一轮`)
log(`  传话筒 : 每 ${CFG.watchMs / 1000}s 看一次 DB`)
log(`  队列   : ${JSON.stringify(stats(db))}`)

runSentinel()                                   // 启动先扫一轮
const tSentinel = setInterval(runSentinel, CFG.sentinelMs)
const tWatch = setInterval(runWatcher, CFG.watchMs)
// 数据库里启动前就有的 pending，也要立刻开工
if (hasPending()) requestWake()

function shutdown(sig) {
  if (stopped) return
  stopped = true
  log(`收到 ${sig}，停止（当前这单会跑完）`)
  clearInterval(tSentinel); clearInterval(tWatch)
  const wait = () => {
    if (busy) { setTimeout(wait, 500); return }
    try { db.close() } catch {}
    log(`已退出，运行 ${((Date.now() - T0) / 1000).toFixed(0)}s`)
    process.exit(0)
  }
  wait()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
