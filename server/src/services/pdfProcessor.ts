import fs from 'fs'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import dotenv from 'dotenv'

dotenv.config()

const MIN_NON_WHITESPACE_CHARS = 10

async function extractTextFromPdf(filePath: string): Promise<string> {
  try {
    const dataBuffer = fs.readFileSync(filePath)
    // pdf-parse@2.x is ESM and exposes a `PDFParse` class (not a callable default export).
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: dataBuffer })
    try {
      // Avoid adding page separator markers like `-- 1 of N --` when pages have no text.
      // Those markers can falsely inflate text length checks and look like "garbled" content.
      const data = await parser.getText({ pageJoiner: '' })
      return data.text.trim()
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch (error) {
    console.error('[PDF] Text extraction failed:', error)
    return ''
  }
}

async function extractPdfViaImages(filePath: string): Promise<string> {
  try {
    console.log('[PDF] Starting image fallback for:', filePath)

    const dataBuffer = fs.readFileSync(filePath)
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: dataBuffer })
    const screenshots = await parser.getScreenshot({
      scale: 2.0,
      imageBuffer: true,
      imageDataUrl: false
    })
    await parser.destroy().catch(() => {})

    // Use vision model to extract text from each page
    const model = new ChatOpenAI({
      modelName: process.env.ROUTER_MODEL || 'gpt-4o-mini',
      temperature: 0,
      openAIApiKey: process.env.ROUTER_API_KEY || process.env.OPENAI_API_KEY,
      configuration: {
        baseURL: process.env.ROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
      }
    })

    const pageTexts: string[] = []

    for (let i = 0; i < screenshots.pages.length; i++) {
      const page = screenshots.pages[i]
      const base64Image = Buffer.from(page.data).toString('base64')

      const response = await model.invoke([
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: '请识别图片中的所有文字内容，保持原有格式和结构。只输出识别的文字，不要添加任何解释。'
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` }
            }
          ]
        })
      ])

      const text = typeof response.content === 'string' ? response.content : ''
      pageTexts.push(text.trim())
      console.log(`[PDF] Extracted page ${i + 1}/${screenshots.pages.length}, length: ${text.length}`)
    }

    return pageTexts.join('\n\n')
  } catch (error) {
    console.error('[PDF] Image fallback failed:', error)
    throw error
  }
}

export async function extractPdfContent(
  filePath: string
): Promise<{
  content: string
  method: 'text' | 'image-fallback'
}> {
  // Stage 1: Try text extraction
  const textContent = await extractTextFromPdf(filePath)

  const nonWhitespaceChars = textContent.replace(/\s+/g, '').length
  if (nonWhitespaceChars >= MIN_NON_WHITESPACE_CHARS) {
    console.log('[PDF] Text extraction successful, length:', textContent.length)
    return { content: textContent, method: 'text' }
  }

  console.log('[PDF] Text extraction insufficient, trying image fallback')

  // Stage 2: Fallback to image conversion
  const imageContent = await extractPdfViaImages(filePath)

  return { content: imageContent, method: 'image-fallback' }
}
