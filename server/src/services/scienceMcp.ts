import { estimateTokensFromText } from './tokenUsage.js'
import { executePythonViaMcp } from './mcpPython.js'
import { answerFollowUp } from './openai.js'
import type { ApiOverride } from './apiOverride.js'

const TOOL_HINT = `（理科题：如需计算/解方程/作图/验算，请在解答末尾额外给出一个可直接运行的 \`\`\`python\`\`\` 代码块，用于 MCP 工具执行；代码里请 print 关键数值或最终表达式。）`

export const withScienceMcpHint = (prompt: string | undefined) => {
  const base = (prompt || '').trim()
  return base ? `${base}\n\n${TOOL_HINT}` : TOOL_HINT
}

const extractPythonCodeBlock = (text: string): string | null => {
  const match = (text || '').match(/```python\s*([\s\S]*?)```/i)
  const code = match?.[1]?.trim()
  return code ? code : null
}

const formatMcpAppendix = (result: { success: boolean; output: string; image_base64?: string; error?: string | null }) => {
  if (result.success) {
    const output = (result.output || '').trim()
    const imgLen = typeof result.image_base64 === 'string' ? result.image_base64.length : 0
    return `\n\n---\n【MCP工具：execute_python】\n${output ? `输出：\n${output}` : '输出：<空>'}${
      imgLen > 0 ? `\n（返回了 image_base64，长度 ${imgLen}）` : ''
    }\n`
  }

  const error = (result.error || '').trim() || '未知错误'
  return `\n\n---\n【MCP工具：execute_python】\n执行失败：${error}\n`
}

export async function enrichScienceAnswerWithMcp(opts: {
  question: string
  answer: string
  apiOverride?: ApiOverride
}): Promise<{ answer: string; mcpUsed: boolean; mcpTokensUsed: number }> {
  const question = (opts.question || '').trim()
  const answer = (opts.answer || '').trim()
  if (!question || !answer) return { answer: opts.answer, mcpUsed: false, mcpTokensUsed: 0 }

  let code = extractPythonCodeBlock(answer)
  if (!code) {
    try {
      const follow = await answerFollowUp({
        baseQuestion: question,
        baseAnswer: answer,
        prompt: '请只输出一个用于计算/验算的 Python 代码块（```python ...```），不要解释文字。',
        apiOverride: opts.apiOverride
      })
      code = extractPythonCodeBlock(follow.answer)
    } catch {
      // ignore
    }
  }

  if (!code) return { answer: opts.answer, mcpUsed: false, mcpTokensUsed: 0 }

  const mcp = await executePythonViaMcp(code)
  const appendix = formatMcpAppendix(mcp)
  const mcpTokensUsed = estimateTokensFromText(code) + estimateTokensFromText(mcp.output || '') + estimateTokensFromText(mcp.error || '')

  return { answer: `${answer}${appendix}`.trim(), mcpUsed: true, mcpTokensUsed }
}

