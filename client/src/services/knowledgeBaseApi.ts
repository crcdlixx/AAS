import axios from 'axios'
import { getFingerprintId } from '../utils/fingerprint'
import { buildApiOverrideHeaders, type ApiConfig } from './api'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'
const KB_BASE = import.meta.env.VITE_KB_API_BASE || `${API_BASE}/knowledge-base`
const parseTimeoutMs = (raw: string | undefined, fallback: number) => {
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const API_TIMEOUT_MS = parseTimeoutMs(import.meta.env.VITE_API_TIMEOUT_MS, 120000)

const api = axios.create({
  baseURL: KB_BASE,
  timeout: API_TIMEOUT_MS
})

api.interceptors.request.use(async (config) => {
  const fingerprint = await getFingerprintId()
  config.headers = config.headers ?? {}
  ;(config.headers as any)['X-AAS-Fingerprint'] = fingerprint
  return config
})

export type KnowledgeBaseFile = {
  id: string
  originalName: string
  description: string
  type: 'pdf' | 'txt'
  extractionMethod: 'text' | 'image-fallback'
  sizeBytes: number
  uploadedAt: number
  error?: string
}

export type UploadResponse = {
  files: KnowledgeBaseFile[]
  sessionInfo: {
    totalFiles: number
    totalSize: number
  }
}

export const uploadFiles = async (files: File[], descriptions: string[], apiConfig?: ApiConfig): Promise<UploadResponse> => {
  const formData = new FormData()
  for (const file of files) {
    formData.append('files', file)
  }
  formData.append('descriptions', JSON.stringify(descriptions))

  const response = await api.post<UploadResponse>('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data', ...buildApiOverrideHeaders(apiConfig) }
  })

  return response.data
}

export const listFiles = async (apiConfig?: ApiConfig): Promise<{ files: KnowledgeBaseFile[] }> => {
  const response = await api.get<{ files: KnowledgeBaseFile[] }>('/list', { headers: buildApiOverrideHeaders(apiConfig) })
  return response.data
}

export const removeFile = async (fileId: string, apiConfig?: ApiConfig): Promise<void> => {
  await api.delete(`/${fileId}`, { headers: buildApiOverrideHeaders(apiConfig) })
}

export const clearAll = async (apiConfig?: ApiConfig): Promise<void> => {
  await api.delete('/clear', { headers: buildApiOverrideHeaders(apiConfig) })
}
