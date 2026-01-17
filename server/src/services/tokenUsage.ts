export type TokenUsageLike =
  | { totalTokens?: number; promptTokens?: number; completionTokens?: number }
  | { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export const extractTotalTokens = (value: unknown): number | undefined => {
  const v: any = value as any
  if (!v) return undefined

  const candidates: any[] = [
    v?.response_metadata?.tokenUsage,
    v?.response_metadata?.token_usage,
    v?.response_metadata?.usage,
    v?.response_metadata?.usage_metadata,
    v?.additional_kwargs?.usage,
    v?.additional_kwargs?.token_usage,
    v?.usage,
    v?.usage_metadata,
    v?.llmOutput?.tokenUsage,
    v?.llmOutput?.token_usage,
    v?.llmOutput?.usage,
    v?.llmOutput?.usage_metadata
  ].filter(Boolean)

  for (const usage of candidates) {
    const total =
      asNumber(usage?.totalTokens) ??
      asNumber(usage?.total_tokens) ??
      asNumber(usage?.total) ??
      asNumber(usage?.tokens)
    if (typeof total === 'number') return total

    const prompt =
      asNumber(usage?.promptTokens) ?? asNumber(usage?.prompt_tokens) ?? asNumber(usage?.input_tokens)
    const completion =
      asNumber(usage?.completionTokens) ??
      asNumber(usage?.completion_tokens) ??
      asNumber(usage?.output_tokens)
    if (typeof prompt === 'number' || typeof completion === 'number') {
      return (prompt ?? 0) + (completion ?? 0)
    }
  }

  return undefined
}

const isCjk = (codePoint: number) =>
  (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
  (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Ideographs Extension A
  (codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana + Katakana
  (codePoint >= 0xac00 && codePoint <= 0xd7af) // Hangul Syllables

export const estimateTokensFromText = (text: string): number => {
  if (!text) return 0
  let cjkCount = 0
  let otherCount = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCjk(cp)) cjkCount += 1
    else otherCount += 1
  }
  // very rough heuristic: ~1 token per CJK char; ~1 token per 4 non-CJK chars
  return cjkCount + Math.ceil(otherCount / 4)
}

