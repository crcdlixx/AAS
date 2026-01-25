const net = require('net')
const path = require('path')

const concurrently = require('concurrently').default

async function canListen(port) {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, () => {
      server.close(() => resolve(true))
    })
  })
}

async function findFreePort(startPort, maxAttempts) {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = startPort + offset
    if (await canListen(port)) return port
  }
  return null
}

async function main() {
  const args = new Set(process.argv.slice(2))

  const requestedPort = process.env.PORT ? Number(process.env.PORT) : null
  if (process.env.PORT && !Number.isFinite(requestedPort)) {
    console.error(`[dev] Invalid PORT value: ${process.env.PORT}`)
    process.exit(1)
  }
  const basePort = Number.isFinite(requestedPort) ? requestedPort : 5174

  let apiPort = basePort
  if (!(await canListen(apiPort))) {
    if (requestedPort != null) {
      console.error(`[dev] PORT ${apiPort} is already in use.`)
      console.error('[dev] Pick a different PORT and retry.')
      process.exit(1)
    }

    const found = await findFreePort(basePort + 1, 50)
    if (found == null) {
      console.error(`[dev] No free port found in range ${basePort + 1}-${basePort + 50}.`)
      process.exit(1)
    }
    apiPort = found
    console.warn(`[dev] Port ${basePort} is in use; using ${apiPort} for the API server.`)
  }

  const baseEnv = { ...process.env }
  const clientEnv = { ...baseEnv }
  if (!clientEnv.VITE_API_TARGET) {
    clientEnv.VITE_API_TARGET = `http://localhost:${apiPort}`
  }

  const serverEnv = { ...baseEnv, PORT: String(apiPort) }

  const mcpEnv = { ...baseEnv }
  delete mcpEnv.PORT

  if (args.has('--print-port')) {
    console.log(String(apiPort))
    return
  }
  if (args.has('--print-config')) {
    console.log(
      JSON.stringify(
        {
          PORT: String(apiPort),
          VITE_API_TARGET: clientEnv.VITE_API_TARGET
        },
        null,
        2
      )
    )
    return
  }

  const repoRoot = path.resolve(__dirname, '..')
  const { result } = concurrently(
    [
      { command: 'npm run dev:client', name: 'client', env: clientEnv },
      { command: 'npm run dev:server', name: 'server', env: serverEnv },
      { command: 'npm run dev:mcp', name: 'mcp', env: mcpEnv }
    ],
    {
      cwd: repoRoot,
      prefixColors: ['blue', 'green', 'magenta']
    }
  )

  try {
    await result
    process.exit(0)
  } catch {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('[dev] Failed to start:', error)
  process.exit(1)
})
