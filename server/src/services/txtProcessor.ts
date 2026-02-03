import fs from 'fs'
import iconv from 'iconv-lite'

export async function extractTxtContent(filePath: string): Promise<string> {
  try {
    const buffer = fs.readFileSync(filePath)

    const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    const hasUtf16LeBom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    const hasUtf16BeBom = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff

    const nulCount = buffer.reduce((count, byte) => count + (byte === 0x00 ? 1 : 0), 0)
    const nulRatio = buffer.length ? nulCount / buffer.length : 0

    if (hasUtf16LeBom || hasUtf16BeBom || nulRatio > 0.1) {
      try {
        const decoded = iconv.decode(buffer, hasUtf16BeBom ? 'utf16-be' : 'utf16-le')
        return decoded.trim()
      } catch {
        return buffer.toString('utf16le').trim()
      }
    }

    const stripUtf8Bom = (text: string) => (hasUtf8Bom ? text.replace(/^\uFEFF/, '') : text)

    const countReplacement = (text: string) => (text.match(/\uFFFD/g) || []).length
    const countControl = (text: string) => {
      let count = 0
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) count += 1
      }
      return count
    }
    const countCjk = (text: string) => {
      let count = 0
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) count += 1
      }
      return count
    }

    const utf8 = stripUtf8Bom(buffer.toString('utf-8'))
    const gb18030 = iconv.decode(buffer, 'gb18030')

    const utf8Repl = countReplacement(utf8)
    const gbRepl = countReplacement(gb18030)

    if (utf8Repl > 0 && gbRepl < utf8Repl) {
      return gb18030.trim()
    }

    const utf8Control = countControl(utf8)
    const gbControl = countControl(gb18030)

    const utf8Cjk = countCjk(utf8)
    const gbCjk = countCjk(gb18030)
    const utf8CjkRatio = utf8Cjk / Math.max(1, utf8.length)
    const gbCjkRatio = gbCjk / Math.max(1, gb18030.length)

    if (
      gbRepl === 0 &&
      gbControl <= utf8Control &&
      gbCjk >= utf8Cjk + 10 &&
      gbCjkRatio >= 0.08 &&
      utf8CjkRatio <= 0.02
    ) {
      return gb18030.trim()
    }

    return utf8.trim()
  } catch (error) {
    console.error('[TXT] Reading failed:', error)
    throw new Error('鏃犳硶璇诲彇鏂囨湰鏂囦欢')
  }
}
