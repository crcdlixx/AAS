export type ApiOverride = {
  apiKey?: string
  baseURL?: string
  model?: string
}

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const normalizeApiOverride = (override: ApiOverride | undefined): ApiOverride | undefined => {
  if (!override) return undefined
  const apiKey = clean(override.apiKey)
  const baseURL = clean(override.baseURL)
  const model = clean(override.model)

  if (!apiKey && !baseURL && !model) return undefined
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(model ? { model } : {})
  }
}

