import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import dotenv from 'dotenv'
import { estimateTokensFromText, extractTotalTokens } from './tokenUsage.js'
import type { ApiOverride } from './apiOverride.js'
import type { KnowledgeBaseFileCatalogItem } from './knowledgeBase.js'

dotenv.config()

export type KnowledgeBaseUseDecision = {
  useKnowledgeBase: boolean
  reason?: string
  decisionTokensUsed: number
  decisionModel: string
}

const KB_DECISION_PROMPT = `你是一个“知识库调用决策器”。你会得到：
- 用户问题
- 当前会话已上传的知识库文件列表（文件名 + 文件描述）

你的任务：判断解答该问题是否需要调用知识库检索。

规则：
1) 如果问题可以用通用常识/学科知识回答，且不依赖这些资料中的“特定信息”，返回 useKnowledgeBase=false。
2) 如果问题明显依赖资料中的具体条款/定义/细节/数据/上下文（或用户明确要求“按资料/根据某文件/这份材料”），返回 useKnowledgeBase=true。
3) 仅根据“文件描述”判断是否需要调用；不要假设你已看到文件内容。
4) 输出必须是严格 JSON（不要 Markdown，不要多余文字）。

输出 JSON 结构：
{"useKnowledgeBase":true|false,"reason":"一句话原因"}`

const toText = (content: unknown): string => {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'object' && content && typeof (content as any).text === 'string') return (content as any).text
  if (Array.isArray(content)) return content.map((item) => toText(item)).join('')
  return ''
}

const extractFirstJsonObject = (text: string): any | null => {
  const s = (text || '').trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {}

  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const slice = s.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const parseUseDecision = (text: string): { useKnowledgeBase: boolean; reason?: string } => {
  const data = extractFirstJsonObject(text)
  const useKnowledgeBase = Boolean((data as any)?.useKnowledgeBase)
  const reason = typeof (data as any)?.reason === 'string' ? (data as any).reason.trim() : undefined
  return { useKnowledgeBase, ...(reason ? { reason } : {}) }
}

const createDecisionModel = (apiOverride?: ApiOverride) => {
  const decisionModel =
    (process.env.KB_DECISION_MODEL || '').trim() ||
    apiOverride?.routerModel ||
    (process.env.ROUTER_MODEL || '').trim() ||
    'gpt-4o-mini'

  const apiKey = apiOverride?.apiKey || process.env.OPENAI_API_KEY
  const baseURL = apiOverride?.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

  return {
    decisionModel,
    model: new ChatOpenAI({
      modelName: decisionModel,
      temperature: 0,
      maxTokens: 200,
      openAIApiKey: apiKey,
      configuration: { baseURL }
    })
  }
}

const buildCatalogText = (catalog: KnowledgeBaseFileCatalogItem[]) => {
  const MAX_DESC_CHARS = 400
  return catalog
    .map((f, idx) => {
      const desc = (f.description || '').trim().slice(0, MAX_DESC_CHARS)
      return `${idx + 1}. 文件：${f.originalName}\n   描述：${desc || '(无描述)'}`
    })
    .join('\n')
}

export async function decideUseKnowledgeBase(
  questionText: string,
  catalog: KnowledgeBaseFileCatalogItem[],
  apiOverride?: ApiOverride
): Promise<KnowledgeBaseUseDecision> {
  const q = (questionText || '').trim()
  if (!q || !catalog.length) {
    return { useKnowledgeBase: false, decisionTokensUsed: 0, decisionModel: 'none' }
  }

  const { model, decisionModel } = createDecisionModel(apiOverride)
  const catalogText = buildCatalogText(catalog)
  const input = `${KB_DECISION_PROMPT}\n\n【知识库文件列表】\n${catalogText}\n\n【用户问题】\n${q}`

  const resp = await model.invoke([new HumanMessage(input)])
  const outText = toText((resp as any)?.content)
  const parsed = parseUseDecision(outText)
  const decisionTokensUsed = extractTotalTokens(resp) ?? estimateTokensFromText(input + outText)

  return {
    useKnowledgeBase: parsed.useKnowledgeBase,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
    decisionTokensUsed,
    decisionModel
  }
}

