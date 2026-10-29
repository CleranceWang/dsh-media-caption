// ============================================================================
// 队列：SQLite 子弹夹
//
// 用户定案：
//   m00100  取队首 → 处理 → 退出，重新开始循环
//   m00103  不记 done —— 随时会被打断，状态靠产物（音轨/ASR/成品）
//   m00107  DB 也不存待办 —— 扫一轮队列要不了多少时间
//   m00174  取出来时标「处理中」，防两个 worker 拿同一单
//
// 所以 DB 只装三样东西：
//   ① 还没被处理的条目（pending）
//   ② 正在被处理的那一条（claimed，带 claimed_at）
//   ③ 失败次数（tries）
// 做完 → 删掉那行。判断"做完没有"永远不靠它。
// ============================================================================

// schema 版本：判断 DB 是否需要重建
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     TEXT    NOT NULL,           -- 身份：目录名末尾那串（用户 m00116）
  note_dir    TEXT    NOT NULL,           -- 笔记目录绝对路径
  queue_no    INTEGER NOT NULL DEFAULT 1, -- 队列号 = 优先级（用户 m00103 之前：没有优先级，只有队列号）
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | claimed
  claimed_at  INTEGER,                    -- 取出时间（ms），超时后可放回
  tries       INTEGER NOT NULL DEFAULT 0, -- 失败重试计数（用户：要 tries）
  created_at  INTEGER NOT NULL,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_pick ON queue(status, queue_no, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_note ON queue(note_id);
`

/**
 * 压入一条到队首（子弹夹：最新插的最先跑，用户 m00099）。
 *
 * SQLite 的 AUTOINCREMENT id 天然递增 —— 所以"队首"= id 最大的 pending 行，
 * 取队首用 ORDER BY id DESC。"沉底"= 越小越靠后，用 ORDER BY id ASC 是沉底语义。
 *
 * 注意：插入时若同 note_id 已存在（pending 或 claimed），按用户 m00117「同一个
 * 笔记 id 就会跳过」—— 不报错，直接返回 existed。
 */
export function enqueue(db, { noteId, noteDir, queueNo = 1 }) {
  const now = Date.now()
  const exist = db.prepare('SELECT id, status FROM queue WHERE note_id = ?').get(noteId)
  if (exist) return { inserted: false, existed: true, id: exist.id, status: exist.status }

  const info = db.prepare(
    'INSERT INTO queue (note_id, note_dir, queue_no, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(noteId, noteDir, queueNo, 'pending', now)
  return { inserted: true, id: info.lastInsertRowid }
}

/**
 * 取队首：pending 里 id 最大的那条（子弹夹顶端）。
 * 取出来立刻标 claimed，防止另一个 worker 同时拿到同一条。
 */
export function claimNext(db, { queueNo, claimTimeoutMs = 30 * 60 * 1000 } = {}) {
  const now = Date.now()

  // 先回收「处理中超时」的：进程被杀时留下的标记，不放回就永远卡住
  db.prepare(
    `UPDATE queue SET status='pending', claimed_at=NULL
     WHERE status='claimed' AND claimed_at < ?`
  ).run(now - claimTimeoutMs)

  const q = queueNo ? 'AND queue_no = ?' : ''
  const args = queueNo ? [queueNo] : []
  const row = db.prepare(
    `SELECT id, note_id, note_dir, queue_no, tries FROM queue
     WHERE status='pending' ${q}
     ORDER BY id DESC LIMIT 1`
  ).get(...args)
  if (!row) return null

  const r = db.prepare(
    `UPDATE queue SET status='claimed', claimed_at=? WHERE id=? AND status='pending'`
  ).run(now, row.id)
  if (r.changes !== 1) return null   // 被抢了

  return row
}

/** 成功：从 DB 删掉。真相在磁盘（用户 m00103）。 */
export function finish(db, id) {
  db.prepare('DELETE FROM queue WHERE id = ?').run(id)
}

/**
 * 失败：tries+1；未超上限就放回 pending（下次还是队首，因为 id 没变），
 * 超了就从 DB 删掉并把它记进失败台账（失败也不靠 DB 记，靠一个文本日志）。
 */
export function fail(db, id, err, { maxTries = 3 } = {}) {
  const row = db.prepare('SELECT tries FROM queue WHERE id = ?').get(id)
  if (!row) return { dropped: false, tries: 0 }
  const tries = row.tries + 1
  if (tries >= maxTries) {
    db.prepare('DELETE FROM queue WHERE id = ?').run(id)
    return { dropped: true, tries, error: err }
  }
  db.prepare(
    `UPDATE queue SET status='pending', claimed_at=NULL, tries=?, last_error=? WHERE id=?`
  ).run(tries, String(err).slice(0, 2000), id)
  return { dropped: false, tries, error: err }
}

/** 队列里还有什么（供哨兵跳过已排队的 note id，避免重复投） */
export function listQueuedNoteIds(db) {
  return new Set(db.prepare('SELECT note_id FROM queue').all().map((r) => r.note_id))
}

/** 统计 */
export function stats(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM queue GROUP BY status').all()
  const out = { pending: 0, claimed: 0, total: 0 }
  for (const r of rows) { out[r.status] = r.n; out.total += r.n }
  return out
}
