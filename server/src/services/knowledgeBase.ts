import { estimateTokensFromText } from './tokenUsage.js'

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
