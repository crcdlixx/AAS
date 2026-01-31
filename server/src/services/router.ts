import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { estimateTokensFromText, extractTotalTokens } from './tokenUsage.js'
import type { ApiOverride } from './apiOverride.js'

dotenv.config()

export type RouteSubject = 'humanities' | 'science' | 'unknown'
export type RouteMode = 'single' | 'debate'
export type UserMode = 'single' | 'debate' | 'auto'

export type RouteDecision = {
  subject: RouteSubject
  mode: RouteMode
  confidence?: number
  routerTokensUsed: number
  routerModel: string
}

export type DebateModelOverride = {
  modelName?: string
  apiKey?: string
  baseURL?: string
}

export type DebateModelsOverride = {
  model1?: DebateModelOverride
  model2?: DebateModelOverride
}

type EncodedImage = { base64Image: string; mimeType: string }

const ROUTER_PROMPT = `你是一个“题目路由器”。你的任务是判断用户发送的题目属于【文科】还是【理科】：

- 理科：数学、物理、化学、生物、信息/计算机、工程类、统计/概率、理工科实验题等
- 文科：语文/作文/阅读、英语、历史、政治、地理、人文社科、法律、经济、艺术等

只根据题目本身判断，不要尝试解题。

输出要求：
1) 只输出严格 JSON（不要 Markdown、不要多余文字）
2) JSON 结构如下：
{"subject":"humanities"|"science"|"unknown","confidence":0~1}

如果无法确定或混合学科，请返回 subject="unknown" 并给出较低 confidence。`

const toText = (content: unknown): string => {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'object' && content && typeof (content as any).text === 'string') return (content as any).text
  if (Array.isArray(content)) return content.map((item) => toText(item)).join('')
  return ''
}

const getMimeType = (filePath: string): string => {
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

const encodeImages = (imagePaths: string[]): EncodedImage[] =>
  imagePaths.map((p) => ({
    base64Image: fs.readFileSync(p).toString('base64'),
    mimeType: getMimeType(p)
  }))

const parseMode = (value: unknown, fallback: RouteMode): RouteMode => {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (v === 'single' || v === 'debate') return v
  return fallback
}

const splitList = (value: unknown): string[] => {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

const parseSubject = (raw: unknown): RouteSubject => {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'science' || v === 'humanities' || v === 'unknown') return v
  return 'unknown'
}

const parseConfidence = (raw: unknown): number | undefined => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.min(1, n))
}

const parseRouterJson = (text: string): { subject: RouteSubject; confidence?: number } => {
  const trimmed = (text || '').trim()
  if (!trimmed) return { subject: 'unknown' }

  try {
    const data = JSON.parse(trimmed) as any
    return { subject: parseSubject(data?.subject), confidence: parseConfidence(data?.confidence) }
  } catch {
    // 容错：模型偶尔会输出带解释的文本
    const hint = trimmed.toLowerCase()
    if (hint.includes('理科') || hint.includes('science')) return { subject: 'science' }
    if (hint.includes('文科') || hint.includes('humanities')) return { subject: 'humanities' }
    return { subject: 'unknown' }
  }
}

const createRouterModel = (apiOverride?: ApiOverride) => {
  const modelName = apiOverride?.routerModel || process.env.ROUTER_MODEL || 'gpt-4o-mini'
  const apiKey = apiOverride?.apiKey || process.env.ROUTER_API_KEY || process.env.OPENAI_API_KEY
  const baseURL = apiOverride?.baseURL || process.env.ROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

  return {
    modelName,
    model: new ChatOpenAI({
      modelName,
      temperature: 0,
      openAIApiKey: apiKey,
      configuration: { baseURL }
    })
  }
}

export const getSubjectSingleModelOverride = (subject: RouteSubject): string | undefined => {
  const list =
    subject === 'humanities'
      ? splitList(process.env.ROUTE_HUMANITIES_SINGLE_MODELS)
      : subject === 'science'
        ? splitList(process.env.ROUTE_SCIENCE_SINGLE_MODELS)
        : splitList(process.env.ROUTE_UNKNOWN_SINGLE_MODELS)
  if (list.length) return list[0]

  const legacy =
    subject === 'humanities'
      ? process.env.ROUTE_HUMANITIES_MODEL
      : subject === 'science'
        ? process.env.ROUTE_SCIENCE_MODEL
        : process.env.ROUTE_UNKNOWN_MODEL
  const v = typeof legacy === 'string' ? legacy.trim() : ''
  return v ? v : undefined
}

export const getSubjectMode = (subject: RouteSubject): RouteMode => {
  const fallback = parseMode(process.env.ROUTE_DEFAULT_MODE, 'debate')
  const envValue =
    subject === 'humanities'
      ? process.env.ROUTE_HUMANITIES_MODE
      : subject === 'science'
        ? process.env.ROUTE_SCIENCE_MODE
        : process.env.ROUTE_UNKNOWN_MODE
  return parseMode(envValue, fallback)
}

const pickDebateModelNames = (subject: RouteSubject): { model1?: string; model2?: string } => {
  const list =
    subject === 'humanities'
      ? splitList(process.env.ROUTE_HUMANITIES_DEBATE_MODELS)
      : subject === 'science'
        ? splitList(process.env.ROUTE_SCIENCE_DEBATE_MODELS)
        : splitList(process.env.ROUTE_UNKNOWN_DEBATE_MODELS)
  return { model1: list[0], model2: list[1] }
}

const getEnvBySubject = (subject: RouteSubject, humanities: string | undefined, science: string | undefined, unknown: string | undefined) =>
  subject === 'humanities' ? humanities : subject === 'science' ? science : unknown

export const getSubjectDebateModelsOverride = (subject: RouteSubject): DebateModelsOverride | undefined => {
  const picked = pickDebateModelNames(subject)

  const model1Name = getEnvBySubject(
    subject,
    process.env.ROUTE_HUMANITIES_DEBATE_MODEL1_NAME,
    process.env.ROUTE_SCIENCE_DEBATE_MODEL1_NAME,
    process.env.ROUTE_UNKNOWN_DEBATE_MODEL1_NAME
  )?.trim()
  const model2Name = getEnvBySubject(
    subject,
    process.env.ROUTE_HUMANITIES_DEBATE_MODEL2_NAME,
    process.env.ROUTE_SCIENCE_DEBATE_MODEL2_NAME,
    process.env.ROUTE_UNKNOWN_DEBATE_MODEL2_NAME
  )?.trim()

  const model1ApiKey = getEnvBySubject(
    subject,
    process.env.ROUTE_HUMANITIES_DEBATE_MODEL1_API_KEY,
    process.env.ROUTE_SCIENCE_DEBATE_MODEL1_API_KEY,
    process.env.ROUTE_UNKNOWN_DEBATE_MODEL1_API_KEY
  )?.trim()
  const model2ApiKey = getEnvBySubject(
    subject,
    process.env.ROUTE_HUMANITIES_DEBATE_MODEL2_API_KEY,
    process.env.ROUTE_SCIENCE_DEBATE_MODEL2_API_KEY,
    process.env.ROUTE_UNKNOWN_DEBATE_MODEL2_API_KEY
  )?.trim()

  const model1BaseURL = getEnvBySubject(
    subject,
    process.env.ROUTE_HUMANITIES_DEBATE_MODEL1_BASE_URL,
    process.env.ROUTE_SCIENCE_DEBATE_MODEL1_BASE_URL,
    process.env.ROUTE_UNKNOWN_DEBATE_MODEL1_BASE_URL
  )?.trim()
  const model2BaseURL = getEnvBySubject(
    subject,
    process.env.ROUTE_HUMANITIES_DEBATE_MODEL2_BASE_URL,
    process.env.ROUTE_SCIENCE_DEBATE_MODEL2_BASE_URL,
    process.env.ROUTE_UNKNOWN_DEBATE_MODEL2_BASE_URL
  )?.trim()

  const finalModel1Name = model1Name || picked.model1
  const finalModel2Name = model2Name || picked.model2

  const model1: DebateModelOverride = {
    ...(finalModel1Name ? { modelName: finalModel1Name } : {}),
    ...(model1ApiKey ? { apiKey: model1ApiKey } : {}),
    ...(model1BaseURL ? { baseURL: model1BaseURL } : {})
  }
  const model2: DebateModelOverride = {
    ...(finalModel2Name ? { modelName: finalModel2Name } : {}),
    ...(model2ApiKey ? { apiKey: model2ApiKey } : {}),
    ...(model2BaseURL ? { baseURL: model2BaseURL } : {})
  }

  const hasAny =
    !!model1.modelName || !!model1.apiKey || !!model1.baseURL || !!model2.modelName || !!model2.apiKey || !!model2.baseURL
  if (!hasAny) return undefined
  return { model1, model2 }
}

export const applyModelOverride = (apiOverride: ApiOverride | undefined, modelOverride?: string): ApiOverride | undefined => {
  const override = modelOverride?.trim()
  if (!override) return apiOverride
  if (apiOverride?.model?.trim()) return apiOverride
  return { ...(apiOverride || {}), model: override }
}

export async function routeQuestionFromImages(
  imagePaths: string[],
  extraPrompt?: string,
  apiOverride?: ApiOverride
): Promise<RouteDecision> {
  const { model, modelName } = createRouterModel(apiOverride)
  const images = encodeImages(imagePaths)

  const content: any[] = []
  content.push({
    type: 'text',
    text: extraPrompt ? `${ROUTER_PROMPT}\n\n补充说明：\n${extraPrompt}` : ROUTER_PROMPT
  })
  for (const image of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.base64Image}` }
    })
  }

  const response = await model.invoke([new HumanMessage({ content })])
  const text = toText((response as any)?.content)
  const parsed = parseRouterJson(text)
  const routerTokensUsed =
    extractTotalTokens(response) ??
    estimateTokensFromText(ROUTER_PROMPT + (extraPrompt ? `\n${extraPrompt}` : '') + text)

  const subject = parsed.subject
  const mode = getSubjectMode(subject)

  return {
    subject,
    mode,
    confidence: parsed.confidence,
    routerTokensUsed,
    routerModel: modelName
  }
}

export async function routeQuestionFromText(
  questionText: string,
  apiOverride?: ApiOverride
): Promise<RouteDecision> {
  const { model, modelName } = createRouterModel(apiOverride)
  const q = (questionText || '').trim()

  const text = `${ROUTER_PROMPT}\n\n【题目文本】\n${q}`
  const response = await model.invoke([new HumanMessage(text)])
  const outText = toText((response as any)?.content)
  const parsed = parseRouterJson(outText)
  const routerTokensUsed = extractTotalTokens(response) ?? estimateTokensFromText(text + outText)

  const subject = parsed.subject
  const mode = getSubjectMode(subject)

  return {
    subject,
    mode,
    confidence: parsed.confidence,
    routerTokensUsed,
    routerModel: modelName
  }
}

export async function routeQuestionFromImagesWithModeOverride(
  imagePaths: string[],
  userMode: UserMode,
  extraPrompt?: string,
  apiOverride?: ApiOverride
): Promise<RouteDecision> {
  // If auto mode, use existing routing logic
  if (userMode === 'auto') {
    return routeQuestionFromImages(imagePaths, extraPrompt, apiOverride)
  }

  // For single or debate mode, still classify subject but override mode
  const { model, modelName } = createRouterModel(apiOverride)
  const images = encodeImages(imagePaths)

  const content: any[] = []
  content.push({
    type: 'text',
    text: extraPrompt ? `${ROUTER_PROMPT}\n\n补充说明：\n${extraPrompt}` : ROUTER_PROMPT
  })
  for (const image of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.base64Image}` }
    })
  }

  const response = await model.invoke([new HumanMessage({ content })])
  const text = toText((response as any)?.content)
  const parsed = parseRouterJson(text)
  const routerTokensUsed =
    extractTotalTokens(response) ??
    estimateTokensFromText(ROUTER_PROMPT + (extraPrompt ? `\n${extraPrompt}` : '') + text)

  const subject = parsed.subject
  // Override mode with user's selection
  const mode = userMode as RouteMode

  return {
    subject,
    mode,
    confidence: parsed.confidence,
    routerTokensUsed,
    routerModel: modelName
  }
}

export async function routeQuestionFromTextWithModeOverride(
  questionText: string,
  userMode: UserMode,
  apiOverride?: ApiOverride
): Promise<RouteDecision> {
  if (userMode === 'auto') {
    return routeQuestionFromText(questionText, apiOverride)
  }

  const { model, modelName } = createRouterModel(apiOverride)
  const q = (questionText || '').trim()
  const text = `${ROUTER_PROMPT}\n\n【题目文本】\n${q}`
  const response = await model.invoke([new HumanMessage(text)])
  const outText = toText((response as any)?.content)
  const parsed = parseRouterJson(outText)
  const routerTokensUsed = extractTotalTokens(response) ?? estimateTokensFromText(text + outText)

  const subject = parsed.subject
  const mode = userMode as RouteMode

  return {
    subject,
    mode,
    confidence: parsed.confidence,
    routerTokensUsed,
    routerModel: modelName
  }
}

export const buildRouteDecisionFromSubject = (subject: RouteSubject, userMode: UserMode): RouteDecision => {
  const mode: RouteMode = userMode === 'auto' ? getSubjectMode(subject) : (userMode as RouteMode)
  return {
    subject,
    mode,
    routerTokensUsed: 0,
    routerModel: 'manual'
  }
}
