import { estimateTokensFromText } from './tokenUsage.js'
import { HttpError } from './httpError.js'
import OpenAI from 'openai'
import { randomUUID } from 'crypto'

export type KnowledgeBaseSession = {
  clientId: string
  files: KnowledgeBaseFile[]
  createdAt: number
  lastAccessedAt: number
}

export type KnowledgeBaseChunk = {
  id: string
  fileId: string
  fileName: string
  index: number
  text: string
  tokens: number
  embedding?: number[]
}

export type KnowledgeBaseFile = {
  id: string
  originalName: string
  description: string
  type: 'pdf' | 'txt'
  content: string
  extractionMethod: 'text' | 'image-fallback'
  sizeBytes: number
  uploadedAt: number
  chunks?: KnowledgeBaseChunk[]
}

export type KnowledgeBaseFileCatalogItem = {
  id: string
  originalName: string
  description: string
  type: 'pdf' | 'txt'
  uploadedAt: number
}

const sessions = new Map<string, KnowledgeBaseSession>()
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2 hours
const MAX_CONTENT_TOKENS = 8000
const DEFAULT_CHUNK_TOKENS = 500
const DEFAULT_CHUNK_OVERLAP_TOKENS = 80
const DEFAULT_TOP_K = 8

const toPositiveInt = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n)) return null
  const i = Math.floor(n)
  return i > 0 ? i : null
}

const getKbMaxFiles = (): number => toPositiveInt(process.env.KB_MAX_FILES) ?? 20
const getKbMaxTotalBytes = (): number => toPositiveInt(process.env.KB_MAX_TOTAL_BYTES) ?? 50 * 1024 * 1024
const getKbChunkTokens = (): number => toPositiveInt(process.env.KB_CHUNK_TOKENS) ?? DEFAULT_CHUNK_TOKENS
const getKbChunkOverlapTokens = (): number => toPositiveInt(process.env.KB_CHUNK_OVERLAP_TOKENS) ?? DEFAULT_CHUNK_OVERLAP_TOKENS
const getKbTopK = (): number => toPositiveInt(process.env.KB_TOP_K) ?? DEFAULT_TOP_K
const getKbRagEnabled = (): boolean => (process.env.KB_RAG_ENABLED ?? '1') !== '0'
const getKbEmbeddingModel = (): string => (process.env.KB_EMBEDDING_MODEL || 'text-embedding-3-small').trim()
const getKbEmbeddingBatchSize = (): number => Math.min(256, Math.max(1, toPositiveInt(process.env.KB_EMBEDDING_BATCH_SIZE) ?? 64))

export function addFile(clientId: string, file: KnowledgeBaseFile): void {
  let session = sessions.get(clientId)
  if (!session) {
    session = {
      clientId,
      files: [],
      createdAt: Date.now(),
      lastAccessedAt: Date.now()
    }
    sessions.set(clientId, session)
  }

  if (getKbRagEnabled() && !file.chunks?.length) {
    file.chunks = buildChunks(file, getKbChunkTokens(), getKbChunkOverlapTokens())
  }

  session.files.push(file)
  session.lastAccessedAt = Date.now()
}

export function removeFile(clientId: string, fileId: string): boolean {
  const session = sessions.get(clientId)
  if (!session) return false
  const index = session.files.findIndex((f) => f.id === fileId)
  if (index === -1) return false
  session.files.splice(index, 1)
  session.lastAccessedAt = Date.now()
  return true
}

export function clearSession(clientId: string): void {
  sessions.delete(clientId)
}

export function getSessionFiles(clientId: string): KnowledgeBaseFile[] {
  const session = sessions.get(clientId)
  if (!session) return []
  session.lastAccessedAt = Date.now()
  return session.files
}

export function getSessionCatalog(clientId: string): KnowledgeBaseFileCatalogItem[] {
  const files = getSessionFiles(clientId)
  return files.map((f) => ({
    id: f.id,
    originalName: f.originalName,
    description: f.description,
    type: f.type,
    uploadedAt: f.uploadedAt
  }))
}

export function assertCanAddFiles(clientId: string, incoming: Array<{ sizeBytes: number; originalName?: string }>): void {
  if (!incoming.length) return
  const existing = getSessionFiles(clientId)
  const currentFiles = existing.length
  const currentBytes = existing.reduce((sum, f) => sum + (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0)

  const incFiles = incoming.length
  const incBytes = incoming.reduce((sum, f) => sum + (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0)

  const maxFiles = getKbMaxFiles()
  const maxBytes = getKbMaxTotalBytes()

  if (currentFiles + incFiles > maxFiles) {
    throw new HttpError(400, `知识库文件数超限：最多 ${maxFiles} 个`, 'KB_LIMIT_FILES')
  }
  if (currentBytes + incBytes > maxBytes) {
    throw new HttpError(400, `知识库总大小超限：最多 ${Math.floor(maxBytes / (1024 * 1024))}MB`, 'KB_LIMIT_BYTES')
  }
}

export function getContentForPrompt(
  clientId: string
):
  | {
      content: string
      truncated: boolean
      filesIncluded: number
    }
  | null {
  const files = getSessionFiles(clientId)
  if (!files.length) return null

  let totalTokens = 0
  let content = ''
  let filesIncluded = 0

  // Process files in reverse order (most recent first)
  for (const file of [...files].reverse()) {
    const fileContent = `[来源: ${file.originalName}]\n${file.content}\n\n`
    const fileTokens = estimateTokensFromText(fileContent)

    if (totalTokens + fileTokens > MAX_CONTENT_TOKENS) {
      break
    }

    content = fileContent + content
    totalTokens += fileTokens
    filesIncluded++
  }

  return {
    content: content.trim(),
    truncated: filesIncluded < files.length,
    filesIncluded
  }
}

type ApiOverrideForKb = { apiKey?: string; baseURL?: string }

const createOpenAIClient = (apiOverride?: ApiOverrideForKb) => {
  const apiKey = apiOverride?.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing; cannot run knowledge base embeddings')
  }
  const baseURL = apiOverride?.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  return new OpenAI({ apiKey, baseURL })
}

const cosineSimilarity = (a: number[], b: number[]) => {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const normalizeQueryTerms = (query: string) =>
  query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)

const keywordScore = (text: string, terms: string[]) => {
  const hay = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    const idx = hay.indexOf(term)
    if (idx !== -1) score += 1
  }
  return score
}

const embedBatch = async (client: OpenAI, model: string, inputs: string[]) => {
  const resp = await client.embeddings.create({ model, input: inputs })
  return resp.data.map((d) => d.embedding as number[])
}

const ensureChunkEmbeddings = async (chunks: KnowledgeBaseChunk[], apiOverride?: ApiOverrideForKb) => {
  const missing = chunks.filter((c) => !c.embedding)
  if (!missing.length) return

  const client = createOpenAIClient(apiOverride)
  const model = getKbEmbeddingModel()
  const batchSize = getKbEmbeddingBatchSize()

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize)
    const embeddings = await embedBatch(client, model, batch.map((c) => c.text))
    for (let j = 0; j < batch.length; j++) {
      batch[j].embedding = embeddings[j]
    }
  }
}

export async function getRagContentForPrompt(
  clientId: string,
  query: string,
  opts?: { apiOverride?: ApiOverrideForKb; topK?: number }
): Promise<
  | {
      content: string
      filesIncluded: number
      chunksIncluded: number
      usedEmbeddings: boolean
    }
  | null
> {
  if (!getKbRagEnabled()) return null
  const q = (query || '').trim()
  if (!q) return null

  const files = getSessionFiles(clientId)
  if (!files.length) return null

  const allChunks: KnowledgeBaseChunk[] = []
  for (const f of files) {
    for (const c of f.chunks || []) allChunks.push(c)
  }
  if (!allChunks.length) return null

  const topK = Math.max(1, Math.min(30, opts?.topK ?? getKbTopK()))

  let usedEmbeddings = false
  let queryEmbedding: number[] | null = null
  try {
    await ensureChunkEmbeddings(allChunks, opts?.apiOverride)
    const client = createOpenAIClient(opts?.apiOverride)
    const embeddings = await embedBatch(client, getKbEmbeddingModel(), [q])
    queryEmbedding = embeddings[0]
    usedEmbeddings = true
  } catch {
    usedEmbeddings = false
  }

  const ranked = allChunks
    .map((c) => {
      const score = usedEmbeddings && queryEmbedding && c.embedding ? cosineSimilarity(queryEmbedding, c.embedding) : keywordScore(c.text, normalizeQueryTerms(q))
      return { chunk: c, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  if (!ranked.length) return null

  const content = ranked
    .map(({ chunk }) => `[KB:${chunk.fileName}#${chunk.index + 1}]\n${chunk.text.trim()}`)
    .join('\n\n')
    .trim()

  const fileNames = new Set(ranked.map((r) => r.chunk.fileId))

  return {
    content,
    filesIncluded: fileNames.size,
    chunksIncluded: ranked.length,
    usedEmbeddings
  }
}

export function startCleanupTimer(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now()
    for (const [clientId, session] of sessions.entries()) {
      if (now - session.lastAccessedAt > SESSION_TIMEOUT_MS) {
        console.log('[KB] Session expired:', {
          clientId,
          age: Math.round((now - session.lastAccessedAt) / 1000 / 60) + 'min'
        })
        sessions.delete(clientId)
      }
    }
  }, 30 * 60 * 1000) // Run every 30 minutes
}

const buildChunks = (file: KnowledgeBaseFile, chunkTokens: number, overlapTokens: number): KnowledgeBaseChunk[] => {
  const raw = (file.content || '').trim()
  if (!raw) return []

  const parts = raw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  const chunks: KnowledgeBaseChunk[] = []
  let buf: string[] = []
  let bufTokens = 0
  let index = 0

  const flush = () => {
    const text = buf.join('\n\n').trim()
    if (!text) return
    const tokens = estimateTokensFromText(text)
    chunks.push({
      id: randomUUID(),
      fileId: file.id,
      fileName: file.originalName,
      index,
      text,
      tokens
    })
    index += 1
  }

  for (const part of parts) {
    const partTokens = estimateTokensFromText(part)
    if (buf.length && bufTokens + partTokens > chunkTokens) {
      flush()

      // Overlap: keep tail parts until overlapTokens budget.
      if (overlapTokens > 0) {
        const nextBuf: string[] = []
        let nextTokens = 0
        for (let i = buf.length - 1; i >= 0; i--) {
          const t = estimateTokensFromText(buf[i])
          if (nextTokens + t > overlapTokens) break
          nextBuf.unshift(buf[i])
          nextTokens += t
        }
        buf = nextBuf
        bufTokens = nextTokens
      } else {
        buf = []
        bufTokens = 0
      }
    }

    if (!buf.length && partTokens > chunkTokens) {
      // Extremely long paragraph: hard-split by characters.
      const sliceSize = Math.max(200, Math.floor(part.length / Math.max(1, Math.ceil(partTokens / chunkTokens))))
      for (let pos = 0; pos < part.length; pos += sliceSize) {
        const slice = part.slice(pos, pos + sliceSize).trim()
        if (!slice) continue
        chunks.push({
          id: randomUUID(),
          fileId: file.id,
          fileName: file.originalName,
          index,
          text: slice,
          tokens: estimateTokensFromText(slice)
        })
        index += 1
      }
      continue
    }

    buf.push(part)
    bufTokens += partTokens
  }

  flush()
  return chunks
}
