import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { estimateTokensFromText, extractTotalTokens } from './tokenUsage.js'
import type { ApiOverride } from './apiOverride.js'
import type { DebateModelsOverride } from './router.js'

dotenv.config()

interface DebateState {
  question: string
  images?: { base64Image: string; mimeType: string }[]
  extraPrompt?: string
  model1_answer: string
  model2_review: string
  iteration: number
  max_iterations: number
  consensus_reached: boolean
  final_answer: string
  tokens_used: number
}

type DebateStreamUpdate = {
  type: 'status' | 'model1' | 'model2'
  content?: string
  iteration: number
  message?: string
}

type DebateUpdateHandler = (update: DebateStreamUpdate) => void

type DebateModels = { model1: ChatOpenAI; model2: ChatOpenAI }

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const createModels = (apiOverride?: ApiOverride, modelsOverride?: DebateModelsOverride): DebateModels => {
  const defaultKey = process.env.OPENAI_API_KEY
  const overrideKey = apiOverride?.apiKey
  const overrideBase = apiOverride?.baseURL
  const overrideModel = apiOverride?.model
  const overrideModel1 = apiOverride?.debateModel1
  const overrideModel2 = apiOverride?.debateModel2

  const model1Override = modelsOverride?.model1
  const model2Override = modelsOverride?.model2

  const model1Name =
    clean(overrideModel1) || clean(overrideModel) || clean(model1Override?.modelName) || process.env.MODEL1_NAME || 'gpt-4o-mini'
  const model2Name =
    clean(overrideModel2) || clean(overrideModel) || clean(model2Override?.modelName) || process.env.MODEL2_NAME || 'gpt-4o'

  const model1 = new ChatOpenAI({
    modelName: model1Name,
    temperature: 0.7,
    openAIApiKey: overrideKey || clean(model1Override?.apiKey) || process.env.MODEL1_API_KEY || defaultKey,
    configuration: {
      baseURL: overrideBase || clean(model1Override?.baseURL) || process.env.MODEL1_BASE_URL || 'https://api.openai.com/v1'
    }
  })

  const model2 = new ChatOpenAI({
    modelName: model2Name,
    temperature: 0.7,
    openAIApiKey: overrideKey || clean(model2Override?.apiKey) || process.env.MODEL2_API_KEY || defaultKey,
    configuration: {
      baseURL: overrideBase || clean(model2Override?.baseURL) || process.env.MODEL2_BASE_URL || 'https://api.openai.com/v1'
    }
  })

  return { model1, model2 }
}

export type FollowUpChatMessage = { role: 'user' | 'assistant'; content: string }

export type FollowUpResult = {
  answer: string
  iterations: number
  consensus: boolean
  tokensUsed: number
}

type FollowUpState = {
  baseQuestion: string
  baseAnswer: string
  history: FollowUpChatMessage[]
  prompt: string
  model1_answer: string
  model2_review: string
  iteration: number
  max_iterations: number
  consensus_reached: boolean
  final_answer: string
  tokens_used: number
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

const formatHistory = (history: FollowUpChatMessage[]) =>
  history
    .slice(-20)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n')

async function followUpModel1Propose(state: FollowUpState, models: DebateModels, signal?: AbortSignal): Promise<FollowUpState> {
  const { iteration, baseQuestion, baseAnswer, history, prompt, model1_answer, model2_review } = state
  const historyText = formatHistory(history)

  const text =
    iteration === 0
      ? `你是中文学习助手。请基于题目与已给出的解答，回答用户追问；必要时可纠错并补充推导/步骤。\n\n题目：\n${baseQuestion}\n\n已给出的解答：\n${baseAnswer}\n${
          historyText ? `\n\n历史对话：\n${historyText}\n` : '\n'
        }\n用户追问：\n${prompt}\n\n请直接给出回答。`
      : `你正在改进上一轮对追问的回答。\n\n题目：\n${baseQuestion}\n\n已给出的解答：\n${baseAnswer}\n${
          historyText ? `\n\n历史对话：\n${historyText}\n` : '\n'
        }\n你上一轮的回答：\n${model1_answer}\n\n审查意见：\n${model2_review}\n\n请根据审查意见改进你的回答；如认为无需修改，请简要说明理由并给出更清晰的最终回答。`

  const response = await (models.model1 as any).invoke([new HumanMessage(text)], { signal })
  const answer = (response.content as string) || ''
  state.tokens_used += extractTotalTokens(response) ?? estimateTokensFromText(answer)
  state.model1_answer = answer
  return state
}

async function followUpModel2Review(state: FollowUpState, models: DebateModels, signal?: AbortSignal): Promise<FollowUpState> {
  const { baseQuestion, baseAnswer, history, prompt, model1_answer } = state
  const historyText = formatHistory(history)

  const reviewPrompt = `你是严谨的审查员。请审查“助手回答”是否准确、有帮助，并且确实回应了“用户追问”。\n\n题目：\n${baseQuestion}\n\n已给出的解答：\n${baseAnswer}\n${
    historyText ? `\n\n历史对话：\n${historyText}\n` : '\n'
  }\n用户追问：\n${prompt}\n\n助手回答：\n${model1_answer}\n\n如果回答已经很好，请回复：\nAPPROVED: <一句话说明为什么好>\n\n如果需要改进，请指出具体问题与改进建议。`

  const response = await (models.model2 as any).invoke([new HumanMessage(reviewPrompt)], { signal })
  const review = (response.content as string) || ''
  state.tokens_used += extractTotalTokens(response) ?? estimateTokensFromText(review)

  state.model2_review = review
  state.consensus_reached = review.toUpperCase().includes('APPROVED')
  if (state.consensus_reached) {
    state.final_answer = model1_answer
  }
  state.iteration += 1
  return state
}

export async function answerFollowUpWithDebate(opts: {
  baseQuestion: string
  baseAnswer: string
  prompt: string
  maxIterations?: number
  messages?: unknown
  apiOverride?: ApiOverride
  modelsOverride?: DebateModelsOverride
  signal?: AbortSignal
}): Promise<FollowUpResult> {
  const baseQuestion = (opts.baseQuestion || '').trim()
  const baseAnswer = (opts.baseAnswer || '').trim()
  const prompt = (opts.prompt || '').trim()
  if (!baseQuestion || !baseAnswer || !prompt) {
    throw new Error('missing baseQuestion/baseAnswer/prompt')
  }

  const maxIterations = Number.isFinite(opts.maxIterations) ? Math.max(1, Math.floor(opts.maxIterations as number)) : 3
  const history = normalizeFollowUpHistory(opts.messages)
  const models = createModels(opts.apiOverride, opts.modelsOverride)

  let state: FollowUpState = {
    baseQuestion,
    baseAnswer,
    history,
    prompt,
    model1_answer: '',
    model2_review: '',
    iteration: 0,
    max_iterations: maxIterations,
    consensus_reached: false,
    final_answer: '',
    tokens_used: 0
  }

  while (state.iteration < state.max_iterations && !state.consensus_reached) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    state = await followUpModel1Propose(state, models, opts.signal)
    state = await followUpModel2Review(state, models, opts.signal)
  }

  const answer = (state.final_answer || state.model1_answer || '').trim()
  if (!answer) throw new Error('empty follow-up answer')

  return {
    answer,
    iterations: state.iteration,
    consensus: state.consensus_reached,
    tokensUsed: state.tokens_used
  }
}

async function model1Propose(state: DebateState, models: DebateModels, onUpdate?: DebateUpdateHandler, signal?: AbortSignal): Promise<DebateState> {
  const { iteration, images, extraPrompt, model1_answer, model2_review } = state

  let content: any[]

  if (iteration === 0) {
    const isTextOnly = !images?.length
    content = [
      {
        type: 'text',
        text: isTextOnly
          ? `请根据用户提供的【题目文本】直接解答。\n\n输出要求：\n- 使用 Markdown。\n- 数学/物理/化学等公式请用 LaTeX（行内 $...$；独立公式 $$...$$）。\n- 解答里必须包含清晰的“最终答案”（可直接复制），并给出推导/步骤。\n\n格式如下（请保留“题目/解答”标签，便于系统解析）：\n\n题目：\n[题目内容]\n\n解答：\n[详细的解答步骤，包含最终答案与必要公式]${
              extraPrompt ? `\n\n补充说明：\n${extraPrompt}` : ''
            }\n\n【题目文本】\n${state.question}`
          : `请识别图片中的题目（可能包含多张图片/多个裁剪区域，属于同一道题的不同部分），并合并理解后给出解答。\n\n输出要求：\n- 使用 Markdown。\n- 数学/物理/化学等公式请用 LaTeX（行内 $...$；独立公式 $$...$$）。\n- 解答里必须包含清晰的“最终答案”（可直接复制），并给出推导/步骤。\n\n格式如下（请保留“题目/解答”标签，便于系统解析）：\n\n题目：\n[识别出的题目内容]\n\n解答：\n[详细的解答步骤，包含最终答案与必要公式]${extraPrompt ? `\n\n补充说明：\n${extraPrompt}` : ''}`
      }
    ]

    if (images?.length) {
      for (const image of images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${image.mimeType};base64,${image.base64Image}`
          }
        })
      }
    }
  } else {
    // 根据模型2的审查意见改进答案
    content = [
      {
        type: 'text',
        text: `原始问题：识别并解答图片中的题目

你之前的答案：
${model1_answer}

审查意见：
${model2_review}

请根据审查意见改进你的答案。如果你认为审查意见合理，请修改答案；如果你认为原答案已经很好，请说明理由并保持或微调答案。保持格式：题目：[内容] 解答：[内容]`
      }
    ]
  }

  const response = await (models.model1 as any).invoke([new HumanMessage({ content })], { signal })
  const answer = response.content as string
  state.tokens_used += extractTotalTokens(response) ?? estimateTokensFromText(answer)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`迭代 ${iteration + 1} - 模型1的答案：`)
  console.log(`${'='.repeat(60)}`)
  console.log(answer)

  state.model1_answer = answer
  if (onUpdate) {
    onUpdate({ type: 'model1', content: answer, iteration: iteration + 1 })
  }
  return state
}

async function model2Review(state: DebateState, models: DebateModels, onUpdate?: DebateUpdateHandler, signal?: AbortSignal): Promise<DebateState> {
  const { question, model1_answer, iteration, images } = state
  const isTextOnly = !images?.length

  const prompt = isTextOnly
    ? `原始任务：根据题目文本解答\n\n题目文本：\n${question}\n\n待审查的答案：\n${model1_answer}\n\n请仔细审查这个答案，评估其：\n1. 是否正确理解题意\n2. 解答的完整性和正确性\n3. 逻辑性和清晰度\n4. 是否有遗漏或错误\n\n如果答案已经很好，请回复\"APPROVED: [简短说明为什么这个答案很好]\"\n如果需要改进，请提供具体的改进建议。`
    : `原始任务：识别并解答图片中的题目

待审查的答案：
${model1_answer}

请仔细审查这个答案，评估其：
1. 题目识别的准确性
2. 解答的完整性和正确性
3. 逻辑性和清晰度
4. 是否有遗漏或错误

如果答案已经很好，请回复"APPROVED: [简短说明为什么这个答案很好]"
如果需要改进，请提供具体的改进建议。`

  const response = await (models.model2 as any).invoke([new HumanMessage(prompt)], { signal })
  const review = response.content as string
  state.tokens_used += extractTotalTokens(response) ?? estimateTokensFromText(review)

  console.log(`\n${'-'.repeat(60)}`)
  console.log(`模型2的审查意见：`)
  console.log(`${'-'.repeat(60)}`)
  console.log(review)

  state.model2_review = review
  state.consensus_reached = review.toUpperCase().includes('APPROVED')
  
  if (state.consensus_reached) {
    state.final_answer = model1_answer
  }
  
  state.iteration += 1
  if (onUpdate) {
    onUpdate({ type: 'model2', content: review, iteration: state.iteration })
  }

  return state
}

export async function solveQuestionWithDebate(
  imagePath: string,
  maxIterations: number = 3,
  apiOverride?: ApiOverride,
  modelsOverride?: DebateModelsOverride
) {
  return solveQuestionWithDebateFromImages([imagePath], maxIterations, undefined, apiOverride, modelsOverride)
}

export async function solveQuestionWithDebateFromImages(
  imagePaths: string[],
  maxIterations: number = 3,
  extraPrompt?: string,
  apiOverride?: ApiOverride,
  modelsOverride?: DebateModelsOverride,
  signal?: AbortSignal
) {
  try {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`开始多模型博弈`)
    console.log(`${'='.repeat(60)}`)
    console.log(`最大迭代次数：${maxIterations}`)

    const images = imagePaths.map((p) => ({
      base64Image: fs.readFileSync(p).toString('base64'),
      mimeType: getMimeType(p)
    }))

    const models = createModels(apiOverride, modelsOverride)
    let state: DebateState = {
      question: '识别并解答图片中的题目',
      images,
      extraPrompt,
      model1_answer: '',
      model2_review: '',
      iteration: 0,
      max_iterations: maxIterations,
      consensus_reached: false,
      final_answer: '',
      tokens_used: 0
    }

    // 博弈循环
    while (state.iteration < maxIterations && !state.consensus_reached) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      // 模型1提出或改进答案
      state = await model1Propose(state, models, undefined, signal)
      
      // 模型2审查
      state = await model2Review(state, models, undefined, signal)
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`博弈结束`)
    console.log(`${'='.repeat(60)}`)
    console.log(`总迭代次数：${state.iteration}`)
    console.log(`是否达成共识：${state.consensus_reached ? '是' : '否（达到最大迭代次数）'}`)

    // 如果没有最终答案，使用最后一次的答案
    const answer = state.final_answer || state.model1_answer

    // 解析题目和答案
    const questionMatch = answer.match(/题目[：:]\s*(.+?)(?=\n\n解答|$)/s)
    const answerMatch = answer.match(/解答[：:]\s*(.+)/s)

    return {
      question: questionMatch ? questionMatch[1].trim() : '未识别到题目',
      answer: answerMatch ? answerMatch[1].trim() : answer,
      iterations: state.iteration,
      consensus: state.consensus_reached,
      tokensUsed: state.tokens_used
    }
  } catch (error) {
    console.error('多模型博弈失败:', error instanceof Error ? error.message : error)
    throw new Error('多模型博弈失败，请检查配置')
  }
}

export async function solveQuestionWithDebateFromText(
  questionText: string,
  maxIterations: number = 3,
  extraPrompt?: string,
  apiOverride?: ApiOverride,
  modelsOverride?: DebateModelsOverride,
  signal?: AbortSignal
) {
  try {
    const q = (questionText || '').trim()
    if (!q) throw new Error('question text is empty')

    const models = createModels(apiOverride, modelsOverride)
    let state: DebateState = {
      question: q,
      images: undefined,
      extraPrompt,
      model1_answer: '',
      model2_review: '',
      iteration: 0,
      max_iterations: maxIterations,
      consensus_reached: false,
      final_answer: '',
      tokens_used: 0
    }

    while (state.iteration < maxIterations && !state.consensus_reached) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      state = await model1Propose(state, models, undefined, signal)
      state = await model2Review(state, models, undefined, signal)
    }

    const answer = state.final_answer || state.model1_answer
    const answerMatch = answer.match(/解答[：:]\s*([\s\S]+)/)
    return {
      question: q,
      answer: answerMatch ? answerMatch[1].trim() : answer,
      iterations: state.iteration,
      consensus: state.consensus_reached,
      tokensUsed: state.tokens_used
    }
  } catch (error) {
    console.error('多模型辩论失败:', error instanceof Error ? error.message : error)
    throw new Error('多模型辩论失败，请检查配置')
  }
}

export async function solveQuestionWithDebateStream(
  imagePath: string,
  maxIterations: number = 3,
  onUpdate?: DebateUpdateHandler,
  apiOverride?: ApiOverride,
  modelsOverride?: DebateModelsOverride
) {
  return solveQuestionWithDebateStreamFromImages([imagePath], maxIterations, undefined, onUpdate, apiOverride, modelsOverride)
}

export async function solveQuestionWithDebateStreamFromText(
  questionText: string,
  maxIterations: number = 3,
  extraPrompt?: string,
  onUpdate?: DebateUpdateHandler,
  apiOverride?: ApiOverride,
  modelsOverride?: DebateModelsOverride,
  signal?: AbortSignal
) {
  try {
    const q = (questionText || '').trim()
    if (!q) throw new Error('question text is empty')

    const models = createModels(apiOverride, modelsOverride)
    let state: DebateState = {
      question: q,
      images: undefined,
      extraPrompt,
      model1_answer: '',
      model2_review: '',
      iteration: 0,
      max_iterations: maxIterations,
      consensus_reached: false,
      final_answer: '',
      tokens_used: 0
    }

    while (state.iteration < maxIterations && !state.consensus_reached) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onUpdate?.({ type: 'status', message: '模型1 生成答案中...', iteration: state.iteration + 1 })
      state = await model1Propose(state, models, onUpdate, signal)
      onUpdate?.({ type: 'status', message: '模型2 审查中...', iteration: state.iteration + 1 })
      state = await model2Review(state, models, onUpdate, signal)
    }

    const answer = state.final_answer || state.model1_answer
    const answerMatch = answer.match(/解答[：:]\s*([\s\S]+)/)
    return {
      question: q,
      answer: answerMatch ? answerMatch[1].trim() : answer,
      iterations: state.iteration,
      consensus: state.consensus_reached,
      tokensUsed: state.tokens_used
    }
  } catch (error) {
    console.error('多模型辩论失败:', error instanceof Error ? error.message : error)
    throw new Error('多模型辩论失败，请检查配置')
  }
}

export async function solveQuestionWithDebateStreamFromImages(
  imagePaths: string[],
  maxIterations: number = 3,
  extraPrompt?: string,
  onUpdate?: DebateUpdateHandler,
  apiOverride?: ApiOverride,
  modelsOverride?: DebateModelsOverride,
  signal?: AbortSignal
) {
  try {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`开始多模型博弈`)
    console.log(`${'='.repeat(60)}`)
    console.log(`最大迭代次数：${maxIterations}`)

    const images = imagePaths.map((p) => ({
      base64Image: fs.readFileSync(p).toString('base64'),
      mimeType: getMimeType(p)
    }))

    const models = createModels(apiOverride, modelsOverride)
    let state: DebateState = {
      question: '识别并解答图片中的题目',
      images,
      extraPrompt,
      model1_answer: '',
      model2_review: '',
      iteration: 0,
      max_iterations: maxIterations,
      consensus_reached: false,
      final_answer: '',
      tokens_used: 0
    }

    while (state.iteration < maxIterations && !state.consensus_reached) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (onUpdate) {
        onUpdate({ type: 'status', message: '模型1 生成答案中...', iteration: state.iteration + 1 })
      }
      state = await model1Propose(state, models, onUpdate, signal)

      if (onUpdate) {
        onUpdate({ type: 'status', message: '模型2 审查中...', iteration: state.iteration + 1 })
      }
      state = await model2Review(state, models, onUpdate, signal)
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`博弈结束`)
    console.log(`${'='.repeat(60)}`)
    console.log(`总迭代次数：${state.iteration}`)
    console.log(`是否达成共识：${state.consensus_reached ? '是' : '否（达到最大迭代次数）'}`)

    const answer = state.final_answer || state.model1_answer
    const questionMatch = answer.match(/题目[：:]\s*(.+?)(?=\n\n解答|$)/s)
    const answerMatch = answer.match(/解答[：:]\s*(.+)/s)

    return {
      question: questionMatch ? questionMatch[1].trim() : '未识别到题目',
      answer: answerMatch ? answerMatch[1].trim() : answer,
      iterations: state.iteration,
      consensus: state.consensus_reached,
      tokensUsed: state.tokens_used
    }
  } catch (error) {
    console.error('多模型博弈失败:', error instanceof Error ? error.message : error)
    throw new Error('多模型博弈失败，请检查配置')
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
