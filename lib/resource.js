// ============================================================================
// dsh-media-caption —— 资源门禁
//
// 为什么要有这个文件（用户 m00992「GPU 还有内存都空的时候就启动」）：
//   老系统 m2d-l 的 ASR 容器常驻占 3-4 GB 显存，用户玩游戏时整机卡顿。
//   新插件是进程级的：有活才起 whisper，跑完即退、显存立刻释放。
//   但如果*启动那一刻*游戏正占着显存，两者就会抢 —— 所以干之前先看一眼。
//
// ★ 判据从实测来，不是拍脑袋。实测源（本机：RTX 4060 Laptop，8 GB 显存，Win11）：
//   硬件是最大的变量，所以留着 —— 换一张卡，下面的门槛就该重测。
//
//   [A] 本地满载 3D 游戏
//       GPU 利用率 0%↔100% 剧烈跳动         ← 所以利用率不能当判据
//       显存 297 MiB → 4363 MiB（稳定增长） ← 这个才是判据
//       系统空闲内存 9.6 GB → 3.6 GB
//
//   [B] 开一堆网页（十余标签）
//       显存纹丝不动 297 MiB；系统内存 10 GB → 6.9 GB（吃 3 GB）
//       ← 浏览器不碰显存，但吃内存
//
//   [C] 云游戏 / 云游戏 + 后台视频
//       显存 297 MiB、GPU 0%、内存稳定 7.3-7.5 GB
//       ← 云游戏的画是远程服务器算的，本机只是解码，不占 GPU
//
//   [D] whisper large-v3 真实峰值：31 分钟中文口播视频（1854s 音频，764 段）
//       显存：基线 297 → 加载后 380 → 峰值 3286 MiB（净增 2.92 GB），波动带 2518-3286
//       GPU 利用率 均值 92% / 中位 95% / 峰值 100%
//       转写耗时 397s（4.67× 实时）
//       系统内存额外占用约 1.5 GB
//       进程退出后显存立刻回 297 MiB —— 没有残留
//
//   短音频对照（108s，实测峰值仅 2518 MiB）说明：
//     ★ 峰值取决于*音频长度*，不是视频分辨率。取最长的那个当上限，即 3.3 GB。
//
// 结论：
//   显存 需要 3.3 GB（实测峰值 3286 MiB）→ 门槛定 4096 MiB，留 750 MiB 给波动和系统
//   内存 需要 1.5 GB（实测）              → 门槛定 4096 MB，留 2.5 GB 给你自己的浏览器
//   游戏占 4363 MiB 时剩 3825 MiB < 4096 → 自动让路（这正是用户要的"宁可等，不要卡"）
// ============================================================================
import { execFileSync } from 'node:child_process'
import os from 'node:os'

export const DEFAULTS = {
  // 显存门槛（MiB）。whisper large-v3 实测峰值 3286 MiB；按用户 m01024「双倍冗余」的本意
  // 是"宁可多等"，但不该按 2× 算（那样游戏开着就永远轮不上），实测给了底气：
  // 4096 已覆盖峰值 + 750 MiB 波动余量。
  minFreeVramMiB: 4096,
  // 内存门槛（MiB）。whisper 实测吃 1.5 GB，浏览器能吃掉 3 GB+，所以这里要的是
  // "跑完还有 2.5 GB 富余"，不是"刚够 whisper 用"。
  minFreeRamMiB: 4096,
  // 连续几次采样都通过才算"空闲"。GPU 利用率会瞬跳到 0%（游戏加载间隙），
  // 单次采样不可信 —— 实测 [A] 里就有 0% 和 100% 相邻出现。
  stableSamples: 3,
  // 采样间隔（毫秒）。3 次 × 2000ms = 6 秒窗口。
  sampleIntervalMs: 2000,
}

/** 读一次显存和内存。拿不到显存时返回 {vram:null} —— 没有 nvidia-smi 也照常跑。 */
export function sample() {
  const ramFreeMiB = Math.round(os.freemem() / 1048576)
  let vram = null
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().split('\n')[0]
    const [total, used, util] = out.split(',').map((s) => Number(s.trim()))
    if (Number.isFinite(total) && Number.isFinite(used)) {
      vram = { totalMiB: total, usedMiB: used, freeMiB: total - used, utilPercent: util }
    }
  } catch { /* 没有 nvidia-smi（非 NVIDIA / 容器内 / PATH 不通）就当没有显存这回事 */ }
  return { ramFreeMiB, vram }
}

/** 单次判定：够不够。返回 {ok, reason, detail}。 */
export function checkOnce(cfg = {}) {
  const o = { ...DEFAULTS, ...cfg }
  const s = sample()
  const detail = {
    ramFreeMiB: s.ramFreeMiB,
    vramFreeMiB: s.vram?.freeMiB ?? null,
    vramUsedMiB: s.vram?.usedMiB ?? null,
    vramTotalMiB: s.vram?.totalMiB ?? null,
    utilPercent: s.vram?.utilPercent ?? null,
  }
  if (s.ramFreeMiB < o.minFreeRamMiB) {
    return { ok: false, reason: `内存不足 ${s.ramFreeMiB}/${o.minFreeRamMiB} MiB`, detail }
  }
  if (s.vram && s.vram.freeMiB < o.minFreeVramMiB) {
    return { ok: false, reason: `显存不足 ${s.vram.freeMiB}/${o.minFreeVramMiB} MiB`, detail }
  }
  return { ok: true, reason: 'ok', detail }
}

/**
 * 连续 stableSamples 次都通过才放行；中间任一次不通过就重新数。
 * 返回最后一次的判定（ok=false 时 reason 已经写明卡在哪）。
 */
export async function waitForResources(cfg = {}, log = () => {}) {
  const o = { ...DEFAULTS, ...cfg }
  let good = 0
  let last = null
  while (good < o.stableSamples) {
    last = checkOnce(o)
    if (last.ok) {
      good += 1
      if (good >= o.stableSamples) return last
    } else {
      if (good > 0) log(`资源刚够又不满足了：${last.reason}，重新计数`)
      else log(`[等待] ${last.reason}`)
      good = 0
    }
    await new Promise((r) => setTimeout(r, o.sampleIntervalMs))
  }
  return last
}
