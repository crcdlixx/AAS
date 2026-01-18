import express, { type RequestHandler } from 'express'
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
  solveQuestionWithDebate,
  solveQuestionWithDebateFromImages,
  solveQuestionWithDebateStream,
  solveQuestionWithDebateStreamFromImages,
  answerFollowUpWithDebate
} from './services/debate.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5174

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

// API路由 - 单模型解答
app.post('/api/solve', usageGuard, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const imagePath = req.file.path
    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)
    
    // 调用OpenAI API解答题目
    const result = await solveQuestion(imagePath, apiOverride)
    const snap = usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)
    
    // 删除临时文件
    fs.unlinkSync(imagePath)
    
    res.json(result)
  } catch (error) {
    console.error('解答失败:', error instanceof Error ? error.message : error)

    // 清理文件
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path)
      } catch (e) {
        console.error('删除临时文件失败:', e)
      }
    }
    
    res.status(500).json({ 
      error: '解答失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 单模型解答（多图）
app.post('/api/solve-multi', usageGuard, upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  try {
    if (!files.length) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
    const imagePaths = files.map((file) => file.path)
    const result = await solveQuestionFromImages(imagePaths, prompt, apiOverride)
    const snap = usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)

    cleanupUploadedFiles(files)
    usageLimiter.setHeaders(res, snap)
    usageLimiter.setHeaders(res, snap)
    res.json(result)
  } catch (error) {
    console.error('解答失败:', error instanceof Error ? error.message : error)
    cleanupUploadedFiles(files)
    res.status(500).json({
      error: '解答失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 单模型解答（流式）
app.post('/api/solve-stream', usageGuard, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  const imagePath = req.file.path
  const clientId = (req as any).clientId as string
  const apiOverride = getApiOverrideFromRequest(req)

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
    const result = await solveQuestionStream(imagePath, (update: StreamUpdate) => {
      switch (update.type) {
        case 'start':
          send({ type: 'start' })
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
    }, apiOverride)

    usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)
    send({ type: 'final', result })
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

// API路由 - 单模型解答（多图，流式）
app.post('/api/solve-multi-stream', usageGuard, upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  const clientId = (req as any).clientId as string
  const apiOverride = getApiOverrideFromRequest(req)
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
  const imagePaths = files.map((file) => file.path)

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
    const result = await solveQuestionStreamFromImages(imagePaths, prompt, (update: StreamUpdate) => {
      switch (update.type) {
        case 'start':
          send({ type: 'start' })
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
    }, apiOverride)

    usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)
    send({ type: 'final', result })
    res.end()
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : '未知错误' })
    res.end()
  } finally {
    cleanupUploadedFiles(files)
  }
})

// API路由 - 多模型博弈解答
app.post('/api/solve-debate', usageGuard, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const imagePath = req.file.path
    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)
    const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')
    
    // 调用多模型博弈系统
    const result = await solveQuestionWithDebate(imagePath, maxIterations, apiOverride)
    const snap = usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)
    
    // 删除临时文件
    fs.unlinkSync(imagePath)
    
    res.json(result)
  } catch (error) {
    console.error('多模型博弈失败:', error instanceof Error ? error.message : error)

    // 清理文件
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path)
      } catch (e) {
        console.error('删除临时文件失败:', e)
      }
    }
    
    res.status(500).json({ 
      error: '多模型博弈失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 多模型博弈解答（多图）
app.post('/api/solve-multi-debate', usageGuard, upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  try {
    if (!files.length) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const clientId = (req as any).clientId as string
    const apiOverride = getApiOverrideFromRequest(req)
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
    const imagePaths = files.map((file) => file.path)
    const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')
    const result = await solveQuestionWithDebateFromImages(imagePaths, maxIterations, prompt, apiOverride)
    const snap = usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)

    cleanupUploadedFiles(files)
    usageLimiter.setHeaders(res, snap)
    res.json(result)
  } catch (error) {
    console.error('多模型博弈失败:', error instanceof Error ? error.message : error)
    cleanupUploadedFiles(files)
    res.status(500).json({
      error: '多模型博弈失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 多模型博弈解答（流式）
app.post('/api/solve-debate-stream', usageGuard, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  const imagePath = req.file.path
  const clientId = (req as any).clientId as string
  const apiOverride = getApiOverrideFromRequest(req)
  const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

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
    const result = await solveQuestionWithDebateStream(imagePath, maxIterations, (update) => {
      send(update)
    }, apiOverride)

    usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)
    send({ type: 'final', result })
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

// API路由 - 多模型博弈解答（多图，流式）
app.post('/api/solve-multi-debate-stream', usageGuard, upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  const clientId = (req as any).clientId as string
  const apiOverride = getApiOverrideFromRequest(req)
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
  const imagePaths = files.map((file) => file.path)
  const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')

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
    const result = await solveQuestionWithDebateStreamFromImages(imagePaths, maxIterations, prompt, (update) => {
      send(update)
    }, apiOverride)

    usageLimiter.addUsage(clientId, (result as any)?.tokensUsed ?? 0)
    send({ type: 'final', result })
    res.end()
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : '未知错误' })
    res.end()
  } finally {
    cleanupUploadedFiles(files)
  }
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
            apiOverride
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

app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`)
  console.log(`📝 API端点: http://localhost:${PORT}/api`)
})
