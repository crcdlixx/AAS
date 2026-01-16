import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

export interface SolveResult {
  question: string
  answer: string
}

export type StreamUpdate =
  | { type: 'start' }
  | { type: 'delta'; value: string }
  | { type: 'complete'; value: string; result: SolveResult }
  | { type: 'error'; message: string }

const PROMPT =
  '请识别图片中的题目（可能包含多张图片/多个裁剪区域，属于同一道题的不同部分），并合并理解后给出详细的解答步骤。请用中文回答。格式如下：\n\n题目：[识别出的题目内容]\n\n解答：[详细的解答步骤]'

const toText = (content: any): string => {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'object' && typeof content.text === 'string') return content.text
  if (Array.isArray(content)) {
    return content.map((item) => toText(item)).join('')
  }
  return ''
}

const buildSolveResult = (content: string): SolveResult => {
  const questionMatch = content.match(/题目[：:]\s*(.+?)(?=\n\n解答|$)/s)
  const answerMatch = content.match(/解答[：:]\s*(.+)/s)

  return {
    question: questionMatch ? questionMatch[1].trim() : '未识别到题目',
    answer: answerMatch ? answerMatch[1].trim() : content
  }
}

const getOptionalMaxTokens = (): number | undefined => {
  const raw = process.env.OPENAI_MAX_TOKENS
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const createModel = (streaming = false) => {
  const maxTokens = getOptionalMaxTokens()
  return new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0.7,
    ...(maxTokens ? { maxTokens } : {}),
    streaming,
    openAIApiKey: process.env.OPENAI_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    }
  })
}

type EncodedImage = { base64Image: string; mimeType: string }

const buildMessages = (images: EncodedImage[], extraPrompt?: string) => {
  const content: any[] = []
  content.push({
    type: 'text',
    text: extraPrompt ? `${PROMPT}\n\n补充说明：\n${extraPrompt}` : PROMPT
  })

  for (const image of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.base64Image}` }
    })
  }

  return [new HumanMessage({ content })]
}

const encodeImage = (imagePath: string): EncodedImage => {
  const imageBuffer = fs.readFileSync(imagePath)
  return { base64Image: imageBuffer.toString('base64'), mimeType: getMimeType(imagePath) }
}

const encodeImages = (imagePaths: string[]): EncodedImage[] => imagePaths.map(encodeImage)

const getDeltaFromStreamChunk = (chunk: any): string => {
  if (!chunk) return ''
  if (typeof chunk === 'string') return chunk
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.content === 'string') return chunk.content
  if (typeof chunk.message?.content === 'string') return chunk.message.content
  if (chunk.message?.content) return toText(chunk.message.content)
  return ''
}

const getEndOutputText = (output: any): { text: string; finishReason?: string } => {
  const generation = output?.generations?.[0]
  const text = toText(generation?.message?.content) || (typeof generation?.text === 'string' ? generation.text : '')
  const finishReason =
    generation?.generationInfo?.finish_reason ??
    generation?.generationInfo?.finishReason ??
    output?.llmOutput?.finish_reason ??
    output?.llmOutput?.finishReason
  return { text, finishReason }
}

export async function solveQuestionStream(
  imagePath: string,
  onUpdate?: (update: StreamUpdate) => void
): Promise<SolveResult> {
  return solveQuestionStreamFromImages([imagePath], undefined, onUpdate)
}

export async function solveQuestionStreamFromImages(
  imagePaths: string[],
  extraPrompt?: string,
  onUpdate?: (update: StreamUpdate) => void
): Promise<SolveResult> {
  try {
    const images = encodeImages(imagePaths)
    const model = createModel(true)
    const stream = await model.streamEvents(buildMessages(images, extraPrompt), { version: 'v1' })

    onUpdate?.({ type: 'start' })
    let content = ''
    let finishReason: string | undefined
    let endEventText = ''
    let deltaCount = 0

    for await (const event of stream) {
      if (event.event === 'on_chat_model_stream') {
        const delta = getDeltaFromStreamChunk(event.data?.chunk)
        if (delta) {
          content += delta
          onUpdate?.({ type: 'delta', value: delta })
          deltaCount += 1
        }
      }

      if (event.event === 'on_chat_model_end') {
        const { text, finishReason: reason } = getEndOutputText(event.data?.output)
        if (text && text.length > endEventText.length) {
          endEventText = text
        }
        if (reason) finishReason = reason
      }
    }

    if (endEventText && endEventText.length > content.length) {
      content = endEventText
    }

    const parsed = buildSolveResult(content)
    const looksIncomplete =
      !content.trim() ||
      !/解答[：:]/.test(content) ||
      finishReason === 'length' ||
      !parsed.answer?.trim()

    if (looksIncomplete) {
      console.warn('流式输出为空或被截断，触发回退调用', {
        finishReason,
        deltaCount,
        contentLength: content.length
      })
      const fallback = await solveQuestionFromImages(imagePaths, extraPrompt)
      const fallbackText = `题目：${fallback.question}\n\n解答：${fallback.answer}`
      onUpdate?.({ type: 'complete', value: fallbackText, result: fallback })
      return fallback
    }

    console.info('流式输出完成', {
      finishReason: finishReason || 'unknown',
      deltaCount,
      contentLength: content.length
    })
    const result = parsed
    onUpdate?.({ type: 'complete', value: content, result })
    return result
  } catch (error) {
    console.error('OpenAI API调用失败:', error)
    onUpdate?.({
      type: 'error',
      message: error instanceof Error ? error.message : 'AI解答失败，请检查API配置'
    })
    throw new Error('AI解答失败，请检查API配置')
  }
}

export async function solveQuestion(imagePath: string): Promise<SolveResult> {
  return solveQuestionFromImages([imagePath])
}

export async function solveQuestionFromImages(imagePaths: string[], extraPrompt?: string): Promise<SolveResult> {
  try {
    const images = encodeImages(imagePaths)
    const model = createModel()
    const response = await model.invoke(buildMessages(images, extraPrompt))
    const content = toText(response.content) || '无法识别题目'

    return buildSolveResult(content)
  } catch (error) {
    console.error('OpenAI API调用失败:', error)
    throw new Error('AI解答失败，请检查API配置')
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }
  return mimeTypes[ext] || 'image/jpeg'
}
