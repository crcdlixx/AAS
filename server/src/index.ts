import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createUsageLimiter, UsageLimitError } from './services/usageLimit.js'
import { normalizeApiOverride, type ApiOverride } from './services/apiOverride.js'
import {
  solveQuestion,
  solveQuestionFromImages,
  solveQuestionStream,
  solveQuestionStreamFromImages,
  answerFollowUp,
  type StreamUpdate
} from './services/openai.js'
import {
  applyModelOverride,
  buildRouteDecisionFromSubject,
  getSubjectDebateModelsOverride,
  getSubjectSingleModelOverride,
  routeQuestionFromImages,
  routeQuestionFromImagesWithModeOverride,
  type RouteDecision,
  type RouteMode,
  type RouteSubject,
  type UserMode
} from './services/router.js'
import { enrichScienceAnswerWithMcp, withScienceMcpHint } from './services/scienceMcp.js'
import {
  solveQuestionWithDebate,
  solveQuestionWithDebateFromImages,
  solveQuestionWithDebateStream,
  solveQuestionWithDebateStreamFromImages,
  answerFollowUpWithDebate
} from './services/debate.js'
import {
  addFile,
  assertCanAddFiles,
  removeFile,
  clearSession,
  getSessionFiles,
  getContentForPrompt,
  startCleanupTimer,
  type KnowledgeBaseFile
} from './services/knowledgeBase.js'
import { HttpError } from './services/httpError.js'
import { validateImageFileMagic, validatePdfFileMagic, validateTextFileLooksText } from './services/uploadValidation.js'
import { extractPdfContent } from './services/pdfProcessor.js'
import { extractTxtContent } from './services/txtProcessor.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5174

const parseTrustProxy = (value: string): boolean | number | string => {
  const v = value.trim()
  if (!v) return 1
  if (v === 'true') return true
  if (v === 'false') return false
  const n = Number.parseInt(v, 10)
  if (Number.isFinite(n) && n >= 0) return n
  return v
}

if (typeof process.env.TRUST_PROXY === 'string') {
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY))
} else if (process.env.NODE_ENV === 'production') {
  // Default: behind 1 reverse proxy hop (nginx/caddy).
  app.set('trust proxy', 1)
}

const parseModelList = (value: unknown): string[] => {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const getAvailableModelsFromEnv = (): string[] => {
  const orderedSources: string[] = []

  orderedSources.push(...parseModelList(process.env.AAS_MODEL_LIST))

  // Defaults
  orderedSources.push(...parseModelList(process.env.OPENAI_MODEL))
  orderedSources.push(...parseModelList(process.env.ROUTER_MODEL))
  orderedSources.push(...parseModelList(process.env.MODEL1_NAME))
  orderedSources.push(...parseModelList(process.env.MODEL2_NAME))

  // Routing lists
  orderedSources.push(...parseModelList(process.env.ROUTE_HUMANITIES_SINGLE_MODELS))
  orderedSources.push(...parseModelList(process.env.ROUTE_SCIENCE_SINGLE_MODELS))
  orderedSources.push(...parseModelList(process.env.ROUTE_UNKNOWN_SINGLE_MODELS))

  orderedSources.push(...parseModelList(process.env.ROUTE_HUMANITIES_DEBATE_MODELS))
  orderedSources.push(...parseModelList(process.env.ROUTE_SCIENCE_DEBATE_MODELS))
  orderedSources.push(...parseModelList(process.env.ROUTE_UNKNOWN_DEBATE_MODELS))

  // Legacy single-model overrides
  orderedSources.push(...parseModelList(process.env.ROUTE_HUMANITIES_MODEL))
  orderedSources.push(...parseModelList(process.env.ROUTE_SCIENCE_MODEL))
  orderedSources.push(...parseModelList(process.env.ROUTE_UNKNOWN_MODEL))

  // Debate per-subject overrides
  orderedSources.push(...parseModelList(process.env.ROUTE_HUMANITIES_DEBATE_MODEL1_NAME))
  orderedSources.push(...parseModelList(process.env.ROUTE_HUMANITIES_DEBATE_MODEL2_NAME))
  orderedSources.push(...parseModelList(process.env.ROUTE_SCIENCE_DEBATE_MODEL1_NAME))
  orderedSources.push(...parseModelList(process.env.ROUTE_SCIENCE_DEBATE_MODEL2_NAME))
  orderedSources.push(...parseModelList(process.env.ROUTE_UNKNOWN_DEBATE_MODEL1_NAME))
  orderedSources.push(...parseModelList(process.env.ROUTE_UNKNOWN_DEBATE_MODEL2_NAME))

  const out: string[] = []
  const seen = new Set<string>()
  for (const model of orderedSources) {
    const key = model.trim()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

const usageLimiter = createUsageLimiter({
  limitTokens: process.env.USAGE_LIMIT_TOKENS,
  windowHours: process.env.USAGE_LIMIT_WINDOW_HOURS,
  storePath: path.join(__dirname, '../usage-store.json')
})

const usageGuard: RequestHandler = (req, res, next) => {
  const clientId = usageLimiter.getClientId(req)
  ;(req as any).clientId = clientId

  try {
    const snap = usageLimiter.assertAllowed(clientId)
    usageLimiter.setHeaders(res, snap)
    next()
  } catch (e) {
    if (e instanceof UsageLimitError) {
      usageLimiter.setHeaders(res, e.snapshot)
      res.status(e.statusCode).json({
        error: e.message,
        enabled: e.snapshot.enabled,
        limitTokens: e.snapshot.limitTokens,
        usedTokens: e.snapshot.usedTokens,
        remainingTokens: e.snapshot.remainingTokens,
        resetAtMs: e.snapshot.resetAtMs
      })
      return
    }
    next(e)
  }
}

const getApiOverrideFromRequest = (req: express.Request): ApiOverride | undefined => {
  const getHeader = (name: string) => {
    const value = (req.headers as any)[name]
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }

  const apiKey = getHeader('x-aas-api-key')
  const baseURL = getHeader('x-aas-base-url')
  const model = getHeader('x-aas-model')

  return normalizeApiOverride({ apiKey, baseURL, model })
}

// 中间件
app.use(cors())
app.use(express.json())

app.get('/api/models', (_req, res) => {
  res.json({ models: getAvailableModelsFromEnv() })
})

// 创建上传目录
const uploadsDir = path.join(__dirname, '../uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
    const mimetype = allowedTypes.test(file.mimetype)

    if (mimetype && extname) {
      return cb(null, true)
    } else {
      cb(new Error('只支持图片文件！'))
    }
  }
})

// 配置知识库文件上传
const kbStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
    cb(null, 'kb-' + uniqueSuffix + path.extname(file.originalname))
  }
})

const kbUpload = multer({
  storage: kbStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|txt/
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
    const mimetype = file.mimetype === 'application/pdf' || file.mimetype === 'text/plain'

    if (mimetype && extname) {
      return cb(null, true)
    } else {
      cb(new Error('只支持 PDF 和 TXT 文件！'))
    }
  }
})

const cleanupUploadedFiles = (files: Express.Multer.File[] | undefined) => {
  if (!files?.length) return
  for (const file of files) {
    try {
      fs.unlinkSync(file.path)
    } catch (e) {
      console.error('删除临时文件失败:', e)
    }
  }
}

const subjectLabel = (subject: RouteSubject) => {
  if (subject === 'science') return '理科'
  if (subject === 'humanities') return '文科'
  return '不确定'
}

const modeLabel = (mode: RouteMode) => (mode === 'debate' ? '双模型审查' : '单模型')

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

const parseUserSubject = (raw: unknown): RouteSubject | undefined => {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'science' || v === 'humanities' || v === 'unknown') return v as RouteSubject
  return undefined
}

const attachRouting = (result: any, decision: RouteDecision, userMode?: UserMode, kbInfo?: any) => {
  const baseTokens = typeof result?.tokensUsed === 'number' ? result.tokensUsed : 0
  return {
    ...result,
    routedSubject: decision.subject,
    routedMode: decision.mode,
    userMode: userMode || 'auto',
    routerModel: decision.routerModel,
    routerConfidence: decision.confidence,
    routerTokensUsed: decision.routerTokensUsed,
    tokensUsed: baseTokens + decision.routerTokensUsed,
    ...(kbInfo
      ? {
          knowledgeBaseUsed: kbInfo.used,
          knowledgeBaseFiles: kbInfo.filesCount,
          knowledgeBaseTruncated: kbInfo.truncated
        }
      : {})
  }
}

const assertUploadOk = (result: { ok: boolean; reason?: string; code?: string }) => {
  if (result.ok) return
  throw new HttpError(400, result.reason || '上传文件校验失败', result.code || 'UPLOAD_INVALID')
}

// API路由 - 自动路由解答（单图）
app.post('/api/solve-auto', usageGuard, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const imagePath = req.file.path
    assertUploadOk(validateImageFileMagic(imagePath))
    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)
    const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

    // Extract user mode from request body
    const userMode: UserMode = ['single', 'debate', 'auto'].includes(req.body?.mode)
      ? (req.body.mode as UserMode)
      : 'auto'

    const userSubject = parseUserSubject(req.body?.subject)
    const decision = userSubject
      ? buildRouteDecisionFromSubject(userSubject, userMode)
      : await routeQuestionFromImagesWithModeOverride([imagePath], userMode, undefined, apiOverride)
    const answerOverride = applyModelOverride(apiOverride, getSubjectSingleModelOverride(decision.subject))
    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'

    const result =
      decision.mode === 'debate'
        ? await solveQuestionWithDebate(imagePath, maxIterations, apiOverride, debateModelsOverride)
        : await solveQuestion(imagePath, answerOverride)

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            const mcp = await enrichScienceAnswerWithMcp({ question: result.question, answer: result.answer, apiOverride })
            return {
              ...result,
              answer: mcp.answer,
              tokensUsed: (result as any)?.tokensUsed ? (result as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : result

    const enriched = attachRouting(enrichedResult, decision, userMode)
    const snap = usageLimiter.addUsage(clientId, (enriched as any)?.tokensUsed ?? 0)

    fs.unlinkSync(imagePath)
    usageLimiter.setHeaders(res, snap)
    res.json(enriched)
  } catch (error) {
    if (error instanceof HttpError) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path)
        } catch (e) {
          console.error('删除临时文件失败:', e)
        }
      }
      res.status(error.statusCode).json({ error: error.message, code: error.code })
      return
    }

    console.error('自动路由解答失败:', error instanceof Error ? error.message : error)

    if (req.file) {
      try {
        fs.unlinkSync(req.file.path)
      } catch (e) {
        console.error('删除临时文件失败:', e)
      }
    }

    res.status(500).json({
      error: '自动路由解答失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 自动路由解答（多图）
app.post('/api/solve-multi-auto', usageGuard, upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  try {
    if (!files.length) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    for (const f of files) {
      assertUploadOk(validateImageFileMagic(f.path))
    }

    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)
    const promptRaw = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
    const imagePaths = files.map((file) => file.path)
    const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

    // Extract user mode from request body
    const userMode: UserMode = ['single', 'debate', 'auto'].includes(req.body?.mode)
      ? (req.body.mode as UserMode)
      : 'auto'

    const userSubject = parseUserSubject(req.body?.subject)
    const decision = userSubject
      ? buildRouteDecisionFromSubject(userSubject, userMode)
      : await routeQuestionFromImagesWithModeOverride(imagePaths, userMode, promptRaw, apiOverride)
    const answerOverride = applyModelOverride(apiOverride, getSubjectSingleModelOverride(decision.subject))
    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'
    const prompt = scienceMcpEnabled ? withScienceMcpHint(promptRaw) : promptRaw

    const result =
      decision.mode === 'debate'
        ? await solveQuestionWithDebateFromImages(imagePaths, maxIterations, prompt, apiOverride, debateModelsOverride)
        : await solveQuestionFromImages(imagePaths, prompt, answerOverride)

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            const mcp = await enrichScienceAnswerWithMcp({ question: result.question, answer: result.answer, apiOverride })
            return {
              ...result,
              answer: mcp.answer,
              tokensUsed: (result as any)?.tokensUsed ? (result as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : result

    const enriched = attachRouting(enrichedResult, decision, userMode)
    const snap = usageLimiter.addUsage(clientId, (enriched as any)?.tokensUsed ?? 0)

    cleanupUploadedFiles(files)
    usageLimiter.setHeaders(res, snap)
    res.json(enriched)
  } catch (error) {
    if (error instanceof HttpError) {
      cleanupUploadedFiles(files)
      res.status(error.statusCode).json({ error: error.message, code: error.code })
      return
    }
    console.error('自动路由解答失败:', error instanceof Error ? error.message : error)
    cleanupUploadedFiles(files)
    res.status(500).json({
      error: '自动路由解答失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 自动路由解答（单图，流式）
app.post('/api/solve-auto-stream', usageGuard, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  const imagePath = req.file.path
  try {
    assertUploadOk(validateImageFileMagic(imagePath))
  } catch (e) {
    try {
      fs.unlinkSync(imagePath)
    } catch {}
    if (e instanceof HttpError) {
      return res.status(e.statusCode).json({ error: e.message, code: e.code })
    }
    return res.status(400).json({ error: '图片文件校验失败' })
  }
  const clientId = (req as any).clientId as string
  const apiOverride = getApiOverrideFromRequest(req)
  const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

  // Extract user mode from request body
  const userMode: UserMode = ['single', 'debate', 'auto'].includes(req.body?.mode)
    ? (req.body.mode as UserMode)
    : 'auto'

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const resAny = res as any
  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    if (typeof resAny.flush === 'function') {
      resAny.flush()
    }
  }

  try {
    const userSubject = parseUserSubject(req.body?.subject)
    const decision = userSubject
      ? buildRouteDecisionFromSubject(userSubject, userMode)
      : await routeQuestionFromImagesWithModeOverride([imagePath], userMode, undefined, apiOverride)
    const routePrefix = decision.routerModel === 'manual' ? '用户选择' : '路由结果'
    const routeMessage = `${routePrefix}：${subjectLabel(decision.subject)} → ${modeLabel(decision.mode)}${
      typeof decision.confidence === 'number' ? `（置信度 ${decision.confidence.toFixed(2)}）` : ''
    }`
    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'

    // Check for knowledge base content
    let enhancedPrompt: string | undefined
    let kbInfo = { used: false, filesCount: 0, truncated: false }

    if (decision.subject === 'humanities') {
      const kbContent = getContentForPrompt(clientId)
      if (kbContent) {
        enhancedPrompt = `【参考资料】\n以下是用户提供的知识库内容，请在解答时参考这些资料：\n\n${kbContent.content}\n\n请基于上述参考资料和题目图片，给出详细解答。`
        kbInfo = { used: true, filesCount: kbContent.filesIncluded, truncated: kbContent.truncated }
        console.log('[KB] Content injected:', {
          clientId,
          subject: 'humanities',
          filesCount: kbContent.filesIncluded,
          truncated: kbContent.truncated
        })
        if (kbContent.truncated) {
          send({ type: 'status', message: `知识库内容已截断（仅使用最近 ${kbContent.filesIncluded} 个文件）` })
        }
      }
    }

    const result =
      decision.mode === 'debate'
        ? (send({ type: 'status', message: routeMessage }),
          await solveQuestionWithDebateStreamFromImages(
            [imagePath],
            maxIterations,
            enhancedPrompt,
            (update) => send(update),
            apiOverride,
            debateModelsOverride
          ))
        : await solveQuestionStreamFromImages(
            [imagePath],
            enhancedPrompt,
            (update: StreamUpdate) => {
              switch (update.type) {
                case 'start':
                  send({ type: 'start' })
                  send({ type: 'status', message: routeMessage })
                  break
                case 'delta':
                  send({ type: 'delta', value: update.value })
                  break
                case 'complete':
                  send({ type: 'complete', value: update.value, result: update.result })
                  break
                case 'error':
                  send({ type: 'error', message: update.message })
                  break
              }
            },
            applyModelOverride(apiOverride, getSubjectSingleModelOverride(decision.subject))
          )

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            send({ type: 'status', message: '理科：调用 MCP 工具中...' })
            const mcp = await enrichScienceAnswerWithMcp({ question: result.question, answer: result.answer, apiOverride })
            return {
              ...result,
              answer: mcp.answer,
              tokensUsed: (result as any)?.tokensUsed ? (result as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : result

    const enriched = attachRouting(enrichedResult, decision, userMode, kbInfo)
    const snap = usageLimiter.addUsage(clientId, (enriched as any)?.tokensUsed ?? 0)
    send({
      type: 'final',
      result: enriched,
      usage: {
        enabled: snap.enabled,
        windowHours: snap.windowHours,
        limitTokens: snap.limitTokens,
        usedTokens: snap.usedTokens,
        remainingTokens: snap.remainingTokens,
        resetAtMs: snap.resetAtMs
      }
    })
    res.end()
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : '未知错误' })
    res.end()
  } finally {
    try {
      fs.unlinkSync(imagePath)
    } catch (e) {
      console.error('删除临时文件失败:', e)
    }
  }
})

// API路由 - 自动路由解答（多图，流式）
app.post('/api/solve-multi-auto-stream', usageGuard, upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  try {
    for (const f of files) {
      assertUploadOk(validateImageFileMagic(f.path))
    }
  } catch (e) {
    cleanupUploadedFiles(files)
    if (e instanceof HttpError) {
      return res.status(e.statusCode).json({ error: e.message, code: e.code })
    }
    return res.status(400).json({ error: '图片文件校验失败' })
  }

  const clientId = (req as any).clientId as string
  const apiOverride = getApiOverrideFromRequest(req)
  const promptRaw = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
  const imagePaths = files.map((file) => file.path)
  const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

  // Extract user mode from request body
  const userMode: UserMode = ['single', 'debate', 'auto'].includes(req.body?.mode)
    ? (req.body.mode as UserMode)
    : 'auto'

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const resAny = res as any
  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    if (typeof resAny.flush === 'function') {
      resAny.flush()
    }
  }

  try {
    const userSubject = parseUserSubject(req.body?.subject)
    const decision = userSubject
      ? buildRouteDecisionFromSubject(userSubject, userMode)
      : await routeQuestionFromImagesWithModeOverride(imagePaths, userMode, promptRaw, apiOverride)
    const routePrefix = decision.routerModel === 'manual' ? '用户选择' : '路由结果'
    const routeMessage = `${routePrefix}：${subjectLabel(decision.subject)} → ${modeLabel(decision.mode)}${
      typeof decision.confidence === 'number' ? `（置信度 ${decision.confidence.toFixed(2)}）` : ''
    }`
    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'

    // Check for knowledge base content
    let kbInfo = { used: false, filesCount: 0, truncated: false }
    let finalPrompt = promptRaw

    if (decision.subject === 'humanities') {
      const kbContent = getContentForPrompt(clientId)
      if (kbContent) {
        const kbPrompt = `【参考资料】\n以下是用户提供的知识库内容，请在解答时参考这些资料：\n\n${kbContent.content}\n\n请基于上述参考资料和题目图片，给出详细解答。`
        finalPrompt = promptRaw ? `${kbPrompt}\n\n${promptRaw}` : kbPrompt
        kbInfo = { used: true, filesCount: kbContent.filesIncluded, truncated: kbContent.truncated }
        console.log('[KB] Content injected:', {
          clientId,
          subject: 'humanities',
          filesCount: kbContent.filesIncluded,
          truncated: kbContent.truncated
        })
        if (kbContent.truncated) {
          send({ type: 'status', message: `知识库内容已截断（仅使用最近 ${kbContent.filesIncluded} 个文件）` })
        }
      }
    }

    const prompt = scienceMcpEnabled ? withScienceMcpHint(finalPrompt) : finalPrompt

    const result =
      decision.mode === 'debate'
        ? (send({ type: 'status', message: routeMessage }),
          await solveQuestionWithDebateStreamFromImages(
            imagePaths,
            maxIterations,
            prompt,
            (update) => send(update),
            apiOverride,
            debateModelsOverride
          ))
        : await solveQuestionStreamFromImages(
            imagePaths,
            prompt,
            (update: StreamUpdate) => {
              switch (update.type) {
                case 'start':
                  send({ type: 'start' })
                  send({ type: 'status', message: routeMessage })
                  break
                case 'delta':
                  send({ type: 'delta', value: update.value })
                  break
                case 'complete':
                  send({ type: 'complete', value: update.value, result: update.result })
                  break
                case 'error':
                  send({ type: 'error', message: update.message })
                  break
              }
            },
            applyModelOverride(apiOverride, getSubjectSingleModelOverride(decision.subject))
          )

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            send({ type: 'status', message: '理科：调用 MCP 工具中...' })
            const mcp = await enrichScienceAnswerWithMcp({ question: result.question, answer: result.answer, apiOverride })
            return {
              ...result,
              answer: mcp.answer,
              tokensUsed: (result as any)?.tokensUsed ? (result as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : result

    const enriched = attachRouting(enrichedResult, decision, userMode, kbInfo)
    const snap = usageLimiter.addUsage(clientId, (enriched as any)?.tokensUsed ?? 0)
    send({
      type: 'final',
      result: enriched,
      usage: {
        enabled: snap.enabled,
        windowHours: snap.windowHours,
        limitTokens: snap.limitTokens,
        usedTokens: snap.usedTokens,
        remainingTokens: snap.remainingTokens,
        resetAtMs: snap.resetAtMs
      }
    })
    res.end()
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : '未知错误' })
    res.end()
  } finally {
    cleanupUploadedFiles(files)
  }
})

// Knowledge Base Routes
app.post('/api/knowledge-base/upload', usageGuard, kbUpload.array('files', 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  const clientId = (req as any).clientId as string

  try {
    if (!files.length) {
      return res.status(400).json({ error: '请上传文件' })
    }

    assertCanAddFiles(
      clientId,
      files.map((f) => ({ sizeBytes: f.size, originalName: f.originalname }))
    )

    const processedFiles = []

    for (const file of files) {
      try {
        const fileType = path.extname(file.originalname).toLowerCase() === '.pdf' ? 'pdf' : 'txt'
        if (fileType === 'pdf') {
          assertUploadOk(validatePdfFileMagic(file.path))
        } else {
          assertUploadOk(validateTextFileLooksText(file.path))
        }
        let content: string
        let extractionMethod: 'text' | 'image-fallback' = 'text'

        if (fileType === 'pdf') {
          const result = await extractPdfContent(file.path)
          content = result.content
          extractionMethod = result.method
        } else {
          content = await extractTxtContent(file.path)
        }

        const kbFile: KnowledgeBaseFile = {
          id: createId(),
          originalName: file.originalname,
          type: fileType,
          content,
          extractionMethod,
          sizeBytes: file.size,
          uploadedAt: Date.now()
        }

        addFile(clientId, kbFile)
        processedFiles.push({
          id: kbFile.id,
          originalName: kbFile.originalName,
          type: kbFile.type,
          extractionMethod: kbFile.extractionMethod,
          sizeBytes: kbFile.sizeBytes,
          uploadedAt: kbFile.uploadedAt
        })

        console.log('[KB] File uploaded:', {
          clientId,
          fileName: file.originalname,
          type: fileType,
          size: file.size,
          extractionMethod
        })
      } catch (error) {
        console.error('[KB] File processing failed:', file.originalname, error)
        processedFiles.push({
          originalName: file.originalname,
          error: error instanceof Error ? error.message : '处理失败',
          ...(error instanceof HttpError ? { code: error.code } : {})
        } as any)
      } finally {
        // Clean up uploaded file
        try {
          fs.unlinkSync(file.path)
        } catch (e) {
          console.error('[KB] Failed to delete temp file:', e)
        }
      }
    }

    const allFiles = getSessionFiles(clientId)
    const totalSize = allFiles.reduce((sum, f) => sum + f.sizeBytes, 0)

    res.json({
      files: processedFiles,
      sessionInfo: {
        totalFiles: allFiles.length,
        totalSize
      }
    })
  } catch (error) {
    if (error instanceof HttpError) {
      cleanupUploadedFiles(files)
      return res.status(error.statusCode).json({ error: error.message, code: error.code })
    }
    cleanupUploadedFiles(files)
    res.status(500).json({
      error: '文件上传失败',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

app.get('/api/knowledge-base/list', usageGuard, (req, res) => {
  const clientId = (req as any).clientId as string
  const files = getSessionFiles(clientId)

  res.json({
    files: files.map((f) => ({
      id: f.id,
      originalName: f.originalName,
      type: f.type,
      extractionMethod: f.extractionMethod,
      sizeBytes: f.sizeBytes,
      uploadedAt: f.uploadedAt
    }))
  })
})

app.delete('/api/knowledge-base/:fileId', usageGuard, (req, res) => {
  const clientId = (req as any).clientId as string
  const fileId = req.params.fileId

  const success = removeFile(clientId, fileId)

  if (success) {
    console.log('[KB] File removed:', { clientId, fileId })
    res.json({ success: true })
  } else {
    res.status(404).json({ error: '文件不存在' })
  }
})

app.delete('/api/knowledge-base/clear', usageGuard, (req, res) => {
  const clientId = (req as any).clientId as string
  clearSession(clientId)
  console.log('[KB] Session cleared:', { clientId })
  res.json({ success: true })
})

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.post('/api/follow-up', usageGuard, async (req, res) => {
  try {
    const body: any = req.body || {}
    const baseQuestion = typeof body.baseQuestion === 'string' ? body.baseQuestion : ''
    const baseAnswer = typeof body.baseAnswer === 'string' ? body.baseAnswer : ''
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    const mode = body.mode === 'debate' ? 'debate' : 'single'
    const messages = body.messages
    const routedSubjectRaw = body.routedSubject
    const routedSubject: RouteSubject | undefined =
      routedSubjectRaw === 'science' || routedSubjectRaw === 'humanities' || routedSubjectRaw === 'unknown'
        ? routedSubjectRaw
        : undefined

    if (!baseQuestion.trim() || !baseAnswer.trim() || !prompt.trim()) {
      return res.status(400).json({ error: 'baseQuestion/baseAnswer/prompt 不能为空' })
    }

    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)

    const result =
      mode === 'debate'
        ? await answerFollowUpWithDebate({
            baseQuestion,
            baseAnswer,
            prompt,
            messages,
            maxIterations: parseInt(process.env.MAX_DEBATE_ITERATIONS || '3', 10),
            apiOverride,
            modelsOverride: routedSubject ? getSubjectDebateModelsOverride(routedSubject) : undefined
          })
        : await answerFollowUp({ baseQuestion, baseAnswer, prompt, messages, apiOverride })

    const snap = usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)
    usageLimiter.setHeaders(res, snap)
    res.json(result)
  } catch (error) {
    console.error('追问失败:', error instanceof Error ? error.message : error)
    res.status(500).json({
      error: '追问失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

app.get('/api/usage', (req, res) => {
  const clientId = usageLimiter.getClientId(req)
  const snap = usageLimiter.snapshot(clientId)
  usageLimiter.setHeaders(res, snap)
  res.json(snap)
})

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof UsageLimitError) {
    usageLimiter.setHeaders(res, err.snapshot)
    res.status(err.statusCode).json({
      error: err.message,
      enabled: err.snapshot.enabled,
      limitTokens: err.snapshot.limitTokens,
      usedTokens: err.snapshot.usedTokens,
      remainingTokens: err.snapshot.remainingTokens,
      resetAtMs: err.snapshot.resetAtMs
    })
    return
  }

  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code })
    return
  }

  const MulterErrorCtor = (multer as any)?.MulterError
  const isMulterError = typeof MulterErrorCtor === 'function' && err instanceof MulterErrorCtor
  if (isMulterError) {
    const code = (err as any)?.code as string | undefined
    const message =
      code === 'LIMIT_FILE_SIZE'
        ? '上传文件过大'
        : code === 'LIMIT_FILE_COUNT'
          ? '上传文件数量超限'
          : code === 'LIMIT_UNEXPECTED_FILE'
            ? '上传字段不符合预期'
            : err instanceof Error
              ? err.message
              : '上传失败'
    res.status(400).json({ error: message, code: code || 'UPLOAD_MULTER_ERROR' })
    return
  }

  const message = err instanceof Error ? err.message : '未知错误'
  res.status(500).json({ error: message })
}

app.use(errorHandler)

// Start knowledge base cleanup timer
startCleanupTimer()

app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`)
  console.log(`📝 API端点: http://localhost:${PORT}/api`)
})
