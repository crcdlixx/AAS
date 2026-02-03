import { createHash } from 'crypto'

export type FetchModelListOptions = {
  apiKey: string
  baseURL: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 5 * 60_000

type CachedLists = {
  allModels: string[]
  chatModels: string[]
  embeddingModels: string[]
  expiresAtMs: number
}

const cache = new Map<string, CachedLists>()

const normalizeModels = (models: unknown): string[] => {
  if (!Array.isArray(models)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of models) {
    const id = typeof item === 'string' ? item : typeof (item as any)?.id === 'string' ? (item as any).id : ''
    const v = id.trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

const extractModelIds = (payload: any): string[] => {
  if (!payload) return []
  if (Array.isArray(payload)) return normalizeModels(payload)
  if (Array.isArray(payload?.models)) return normalizeModels(payload.models)
  if (Array.isArray(payload?.data)) return normalizeModels(payload.data)
  return []
}

const isLikelyChatModel = (modelId: string): boolean => {
  const v = (modelId || '').trim().toLowerCase()
  if (!v) return false

  // Heuristics: keep chat/completions-like models; drop common non-chat families.
  const deny = [
    'embedding',
    'whisper',
    'tts',
    'dall',
    'image',
    'moderation',
    'audio',
    'transcribe',
    'speech',
    'rerank',
    'ranker'
  ]
  for (const token of deny) {
    if (v.includes(token)) return false
  }
  return true
}

const isLikelyEmbeddingModel = (modelId: string): boolean => {
  const v = (modelId || '').trim().toLowerCase()
  if (!v) return false
  // Best-effort: OpenAI-style names usually contain "embedding". For other providers this may miss embeddings,
  // but it's still useful for UI autocomplete while keeping chat model dropdowns clean.
  if (v.includes('embedding')) return true
  if (v.includes('text-embedding')) return true
  // Common open-source embedding model families exposed by OpenAI-compatible gateways.
  const tokens = ['bge', 'e5', 'gte', 'text2vec', 'm3e', 'nomic-embed', 'jina-embeddings', 'arctic-embed', 'voyage']
  for (const t of tokens) {
    if (v.includes(t)) return true
  }
  return false
}

const filterModelsForChat = (models: string[]): string[] => models.filter(isLikelyChatModel)
const filterModelsForEmbeddings = (models: string[]): string[] => models.filter(isLikelyEmbeddingModel)

const buildModelsUrl = (baseURL: string): string => {
  const raw = (baseURL || '').trim()
  const trimmed = raw.replace(/\/+$/, '')
  if (!trimmed) return 'https://api.openai.com/v1/models'

  try {
    const url = new URL(trimmed)
    const path = url.pathname.replace(/\/+$/, '')
    const hasV1 = /\/v1$/.test(path)
    url.pathname = `${hasV1 ? path : `${path}/v1`}/models`
    return url.toString()
  } catch {
    if (/\/v1$/.test(trimmed)) return `${trimmed}/models`
    return `${trimmed}/v1/models`
  }
}

const cacheKey = (apiKey: string, baseURL: string): string => {
  const keyHash = createHash('sha256').update(apiKey).digest('hex')
  return `${keyHash}|${baseURL}`
}

export async function fetchModelListsFromApi(options: FetchModelListOptions): Promise<{
  allModels: string[]
  chatModels: string[]
  embeddingModels: string[]
}> {
  const apiKey = (options.apiKey || '').trim()
  const baseURL = (options.baseURL || '').trim()
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? (options.timeoutMs as number) : DEFAULT_TIMEOUT_MS
  if (!apiKey) return { allModels: [], chatModels: [], embeddingModels: [] }

  const key = cacheKey(apiKey, baseURL)
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAtMs > now) {
    return { allModels: cached.allModels, chatModels: cached.chatModels, embeddingModels: cached.embeddingModels }
  }

  const url = buildModelsUrl(baseURL || 'https://api.openai.com/v1')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Some OpenAI-compatible gateways accept `api-key` instead of Authorization.
        'api-key': apiKey
      },
      signal: controller.signal
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`models.list failed (${response.status}): ${text?.slice(0, 200) || response.statusText}`)
    }

    let data: any
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`models.list returned non-JSON: ${text?.slice(0, 200) || ''}`)
    }

    const extracted = extractModelIds(data)
    const allModels = extracted
    const chatModels = filterModelsForChat(extracted)
    const embeddingModels = filterModelsForEmbeddings(extracted)

    cache.set(key, { allModels, chatModels, embeddingModels, expiresAtMs: now + CACHE_TTL_MS })
    return { allModels, chatModels, embeddingModels }
  } finally {
    clearTimeout(timeout)
  }
}

// Back-compat: previous API returned chat-like models only.
export async function fetchModelListFromApi(options: FetchModelListOptions): Promise<string[]> {
  const lists = await fetchModelListsFromApi(options)
  return lists.chatModels
}
