import axios from 'axios'
import { getFingerprintId } from '../utils/fingerprint'

const api = axios.create({
  baseURL: '/api/knowledge-base',
  timeout: 120000
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

export const uploadFiles = async (files: File[]): Promise<UploadResponse> => {
  const formData = new FormData()
  for (const file of files) {
    formData.append('files', file)
  }

  const response = await api.post<UploadResponse>('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })

  return response.data
}

export const listFiles = async (): Promise<{ files: KnowledgeBaseFile[] }> => {
  const response = await api.get<{ files: KnowledgeBaseFile[] }>('/list')
  return response.data
}

export const removeFile = async (fileId: string): Promise<void> => {
  await api.delete(`/${fileId}`)
}

export const clearAll = async (): Promise<void> => {
  await api.delete('/clear')
}
