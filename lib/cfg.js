// 配置加载：插件（index.js）与后台批处理（sweep.js）共用这一份。
//
// 优先级：环境变量 MEDIA_CAPTION_* > ~/.dsh/media-caption.config.json > 默认值。
// 配置文件路径：DSH_HOME/media-caption.config.json（DSH_HOME 默认 ~/.dsh）。
//
// ★ 常驻开关默认关（用户 m00892）：装上插件先只给工具，不自作主张扫盘。
//   要自动扫盘，在配置里写 "autoSweep": true。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS as RES_DEFAULTS } from './resource.js'

export const CFG_FILE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'media-caption.config.json',
)

export function readCfgFile() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch { return {} }
}

export function loadCfg() {
  const f = readCfgFile()
  const env = process.env
  return {
    inputRoot: env.MEDIA_CAPTION_INPUT_ROOT || f.inputRoot || '',
    outRoot: env.MEDIA_CAPTION_OUT_ROOT || f.outRoot || '',
    dbPath: env.MEDIA_CAPTION_DB || f.dbPath || '',
    // ASR：这两个漏读会让 process.js 退化成 PATH 里的裸命令 'faster-whisper-xxl'
    whisper: env.MEDIA_CAPTION_WHISPER || f.whisper || '',
    modelDir: env.MEDIA_CAPTION_MODEL_DIR || f.modelDir || '',
    ffmpegDir: env.MEDIA_CAPTION_FFMPEG_DIR || f.ffmpegDir || '',
    nMin: Number(env.MEDIA_CAPTION_N_MIN || f.nMin || 9),
    nMax: Number(env.MEDIA_CAPTION_N_MAX || f.nMax || 27),
    tile: Number(env.MEDIA_CAPTION_TILE || f.tile || 720),
    queueNo: Number(env.MEDIA_CAPTION_QUEUE_NO || f.queueNo || 1),
    maxTries: Number(env.MEDIA_CAPTION_MAX_TRIES || f.maxTries || 3),
    claimTimeoutMin: Number(env.MEDIA_CAPTION_CLAIM_TIMEOUT_MIN || f.claimTimeoutMin || 60),

    // ★ 调度（用户 m01172/m01181/m01187）：
    //   不再有常驻定时器。DSH 启动时唤醒一次 sweep，扫一轮、处理完、退出；
    //   之后想再来一轮，靠 media_caption_sweep 工具手动叫。
    //   旧的 sentinel/watcher 两个开关已废弃，读到只用来提示迁移。
    autoSweep: f.autoSweep === true,
    autoSweepLimit: Number(f.autoSweepLimit || 0), // 0 = 不限

    enabled: (f.enabled ?? true) !== false,

    // ★ 资源门禁（用户 m00992「GPU 还有内存都空的时候就启动」）。
    //   判据与实测出处见 lib/resource.js 顶部。默认 on，门槛按实测定。
    gate: (f.gate ?? true) !== false,
    gateCfg: { ...RES_DEFAULTS, ...(f.gateCfg || {}) },
  }
}
