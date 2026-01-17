import fs from 'fs'
import path from 'path'
import type { Request, Response } from 'express'

type UsageRecord = {
  windowStartMs: number
  tokensUsed: number
  updatedAtMs: number
}

type UsageStoreFile = {
  version: 1
  records: Record<string, UsageRecord>
}

export type UsageSnapshot = {
  enabled: boolean
  clientId: string
  windowHours: number
  limitTokens: number
  usedTokens: number
  remainingTokens: number
  resetAtMs: number
}

export class UsageLimitError extends Error {
  statusCode = 429
  snapshot: UsageSnapshot

  constructor(message: string, snapshot: UsageSnapshot) {
    super(message)
    this.name = 'UsageLimitError'
    this.snapshot = snapshot
  }
}

const toPositiveInt = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n)) return null
  const i = Math.floor(n)
  return i > 0 ? i : null
}

const toPositiveNumber = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n)) return null
  return n > 0 ? n : null
}

const safeId = (raw: string) => raw.trim().slice(0, 200)

const readStoreFile = (storePath: string): UsageStoreFile => {
  try {
    if (!fs.existsSync(storePath)) return { version: 1, records: {} }
    const text = fs.readFileSync(storePath, 'utf8')
    const parsed = JSON.parse(text) as UsageStoreFile
    if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object') return { version: 1, records: {} }
    return parsed
  } catch {
    return { version: 1, records: {} }
  }
}

const writeStoreFile = (storePath: string, store: UsageStoreFile) => {
  const dir = path.dirname(storePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${storePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmpPath, storePath)
}

export const createUsageLimiter = (opts: {
  limitTokens?: unknown
  windowHours?: unknown
  storePath: string
}) => {
  const limitTokens = toPositiveInt(opts.limitTokens) ?? 0
  const windowHours = toPositiveNumber(opts.windowHours) ?? 24
  const windowMs = Math.floor(windowHours * 60 * 60 * 1000)
  const enabled = limitTokens > 0 && windowMs > 0

  const storePath = opts.storePath
  const store = readStoreFile(storePath)

  const ensureWindow = (clientId: string, nowMs: number): UsageRecord => {
    const existing = store.records[clientId]
    if (!existing) {
      const record: UsageRecord = { windowStartMs: nowMs, tokensUsed: 0, updatedAtMs: nowMs }
      store.records[clientId] = record
      return record
    }
    const expired = nowMs - existing.windowStartMs >= windowMs
    if (expired) {
      existing.windowStartMs = nowMs
      existing.tokensUsed = 0
    }
    existing.updatedAtMs = nowMs
    return existing
  }

  const snapshot = (clientId: string, nowMs = Date.now()): UsageSnapshot => {
    const record = ensureWindow(clientId, nowMs)
    const resetAtMs = record.windowStartMs + windowMs
    const usedTokens = record.tokensUsed
    const remainingTokens = enabled ? Math.max(limitTokens - usedTokens, 0) : 0
    return {
      enabled,
      clientId,
      windowHours,
      limitTokens,
      usedTokens,
      remainingTokens,
      resetAtMs
    }
  }

  const save = () => {
    try {
      // best-effort cleanup: drop idle records older than 30 days
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      for (const [id, rec] of Object.entries(store.records)) {
        if (rec.updatedAtMs < cutoff) delete store.records[id]
      }
      writeStoreFile(storePath, store)
    } catch (e) {
      console.error('usage store write failed:', e)
    }
  }

  const getClientId = (req: Request): string => {
    const header =
      (typeof req.headers['x-aas-fingerprint'] === 'string' ? req.headers['x-aas-fingerprint'] : undefined) ||
      (typeof req.headers['x-fingerprint'] === 'string' ? req.headers['x-fingerprint'] : undefined) ||
      (typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'] : undefined)

    if (header && header.trim()) return safeId(header)

    const ip = req.ip || (typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '')
    return safeId(`ip_${ip || 'unknown'}`)
  }

  const setHeaders = (res: Response, s: UsageSnapshot) => {
    res.setHeader('X-Usage-Limit-Tokens', String(s.limitTokens))
    res.setHeader('X-Usage-Window-Hours', String(s.windowHours))
    res.setHeader('X-Usage-Used-Tokens', String(s.usedTokens))
    res.setHeader('X-Usage-Remaining-Tokens', String(s.remainingTokens))
    res.setHeader('X-Usage-Reset-At', String(s.resetAtMs))
  }

  const assertAllowed = (clientId: string) => {
    const s = snapshot(clientId)
    if (!enabled) return s
    if (s.remainingTokens <= 0) {
      throw new UsageLimitError('用量已达上限，请稍后再试', s)
    }
    return s
  }

  const addUsage = (clientId: string, tokens: number) => {
    if (!enabled) return snapshot(clientId)
    const nowMs = Date.now()
    const record = ensureWindow(clientId, nowMs)
    const inc = Number.isFinite(tokens) ? Math.max(Math.floor(tokens), 0) : 0
    record.tokensUsed += inc
    record.updatedAtMs = nowMs
    save()
    return snapshot(clientId, nowMs)
  }

  return {
    enabled,
    getClientId,
    snapshot,
    assertAllowed,
    addUsage,
    setHeaders
  }
}
