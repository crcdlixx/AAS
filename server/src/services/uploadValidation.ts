import fs from 'fs'

type MagicResult =
  | { ok: true }
  | {
      ok: false
      reason: string
      code: 'UPLOAD_INVALID_MAGIC' | 'UPLOAD_READ_FAILED'
    }

const readHead = (filePath: string, length: number): Buffer => {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const bytesRead = fs.readSync(fd, buf, 0, length, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    fs.closeSync(fd)
  }
}

const startsWith = (buf: Buffer, bytes: number[]) => {
  if (buf.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false
  }
  return true
}

const isJpeg = (buf: Buffer) => startsWith(buf, [0xff, 0xd8, 0xff])
const isPng = (buf: Buffer) => startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const isGif = (buf: Buffer) => startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const isWebp = (buf: Buffer) =>
  buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP'
const isPdf = (buf: Buffer) => buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-'

const looksBinary = (buf: Buffer) => {
  const n = Math.min(buf.length, 2048)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export const validateImageFileMagic = (filePath: string): MagicResult => {
  try {
    const head = readHead(filePath, 32)
    if (isJpeg(head) || isPng(head) || isGif(head) || isWebp(head)) return { ok: true }
    return { ok: false, code: 'UPLOAD_INVALID_MAGIC', reason: '文件内容不是有效的图片（JPG/PNG/GIF/WebP）' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'UPLOAD_READ_FAILED', reason: `读取上传文件失败：${message}` }
  }
}

export const validatePdfFileMagic = (filePath: string): MagicResult => {
  try {
    const head = readHead(filePath, 16)
    if (isPdf(head)) return { ok: true }
    return { ok: false, code: 'UPLOAD_INVALID_MAGIC', reason: '文件内容不是有效的 PDF' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'UPLOAD_READ_FAILED', reason: `读取上传文件失败：${message}` }
  }
}

export const validateTextFileLooksText = (filePath: string): MagicResult => {
  try {
    const head = readHead(filePath, 2048)
    if (!head.length) return { ok: true }
    if (looksBinary(head)) {
      return { ok: false, code: 'UPLOAD_INVALID_MAGIC', reason: 'TXT 文件疑似包含二进制内容（包含 NUL 字节）' }
    }
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'UPLOAD_READ_FAILED', reason: `读取上传文件失败：${message}` }
  }
}

