import fs from 'node:fs'
import path from 'node:path'
for (const line of fs.readFileSync(new URL('./.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^export\s+(\w+)="?([^"]*)"?\s*$/)
  if (!m) continue
  let v = m[2].trim()
  if (v.startsWith('$(pwd)/')) v = path.resolve(v.slice(7))
  process.env[m[1]] = v
}
const { processFile } = await import('./direct.js')
const OUT = path.resolve('out-run')
const cfg = { outRoot: OUT }
const src = process.argv[2]
const id = process.argv[3] || null
const t = Date.now()
const r = processFile(src, cfg, id, (m) => console.log('  ', m))
console.log(`\n用时 ${((Date.now() - t) / 1000).toFixed(1)}s`)
console.log(`身份: ${r.id}`)
console.log(`段落: ${r.manifest.segments.length}  时长: ${r.manifest.duration_ms}ms`)
console.log(`屏数: ${r.manifest.where.sheets?.length ?? 0}`)
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'last-manifest.json'), JSON.stringify(r.manifest, null, 2))
console.log(`\n字幕正文已写到 last-manifest.json`)
