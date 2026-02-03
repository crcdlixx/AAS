import axios from 'axios'
import { getFingerprintId } from '../utils/fingerprint'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'
const parseTimeoutMs = (raw: string | undefined, fallback: number) => {
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const API_TIMEOUT_MS = parseTimeoutMs(import.meta.env.VITE_API_TIMEOUT_MS, 120000)

const api = axios.create({
  baseURL: API_BASE,
  timeout: API_TIMEOUT_MS, // 增加超时时间以支持多模型博弈
})

api.interceptors.request.use(async (config) => {
  const fingerprint = await getFingerprintId()
  config.headers = config.headers ?? {}
  ;(config.headers as any)['X-AAS-Fingerprint'] = fingerprint
  return config
})

export interface SolveQuestionResponse {
  answer: string
  question: string
  iterations?: number
  consensus?: boolean
  tokensUsed?: number
  routedMode?: 'single' | 'debate'
  routedSubject?: 'humanities' | 'science' | 'unknown'
  userMode?: 'single' | 'debate' | 'auto'
  routerModel?: string
  routerConfidence?: number
  routerTokensUsed?: number
}

export type FollowUpChatMessage = { role: 'user' | 'assistant'; content: string }

export type FollowUpResponse = {
  answer: string
  tokensUsed?: number
  iterations?: number
  consensus?: boolean
}

export type UsageInfo = {
  enabled: boolean
  windowHours: number
  limitTokens: number
  usedTokens: number
  remainingTokens: number
  resetAtMs: number
}

export type ApiConfig = {
  apiKey: string
  baseUrl?: string
  singleModel?: string
  debateModel1?: string
  debateModel2?: string
  routerModel?: string
  embeddingModel?: string
  modelCandidates?: string[]
}

export type AvailableModelsResponse = {
  models: string[]
  embeddingModels?: string[]
  allModels?: string[]
  source?: 'api' | 'env' | 'deprecated-env'
}

export const getAvailableModels = async (apiConfig?: ApiConfig): Promise<string[]> => {
  const response = await api.get<AvailableModelsResponse>('/models', { headers: buildApiOverrideHeaders(apiConfig) })
  return Array.isArray(response.data?.models) ? response.data.models : []
}

export const getAvailableModelLists = async (
  apiConfig?: ApiConfig
): Promise<{ chatModels: string[]; embeddingModels: string[]; allModels: string[] }> => {
  const response = await api.get<AvailableModelsResponse>('/models', { headers: buildApiOverrideHeaders(apiConfig) })
  const chatModels = Array.isArray(response.data?.models) ? response.data.models : []
  const embeddingModels = Array.isArray(response.data?.embeddingModels) ? response.data.embeddingModels : []
  const allModels = Array.isArray(response.data?.allModels) ? response.data.allModels : chatModels
  return { chatModels, embeddingModels, allModels }
}

export type StreamEvent =
  | { type: 'start' }
  | { type: 'delta'; value: string }
  | { type: 'complete'; value: string; result?: SolveQuestionResponse }
  | { type: 'final'; result: SolveQuestionResponse; usage?: UsageInfo }
  | { type: 'model1'; content: string; iteration?: number }
  | { type: 'model2'; content: string; iteration?: number }
  | { type: 'status'; message: string; iteration?: number }
  | { type: 'error'; message: string }

const parseResponseErrorMessage = async (response: Response) => {
  const fallback = `请求失败（${response.status}）`
  try {
    const text = await response.text()
    if (!text?.trim()) return fallback
    try {
      const data = JSON.parse(text) as any
      return data?.error || data?.message || fallback
    } catch {
      return text
    }
  } catch {
    return fallback
  }
}

const toNumber = (value: string | null) => {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export const getUsageInfoFromHeaders = (headers: Headers): UsageInfo | null => {
  const limitTokens = toNumber(headers.get('X-Usage-Limit-Tokens'))
  const usedTokens = toNumber(headers.get('X-Usage-Used-Tokens'))
  const remainingTokens = toNumber(headers.get('X-Usage-Remaining-Tokens'))
  const resetAtMs = toNumber(headers.get('X-Usage-Reset-At'))
  const windowHours = toNumber(headers.get('X-Usage-Window-Hours'))

  if (
    limitTokens === null ||
    usedTokens === null ||
    remainingTokens === null ||
    resetAtMs === null ||
    windowHours === null
  ) {
    return null
  }

  return {
    enabled: limitTokens > 0,
    windowHours,
    limitTokens,
    usedTokens,
    remainingTokens,
    resetAtMs
  }
}

export const getUsage = async (): Promise<UsageInfo> => {
  const fingerprint = await getFingerprintId()
  const response = await fetch(`${API_BASE}/usage`, { headers: { 'X-AAS-Fingerprint': fingerprint } })
  if (!response.ok) {
    throw new Error(await parseResponseErrorMessage(response))
  }
  return (await response.json()) as UsageInfo
}

export const solveQuestion = async (imageBlob: Blob): Promise<SolveQuestionResponse> => {
  const formData = new FormData()
  formData.append('image', imageBlob, 'question.jpg')

  const endpoint = '/solve-auto'

  // Do NOT set `Content-Type` manually here; the browser/axios needs to inject the multipart boundary.
  const response = await api.post<SolveQuestionResponse>(endpoint, formData)

  return response.data
}

const uniqueModels = (models: string[] | undefined) => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of models || []) {
    const v = (m || '').trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

const pickRandomModel = (models: string[] | undefined) => {
  const list = uniqueModels(models)
  if (!list.length) return undefined
  const idx = Math.floor(Math.random() * list.length)
  return list[idx]
}

const pickRandomModelExcluding = (models: string[] | undefined, exclude: string | undefined) => {
  const ex = (exclude || '').trim()
  const list = uniqueModels(models).filter((m) => (ex ? m !== ex : true))
  if (!list.length) return undefined
  const idx = Math.floor(Math.random() * list.length)
  return list[idx]
}

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function buildApiOverrideHeaders(apiConfig?: ApiConfig) {
  if (!apiConfig?.apiKey) return {}
  const headers: Record<string, string> = { 'X-AAS-Api-Key': apiConfig.apiKey }
  if (apiConfig.baseUrl) headers['X-AAS-Base-Url'] = apiConfig.baseUrl

  const candidates = apiConfig.modelCandidates
  const singleModel = clean(apiConfig.singleModel) || pickRandomModel(candidates) || ''
  const debateModel1 = clean(apiConfig.debateModel1) || pickRandomModel(candidates) || ''
  const debateModel2 = clean(apiConfig.debateModel2) || pickRandomModelExcluding(candidates, debateModel1) || ''
  const routerModel = clean(apiConfig.routerModel) || pickRandomModel(candidates) || ''
  const embeddingModel = clean(apiConfig.embeddingModel)

  if (singleModel) headers['X-AAS-Model-Single'] = singleModel
  if (debateModel1) headers['X-AAS-Model-Debate-1'] = debateModel1
  if (debateModel2) headers['X-AAS-Model-Debate-2'] = debateModel2
  if (routerModel) headers['X-AAS-Model-Router'] = routerModel
  if (embeddingModel) headers['X-AAS-Model-Embedding'] = embeddingModel

  return headers
}

export const followUpQuestion = async (
  payload: {
    baseQuestion: string
    baseAnswer: string
    prompt: string
    mode?: 'single' | 'debate'
    messages?: FollowUpChatMessage[]
    routedSubject?: 'humanities' | 'science' | 'unknown'
  },
  apiConfig?: ApiConfig
): Promise<FollowUpResponse> => {
  const response = await api.post<FollowUpResponse>('/follow-up', payload, {
    headers: { ...buildApiOverrideHeaders(apiConfig) }
  })
  return response.data
}

export const solveQuestionStream = async (
  imageBlob: Blob,
  onEvent: (event: StreamEvent) => void,
  onUsage?: (usage: UsageInfo) => void,
  apiConfig?: ApiConfig,
  mode?: 'single' | 'debate' | 'auto',
  signal?: AbortSignal
): Promise<SolveQuestionResponse> => {
  const formData = new FormData()
  formData.append('image', imageBlob, 'question.jpg')
  if (mode) {
    formData.append('mode', mode)
  }

  const endpoint = '/solve-auto-stream'

  const fingerprint = await getFingerprintId()
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    body: formData,
    headers: { 'X-AAS-Fingerprint': fingerprint, ...buildApiOverrideHeaders(apiConfig) },
    signal
  })

  if (!response.ok) {
    throw new Error(await parseResponseErrorMessage(response))
  }

  const usage = getUsageInfoFromHeaders(response.headers)
  if (usage) onUsage?.(usage)

  if (!response.body) {
    return solveQuestion(imageBlob)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const bufferRef = { value: '' }
  let finalResult: SolveQuestionResponse | null = null
  let lastCompleteResult: SolveQuestionResponse | null = null

  const processChunk = (chunk: string) => {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.replace(/^data:\s*/, '')
      if (!raw) continue
      let event: StreamEvent
      try {
        event = JSON.parse(raw) as StreamEvent
      } catch {
        continue
      }
      onEvent(event)
      if (event.type === 'complete' && event.result) {
        lastCompleteResult = event.result
        if (!finalResult) {
          finalResult = event.result
        }
      }
      if (event.type === 'final' && event.result) {
        finalResult = event.result
        if (event.usage) onUsage?.(event.usage)
      }
      if (event.type === 'error' && event.message) {
        throw new Error(event.message)
      }
    }
  }

  const processBuffer = (ref: { value: string }) => {
    let splitIndex = ref.value.indexOf('\n\n')
    while (splitIndex !== -1) {
      const chunk = ref.value.slice(0, splitIndex)
      ref.value = ref.value.slice(splitIndex + 2)
      splitIndex = ref.value.indexOf('\n\n')
      processChunk(chunk)
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bufferRef.value += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    processBuffer(bufferRef)
  }

  bufferRef.value += decoder.decode().replace(/\r\n/g, '\n')
  processBuffer(bufferRef)

  if (bufferRef.value.trim()) {
    processChunk(bufferRef.value)
  }

  if (!finalResult && lastCompleteResult) {
    finalResult = lastCompleteResult
  }

  if (!finalResult) {
    throw new Error('未收到最终结果')
  }

  return finalResult
}

export const solveQuestionText = async (
  text: string,
  apiConfig?: ApiConfig,
  mode?: 'single' | 'debate' | 'auto',
  subject?: 'science' | 'humanities' | 'unknown'
): Promise<SolveQuestionResponse> => {
  const payload: Record<string, unknown> = { text }
  if (mode) payload.mode = mode
  if (subject) payload.subject = subject

  const response = await api.post<SolveQuestionResponse>('/solve-text-auto', payload, {
    headers: { ...buildApiOverrideHeaders(apiConfig) }
  })
  return response.data
}

export const solveQuestionMultiStream = async (
  imageBlobs: Blob[],
  prompt: string | undefined,
  onEvent: (event: StreamEvent) => void,
  onUsage?: (usage: UsageInfo) => void,
  apiConfig?: ApiConfig,
  mode?: 'single' | 'debate' | 'auto',
  subject?: 'science' | 'humanities' | 'unknown',
  signal?: AbortSignal
): Promise<SolveQuestionResponse> => {
  const formData = new FormData()
  for (const [index, blob] of imageBlobs.entries()) {
    formData.append('images', blob, `question-${index + 1}.jpg`)
  }
  if (prompt) {
    formData.append('prompt', prompt)
  }
  if (mode) {
    formData.append('mode', mode)
  }
  if (subject) {
    formData.append('subject', subject)
  }

  const endpoint = '/solve-multi-auto-stream'

  const fingerprint = await getFingerprintId()
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    body: formData,
    headers: { 'X-AAS-Fingerprint': fingerprint, ...buildApiOverrideHeaders(apiConfig) },
    signal
  })

  if (!response.ok) {
    throw new Error(await parseResponseErrorMessage(response))
  }

  const usage = getUsageInfoFromHeaders(response.headers)
  if (usage) onUsage?.(usage)

  if (!response.body) {
    // 目前仅实现了流式版本，多图情况下 body 不存在则直接报错
    throw new Error('服务器未返回流式响应')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const bufferRef = { value: '' }
  let finalResult: SolveQuestionResponse | null = null
  let lastCompleteResult: SolveQuestionResponse | null = null

  const processChunk = (chunk: string) => {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.replace(/^data:\s*/, '')
      if (!raw) continue
      let event: StreamEvent
      try {
        event = JSON.parse(raw) as StreamEvent
      } catch {
        continue
      }
      onEvent(event)
      if (event.type === 'complete' && event.result) {
        lastCompleteResult = event.result
        if (!finalResult) {
          finalResult = event.result
        }
      }
      if (event.type === 'final' && event.result) {
        finalResult = event.result
        if (event.usage) onUsage?.(event.usage)
      }
      if (event.type === 'error' && event.message) {
        throw new Error(event.message)
      }
    }
  }

  const processBuffer = (ref: { value: string }) => {
    let splitIndex = ref.value.indexOf('\n\n')
    while (splitIndex !== -1) {
      const chunk = ref.value.slice(0, splitIndex)
      ref.value = ref.value.slice(splitIndex + 2)
      splitIndex = ref.value.indexOf('\n\n')
      processChunk(chunk)
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bufferRef.value += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    processBuffer(bufferRef)
  }

  bufferRef.value += decoder.decode().replace(/\r\n/g, '\n')
  processBuffer(bufferRef)

  if (bufferRef.value.trim()) {
    processChunk(bufferRef.value)
  }

  if (!finalResult && lastCompleteResult) {
    finalResult = lastCompleteResult
  }

  if (!finalResult) {
    throw new Error('未收到最终结果')
  }

  return finalResult
}

export const solveQuestionTextStream = async (
  text: string,
  onEvent: (event: StreamEvent) => void,
  onUsage?: (usage: UsageInfo) => void,
  apiConfig?: ApiConfig,
  mode?: 'single' | 'debate' | 'auto',
  subject?: 'science' | 'humanities' | 'unknown',
  signal?: AbortSignal
): Promise<SolveQuestionResponse> => {
  const payload: Record<string, unknown> = { text }
  if (mode) payload.mode = mode
  if (subject) payload.subject = subject

  const endpoint = '/solve-text-auto-stream'
  const fingerprint = await getFingerprintId()
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      'X-AAS-Fingerprint': fingerprint,
      ...buildApiOverrideHeaders(apiConfig)
    },
    signal
  })

  if (!response.ok) {
    throw new Error(await parseResponseErrorMessage(response))
  }

  const usage = getUsageInfoFromHeaders(response.headers)
  if (usage) onUsage?.(usage)

  let finalResult: SolveQuestionResponse | null = null
  let lastCompleteResult: SolveQuestionResponse | null = null

  const processChunk = (chunk: string) => {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.replace(/^data:\s*/, '')
      if (!raw) continue
      let event: StreamEvent
      try {
        event = JSON.parse(raw) as StreamEvent
      } catch {
        continue
      }
      onEvent(event)
      if (event.type === 'complete' && event.result) {
        lastCompleteResult = event.result
        if (!finalResult) {
          finalResult = event.result
        }
      }
      if (event.type === 'final' && event.result) {
        finalResult = event.result
        if (event.usage) onUsage?.(event.usage)
      }
      if (event.type === 'error' && event.message) {
        throw new Error(event.message)
      }
    }
  }

  const processBuffer = (bufferRef: { value: string }) => {
    let splitIndex = bufferRef.value.indexOf('\n\n')
    while (splitIndex !== -1) {
      const chunk = bufferRef.value.slice(0, splitIndex)
      bufferRef.value = bufferRef.value.slice(splitIndex + 2)
      splitIndex = bufferRef.value.indexOf('\n\n')
      processChunk(chunk)
    }
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType && !contentType.includes('text/event-stream')) {
    const rawText = await response.text()
    if (rawText?.trim()) {
      try {
        const data = JSON.parse(rawText) as SolveQuestionResponse
        if (data && typeof data.answer === 'string' && typeof data.question === 'string') {
          return data
        }
      } catch {
        // fall through to SSE parsing
      }

      const bufferRef = { value: rawText.replace(/\r\n/g, '\n') }
      processBuffer(bufferRef)
      if (bufferRef.value.trim()) {
        processChunk(bufferRef.value)
      }

      if (!finalResult && lastCompleteResult) {
        finalResult = lastCompleteResult
      }
      if (finalResult) {
        return finalResult
      }

      throw new Error(`服务端返回非流式响应：${rawText.slice(0, 200)}`)
    }

    return solveQuestionText(text, apiConfig, mode, subject)
  }

  if (!response.body) {
    return solveQuestionText(text, apiConfig, mode, subject)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const bufferRef = { value: '' }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bufferRef.value += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    processBuffer(bufferRef)
  }

  bufferRef.value += decoder.decode().replace(/\r\n/g, '\n')
  processBuffer(bufferRef)

  if (bufferRef.value.trim()) {
    processChunk(bufferRef.value)
  }

  if (!finalResult && lastCompleteResult) {
    finalResult = lastCompleteResult
  }

  if (!finalResult) {
    return solveQuestionText(text, apiConfig, mode, subject)
  }

  return finalResult
}
