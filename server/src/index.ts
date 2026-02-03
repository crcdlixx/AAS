import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createUsageLimiter, UsageLimitError } from './services/usageLimit.js'
import { normalizeApiOverride, type ApiOverride } from './services/apiOverride.js'
import { fetchModelListsFromApi } from './services/modelList.js'
import {
  solveQuestion,
  solveQuestionFromImages,
  solveQuestionStream,
  solveQuestionStreamFromImages,
  solveQuestionFromText,
  solveQuestionStreamFromText,
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
  routeQuestionFromTextWithModeOverride,
  type RouteDecision,
  type RouteMode,
  type RouteSubject,
  type UserMode
} from './services/router.js'
import { enrichScienceAnswerWithMcp, withScienceMcpHint } from './services/scienceMcp.js'
import {
  solveQuestionWithDebate,
  solveQuestionWithDebateFromImages,
  solveQuestionWithDebateFromText,
  solveQuestionWithDebateStream,
  solveQuestionWithDebateStreamFromImages,
  solveQuestionWithDebateStreamFromText,
  answerFollowUpWithDebate
} from './services/debate.js'
import {
  addFile,
  assertCanAddFiles,
  removeFile,
  clearSession,
  getSessionFiles,
  getSessionCatalog,
  getRagContentForPrompt,
  precomputeFileEmbeddings,
  startCleanupTimer,
  type KnowledgeBaseFile
} from './services/knowledgeBase.js'
import { decideUseKnowledgeBase } from './services/knowledgeBaseDecision.js'
import { HttpError } from './services/httpError.js'
import { validateImageFileMagic, validatePdfFileMagic, validateTextFileLooksText } from './services/uploadValidation.js'
import { extractPdfContent } from './services/pdfProcessor.js'
import { extractTxtContent } from './services/txtProcessor.js'

dotenv.config()

if (typeof process.env.AAS_MODEL_LIST === 'string' && process.env.AAS_MODEL_LIST.trim()) {
  console.warn(
    '[DEPRECATED] AAS_MODEL_LIST is deprecated and will be removed in a future release. ' +
      'The server now fetches model lists from the configured API (/v1/models).'
  )
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

const resolveDataDir = (): string => {
  const explicit = typeof process.env.AAS_DATA_DIR === 'string' ? process.env.AAS_DATA_DIR.trim() : ''
  if (explicit) return path.resolve(explicit)
  return path.join(__dirname, '..')
}

const resolveUploadsDir = (): string => {
  const explicit = typeof process.env.UPLOADS_DIR === 'string' ? process.env.UPLOADS_DIR.trim() : ''
  if (explicit) return path.resolve(explicit)
  return path.join(resolveDataDir(), 'uploads')
}

const resolveUsageStorePath = (): string => {
  const explicit = typeof process.env.USAGE_STORE_PATH === 'string' ? process.env.USAGE_STORE_PATH.trim() : ''
  if (explicit) return path.resolve(explicit)
  return path.join(resolveDataDir(), 'usage-store.json')
}

const normalizePort = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return fallback
    const n = Number.parseInt(trimmed, 10)
    if (Number.isFinite(n)) return Math.max(0, n)
  }
  return fallback
}

// Legacy constant kept to avoid TypeScript errors in unreachable compatibility code paths.
const PORT = normalizePort(process.env.PORT, 5174)

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

const uniqueModels = (models: string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const model of models) {
    const key = (model || '').trim()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

const getAvailableModelsFromEnvFallback = (): string[] => {
  const orderedSources: string[] = []

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

  return uniqueModels(orderedSources)
}

const getAvailableEmbeddingModelsFromEnvFallback = (): string[] => {
  const orderedSources: string[] = []
  if (typeof process.env.KB_EMBEDDING_MODEL === 'string') {
    orderedSources.push(...parseModelList(process.env.KB_EMBEDDING_MODEL))
  }
  return uniqueModels(orderedSources)
}

const getAvailableModelsForRequest = async (
  apiOverride: ApiOverride | undefined
): Promise<{
  models: string[]
  embeddingModels: string[]
  allModels: string[]
  source: 'api' | 'env' | 'deprecated-env'
}> => {
  const apiKey = apiOverride?.apiKey || process.env.OPENAI_API_KEY
  const baseURL = apiOverride?.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const chatFallback = getAvailableModelsFromEnvFallback()
  const embeddingFallback = getAvailableEmbeddingModelsFromEnvFallback()

  if (apiKey) {
    try {
      const fetched = await fetchModelListsFromApi({ apiKey, baseURL })
      const chatMerged = uniqueModels([...fetched.chatModels, ...chatFallback])
      const embeddingMerged = uniqueModels([...fetched.embeddingModels, ...embeddingFallback])
      const allMerged = uniqueModels([...fetched.allModels, ...chatFallback, ...embeddingFallback])
      if (chatMerged.length || embeddingMerged.length || allMerged.length) {
        return {
          models: chatMerged,
          embeddingModels: embeddingMerged,
          allModels: allMerged,
          source: 'api'
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn('Failed to fetch /v1/models; falling back to env-derived model list.', { baseURL, message })
    }
  }

  if (chatFallback.length || embeddingFallback.length) {
    return {
      models: chatFallback,
      embeddingModels: embeddingFallback,
      allModels: uniqueModels([...chatFallback, ...embeddingFallback]),
      source: 'env'
    }
  }

  const legacy = parseModelList(process.env.AAS_MODEL_LIST)
  const legacyUnique = uniqueModels(legacy)
  return { models: legacyUnique, embeddingModels: [], allModels: legacyUnique, source: 'deprecated-env' }
}

const usageLimiter = createUsageLimiter({
  limitTokens: process.env.USAGE_LIMIT_TOKENS,
  windowHours: process.env.USAGE_LIMIT_WINDOW_HOURS,
  storePath: resolveUsageStorePath()
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
  const singleModel = getHeader('x-aas-model-single')
  const debateModel1 = getHeader('x-aas-model-debate-1')
  const debateModel2 = getHeader('x-aas-model-debate-2')
  const routerModel = getHeader('x-aas-model-router')
  const embeddingModel = getHeader('x-aas-model-embedding')

  return normalizeApiOverride({ apiKey, baseURL, model, singleModel, debateModel1, debateModel2, routerModel, embeddingModel })
}

const normalizeSingleModelOverride = (apiOverride: ApiOverride | undefined): ApiOverride | undefined => {
  if (!apiOverride) return undefined
  const user = (apiOverride.singleModel || apiOverride.model || '').trim()
  if (!user) return apiOverride
  if ((apiOverride.model || '').trim() === user) return apiOverride
  return { ...apiOverride, model: user }
}

// 中间件
app.use(cors())
app.use(express.json())

app.get('/api/models', async (req, res, next) => {
  try {
    const apiOverride = getApiOverrideFromRequest(req)
    const result = await getAvailableModelsForRequest(apiOverride)
    res.json({
      models: result.models,
      embeddingModels: result.embeddingModels,
      allModels: result.allModels,
      source: result.source
    })
  } catch (e) {
    next(e)
  }
})

// 创建上传目录
const uploadsDir = resolveUploadsDir()
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

const isAbortError = (error: unknown): boolean => {
  if (!error) return false
  const anyErr = error as any
  if (typeof anyErr?.name === 'string' && anyErr.name === 'AbortError') return true
  const msg = typeof anyErr?.message === 'string' ? anyErr.message : ''
  return msg === 'Aborted' || msg === 'The operation was aborted.'
}

const containsCjk = (text: string): boolean => /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(text)

const fixUploadedOriginalName = (name: string): string => {
  const raw = typeof name === 'string' ? name : ''
  if (!raw) return raw

  // Heuristic for common mojibake like "ä¸­æ–‡.pdf" where UTF-8 bytes were decoded as latin1.
  if (!/[\u00C0-\u00FF]/.test(raw)) return raw

  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8')
    if (!decoded || decoded === raw) return raw
    if (decoded.includes('\uFFFD')) return raw
    if (containsCjk(decoded)) return decoded
    return raw
  } catch {
    return raw
  }
}

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

const buildKbRefinePrompt = (kbContent: string) => {
  const content = (kbContent || '').trim()
  if (!content) return ''
  return [
    '你将基于【参考资料】对现有解答进行校对与补充。',
    '',
    '要求：',
    '- 若资料与原解答冲突，以资料为准并说明。',
    '- 重要结论/定义/条款需要在句末用引用标注：例如 [KB:文件名#1]。',
    '- 输出保持 Markdown；数学公式用 LaTeX（$...$ / $$...$$）。',
    '',
    '【参考资料】',
    content
  ].join('\\n')
}

const maybeGetKbForQuestion = async (
  clientId: string,
  question: string,
  apiOverride?: ApiOverride,
  onStatus?: (message: string) => void
) => {
  const ragEnabled = (process.env.KB_RAG_ENABLED ?? '1') !== '0'
  if (!ragEnabled) return { kb: null as Awaited<ReturnType<typeof getRagContentForPrompt>>, decisionTokensUsed: 0 }

  const catalog = getSessionCatalog(clientId)
  if (!catalog.length) return { kb: null as Awaited<ReturnType<typeof getRagContentForPrompt>>, decisionTokensUsed: 0 }

  onStatus?.('知识库：根据文件描述判断是否需要检索…')
  let decision:
    | Awaited<ReturnType<typeof decideUseKnowledgeBase>>
    | { useKnowledgeBase: boolean; decisionTokensUsed: number; decisionModel: string } = {
    useKnowledgeBase: true,
    decisionTokensUsed: 0,
    decisionModel: 'fallback'
  }
  try {
    decision = await decideUseKnowledgeBase(question, catalog, apiOverride)
  } catch {
    onStatus?.('知识库：决策模型不可用，直接尝试检索…')
  }
  const decisionTokensUsed = typeof (decision as any).decisionTokensUsed === 'number' ? (decision as any).decisionTokensUsed : 0

  if (!decision.useKnowledgeBase) {
    onStatus?.('知识库：根据文件描述判定无需检索')
    return { kb: null as Awaited<ReturnType<typeof getRagContentForPrompt>>, decisionTokensUsed }
  }

  onStatus?.('知识库：检索相关资料中…')
  const kb = await getRagContentForPrompt(clientId, question, { apiOverride })
  if (kb?.content) {
    onStatus?.(
      `知识库：已命中 ${kb.chunksIncluded} 段（${kb.filesIncluded} 个文件，${kb.usedEmbeddings ? '向量检索' : '关键词检索'}）`
    )
  } else {
    onStatus?.('知识库：未命中相关资料')
  }
  return { kb, decisionTokensUsed }
}

const parseKbDescriptions = (raw: unknown): string[] | null => {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    try {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) return null
      const out = parsed.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
      return out.length ? out : null
    } catch {
      return null
    }
  }
  if (Array.isArray(raw)) {
    const out = raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
    return out.length ? out : null
  }
  return null
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
    const answerOverride = applyModelOverride(normalizeSingleModelOverride(apiOverride), getSubjectSingleModelOverride(decision.subject))
    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'

    let kbInfo = { used: false, filesCount: 0, truncated: false }

    const result =
      decision.mode === 'debate'
        ? await solveQuestionWithDebate(imagePath, maxIterations, apiOverride, debateModelsOverride)
        : await solveQuestion(imagePath, answerOverride)

    let kbRefined = result
    if (decision.subject === 'humanities') {
      const { kb, decisionTokensUsed } = await maybeGetKbForQuestion(clientId, result.question, apiOverride)
      if (kb?.content) {
        const refinePrompt = buildKbRefinePrompt(kb.content)
        const follow =
          decision.mode === 'debate'
            ? await answerFollowUpWithDebate({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                maxIterations,
                apiOverride,
                modelsOverride: debateModelsOverride
              })
            : await answerFollowUp({ baseQuestion: result.question, baseAnswer: result.answer, prompt: refinePrompt, apiOverride: answerOverride })

        const followTokens = typeof (follow as any)?.tokensUsed === 'number' ? (follow as any).tokensUsed : 0
        kbRefined = {
          ...result,
          answer: follow.answer,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed + followTokens
        }
        kbInfo = { used: true, filesCount: kb.filesIncluded, truncated: false }
      } else {
        kbRefined = {
          ...result,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed
        }
        kbRefined = {
          ...result,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed
        }
        kbRefined = {
          ...result,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed
        }
        kbRefined = {
          ...result,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed
        }
      }
    }

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            const mcp = await enrichScienceAnswerWithMcp({
              question: kbRefined.question,
              answer: kbRefined.answer,
              apiOverride: answerOverride
            })
            return {
              ...kbRefined,
              answer: mcp.answer,
              tokensUsed: (kbRefined as any)?.tokensUsed ? (kbRefined as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : kbRefined

    const enriched = attachRouting(enrichedResult, decision, userMode, kbInfo)
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

// API路由 - 文字题目自动路由解答（JSON）
app.post('/api/solve-text-auto', usageGuard, async (req, res) => {
  try {
    const text = typeof (req.body as any)?.text === 'string' ? (req.body as any).text : ''
    const questionText = (text || '').trim()
    if (!questionText) {
      return res.status(400).json({ error: '请填写题目文本' })
    }

    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)
    const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

    const userMode: UserMode = ['single', 'debate', 'auto'].includes((req.body as any)?.mode)
      ? ((req.body as any).mode as UserMode)
      : 'auto'

    const userSubject = parseUserSubject((req.body as any)?.subject)
    const decision = userSubject
      ? buildRouteDecisionFromSubject(userSubject, userMode)
      : await routeQuestionFromTextWithModeOverride(questionText, userMode, apiOverride)

    const answerOverride = applyModelOverride(normalizeSingleModelOverride(apiOverride), getSubjectSingleModelOverride(decision.subject))
    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'

    let kbInfo = { used: false, filesCount: 0, truncated: false }
    const extraPrompt = scienceMcpEnabled ? withScienceMcpHint(undefined) : undefined

    const result =
      decision.mode === 'debate'
        ? await solveQuestionWithDebateFromText(questionText, maxIterations, extraPrompt, apiOverride, debateModelsOverride)
        : await solveQuestionFromText(questionText, extraPrompt, answerOverride)

    let kbRefined = result
    if (decision.subject === 'humanities') {
      const { kb, decisionTokensUsed } = await maybeGetKbForQuestion(clientId, result.question, apiOverride)
      if (kb?.content) {
        const refinePrompt = buildKbRefinePrompt(kb.content)
        const follow =
          decision.mode === 'debate'
            ? await answerFollowUpWithDebate({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                maxIterations,
                apiOverride,
                modelsOverride: debateModelsOverride
              })
            : await answerFollowUp({ baseQuestion: result.question, baseAnswer: result.answer, prompt: refinePrompt, apiOverride: answerOverride })

        const followTokens = typeof (follow as any)?.tokensUsed === 'number' ? (follow as any).tokensUsed : 0
        kbRefined = {
          ...result,
          answer: follow.answer,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed + followTokens
        }
        kbInfo = { used: true, filesCount: kb.filesIncluded, truncated: false }
      } else {
        kbRefined = {
          ...result,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed
        }
      }
    }

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            const mcp = await enrichScienceAnswerWithMcp({ question: kbRefined.question, answer: kbRefined.answer, apiOverride: answerOverride })
            return {
              ...kbRefined,
              answer: mcp.answer,
              tokensUsed: (kbRefined as any)?.tokensUsed ? (kbRefined as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : kbRefined

    const enriched = attachRouting(enrichedResult, decision, userMode, kbInfo)
    const snap = usageLimiter.addUsage(clientId, (enriched as any)?.tokensUsed ?? 0)

    usageLimiter.setHeaders(res, snap)
    res.json(enriched)
  } catch (error) {
    console.error('文字题目解答失败:', error instanceof Error ? error.message : error)
    res.status(500).json({
      error: '文字题目解答失败，请重试',
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
    const answerOverride = applyModelOverride(normalizeSingleModelOverride(apiOverride), getSubjectSingleModelOverride(decision.subject))
    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'
    const prompt = scienceMcpEnabled ? withScienceMcpHint(promptRaw) : promptRaw

    let kbInfo = { used: false, filesCount: 0, truncated: false }

    const result =
      decision.mode === 'debate'
        ? await solveQuestionWithDebateFromImages(imagePaths, maxIterations, prompt, apiOverride, debateModelsOverride)
        : await solveQuestionFromImages(imagePaths, prompt, answerOverride)

    let kbRefined = result
    if (decision.subject === 'humanities') {
      const { kb, decisionTokensUsed } = await maybeGetKbForQuestion(clientId, result.question, apiOverride)
      if (kb?.content) {
        const refinePrompt = buildKbRefinePrompt(kb.content)
        const follow =
          decision.mode === 'debate'
            ? await answerFollowUpWithDebate({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                maxIterations,
                apiOverride,
                modelsOverride: debateModelsOverride
              })
            : await answerFollowUp({ baseQuestion: result.question, baseAnswer: result.answer, prompt: refinePrompt, apiOverride: answerOverride })

        const followTokens = typeof (follow as any)?.tokensUsed === 'number' ? (follow as any).tokensUsed : 0
        kbRefined = {
          ...result,
          answer: follow.answer,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed + followTokens
        }
        kbInfo = { used: true, filesCount: kb.filesIncluded, truncated: false }
      } else {
        kbRefined = {
          ...result,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed
        }
      }
    }

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            const mcp = await enrichScienceAnswerWithMcp({
              question: kbRefined.question,
              answer: kbRefined.answer,
              apiOverride: answerOverride
            })
            return {
              ...kbRefined,
              answer: mcp.answer,
              tokensUsed: (kbRefined as any)?.tokensUsed ? (kbRefined as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : kbRefined

    const enriched = attachRouting(enrichedResult, decision, userMode, kbInfo)
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

// API路由 - 文字题目自动路由解答（流式）
app.post('/api/solve-text-auto-stream', usageGuard, async (req, res) => {
  const text = typeof (req.body as any)?.text === 'string' ? (req.body as any).text : ''
  const questionText = (text || '').trim()
  if (!questionText) {
    return res.status(400).json({ error: '请填写题目文本' })
  }

  const clientId = (req as any).clientId as string
  const apiOverride = getApiOverrideFromRequest(req)
  const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

  const userMode: UserMode = ['single', 'debate', 'auto'].includes((req.body as any)?.mode)
    ? ((req.body as any).mode as UserMode)
    : 'auto'

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const resAny = res as any
  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    if (typeof resAny.flush === 'function') resAny.flush()
  }

  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

  try {
    const userSubject = parseUserSubject((req.body as any)?.subject)
    const decision = userSubject
      ? buildRouteDecisionFromSubject(userSubject, userMode)
      : await routeQuestionFromTextWithModeOverride(questionText, userMode, apiOverride)
    const routePrefix = decision.routerModel === 'manual' ? '用户选择' : '路由结果'
    const routeMessage = `${routePrefix}：${subjectLabel(decision.subject)} → ${modeLabel(decision.mode)}${
      typeof decision.confidence === 'number' ? `（置信度 ${decision.confidence.toFixed(2)}）` : ''
    }`

    const debateModelsOverride = getSubjectDebateModelsOverride(decision.subject)
    const scienceMcpEnabled = decision.subject === 'science' && process.env.MCP_PYTHON_ENABLED !== '0'
    const extraPrompt = scienceMcpEnabled ? withScienceMcpHint(undefined) : undefined
    const answerOverride = applyModelOverride(normalizeSingleModelOverride(apiOverride), getSubjectSingleModelOverride(decision.subject))

    let kbInfo = { used: false, filesCount: 0, truncated: false }

    const result =
      decision.mode === 'debate'
        ? (send({ type: 'status', message: routeMessage }),
          await solveQuestionWithDebateStreamFromText(
            questionText,
            maxIterations,
            extraPrompt,
            (update) => send(update),
            apiOverride,
            debateModelsOverride,
            abortController.signal
          ))
        : await solveQuestionStreamFromText(
            questionText,
            extraPrompt,
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
            answerOverride,
            abortController.signal
          )

    let kbRefined = result
    if (decision.subject === 'humanities') {
      send({ type: 'status', message: '知识库：检索相关资料中…' })
      const { kb, decisionTokensUsed } = await maybeGetKbForQuestion(clientId, result.question, apiOverride)
      if (kb?.content) {
        send({
          type: 'status',
          message: `知识库：已命中 ${kb.chunksIncluded} 段（${kb.filesIncluded} 个文件，${kb.usedEmbeddings ? '向量检索' : '关键词检索'}）`
        })
        const refinePrompt = buildKbRefinePrompt(kb.content)
        const follow =
          decision.mode === 'debate'
            ? await answerFollowUpWithDebate({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                maxIterations,
                apiOverride,
                modelsOverride: debateModelsOverride,
                signal: abortController.signal
              })
            : await answerFollowUp({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                apiOverride: answerOverride,
                signal: abortController.signal
              })

        const followTokens = typeof (follow as any)?.tokensUsed === 'number' ? (follow as any).tokensUsed : 0
        kbRefined = {
          ...result,
          answer: follow.answer,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed + followTokens
        }
        kbInfo = { used: true, filesCount: kb.filesIncluded, truncated: false }
      } else {
        send({ type: 'status', message: '知识库：未命中相关资料' })
      }
    }

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            send({ type: 'status', message: '理科：调用 MCP 工具中…' })
            const mcp = await enrichScienceAnswerWithMcp({ question: kbRefined.question, answer: kbRefined.answer, apiOverride: answerOverride })
            return {
              ...kbRefined,
              answer: mcp.answer,
              tokensUsed: (kbRefined as any)?.tokensUsed ? (kbRefined as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : kbRefined

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
    if (abortController.signal.aborted || isAbortError(error)) {
      res.end()
      return
    }
    send({ type: 'error', message: error instanceof Error ? error.message : '未知错误' })
    res.end()
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

  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

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
    const answerOverride = applyModelOverride(normalizeSingleModelOverride(apiOverride), getSubjectSingleModelOverride(decision.subject))

    let kbInfo = { used: false, filesCount: 0, truncated: false }
    const extraPrompt = scienceMcpEnabled ? withScienceMcpHint(undefined) : undefined

    const result =
      decision.mode === 'debate'
        ? (send({ type: 'status', message: routeMessage }),
          await solveQuestionWithDebateStreamFromImages(
            [imagePath],
            maxIterations,
            extraPrompt,
            (update) => send(update),
            apiOverride,
            debateModelsOverride,
            abortController.signal
          ))
        : await solveQuestionStreamFromImages(
            [imagePath],
            extraPrompt,
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
            answerOverride,
            abortController.signal
          )

    let kbRefined = result
    if (decision.subject === 'humanities') {
      send({ type: 'status', message: '知识库：检索相关资料中…' })
      const { kb, decisionTokensUsed } = await maybeGetKbForQuestion(clientId, result.question, apiOverride)
      if (kb?.content) {
        send({
          type: 'status',
          message: `知识库：已命中 ${kb.chunksIncluded} 段（${kb.filesIncluded} 个文件，${kb.usedEmbeddings ? '向量检索' : '关键词检索'}）`
        })
        const refinePrompt = buildKbRefinePrompt(kb.content)
        const follow =
          decision.mode === 'debate'
            ? await answerFollowUpWithDebate({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                maxIterations,
                apiOverride,
                modelsOverride: debateModelsOverride,
                signal: abortController.signal
              })
            : await answerFollowUp({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                apiOverride: answerOverride,
                signal: abortController.signal
              })

        const followTokens = typeof (follow as any)?.tokensUsed === 'number' ? (follow as any).tokensUsed : 0
        kbRefined = {
          ...result,
          answer: follow.answer,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed + followTokens
        }
        kbInfo = { used: true, filesCount: kb.filesIncluded, truncated: false }
      } else {
        send({ type: 'status', message: '知识库：未命中相关资料' })
      }
    }

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            send({ type: 'status', message: '理科：调用 MCP 工具中...' })
            const mcp = await enrichScienceAnswerWithMcp({
              question: kbRefined.question,
              answer: kbRefined.answer,
              apiOverride: answerOverride
            })
            return {
              ...kbRefined,
              answer: mcp.answer,
              tokensUsed: (kbRefined as any)?.tokensUsed ? (kbRefined as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : kbRefined

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
    if (abortController.signal.aborted || isAbortError(error)) {
      res.end()
      return
    }
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

  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

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
    const answerOverride = applyModelOverride(normalizeSingleModelOverride(apiOverride), getSubjectSingleModelOverride(decision.subject))

    let kbInfo = { used: false, filesCount: 0, truncated: false }
    const prompt = scienceMcpEnabled ? withScienceMcpHint(promptRaw) : promptRaw

    const result =
      decision.mode === 'debate'
        ? (send({ type: 'status', message: routeMessage }),
          await solveQuestionWithDebateStreamFromImages(
            imagePaths,
            maxIterations,
            prompt,
            (update) => send(update),
            apiOverride,
            debateModelsOverride,
            abortController.signal
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
            answerOverride,
            abortController.signal
          )

    let kbRefined = result
    if (decision.subject === 'humanities') {
      send({ type: 'status', message: '知识库：检索相关资料中…' })
      const { kb, decisionTokensUsed } = await maybeGetKbForQuestion(clientId, result.question, apiOverride)
      if (kb?.content) {
        send({
          type: 'status',
          message: `知识库：已命中 ${kb.chunksIncluded} 段（${kb.filesIncluded} 个文件，${kb.usedEmbeddings ? '向量检索' : '关键词检索'}）`
        })
        const refinePrompt = buildKbRefinePrompt(kb.content)
        const follow =
          decision.mode === 'debate'
            ? await answerFollowUpWithDebate({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                maxIterations,
                apiOverride,
                modelsOverride: debateModelsOverride,
                signal: abortController.signal
              })
            : await answerFollowUp({
                baseQuestion: result.question,
                baseAnswer: result.answer,
                prompt: refinePrompt,
                apiOverride: answerOverride,
                signal: abortController.signal
              })

        const followTokens = typeof (follow as any)?.tokensUsed === 'number' ? (follow as any).tokensUsed : 0
        kbRefined = {
          ...result,
          answer: follow.answer,
          tokensUsed: (typeof result.tokensUsed === 'number' ? result.tokensUsed : 0) + decisionTokensUsed + followTokens
        }
        kbInfo = { used: true, filesCount: kb.filesIncluded, truncated: false }
      } else {
        send({ type: 'status', message: '知识库：未命中相关资料' })
      }
    }

    const enrichedResult =
      scienceMcpEnabled
        ? await (async () => {
            send({ type: 'status', message: '理科：调用 MCP 工具中...' })
            const mcp = await enrichScienceAnswerWithMcp({
              question: kbRefined.question,
              answer: kbRefined.answer,
              apiOverride: answerOverride
            })
            return {
              ...kbRefined,
              answer: mcp.answer,
              tokensUsed: (kbRefined as any)?.tokensUsed ? (kbRefined as any).tokensUsed + mcp.mcpTokensUsed : mcp.mcpTokensUsed
            }
          })()
        : kbRefined

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
    if (abortController.signal.aborted || isAbortError(error)) {
      res.end()
      return
    }
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
  const apiOverride = getApiOverrideFromRequest(req)

  try {
    if (!files.length) {
      return res.status(400).json({ error: '请上传文件' })
    }

    const descriptions = parseKbDescriptions((req.body as any)?.descriptions)
    if (!descriptions || descriptions.length !== files.length) {
      cleanupUploadedFiles(files)
      return res.status(400).json({ error: '请为每个文件提供文件描述' })
    }

    assertCanAddFiles(
      clientId,
      files.map((f) => ({ sizeBytes: f.size, originalName: fixUploadedOriginalName(f.originalname) }))
    )

    const processedFiles = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const originalName = fixUploadedOriginalName(file.originalname)
      try {
        const fileType = path.extname(originalName).toLowerCase() === '.pdf' ? 'pdf' : 'txt'
        if (fileType === 'pdf') {
          assertUploadOk(validatePdfFileMagic(file.path))
        } else {
          assertUploadOk(validateTextFileLooksText(file.path))
        }
        let content: string
        let extractionMethod: 'text' | 'image-fallback' = 'text'

        if (fileType === 'pdf') {
          const result = await extractPdfContent(file.path, apiOverride)
          content = result.content
          extractionMethod = result.method
        } else {
          content = await extractTxtContent(file.path)
        }

        const description = (descriptions[i] || '').trim()
        if (!description) {
          throw new HttpError(400, '请为每个文件提供文件描述', 'KB_DESCRIPTION_REQUIRED')
        }

        const kbFile: KnowledgeBaseFile = {
          id: createId(),
          originalName,
          description,
          type: fileType,
          content,
          extractionMethod,
          sizeBytes: file.size,
          uploadedAt: Date.now()
        }

        addFile(clientId, kbFile)
        void precomputeFileEmbeddings(kbFile, apiOverride).catch((e) => {
          const message = e instanceof Error ? e.message : String(e)
          console.warn('[KB] Embedding precompute failed:', { clientId, fileName: kbFile.originalName, message })
        })
        processedFiles.push({
          id: kbFile.id,
          originalName: kbFile.originalName,
          description: kbFile.description,
          type: kbFile.type,
          extractionMethod: kbFile.extractionMethod,
          sizeBytes: kbFile.sizeBytes,
          uploadedAt: kbFile.uploadedAt
        })

        console.log('[KB] File uploaded:', {
          clientId,
          fileName: originalName,
          type: fileType,
          size: file.size,
          extractionMethod
        })
      } catch (error) {
        console.error('[KB] File processing failed:', originalName, error)
        processedFiles.push({
          originalName,
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
      description: f.description,
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
    const baseApiOverride = normalizeSingleModelOverride(apiOverride)
    const followUpApiOverride =
      mode === 'single' && routedSubject ? applyModelOverride(baseApiOverride, getSubjectSingleModelOverride(routedSubject)) : baseApiOverride

    let finalPrompt = prompt
    let kbDecisionTokensUsed = 0
    if (routedSubject === 'humanities') {
      const { kb, decisionTokensUsed } = await maybeGetKbForQuestion(clientId, `${baseQuestion}\n${prompt}`, apiOverride)
      kbDecisionTokensUsed = decisionTokensUsed
      if (kb?.content) {
        finalPrompt = `${buildKbRefinePrompt(kb.content)}\n\n---\n\n用户追问：\n${prompt}`
      }
    }

    const result =
      mode === 'debate'
        ? await answerFollowUpWithDebate({
            baseQuestion,
            baseAnswer,
            prompt: finalPrompt,
            messages,
            maxIterations: parseInt(process.env.MAX_DEBATE_ITERATIONS || '3', 10),
            apiOverride,
            modelsOverride: routedSubject ? getSubjectDebateModelsOverride(routedSubject) : undefined
          })
        : await answerFollowUp({ baseQuestion, baseAnswer, prompt: finalPrompt, messages, apiOverride: followUpApiOverride })

    const withKbDecisionTokens = {
      ...(result as any),
      tokensUsed: ((result as any)?.tokensUsed ?? 0) + kbDecisionTokensUsed
    }

    const snap = usageLimiter.addUsage(clientId, (withKbDecisionTokens as any)?.tokensUsed ?? 0)
    usageLimiter.setHeaders(res, snap)
    res.json(withKbDecisionTokens)
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

let startPromise: Promise<{ port: number; server: any }> | null = null

export const startServer = async (opts?: { port?: number | string }) => {
  if (startPromise) return startPromise

  const requestedPort = normalizePort(opts?.port ?? process.env.PORT, 5174)

  startPromise = new Promise((resolve, reject) => {
    try {
      const timer = startCleanupTimer()
      ;(timer as any)?.unref?.()
    } catch {
      // ignore
    }

    const server = app.listen(requestedPort, () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address && typeof (address as any).port === 'number'
          ? (address as any).port
          : requestedPort

      console.log(`🚀 服务器运行在 http://localhost:${port}`)
      console.log(`📝 API端点: http://localhost:${port}/api`)

      if (process.env.AAS_PRINT_PORT === '1') {
        console.log(`AAS_PORT=${port}`)
      }

      resolve({ port, server })
    })

    server.on('error', (err) => {
      reject(err)
    })
  })

  return startPromise
}

if (process.env.AAS_EMBEDDED !== '1') {
  startServer().catch((error) => {
    console.error('server start failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

// Legacy autostart block removed
if (false) app.listen(0, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`)
  console.log(`📝 API端点: http://localhost:${PORT}/api`)
})
