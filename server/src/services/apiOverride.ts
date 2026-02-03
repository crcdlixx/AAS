export type ApiOverride = {
  apiKey?: string
  baseURL?: string
  // Legacy: a single model override (applies to single & debate unless more specific fields are provided)
  model?: string
  // Per-mode overrides
  singleModel?: string
  debateModel1?: string
  debateModel2?: string
  routerModel?: string
  embeddingModel?: string
}

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const normalizeApiOverride = (override: ApiOverride | undefined): ApiOverride | undefined => {
  if (!override) return undefined
  const apiKey = clean(override.apiKey)
  const baseURL = clean(override.baseURL)
  const model = clean(override.model)
  const singleModel = clean(override.singleModel)
  const debateModel1 = clean(override.debateModel1)
  const debateModel2 = clean(override.debateModel2)
  const routerModel = clean(override.routerModel)
  const embeddingModel = clean(override.embeddingModel)

  if (!apiKey && !baseURL && !model && !singleModel && !debateModel1 && !debateModel2 && !routerModel && !embeddingModel) return undefined
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(model ? { model } : {}),
    ...(singleModel ? { singleModel } : {}),
    ...(debateModel1 ? { debateModel1 } : {}),
    ...(debateModel2 ? { debateModel2 } : {}),
    ...(routerModel ? { routerModel } : {}),
    ...(embeddingModel ? { embeddingModel } : {})
  }
}
