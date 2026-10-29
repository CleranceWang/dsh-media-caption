// 验证插件注册与三个工具的参数/render（不真跑转写）。
//   node --experimental-strip-types dev/verify-sweep.mjs   ← 不需要
//   node dev/verify-sweep.mjs
//
// 做的事：造一个假 ctx（tools.register / effect / logger），调 apply(ctx)，
// 然后打印注册结果，并用假数据试 media_eye_sweep 的两种 render。

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href

// 别让验证脚本去碰真实 NAS：把所有 MEDIA_EYE_* 指到临时目录
const tmp = path.join(here, '..', '.verify-tmp')
process.env.MEDIA_EYE_INPUT_ROOT ||= tmp
process.env.MEDIA_EYE_OUT_ROOT ||= path.join(tmp, 'out')
process.env.MEDIA_EYE_DB ||= path.join(tmp, 'queue.db')

const mod = await import(entry)

const tools = []
const effects = []
const ctx = {
  tools: { register: (def) => { tools.push(def); return () => {} } },
  effect: (fn, label) => { effects.push(label); return () => {} },
  logger: () => {},
}

mod.apply(ctx)

console.log('═══ 插件注册结果 ═══')
console.log('name     =', mod.name)
console.log('inject   =', JSON.stringify(mod.inject))
console.log('工具数   =', tools.length)
for (const t of tools) {
  const props = Object.keys(t.parameters?.properties ?? {})
  console.log(`  · ${t.name}`)
  console.log(`      参数: ${props.join(', ') || '(无)'}   必填: ${JSON.stringify(t.parameters?.required ?? [])}`)
  console.log(`      render: ${typeof t.output?.render === 'function' ? '✓' : '✗'}`)
}
console.log('effect 数 =', effects.length, effects.length ? `(${effects.join(', ')})` : '')

// ── 试 render ─────────────────────────────────────────────────────
const sw = tools.find((t) => t.name === 'media_eye_sweep')
if (!sw) { console.error('\n✗ 没找到 media_eye_sweep'); process.exit(1) }

const dryFake = {
  inputRoot: '\\\\nas\\dsh-cache\\media2doc\\input',
  outRoot: '\\\\nas\\dsh-cache\\media2doc\\output',
  pending: [{ noteId: 'aaa11111' }, { noteId: 'bbb22222' }],
  skippedDone: 235,
  skippedNoMedia: 0,
  ran: false, running: false, started: false,
}
console.log('\n═══ media_eye_sweep  dry-run ═══')
for (const b of sw.output.render({}, dryFake)) console.log(b.text)

const runFake = { ...dryFake, ran: true, started: true }
console.log('\n═══ media_eye_sweep  run:true ═══')
for (const b of sw.output.render({ run: true }, runFake)) console.log(b.text)

// ── 试 media_eye_process 的 render（有声 / 无人声两种）──────────────
const pr = tools.find((t) => t.name === 'media_eye_process')
const manifestVoice = {
  note_id: '96ff5a3f', duration_ms: 195280, speech: 'present', language: 'zh',
  segments: [{ start: 0, end: 3200, text: '第一句。' }, { start: 3200, end: 6800, text: '第二句。' }],
  where: {
    subtitle: '\\\\nas\\out\\X\\字幕.json',
    sheets: ['\\\\nas\\out\\X\\previews\\sheet.jpg'],
    audio: '\\\\nas\\out\\X\\audio\\audio.wav',
    sheet: '\\\\nas\\out\\X\\previews\\sheet.jpg',
  },
  from_cache: false,
}
console.log('\n═══ media_eye_process  有字幕 ═══')
for (const b of pr.output.render({}, manifestVoice)) console.log(b.text)

const manifestMute = { ...manifestVoice, speech: 'none', language: null, segments: [] }
console.log('\n═══ media_eye_process  无人声 ═══')
for (const b of pr.output.render({}, manifestMute)) console.log(b.text)

console.log('\n✓ 验证完成')
