import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 120000, // 增加超时时间以支持多模型博弈
})

export interface SolveQuestionResponse {
  answer: string
  question: string
  iterations?: number
  consensus?: boolean
}

export type StreamEvent =
  | { type: 'start' }
  | { type: 'delta'; value: string }
  | { type: 'complete'; value: string; result?: SolveQuestionResponse }
  | { type: 'final'; result: SolveQuestionResponse }
  | { type: 'model1'; content: string; iteration?: number }
  | { type: 'model2'; content: string; iteration?: number }
  | { type: 'status'; message: string; iteration?: number }
  | { type: 'error'; message: string }

export const solveQuestion = async (imageBlob: Blob, useDebate: boolean = false): Promise<SolveQuestionResponse> => {
  const formData = new FormData()
  formData.append('image', imageBlob, 'question.jpg')

  const endpoint = useDebate ? '/solve-debate' : '/solve'
  
  const response = await api.post<SolveQuestionResponse>(endpoint, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  })

  return response.data
}

export const solveQuestionStream = async (
  imageBlob: Blob,
  useDebate: boolean,
  onEvent: (event: StreamEvent) => void
): Promise<SolveQuestionResponse> => {
  const formData = new FormData()
  formData.append('image', imageBlob, 'question.jpg')

  const endpoint = useDebate ? '/solve-debate-stream' : '/solve-stream'

  const response = await fetch(`/api${endpoint}`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    throw new Error('流式请求失败')
  }

  if (!response.body) {
    return solveQuestion(imageBlob, useDebate)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let finalResult: SolveQuestionResponse | null = null
  let lastCompleteResult: SolveQuestionResponse | null = null

  const processChunk = (chunk: string) => {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.replace(/^data:\s*/, '')
      if (!raw) continue
      let event: StreamEvent
      try {
        event = JSON.parse(raw) as StreamEvent
      } catch {
        continue
      }
      onEvent(event)
      if (event.type === 'complete' && event.result) {
        lastCompleteResult = event.result
        if (!finalResult) {
          finalResult = event.result
        }
      }
      if (event.type === 'final' && event.result) {
        finalResult = event.result
      }
      if (event.type === 'error' && event.message) {
        throw new Error(event.message)
      }
    }
  }

  const processBuffer = () => {
    let splitIndex = buffer.indexOf('\n\n')
    while (splitIndex !== -1) {
      const chunk = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + 2)
      splitIndex = buffer.indexOf('\n\n')
      processChunk(chunk)
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    processBuffer()
  }

  buffer += decoder.decode().replace(/\r\n/g, '\n')
  processBuffer()

  if (buffer.trim()) {
    processChunk(buffer)
  }

  if (!finalResult && lastCompleteResult) {
    finalResult = lastCompleteResult
  }

  if (!finalResult) {
    throw new Error('未收到最终结果')
  }

  return finalResult
}

export const solveQuestionMultiStream = async (
  imageBlobs: Blob[],
  useDebate: boolean,
  prompt: string | undefined,
  onEvent: (event: StreamEvent) => void
): Promise<SolveQuestionResponse> => {
  const formData = new FormData()
  for (const [index, blob] of imageBlobs.entries()) {
    formData.append('images', blob, `question-${index + 1}.jpg`)
  }
  if (prompt) {
    formData.append('prompt', prompt)
  }

  const endpoint = useDebate ? '/solve-multi-debate-stream' : '/solve-multi-stream'

  const response = await fetch(`/api${endpoint}`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    throw new Error('流式请求失败')
  }

  if (!response.body) {
    // 目前仅实现了流式版本，多图情况下 body 不存在则直接报错
    throw new Error('服务器未返回流式响应')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let finalResult: SolveQuestionResponse | null = null
  let lastCompleteResult: SolveQuestionResponse | null = null

  const processChunk = (chunk: string) => {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.replace(/^data:\s*/, '')
      if (!raw) continue
      let event: StreamEvent
      try {
        event = JSON.parse(raw) as StreamEvent
      } catch {
        continue
      }
      onEvent(event)
      if (event.type === 'complete' && event.result) {
        lastCompleteResult = event.result
        if (!finalResult) {
          finalResult = event.result
        }
      }
      if (event.type === 'final' && event.result) {
        finalResult = event.result
      }
      if (event.type === 'error' && event.message) {
        throw new Error(event.message)
      }
    }
  }

  const processBuffer = () => {
    let splitIndex = buffer.indexOf('\n\n')
    while (splitIndex !== -1) {
      const chunk = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + 2)
      splitIndex = buffer.indexOf('\n\n')
      processChunk(chunk)
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    processBuffer()
  }

  buffer += decoder.decode().replace(/\r\n/g, '\n')
  processBuffer()

  if (buffer.trim()) {
    processChunk(buffer)
  }

  if (!finalResult && lastCompleteResult) {
    finalResult = lastCompleteResult
  }

  if (!finalResult) {
    throw new Error('未收到最终结果')
  }

  return finalResult
}
