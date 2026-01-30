import { app, BrowserWindow } from 'electron'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyMiddleware } from 'http-proxy-middleware'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const startEmbeddedApiServer = async () => {
  const dataDir = path.join(app.getPath('userData'), 'aas-server')
  const uploadsDir = path.join(dataDir, 'uploads')

  fs.mkdirSync(uploadsDir, { recursive: true })

  process.env.AAS_EMBEDDED = '1'
  process.env.AAS_DATA_DIR = dataDir
  process.env.UPLOADS_DIR = uploadsDir
  process.env.USAGE_STORE_PATH = path.join(dataDir, 'usage-store.json')

  const { startServer } = await import('../server/index.js')
  const { port, server } = await startServer({ port: 0 })
  return { port, server }
}

const createLocalServer = async ({ apiTarget }) => {
  const rendererDir = path.join(__dirname, '..', 'renderer')

  const server = express()
  server.use(
    '/api',
    createProxyMiddleware({
      target: apiTarget,
      changeOrigin: true,
      ws: true
    })
  )
  server.use(express.static(rendererDir))
  server.get('*', (_req, res) => res.sendFile(path.join(rendererDir, 'index.html')))

  const httpServer = await new Promise((resolve, reject) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s))
    s.on('error', reject)
  })

  return httpServer
}

const createWindow = async (url) => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true
    }
  })

  await win.loadURL(url)
}

app.whenReady().then(async () => {
  let embedded = null
  try {
    embedded = await startEmbeddedApiServer()
  } catch (e) {
    console.error('[desktop] failed to start embedded API server, falling back:', e instanceof Error ? e.message : e)
  }

  const apiTarget =
    embedded && embedded.port ? `http://127.0.0.1:${embedded.port}` : process.env.AAS_API_TARGET || 'http://127.0.0.1:5174'

  const httpServer = await createLocalServer({ apiTarget })
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('Failed to start local server')

  await createWindow(`http://127.0.0.1:${port}`)

  app.on('before-quit', () => {
    try {
      httpServer.close()
    } catch {
      // ignore
    }

    try {
      embedded?.server?.close?.()
    } catch {
      // ignore
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow('about:blank')
  }
})
