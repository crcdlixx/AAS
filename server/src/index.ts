import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  solveQuestion,
  solveQuestionFromImages,
  solveQuestionStream,
  solveQuestionStreamFromImages,
  type StreamUpdate
} from './services/openai.js'
import {
  solveQuestionWithDebate,
  solveQuestionWithDebateFromImages,
  solveQuestionWithDebateStream,
  solveQuestionWithDebateStreamFromImages
} from './services/debate.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5174

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
app.post('/api/solve', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const imagePath = req.file.path
    
    // 调用OpenAI API解答题目
    const result = await solveQuestion(imagePath)
    
    // 删除临时文件
    fs.unlinkSync(imagePath)
    
    res.json(result)
  } catch (error) {
    console.error('解答失败:', error)
    
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
app.post('/api/solve-multi', upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  try {
    if (!files.length) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
    const imagePaths = files.map((file) => file.path)
    const result = await solveQuestionFromImages(imagePaths, prompt)

    cleanupUploadedFiles(files)
    res.json(result)
  } catch (error) {
    console.error('解答失败:', error)
    cleanupUploadedFiles(files)
    res.status(500).json({
      error: '解答失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 单模型解答（流式）
app.post('/api/solve-stream', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  const imagePath = req.file.path

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
    })

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
app.post('/api/solve-multi-stream', upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

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
    })

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
app.post('/api/solve-debate', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const imagePath = req.file.path
    const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')
    
    // 调用多模型博弈系统
    const result = await solveQuestionWithDebate(imagePath, maxIterations)
    
    // 删除临时文件
    fs.unlinkSync(imagePath)
    
    res.json(result)
  } catch (error) {
    console.error('多模型博弈失败:', error)
    
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
app.post('/api/solve-multi-debate', upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  try {
    if (!files.length) {
      return res.status(400).json({ error: '请上传图片文件' })
    }

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined
    const imagePaths = files.map((file) => file.path)
    const maxIterations = parseInt(process.env.MAX_DEBATE_ITERATIONS || '3')
    const result = await solveQuestionWithDebateFromImages(imagePaths, maxIterations, prompt)

    cleanupUploadedFiles(files)
    res.json(result)
  } catch (error) {
    console.error('多模型博弈失败:', error)
    cleanupUploadedFiles(files)
    res.status(500).json({
      error: '多模型博弈失败，请重试',
      details: error instanceof Error ? error.message : '未知错误'
    })
  }
})

// API路由 - 多模型博弈解答（流式）
app.post('/api/solve-debate-stream', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

  const imagePath = req.file.path
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
    })

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
app.post('/api/solve-multi-debate-stream', upload.array('images', 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) {
    return res.status(400).json({ error: '请上传图片文件' })
  }

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
    })

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

app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`)
  console.log(`📝 API端点: http://localhost:${PORT}/api`)
})
