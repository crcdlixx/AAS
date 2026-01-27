import { estimateTokensFromText } from './tokenUsage.js'
import { HttpError } from './httpError.js'

export type KnowledgeBaseSession = {
  clientId: string
  files: KnowledgeBaseFile[]
  createdAt: number
  lastAccessedAt: number
}

export type KnowledgeBaseFile = {
  id: string
  originalName: string
  type: 'pdf' | 'txt'
  content: string
  extractionMethod: 'text' | 'image-fallback'
  sizeBytes: number
  uploadedAt: number
}

const sessions = new Map<string, KnowledgeBaseSession>()
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2 hours
const MAX_CONTENT_TOKENS = 8000

const toPositiveInt = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n)) return null
  const i = Math.floor(n)
  return i > 0 ? i : null
}

const getKbMaxFiles = (): number => toPositiveInt(process.env.KB_MAX_FILES) ?? 20
const getKbMaxTotalBytes = (): number => toPositiveInt(process.env.KB_MAX_TOTAL_BYTES) ?? 50 * 1024 * 1024

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
