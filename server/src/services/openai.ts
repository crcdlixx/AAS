import { ChatOpenAI } from '@langchain/openai'
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { estimateTokensFromText, extractTotalTokens } from './tokenUsage.js'
import type { ApiOverride } from './apiOverride.js'

dotenv.config()

export interface SolveResult {
  question: string
  answer: string
  tokensUsed?: number
}

export type FollowUpChatMessage = { role: 'user' | 'assistant'; content: string }

export interface FollowUpResult {
  answer: string
  tokensUsed?: number
}

export type StreamUpdate =
  | { type: 'start' }
  | { type: 'delta'; value: string }
  | { type: 'complete'; value: string; result: SolveResult }
  | { type: 'error'; message: string }

const MULTIPLE_CHOICE_HINT = `选择题注意：
- 若题目为选择题，请判断是单选/多选/不定项选择。
- 若为多选/不定项，最终答案必须给出所有正确选项（如 ACD），不要只给一个。
- 若题型不明确，请说明不确定性并给出最可能的选项组合。`

const PROMPT_BASE = `请识别图片中的题目（可能包含多张图片/多个裁剪区域，属于同一道题的不同部分），并合并理解后给出解答。

输出要求：
- 使用 Markdown。
- 数学/物理/化学等公式请用 LaTeX（行内 $...$；独立公式 $$...$$）。
- 解答里必须包含清晰的“最终答案”（可直接复制），并给出推导/步骤。

格式如下（请保留“题目/解答”标签，便于系统解析）：

题目：
[识别出的题目内容]

解答：
[详细的解答步骤，包含最终答案与必要公式]`

const PROMPT = PROMPT_BASE + '\n\n' + MULTIPLE_CHOICE_HINT

const TEXT_PROMPT_BASE = `请根据用户提供的【题目文本】直接解答。
输出要求：
- 使用 Markdown。
- 数学/物理/化学等公式请用 LaTeX（行内 $...$；独立公式 $$...$$）。
- 解答里必须包含清晰的“最终答案”（可直接复制），并给出推导/步骤。
格式如下（请保留“题目/解答”标签，便于系统解析）：

题目：[题目内容]

解答：[详细解答步骤，包含最终答案与必要公式]`

const TEXT_PROMPT = TEXT_PROMPT_BASE + '\n\n' + MULTIPLE_CHOICE_HINT

export const __TESTING__ = { PROMPT, TEXT_PROMPT, MULTIPLE_CHOICE_HINT }

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

const createModel = (streaming = false, apiOverride?: ApiOverride) => {
  const maxTokens = getOptionalMaxTokens()
  return new ChatOpenAI({
    modelName: apiOverride?.model || process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0.7,
    ...(maxTokens ? { maxTokens } : {}),
    streaming,
    openAIApiKey: apiOverride?.apiKey || process.env.OPENAI_API_KEY,
    configuration: {
      baseURL: apiOverride?.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    }
  })
}

const normalizeFollowUpHistory = (messages: unknown): FollowUpChatMessage[] => {
  if (!Array.isArray(messages)) return []
  const out: FollowUpChatMessage[] = []
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const role = (item as any).role
    const content = (item as any).content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue
    const text = content.trim()
    if (!text) continue
    out.push({ role, content: text })
  }
  return out
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

const buildTextMessages = (questionText: string, extraPrompt?: string) => {
  const q = (questionText || '').trim()
  const prompt = extraPrompt ? `${TEXT_PROMPT}\n\n补充说明：\n${extraPrompt}` : TEXT_PROMPT
  return [new HumanMessage(`${prompt}\n\n【题目文本】\n${q}`)]
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
  if (chunk.content) return toText(chunk.content)
  if (typeof chunk.message?.content === 'string') return chunk.message.content
  if (chunk.message?.content) return toText(chunk.message.content)
  if (chunk.delta?.content) return toText(chunk.delta.content)
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

export type ConsumedLangChainStream = {
  content: string
  finishReason?: string
  tokensUsed?: number
  deltaCount: number
  observedEvents: string[]
}

export async function consumeLangChainEventStream(
  stream: AsyncIterable<any>,
  opts?: {
    onDelta?: (delta: string) => void
    signal?: AbortSignal
    extractTokensUsed?: (output: any) => number | undefined
  }
): Promise<ConsumedLangChainStream> {
  let content = ''
  let finishReason: string | undefined
  let endEventText = ''
  let tokensUsed: number | undefined
  let deltaCount = 0
  const observedEvents = new Set<string>()

  for await (const event of stream) {
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const eventName =
      typeof event?.event === 'string'
        ? event.event
        : typeof event?.name === 'string'
          ? event.name
          : typeof event?.type === 'string'
            ? event.type
            : ''
    observedEvents.add(eventName || 'unknown')

    // LangChain event names/shapes have varied across versions; prefer resilient extraction.
    const deltaSource = event?.data?.chunk ?? event?.data?.delta ?? event?.data?.token ?? event?.data?.text
    const delta = getDeltaFromStreamChunk(deltaSource)
    if (delta) {
      content += delta
      opts?.onDelta?.(delta)
      deltaCount += 1
    }

    const endOutput = event?.data?.output ?? event?.data?.response ?? event?.data?.result
    if (endOutput) {
      const { text, finishReason: reason } = getEndOutputText(endOutput)
      if (text && text.length > endEventText.length) {
        endEventText = text
      }
      if (reason) finishReason = reason
      if (tokensUsed === undefined && opts?.extractTokensUsed) {
        tokensUsed = opts.extractTokensUsed(endOutput)
      }
    }
  }

  if (endEventText && endEventText.length > content.length) {
    content = endEventText
  }

  return { content, finishReason, tokensUsed, deltaCount, observedEvents: Array.from(observedEvents) }
}

export async function solveQuestionStream(
  imagePath: string,
  onUpdate?: (update: StreamUpdate) => void,
  apiOverride?: ApiOverride,
  signal?: AbortSignal
): Promise<SolveResult> {
  return solveQuestionStreamFromImages([imagePath], undefined, onUpdate, apiOverride, signal)
}

export async function solveQuestionStreamFromImages(
  imagePaths: string[],
  extraPrompt?: string,
  onUpdate?: (update: StreamUpdate) => void,
  apiOverride?: ApiOverride,
  signal?: AbortSignal
): Promise<SolveResult> {
  try {
    const images = encodeImages(imagePaths)
    const model = createModel(true, apiOverride)
    const stream = await (model as any).streamEvents(buildMessages(images, extraPrompt), { version: 'v1', signal })

    onUpdate?.({ type: 'start' })
    const { content, finishReason, tokensUsed, deltaCount, observedEvents } = await consumeLangChainEventStream(stream, {
      signal,
      onDelta: (delta) => onUpdate?.({ type: 'delta', value: delta }),
      extractTokensUsed: extractTotalTokens
    })

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
        contentLength: content.length,
        observedEvents: observedEvents.slice(0, 40)
      })
      const fallback = await solveQuestionFromImages(imagePaths, extraPrompt, apiOverride, signal)
      const fallbackText = `题目：${fallback.question}\n\n解答：${fallback.answer}`
      onUpdate?.({ type: 'complete', value: fallbackText, result: fallback })
      return fallback
    }

    console.info('流式输出完成', {
      finishReason: finishReason || 'unknown',
      deltaCount,
      contentLength: content.length
    })
    const result: SolveResult = {
      ...parsed,
      tokensUsed:
        tokensUsed ??
        estimateTokensFromText(PROMPT + (extraPrompt ? `\n${extraPrompt}` : '')) + estimateTokensFromText(content)
    }
    onUpdate?.({ type: 'complete', value: content, result })
    return result
  } catch (error) {
    console.error('OpenAI API调用失败:', error instanceof Error ? error.message : error)
    onUpdate?.({
      type: 'error',
      message: error instanceof Error ? error.message : 'AI解答失败，请检查API配置'
    })
    throw new Error('AI解答失败，请检查API配置')
  }
}

export async function solveQuestion(imagePath: string, apiOverride?: ApiOverride): Promise<SolveResult> {
  return solveQuestionFromImages([imagePath], undefined, apiOverride)
}

export async function solveQuestionFromImages(
  imagePaths: string[],
  extraPrompt?: string,
  apiOverride?: ApiOverride,
  signal?: AbortSignal
): Promise<SolveResult> {
  try {
    const images = encodeImages(imagePaths)
    const model = createModel(false, apiOverride)
    const response = await (model as any).invoke(buildMessages(images, extraPrompt), { signal })
    const content = toText(response.content) || '无法识别题目'

    const parsed = buildSolveResult(content)
    const tokensUsed =
      extractTotalTokens(response) ??
      estimateTokensFromText(PROMPT + (extraPrompt ? `\n${extraPrompt}` : '')) + estimateTokensFromText(content)

    return { ...parsed, tokensUsed }
  } catch (error) {
    console.error('OpenAI API调用失败:', error instanceof Error ? error.message : error)
    throw new Error('AI解答失败，请检查API配置')
  }
}

export async function solveQuestionFromText(
  questionText: string,
  extraPrompt?: string,
  apiOverride?: ApiOverride,
  signal?: AbortSignal
): Promise<SolveResult> {
  try {
    const q = (questionText || '').trim()
    if (!q) throw new Error('question text is empty')

    const model = createModel(false, apiOverride)
    const response = await (model as any).invoke(buildTextMessages(q, extraPrompt), { signal })
    const content = toText(response.content) || '无法解答'

    const parsed = buildSolveResult(content)
    const tokensUsed =
      extractTotalTokens(response) ??
      estimateTokensFromText(TEXT_PROMPT + (extraPrompt ? `\n${extraPrompt}` : '')) + estimateTokensFromText(content)

    return { question: q, answer: parsed.answer || content, tokensUsed }
  } catch (error) {
    console.error('OpenAI API调用失败:', error instanceof Error ? error.message : error)
    throw new Error('AI解答失败，请检查 API 配置')
  }
}

export async function solveQuestionStreamFromText(
  questionText: string,
  extraPrompt?: string,
  onUpdate?: (update: StreamUpdate) => void,
  apiOverride?: ApiOverride,
  signal?: AbortSignal
): Promise<SolveResult> {
  try {
    const q = (questionText || '').trim()
    if (!q) throw new Error('question text is empty')

    const model = createModel(true, apiOverride)
    const stream = await (model as any).streamEvents(buildTextMessages(q, extraPrompt), { version: 'v1', signal })

    onUpdate?.({ type: 'start' })
    const { content, finishReason, tokensUsed, deltaCount, observedEvents } = await consumeLangChainEventStream(stream, {
      signal,
      onDelta: (delta) => onUpdate?.({ type: 'delta', value: delta }),
      extractTokensUsed: extractTotalTokens
    })

    const parsed = buildSolveResult(content)
    const looksIncomplete = !content.trim() || finishReason === 'length' || !parsed.answer?.trim()

    if (looksIncomplete) {
      console.warn('stream output empty/truncated; falling back', {
        finishReason,
        deltaCount,
        contentLength: content.length,
        observedEvents: observedEvents.slice(0, 40)
      })
      const fallback = await solveQuestionFromText(q, extraPrompt, apiOverride, signal)
      const fallbackText = `题目：${fallback.question}\n\n解答：${fallback.answer}`
      onUpdate?.({ type: 'complete', value: fallbackText, result: fallback })
      return fallback
    }

    const result: SolveResult = {
      question: q,
      answer: parsed.answer || content,
      tokensUsed:
        tokensUsed ??
        estimateTokensFromText(TEXT_PROMPT + (extraPrompt ? `\n${extraPrompt}` : '')) + estimateTokensFromText(content)
    }
    onUpdate?.({ type: 'complete', value: content, result })
    return result
  } catch (error) {
    console.error('OpenAI API调用失败:', error instanceof Error ? error.message : error)
    onUpdate?.({
      type: 'error',
      message: error instanceof Error ? error.message : 'AI解答失败，请检查 API 配置'
    })
    throw new Error('AI解答失败，请检查 API 配置')
  }
}

export async function answerFollowUp(opts: {
  baseQuestion: string
  baseAnswer: string
  prompt: string
  messages?: unknown
  apiOverride?: ApiOverride
  signal?: AbortSignal
}): Promise<FollowUpResult> {
  const baseQuestion = (opts.baseQuestion || '').trim()
  const baseAnswer = (opts.baseAnswer || '').trim()
  const prompt = (opts.prompt || '').trim()
  if (!baseQuestion || !baseAnswer || !prompt) {
    throw new Error('missing baseQuestion/baseAnswer/prompt')
  }

  const history = normalizeFollowUpHistory(opts.messages)
  const model = createModel(false, opts.apiOverride)

  const lcMessages: (SystemMessage | HumanMessage | AIMessage)[] = [
    new SystemMessage(
      '你是一个严谨、友好的中文学习助手。你将基于题目与已有解答，回答用户的后续追问；必要时可纠错并给出更清晰的推导步骤。请使用 Markdown；公式用 LaTeX（$...$ / $$...$$）。'
    ),
    new HumanMessage(`题目：\n${baseQuestion}\n\n已给出的解答：\n${baseAnswer}`)
  ]

  for (const msg of history.slice(-20)) {
    lcMessages.push(msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content))
  }

  lcMessages.push(new HumanMessage(`用户追问：\n${prompt}`))

  const response = await (model as any).invoke(lcMessages, { signal: opts.signal })
  const answer = (toText((response as any)?.content) || '').trim()
  const tokensUsed =
    extractTotalTokens(response) ??
    estimateTokensFromText(baseQuestion) +
      estimateTokensFromText(baseAnswer) +
      estimateTokensFromText(history.map((m) => m.content).join('\n')) +
      estimateTokensFromText(prompt) +
      estimateTokensFromText(answer)

  if (!answer) {
    throw new Error('empty follow-up answer')
  }

  return { answer, tokensUsed }
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
