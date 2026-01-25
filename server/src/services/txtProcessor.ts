import fs from 'fs'
import iconv from 'iconv-lite'

export async function extractTxtContent(filePath: string): Promise<string> {
  try {
    // Read file as buffer
    const buffer = fs.readFileSync(filePath)

    const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    const hasUtf16LeBom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    const hasUtf16BeBom = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff

    const nulCount = buffer.reduce((count, byte) => count + (byte === 0x00 ? 1 : 0), 0)
    const nulRatio = buffer.length ? nulCount / buffer.length : 0

    let content = ''

    if (hasUtf16LeBom || hasUtf16BeBom || nulRatio > 0.1) {
      // Windows Notepad often saves as UTF-16; UTF-8 decoding would look like gibberish without \uFFFD.
      try {
        content = iconv.decode(buffer, hasUtf16BeBom ? 'utf16-be' : 'utf16-le')
      } catch {
        content = buffer.toString('utf16le')
      }
    } else {
      // Try UTF-8 first
      content = buffer.toString('utf-8')
      if (hasUtf8Bom) content = content.replace(/^\uFEFF/, '')
    }

    // Check for invalid UTF-8 characters
    if (content.includes('\uFFFD')) {
      // Try GBK/GB2312 (common in Chinese files)
      try {
        content = iconv.decode(buffer, 'gbk')
      } catch {
        // If iconv-lite fails, use UTF-8 anyway
        content = buffer.toString('utf-8')
      }
    }

    return content.trim()
  } catch (error) {
    console.error('[TXT] Reading failed:', error)
    throw new Error('无法读取文本文件')
  }
}
