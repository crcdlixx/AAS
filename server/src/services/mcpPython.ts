import dotenv from 'dotenv'

dotenv.config()

export type McpPythonExecuteResult = {
  success: boolean
  output: string
  image_base64?: string
  error?: string | null
}

const getTimeoutMs = () => {
  const raw = process.env.MCP_PYTHON_TIMEOUT_MS
  if (!raw) return 120_000
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000
}

export const getMcpPythonUrl = () => process.env.MCP_PYTHON_URL || 'http://127.0.0.1:8080/method/execute_python'

export async function executePythonViaMcp(code: string): Promise<McpPythonExecuteResult> {
  const url = getMcpPythonUrl()
  const timeoutMs = getTimeoutMs()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: controller.signal
    })

    const text = await response.text()
    if (!response.ok) {
      return {
        success: false,
        output: '',
        image_base64: '',
        error: `MCP请求失败（${response.status}）：${text || response.statusText}`
      }
    }

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { success: false, output: '', error: `MCP返回非JSON：${text.slice(0, 500)}` }
    }

    return {
      success: !!data?.success,
      output: typeof data?.output === 'string' ? data.output : '',
      image_base64: typeof data?.image_base64 === 'string' ? data.image_base64 : '',
      error: typeof data?.error === 'string' ? data.error : null
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, output: '', error: `MCP调用异常：${message}` }
  } finally {
    clearTimeout(timeout)
  }
}
