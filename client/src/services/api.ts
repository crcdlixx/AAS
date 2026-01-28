import axios from 'axios'
import { getFingerprintId } from '../utils/fingerprint'

const api = axios.create({
  baseURL: '/api',
  timeout: 120000, // 增加超时时间以支持多模型博弈
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
  model?: string
}

export const getAvailableModels = async (): Promise<string[]> => {
  const response = await api.get<{ models: string[] }>('/models')
  return Array.isArray(response.data?.models) ? response.data.models : []
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
  const response = await fetch('/api/usage', { headers: { 'X-AAS-Fingerprint': fingerprint } })
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

const buildApiOverrideHeaders = (apiConfig?: ApiConfig) => {
  if (!apiConfig?.apiKey) return {}
  const headers: Record<string, string> = { 'X-AAS-Api-Key': apiConfig.apiKey }
  if (apiConfig.baseUrl) headers['X-AAS-Base-Url'] = apiConfig.baseUrl
  if (apiConfig.model) headers['X-AAS-Model'] = apiConfig.model
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
  mode?: 'single' | 'debate' | 'auto'
): Promise<SolveQuestionResponse> => {
  const formData = new FormData()
  formData.append('image', imageBlob, 'question.jpg')
  if (mode) {
    formData.append('mode', mode)
  }

  const endpoint = '/solve-auto-stream'

  const fingerprint = await getFingerprintId()
  const response = await fetch(`/api${endpoint}`, {
    method: 'POST',
    body: formData,
    headers: { 'X-AAS-Fingerprint': fingerprint, ...buildApiOverrideHeaders(apiConfig) }
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
  let buffer = ''
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

  const processBuffer = () => {
    let splitIndex = buffer.indexOf('\n\n')
    while (splitIndex !== -1) {
      const chunk = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + 2)
      splitIndex = buffer.indexOf('\n\n')
      processChunk(chunk)
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    processBuffer()
  }

  buffer += decoder.decode().replace(/\r\n/g, '\n')
  processBuffer()

  if (buffer.trim()) {
    processChunk(buffer)
  }

  if (!finalResult && lastCompleteResult) {
    finalResult = lastCompleteResult
  }

  if (!finalResult) {
    throw new Error('未收到最终结果')
  }

  return finalResult
}

export const solveQuestionMultiStream = async (
  imageBlobs: Blob[],
  prompt: string | undefined,
  onEvent: (event: StreamEvent) => void,
  onUsage?: (usage: UsageInfo) => void,
  apiConfig?: ApiConfig,
  mode?: 'single' | 'debate' | 'auto',
  subject?: 'science' | 'humanities' | 'unknown'
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
  const response = await fetch(`/api${endpoint}`, {
    method: 'POST',
    body: formData,
    headers: { 'X-AAS-Fingerprint': fingerprint, ...buildApiOverrideHeaders(apiConfig) }
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
  let buffer = ''
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

  const processBuffer = () => {
    let splitIndex = buffer.indexOf('\n\n')
    while (splitIndex !== -1) {
      const chunk = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + 2)
      splitIndex = buffer.indexOf('\n\n')
      processChunk(chunk)
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    processBuffer()
  }

  buffer += decoder.decode().replace(/\r\n/g, '\n')
  processBuffer()

  if (buffer.trim()) {
    processChunk(buffer)
  }

  if (!finalResult && lastCompleteResult) {
    finalResult = lastCompleteResult
  }

  if (!finalResult) {
    throw new Error('未收到最终结果')
  }

  return finalResult
}
