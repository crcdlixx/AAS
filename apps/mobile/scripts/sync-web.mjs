import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const mobileRoot = path.resolve(__dirname, '..')
const srcDir = path.resolve(mobileRoot, '..', '..', 'client', 'dist')
const dstDir = path.resolve(mobileRoot, 'www')

if (!fs.existsSync(srcDir)) {
  throw new Error(`client build output not found: ${srcDir}`)
}

fs.rmSync(dstDir, { recursive: true, force: true })
fs.mkdirSync(dstDir, { recursive: true })
fs.cpSync(srcDir, dstDir, { recursive: true })

console.log('[mobile] synced web assets:', { from: srcDir, to: dstDir })

