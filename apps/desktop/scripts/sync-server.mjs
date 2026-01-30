import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const desktopRoot = path.resolve(__dirname, '..')
const srcDir = path.resolve(desktopRoot, '..', '..', 'server', 'dist')
const dstDir = path.resolve(desktopRoot, 'server')

if (!fs.existsSync(srcDir)) {
  throw new Error(`server build output not found: ${srcDir}`)
}

fs.rmSync(dstDir, { recursive: true, force: true })
fs.mkdirSync(dstDir, { recursive: true })
fs.cpSync(srcDir, dstDir, { recursive: true })

console.log('[desktop] synced server:', { from: srcDir, to: dstDir })

