// ============================================================================
// dsh-media-eye —— 宿主侧入口
//
// 用户定案：
//   m00270         只做眼睛：转写 + 抽帧，不调 AI、不出 md
//   m00305         eye 告诉 AI 去哪取东西（返回取货单）
//   m00308         点名面做成 DSH 工具
//   m00309         一体两面、盘上齐了直接返回、DB 放本地
//   m01172/m01181  调度改由 DSH 唤醒：启动时扫一轮，扫完就睡，不再常驻定时器
//   m01189         哨兵 = 扫盘 + 写队列；传话筒作为独立角色消失
//   m01196         手动唤醒走 media_eye_sweep 工具
//
// 结构：
//   三个工具   media_eye_process（点名一条笔记）
//              media_eye_file   （任意文件直给）
//              media_eye_sweep  （手动唤醒后台批处理）
//   DSH 启动   autoSweep:true → spawn lib/sweep.js（独立进程，DSH 不等它）
//              sweep 进程：扫一轮 → 入队 → 逐个处理 → 退出
//
// 没有 setInterval。想再来一轮：重启 DSH，或调 media_eye_sweep。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SCHEMA, listQueuedNoteIds, stats } from './queue.js'
import { scan } from './sentinel.js'
import { processNote, checkDeps } from './process.js'
import { processOne } from './oncall.js'
import { processFile } from './direct.js'
import { sample } from './resource.js'
import { loadCfg, CFG_FILE } from './cfg.js'

export const name = 'media-eye'
export const inject = ['tools']

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))   // 包根
const SWEEP_JS = path.join(ROOT, 'lib', 'sweep.js')

export function apply(ctx) {
  const cfg = loadCfg()
  const log = (...a) => console.log('[media-eye]', ...a)
  const state = { db: null, sweepProc: null, stopped: false, deps: [] }

  // ── 依赖体检：缺工具时说清楚缺哪个，而不是跑一半报看不懂的错
  state.deps = checkDeps(cfg)
  if (state.deps.length) for (const p of state.deps) log('依赖缺失：', p)

  // ══════════════════════════════════════════════════════════════════
  // 工具 1：点名面（m00308）
  // ══════════════════════════════════════════════════════════════════
  ctx.tools.register({
    name: 'media_eye_process',
    description: '让 media-eye 处理一条笔记（转写 + 抽帧），返回一张取货单：'
      + '字幕正文（segments，毫秒整数）+ 所有产物在磁盘上的绝对路径（where）。'
      + '盘上产物已经齐了就秒回，不重算。',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '笔记目录名（如 2026-01-01_标题_96ff5a3f）或它的绝对路径。',
        },
      },
      required: ['note'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          note_id: { type: 'string' },
          duration_ms: { type: 'number' },
          speech: { type: 'string', description: 'present | none' },
          language: { type: ['string', 'null'] },
          segments: { type: 'array' },
          where: { type: 'object' },
          from_cache: { type: 'boolean' },
        },
        required: ['note_id', 'segments', 'where'],
        additionalProperties: true,
      },
      render: (args, v) => {
        const lines = []
        lines.push(`笔记 ${v.note_id}  时长 ${(v.duration_ms / 1000).toFixed(1)}s`)
        if (v.speech === 'none') {
          lines.push('⚠ 未检出人声，内容在图里 —— 请直接看 sheet')
        } else {
          lines.push(`语种 ${v.language ?? '未知'}  字幕 ${v.segments.length} 段${v.from_cache ? '（来自缓存）' : ''}`)
        }
        lines.push('')
        lines.push(`字幕  ${v.where.subtitle}`)
        for (const s of v.where.sheets ?? [v.where.sheet]) lines.push(`九宫格 ${s}`)
        if (v.where.audio) lines.push(`音轨  ${v.where.audio}`)
        if (v.speech === 'none') {
          lines.push('')
          lines.push('（无字幕正文，请读上面九宫格里的画面）')
        } else {
          lines.push('')
          lines.push(`正文（${(v.duration_ms / 1000).toFixed(0)}s，${v.segments.length} 段，已写成纯文本）：`)
          lines.push(v.segments.map((s) => s.text).join(''))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const note = String(args?.note ?? '').trim()
      if (!note) throw new Error('需要 note 参数（笔记目录名或绝对路径）')
      const c = loadCfg()
      return await processOne(note, c, (...a) => log('  ', ...a))
    },
  })

  // ══════════════════════════════════════════════════════════════════
  // 工具 2：任意文件直给（m00371/m00376）
  // ══════════════════════════════════════════════════════════════════
  ctx.tools.register({
    name: 'media_eye_file',
    description: '给 media-eye 一个本地媒体文件（任意路径的 mp4/mp3/wav/m4a…），'
      + '直接转写 + 抽帧，不要求它在任何笔记目录里。'
      + '给 id 就用这个 id 作产物目录名；不给就按文件内容指纹命名（h_xxxx）。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本地媒体文件的绝对路径。' },
        id: { type: 'string', description: '可选的产物目录名（省略则用内容指纹）。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          note_id: { type: 'string' },
          duration_ms: { type: 'number' },
          speech: { type: 'string' },
          language: { type: ['string', 'null'] },
          segments: { type: 'array' },
          where: { type: 'object' },
        },
        required: ['note_id', 'segments', 'where'],
        additionalProperties: true,
      },
      render: (args, v) => {
        const lines = [`文件 ${v.note_id}  时长 ${(v.duration_ms / 1000).toFixed(1)}s`]
        if (v.speech === 'none') lines.push('⚠ 未检出人声，内容在图里 —— 请直接看 sheet')
        else lines.push(`语种 ${v.language ?? '未知'}  字幕 ${v.segments.length} 段`)
        lines.push('')
        lines.push(`字幕  ${v.where.subtitle}`)
        for (const s of v.where.sheets ?? [v.where.sheet]) lines.push(`九宫格 ${s}`)
        if (v.where.audio) lines.push(`音轨  ${v.where.audio}`)
        if (v.speech !== 'none') {
          lines.push('')
          lines.push('正文：')
          lines.push(v.segments.map((s) => s.text).join(''))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const file = String(args?.file ?? '').trim()
      if (!file) throw new Error('需要 file 参数（媒体文件绝对路径）')
      const c = loadCfg()
      if (!c.outRoot) throw new Error(`media-eye 未配置输出根（看 ${CFG_FILE} 或环境变量 MEDIA_EYE_OUT_ROOT）`)
      // processFile 返回 { id, outDir, status, manifest }，取货单在 manifest 里
      const r = processFile(file, c, args?.id ? String(args.id) : null, (...a) => log('  ', ...a))
      return r.manifest
    },
  })

  // ══════════════════════════════════════════════════════════════════
  // 工具 3：手动唤醒后台批处理（m01196）
  // ══════════════════════════════════════════════════════════════════
  ctx.tools.register({
    name: 'media_eye_sweep',
    description: '手动唤醒后台批处理。默认只报告（扫一遍输入根，列出待做清单，不动手）；'
      + 'run:true 会另起一个独立进程去扫盘并处理，立刻返回不阻塞。'
      + '平时用不到 —— DSH 启动时若 autoSweep 开着会自动扫一轮；'
      + '只有在 DSH 一直开着、中途又往输入根塞了新视频、且等不及下次重启时才需要手动催。',
    parameters: {
      type: 'object',
      properties: {
        run: { type: 'boolean', description: '省略/false = 只报告；true = 真起进程去处理。' },
        limit: { type: 'number', description: 'run:true 时最多处理几单。省略 = 不限。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          inputRoot: { type: 'string' },
          outRoot: { type: 'string' },
          pending: { type: 'array' },
          skippedDone: { type: 'number' },
          skippedNoMedia: { type: 'number' },
          ran: { type: 'boolean' },
          running: { type: 'boolean' },
          started: { type: 'boolean' },
        },
        required: ['inputRoot', 'outRoot', 'pending'],
        additionalProperties: true,
      },
      render: (args, v) => {
        const lines = [`输入根 ${v.inputRoot}`, `输出根 ${v.outRoot}`]
        if (v.running) lines.push('后台批处理：正在跑（不重复催）')
        if (v.started) lines.push('已另起一个后台进程，扫完就退；进度看插件日志。')
        lines.push(`待处理 ${v.pending.length} 条（已完成跳过 ${v.skippedDone} / 无媒体跳过 ${v.skippedNoMedia}）`)
        if (v.pending.length) {
          for (const p of v.pending.slice(0, 30)) lines.push(`  · ${p.noteId}`)
          if (v.pending.length > 30) lines.push(`  …还有 ${v.pending.length - 30} 条`)
        }
        if (!v.ran && v.pending.length) {
          lines.push('')
          lines.push('（只报告，没动。要真处理请传 run: true）')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const c = loadCfg()
      if (!c.inputRoot) throw new Error(`media-eye 未配置输入根（看 ${CFG_FILE} 或环境变量 MEDIA_EYE_INPUT_ROOT）`)
      if (!c.outRoot) throw new Error(`media-eye 未配置输出根（看 ${CFG_FILE} 或环境变量 MEDIA_EYE_OUT_ROOT）`)

      const doRun = args?.run === true
      const limit = Number.isFinite(args?.limit) ? Number(args.limit) : 0

      // 先扫一遍，无论跑不跑都给一份清单
      const r = scan(c.inputRoot, c.outRoot, listQueuedNoteIds(state.db))
      const out = {
        inputRoot: c.inputRoot,
        outRoot: c.outRoot,
        pending: r.found.map((x) => ({ noteId: x.noteId })),
        skippedDone: r.skippedDone,
        skippedNoMedia: r.skippedNoMedia,
        ran: doRun,
        running: !!state.sweepProc,
        started: false,
      }
      if (!doRun) return out

      const sp = spawnSweep(state, log, limit)
      out.started = sp.started
      if (!sp.started) out.running = true
      return out
    },
  })

  // ══════════════════════════════════════════════════════════════════
  // 队列 DB（本地，用户 m00309：不往 NAS 上放）
  // ══════════════════════════════════════════════════════════════════
  if (!cfg.dbPath) {
    log('没配队列 DB（dbPath），自动扫盘不启动；三个工具仍可用')
  } else {
    try {
      fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true })
      const db = new DatabaseSync(cfg.dbPath)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 10000')
      db.exec(SCHEMA)
      state.db = db
    } catch (e) {
      log('队列打不开，自动扫盘不启动：', e.message)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 启动：要不要扫一轮
  // ══════════════════════════════════════════════════════════════════
  if (!cfg.enabled) {
    log('插件已禁用（enabled:false），工具可用，不自动扫盘')
  } else if (!cfg.autoSweep) {
    log(`自动扫盘未启用（工具可用）。要在 DSH 启动时扫一轮，在 ${CFG_FILE} 写 "autoSweep": true`)
  } else if (!state.db) {
    log('autoSweep 开着，但没有队列 DB，跳过')
  } else {
    log(`autoSweep 开：启动后扫一轮 ${cfg.inputRoot} → ${cfg.outRoot}`)
    if (cfg.gate) {
      const g = cfg.gateCfg
      const s0 = sample()
      log(`  资源门禁：显存需空闲 >${g.minFreeVramMiB} MiB / 内存需空闲 >${g.minFreeRamMiB} MiB / 连续 ${g.stableSamples} 次`)
      log(`  当前：${s0.vram ? `显存 ${s0.vram.freeMiB}/${s0.vram.totalMiB} MiB 空闲` : '无 nvidia-smi，跳过显存检查'} / 内存 ${s0.ramFreeMiB} MiB 空闲`)
    } else {
      log('  资源门禁：关')
    }
    spawnSweep(state, log, cfg.autoSweepLimit)
  }

  ctx.effect(() => () => {
    state.stopped = true
    if (state.sweepProc) {
      try {
        log(`DSH 卸载，通知后台批处理（pid ${state.sweepProc.pid}）收尾`)
        state.sweepProc.kill('SIGTERM')
      } catch {}
      state.sweepProc = null
    }
    try { state.db?.close() } catch {}
  }, 'media-eye: stop sweep process and close queue')
}

// ══════════════════════════════════════════════════════════════════════
// spawn 后台批处理
//
// 为什么独立进程（用户 m01183）：6 小时的批处理不能卡住 DSH 本身。
// 为什么没有 setInterval（m01172/m01181）：跑完就退。想再来一轮，重启 DSH 或调工具。
// ══════════════════════════════════════════════════════════════════════
function spawnSweep(state, log, limit = 0) {
  if (state.sweepProc) {
    log('后台批处理已经在跑，不重复起')
    return { started: false, reason: 'already-running', pid: state.sweepProc.pid }
  }
  const argv = [SWEEP_JS]
  if (limit > 0) argv.push('--limit', String(limit))

  let p
  try {
    p = spawn(process.execPath, argv, {
      cwd: ROOT,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
  } catch (e) {
    log('后台批处理起不来：', e.message)
    return { started: false, reason: e.message }
  }

  state.sweepProc = p
  log(`后台批处理已启动（pid ${p.pid}${limit ? `，最多 ${limit} 单` : ''}）`)

  const pipe = (stream, tag) => {
    if (!stream) return
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buf += chunk
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) log(`[${tag}] ${line}`)
    })
    stream.on('end', () => { if (buf.trim()) log(`[${tag}] ${buf}`) })
  }
  pipe(p.stdout, 'sweep')
  pipe(p.stderr, 'sweep!')

  p.on('exit', (code) => {
    log(`后台批处理结束（code ${code}）`)
    state.sweepProc = null
  })
  p.on('error', (e) => {
    log('后台批处理出错：', e.message)
    state.sweepProc = null
  })
  return { started: true, pid: p.pid }
}
