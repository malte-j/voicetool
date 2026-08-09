import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules/onnxruntime-web/dist')
const out = join(root, 'public')

const files = [
  'ort.wasm.min.js',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
]

mkdirSync(out, { recursive: true })

for (const file of files) {
  const from = join(dist, file)
  if (!existsSync(from)) {
    console.warn(`[copy-ort-assets] missing ${file}`)
    continue
  }
  copyFileSync(from, join(out, file))
  console.log(`[copy-ort-assets] ${file}`)
}
