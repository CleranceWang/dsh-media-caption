// ============================================================================
// dsh-media-eye —— 主循环
//
// 用户定的形状（m00100 / m00107 / m00110）：
//
//   哨兵（发现）→ 投 DB 队首 → 执行者取队首 → 处理 → 从 DB 删 → 退出
//                                      ↑                          ↓
//                                      └──── 下一轮重新开始 ←─────┘
//
// 一轮只处理一条（用户 m00099：「插件永远只处理队首的，处理完队首，
// 队首沉底，然后退出，重新开始循环」）。
//
// 用法：
//   node main.js tick                 跑一轮（哨兵 + 执行一个）
//   node main.js tick --no-scan       跳过哨兵，只消费队列
//   node main.js scan                 只跑哨兵（看会投什么，不执行）
//   node main.js push <笔记目录>       手动插队一条到队首
//   node main.js status               看队列
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA, enqueue, claimNext, finish, fail, listQueuedNoteIds, stats } from './queue.js'
import { scan, readNoteId, isFinished } from './sentinel.js'
import { processNote } from './process.js'

// ── 配置：全部走环境变量，不写死本机路径（GitHub 开源标准）
const CFG = {
  inputRoot: process.env.MEDIA_EYE_INPUT_ROOT || '',
  outRoot: process.env.MEDIA_EYE_OUT_ROOT || '',
  dbPath: process.env.MEDIA_EYE_DB || '',
  queueNo: Number(process.env.MEDIA_EYE_QUEUE_NO || 1),
  maxTries: Number(process.env.MEDIA_EYE_MAX_TRIES || 3),
  claimTimeoutMin: Number(process.env.MEDIA_EYE_CLAIM_TIMEOUT_MIN || 60),
}

function requireCfg() {
  const missing = []
  if (!CFG.inputRoot) missing.push('MEDIA_EYE_INPUT_ROOT')
  if (!CFG.outRoot) missing.push('MEDIA_EYE_OUT_ROOT')
  if (!CFG.dbPath) missing.push('MEDIA_EYE_DB')
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join(', ')}`)
    console.error('例：MEDIA_EYE_INPUT_ROOT=D:\\in MEDIA_EYE_OUT_ROOT=D:\\out MEDIA_EYE_DB=D:\\queue.db')
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

// ── 哨兵一轮：扫描 + 投递
function runSentinel(db) {
  if (!CFG.inputRoot || !fs.existsSync(CFG.inputRoot)) {
    console.log(`[哨兵] 输入根不存在，跳过扫描：${CFG.inputRoot || '(未配置)'}`)
    return []
  }
  const queued = listQueuedNoteIds(db)
  const r = scan(CFG.inputRoot, CFG.outRoot, queued, console.log)
  const pushed = []
  for (const item of r.found) {
    const res = enqueue(db, { noteId: item.noteId, noteDir: item.noteDir, queueNo: CFG.queueNo })
    if (res.inserted) pushed.push(item)
  }
  console.log(`[哨兵] 发现 ${r.found.length} 条 → 投递 ${pushed.length} 条`
    + `（已完成 ${r.skippedDone} / 已排队 ${r.skippedQueued} / 无媒体 ${r.skippedNoMedia}）`)
  return pushed
}

// ── 执行一条
function runOne(db, doScan) {
  if (doScan) runSentinel(db)

  const job = claimNext(db, { queueNo: CFG.queueNo, claimTimeoutMs: CFG.claimTimeoutMin * 60 * 1000 })
  if (!job) { console.log('[执行] 队列空，本轮无活'); return 0 }

  console.log(`\n[执行] 取队首 #${job.id} ${job.note_id} (第 ${job.tries + 1} 次尝试)`)
  const t0 = Date.now()
  try {
    const r = processNote(path.join(CFG.outRoot, path.basename(job.note_dir)), CFG.outRoot, { srcDir: job.note_dir, log: console.log })
    finish(db, job.id)
    console.log(`[执行] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${JSON.stringify(r)}`)
    return 0
  } catch (e) {
    const res = fail(db, job.id, e.message, { maxTries: CFG.maxTries })
    console.error(`[执行] 失败: ${e.message}`)
    if (res.dropped) console.error(`[执行] 已达上限 ${CFG.maxTries} 次，移出队列`)
    else console.error(`[执行] 已放回队首（第 ${res.tries}/${CFG.maxTries} 次失败）`)
    return 1
  }
}

// ── CLI
const [, , cmd = 'tick', ...rest] = process.argv

if (cmd === 'push') {
  requireCfg()
  const noteDir = rest[0]
  if (!noteDir || !fs.existsSync(noteDir)) { console.error('用法: node main.js push <笔记目录>'); process.exit(2) }
  const db = openDb()
  const noteId = readNoteId(noteDir)
  const r = enqueue(db, { noteId, noteDir: path.resolve(noteDir), queueNo: CFG.queueNo })
  if (r.inserted) console.log(`已插队到队首：${noteId} (#${r.id})`)
  else console.log(`已在队列中，跳过：${noteId} (${r.status})`)   // 用户 m00117
  process.exit(0)
} else if (cmd === 'status') {
  requireCfg()
  const db = openDb()
  console.log('队列状态：', stats(db))
  const rows = db.prepare('SELECT id, note_id, status, tries FROM queue ORDER BY id DESC LIMIT 20').all()
  for (const r of rows) console.log(`  #${r.id} ${r.note_id} ${r.status} tries=${r.tries}`)
  process.exit(0)
} else if (cmd === 'scan') {
  requireCfg()
  const db = openDb()
  const queued = listQueuedNoteIds(db)
  const r = scan(CFG.inputRoot, CFG.outRoot, queued, console.log)
  console.log(`发现 ${r.found.length} 条（已完成 ${r.skippedDone} / 已排队 ${r.skippedQueued} / 无媒体 ${r.skippedNoMedia}）`)
  for (const f of r.found) console.log(`  + ${f.noteId}  ${f.noteDir}`)
  process.exit(0)
} else {
  // tick：跑一轮
  requireCfg()
  const db = openDb()
  const code = runOne(db, !rest.includes('--no-scan'))
  db.close()
  process.exit(code)
}
