import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Card,
  message,
  Switch,
  Space,
  Tabs,
  Drawer,
  Collapse,
  Tag,
  FloatButton,
  Modal,
  Select,
  Progress,
  Input,
  AutoComplete,
  Radio
} from 'antd'
import { SendOutlined, DeleteOutlined, DownloadOutlined, LinkOutlined } from '@ant-design/icons'
import MultiCropper, { CropBox, CropGroups, ModelMode } from './components/MultiCropper'
import MarkdownView from './components/MarkdownView'
import KnowledgeBasePanel from './components/KnowledgeBasePanel'
import {
  followUpQuestion,
  getAvailableModels,
  getUsage,
  solveQuestionMultiStream,
  solveQuestionTextStream,
  StreamEvent,
  SolveQuestionResponse,
  type ApiConfig,
  type FollowUpChatMessage,
  type UsageInfo
} from './services/api'
import { listFiles, type KnowledgeBaseFile } from './services/knowledgeBaseApi'
import { cropToJpegBlobFromFile } from './utils/cropBlob'
import logo from './assets/logo.png'
import './App.css'

type ImageItem = {
  id: string
  file: File
  name: string
  url: string
  defaultMode: ModelMode
  subject: 'science' | 'humanities' | 'unknown'
  crops: CropBox[]
  groups: CropGroups
  activeCropId: string
}

type SubjectiveAnswerStyle = 'outline' | 'standard' | 'full'

type SolveTask = {
  id: string
  createdAt: number
  imageId: string
  title: string
  mode: ModelMode
  status: 'pending' | 'running' | 'done' | 'error' | 'canceled'
  streamText: string
  result?: SolveQuestionResponse
  error?: string
  subjectiveAnswerStyle?: SubjectiveAnswerStyle
  followUps: FollowUpMessage[]
  followUpDraft: string
  followUpSending: boolean
}

type FollowUpMessage = FollowUpChatMessage & {
  id: string
  createdAt: number
  status?: 'pending' | 'done' | 'error'
}

type CrossImageMergeOverride = {
  fromImageId: string
  fromCropId: string
  toCropId: string
}

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

function App() {
  const [images, setImages] = useState<ImageItem[]>([])
  const [activeImageId, setActiveImageId] = useState<string>('')
  const [questionDraft, setQuestionDraft] = useState('')
  const [questionMode, setQuestionMode] = useState<ModelMode>('auto')
  const [questionSubject, setQuestionSubject] = useState<ImageItem['subject']>('unknown')
  const imagePickerRef = useRef<HTMLInputElement | null>(null)

  const [tasks, setTasks] = useState<SolveTask[]>([])
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false)
  const [exportingMd, setExportingMd] = useState(false)
  const [usageInfo, setUsageInfo] = useState<UsageInfo | null>(null)
  const [apiConfigOpen, setApiConfigOpen] = useState(false)
  const [apiConfigEnabled, setApiConfigEnabled] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [apiSingleModel, setApiSingleModel] = useState('')
  const [apiDebateModel1, setApiDebateModel1] = useState('')
  const [apiDebateModel2, setApiDebateModel2] = useState('')
  const [apiRouterModel, setApiRouterModel] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [availableModelsLoading, setAvailableModelsLoading] = useState(false)
  const [customAvailableModels, setCustomAvailableModels] = useState<string[]>([])
  const fileImportRef = useRef<HTMLInputElement | null>(null)
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(2)
  const taskPayloadsRef = useRef<
    Record<
      string,
      {
        kind: 'images' | 'text'
        blobs?: Blob[]
        prompt?: string
        text?: string
        subject: ImageItem['subject']
        apiConfig?: ApiConfig
      }
    >
  >({})
  const taskControllersRef = useRef<Record<string, AbortController>>({})
  const schedulerTickingRef = useRef(false)
  const [crossImageMergeEnabled, setCrossImageMergeEnabled] = useState(true)
  const [crossImageMergeOverrides, setCrossImageMergeOverrides] = useState<Record<string, CrossImageMergeOverride>>({})
  const [crossImageMergeModalOpen, setCrossImageMergeModalOpen] = useState(false)
  const [mergeFromCropId, setMergeFromCropId] = useState<string>('')
  const [mergeToCropId, setMergeToCropId] = useState<string>('')
  const [knowledgeBaseFiles, setKnowledgeBaseFiles] = useState<KnowledgeBaseFile[]>([])

  const activeImage = useMemo(() => images.find((img) => img.id === activeImageId), [images, activeImageId])
  const activeImageIndex = useMemo(() => images.findIndex((img) => img.id === activeImageId), [images, activeImageId])
  const prevImage = useMemo(
    () => (activeImageIndex > 0 ? images[activeImageIndex - 1] : undefined),
    [images, activeImageIndex]
  )
  const runningCount = useMemo(() => tasks.filter((t) => t.status === 'running' || t.status === 'pending').length, [tasks])
  const hasAnyTasks = tasks.length > 0
  const activeApiConfig = useMemo<ApiConfig | undefined>(() => {
    if (!apiConfigEnabled) return undefined
    const key = apiKey.trim()
    if (!key) return undefined
    const baseUrl = apiBaseUrl.trim()
    const singleModel = apiSingleModel.trim()
    const debateModel1 = apiDebateModel1.trim()
    const debateModel2 = apiDebateModel2.trim()
    const routerModel = apiRouterModel.trim()
    const modelCandidates = [...new Set([...customAvailableModels, ...availableModels].map((m) => m.trim()).filter(Boolean))]

    return {
      apiKey: key,
      baseUrl: baseUrl || undefined,
      singleModel: singleModel || undefined,
      debateModel1: debateModel1 || undefined,
      debateModel2: debateModel2 || undefined,
      routerModel: routerModel || undefined,
      modelCandidates: modelCandidates.length ? modelCandidates : undefined
    }
  }, [
    apiConfigEnabled,
    apiKey,
    apiBaseUrl,
    apiSingleModel,
    apiDebateModel1,
    apiDebateModel2,
    apiRouterModel,
    customAvailableModels,
    availableModels
  ])

  const refreshAvailableModels = useCallback(async () => {
    setAvailableModelsLoading(true)
    try {
      const key = apiKey.trim()
      const baseUrl = apiBaseUrl.trim()
      const models = await getAvailableModels(key ? { apiKey: key, baseUrl: baseUrl || undefined } : undefined)
      setAvailableModels(models)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '获取模型列表失败')
    } finally {
      setAvailableModelsLoading(false)
    }
  }, [apiBaseUrl, apiKey])

  useEffect(() => {
    if (!apiConfigOpen) return
    refreshAvailableModels()
  }, [apiConfigOpen, refreshAvailableModels])

  const exportApiConfig = () => {
    const payload = {
      enabled: apiConfigEnabled,
      apiKey: apiKey.trim(),
      baseUrl: apiBaseUrl.trim() || undefined,
      singleModel: apiSingleModel.trim() || undefined,
      debateModel1: apiDebateModel1.trim() || undefined,
      debateModel2: apiDebateModel2.trim() || undefined,
      routerModel: apiRouterModel.trim() || undefined,
      availableModels: customAvailableModels
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'aas-api-config.json'
    a.click()
    URL.revokeObjectURL(url)
    message.success('已导出配置（包含 API Key）')
  }

  const importApiConfigFromFile = async (file: File) => {
    const text = await file.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      message.error('配置文件不是有效的 JSON')
      return
    }

    const enabled = typeof data.enabled === 'boolean' ? data.enabled : apiConfigEnabled
    const importedKey = typeof data.apiKey === 'string' ? data.apiKey : ''
    const importedBase =
      typeof data.baseUrl === 'string'
        ? data.baseUrl
        : typeof data.baseURL === 'string'
          ? data.baseURL
          : ''
    const importedSingleModel =
      typeof data.singleModel === 'string'
        ? data.singleModel
        : typeof data.model === 'string'
          ? data.model
          : ''
    const importedDebateModel1 =
      typeof data.debateModel1 === 'string'
        ? data.debateModel1
        : typeof data.model === 'string'
          ? data.model
          : ''
    const importedDebateModel2 =
      typeof data.debateModel2 === 'string'
        ? data.debateModel2
        : typeof data.model === 'string'
          ? data.model
          : ''
    const importedRouterModel = typeof data.routerModel === 'string' ? data.routerModel : ''
    const importedAvailableModels = Array.isArray(data.availableModels)
      ? data.availableModels.filter((x: unknown) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean)
      : []

    setApiConfigEnabled(enabled)
    setApiKey(importedKey)
    setApiBaseUrl(importedBase)
    setApiSingleModel(importedSingleModel)
    setApiDebateModel1(importedDebateModel1)
    setApiDebateModel2(importedDebateModel2)
    setApiRouterModel(importedRouterModel)
    setCustomAvailableModels(importedAvailableModels)
    message.success('已导入配置')
  }

  const addImageFile = (file: File) => {
    const id = createId()
    const url = URL.createObjectURL(file)
    const firstCropId = createId()
    const newImage: ImageItem = {
      id,
      file,
      name: file.name,
      url,
      defaultMode: 'auto',
      subject: 'unknown',
      crops: [
        {
          id: firstCropId,
          title: '题目 1',
          crop: { unit: '%', width: 50, height: 50, x: 25, y: 25 },
          mode: 'auto'
        }
      ],
      groups: {},
      activeCropId: firstCropId
    }

    setImages((prev) => [...prev, newImage])
    setActiveImageId((prev) => prev || id)
  }

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((x) => x.id === id)
      if (target) URL.revokeObjectURL(target.url)
      const next = prev.filter((x) => x.id !== id)
      if (activeImageId === id) setActiveImageId(next[0]?.id || '')
      return next
    })
    setCrossImageMergeOverrides((prev) => {
      const next: Record<string, CrossImageMergeOverride> = {}
      for (const [toImageId, rule] of Object.entries(prev)) {
        if (toImageId === id) continue
        if (rule.fromImageId === id) continue
        next[toImageId] = rule
      }
      return next
    })
  }

  const resetAll = () => {
    for (const image of images) {
      URL.revokeObjectURL(image.url)
    }
    setImages([])
    setActiveImageId('')
    setTasks([])
    setCrossImageMergeOverrides({})
    setCrossImageMergeModalOpen(false)
    setMergeFromCropId('')
    setMergeToCropId('')
  }

  const updateImage = (id: string, updater: (img: ImageItem) => ImageItem) => {
    setImages((prev) => prev.map((img) => (img.id === id ? updater(img) : img)))
  }

  const buildPrompt = (groupTitle: string, groupCrops: Array<{ label: string; title: string }>) => {
    const lines: string[] = []
    if (groupCrops.length > 1) {
      lines.push(`以下是同一道题的多个裁剪区域（可能跨多张图片），请合并理解后解答。合并题目：${groupTitle}`)
    } else {
      lines.push(`题目标题：${groupTitle}`)
    }
    lines.push(...groupCrops.map((c, idx) => `区域${idx + 1}：${c.label} - ${c.title || `题目 ${idx + 1}`}`))
    return lines.join('\n')
  }

  const subjectiveStyleStorageKey = 'aas-subjective-answer-style'

  const parseSubjectiveAnswerStyle = (value: unknown): SubjectiveAnswerStyle | undefined => {
    if (value === 'outline' || value === 'standard' || value === 'full') return value
    return undefined
  }

  const getSubjectiveStyleLabel = (style: SubjectiveAnswerStyle) =>
    style === 'outline' ? '提纲/要点' : style === 'full' ? '成文作答' : '标准答题'

  const isLikelySubjectiveQuestion = (questionText: string): boolean => {
    const q = (questionText || '').trim()
    if (!q) return false

    const essayLike =
      /(作文|写作|命题作文|材料作文|读后感|演讲稿|书信|写一篇|以.+为题|不少于\s*\d+\s*字|字数\s*(不少于|不少于)|write\s+(an|a)\s+(essay|composition|passage|article|story|letter)|essay|composition)/i
    const openEnded =
      /(谈谈|谈一谈|谈谈你的看法|阐述|论述|结合.+(分析|谈|说明)|简答|简述|说明理由|开放性|自拟题目)/i

    return essayLike.test(q) || openEnded.test(q)
  }

  const buildSubjectiveStylePrompt = (style: SubjectiveAnswerStyle) => {
    if (style === 'outline') {
      return [
        '如果题目属于主观题/作文/论述题，请按【提纲/要点】作答：',
        '- 先给出立意/核心观点（1-2 句）。',
        '- 给出结构化提纲（分点/分段），每点写清要写什么。',
        '- 如题目有字数/体裁/角度限制，请严格遵守并在提纲里体现。',
        '- 不要直接给完整正文（除非题目明确要求必须写成文）。'
      ].join('\n')
    }
    if (style === 'full') {
      return [
        '如果题目属于主观题/作文/论述题，请按【成文作答】作答：',
        '- 先给出立意/核心观点（1-2 句）。',
        '- 再输出一份可直接抄写的完整正文（分段清晰）。',
        '- 如有字数/题目/体裁要求，请严格满足；若未给字数，优先给中等篇幅。'
      ].join('\n')
    }
    return [
      '如果题目属于主观题/简答/论述题，请按【标准答题】作答：',
      '- 分点作答（要点+展开解释/例子），层次清晰。',
      '- 结尾给 1-2 句总结；如有评分点，尽量覆盖。'
    ].join('\n')
  }

  const askSubjectiveAnswerStyle = (questionText: string): Promise<SubjectiveAnswerStyle | null> => {
    const saved = (() => {
      try {
        return parseSubjectiveAnswerStyle(localStorage.getItem(subjectiveStyleStorageKey))
      } catch {
        return undefined
      }
    })()

    return new Promise((resolve) => {
      let selected: SubjectiveAnswerStyle = saved || 'standard'
      const preview = (questionText || '').replace(/\s+/g, ' ').trim().slice(0, 120)

      Modal.confirm({
        title: '检测到主观题',
        content: (
          <div>
            <div style={{ color: 'rgba(0,0,0,0.65)', marginBottom: 8 }}>请选择更适合的作答方式：</div>
            {!!preview && (
              <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginBottom: 12 }}>题目预览：{preview}…</div>
            )}
            <Radio.Group
              defaultValue={selected}
              onChange={(e) => {
                selected = e.target.value as SubjectiveAnswerStyle
              }}
            >
              <Space direction="vertical">
                <Radio value="outline">提纲/要点（先给思路，不直接成文）</Radio>
                <Radio value="standard">标准答题（分点 + 展开，适合考试）</Radio>
                <Radio value="full">成文作答（作文/论述完整正文）</Radio>
              </Space>
            </Radio.Group>
          </div>
        ),
        okText: '继续',
        cancelText: '取消',
        onOk: () => {
          try {
            localStorage.setItem(subjectiveStyleStorageKey, selected)
          } catch {
            // ignore
          }
          resolve(selected)
        },
        onCancel: () => resolve(null)
      })
    })
  }

  const openCrossImageMergeModal = () => {
    if (!activeImage) return
    if (!prevImage) {
      setMergeFromCropId('')
      setMergeToCropId(activeImage.crops[0]?.id || '')
      setCrossImageMergeModalOpen(true)
      return
    }

    const override = crossImageMergeOverrides[activeImage.id]
    const defaultFrom = prevImage.crops[prevImage.crops.length - 1]?.id || ''
    const defaultTo = activeImage.crops[0]?.id || ''
    setMergeFromCropId(override?.fromCropId || defaultFrom)
    setMergeToCropId(override?.toCropId || defaultTo)
    setCrossImageMergeModalOpen(true)
  }

  const applyCrossImageMergeOverride = () => {
    if (!activeImage || !prevImage) return
    if (!mergeFromCropId || !mergeToCropId) {
      message.warning('请选择要合并的题目')
      return
    }
    setCrossImageMergeOverrides((prev) => ({
      ...prev,
      [activeImage.id]: { fromImageId: prevImage.id, fromCropId: mergeFromCropId, toCropId: mergeToCropId }
    }))
    message.success('已应用跨图合并规则')
    setCrossImageMergeModalOpen(false)
  }

  const clearCrossImageMergeOverride = () => {
    if (!activeImage) return
    setCrossImageMergeOverrides((prev) => {
      const next = { ...prev }
      delete next[activeImage.id]
      return next
    })
    message.success('已清除自定义跨图合并规则')
  }

  const enqueueTask = (
    task: SolveTask,
    payload:
      | { kind: 'images'; blobs: Blob[]; prompt: string; subject: ImageItem['subject'] }
      | { kind: 'text'; text: string; subject: ImageItem['subject'] }
  ) => {
    taskPayloadsRef.current[task.id] = { ...payload, apiConfig: activeApiConfig }
    setTasks((prev) => [task, ...prev])
    setTaskDrawerOpen(true)
  }

  const cancelTask = (taskId: string) => {
    const controller = taskControllersRef.current[taskId]
    if (controller) controller.abort()
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId && (t.status === 'pending' || t.status === 'running')
          ? { ...t, status: 'canceled', error: '已取消' }
          : t
      )
    )
  }

  const cancelAllTasks = () => {
    const ids = tasks.filter((t) => t.status === 'pending' || t.status === 'running').map((t) => t.id)
    ids.forEach(cancelTask)
  }

  const deleteTask = (taskId: string) => {
    cancelTask(taskId)
    delete taskControllersRef.current[taskId]
    delete taskPayloadsRef.current[taskId]
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
  }

  const retryTask = (taskId: string) => {
    if (!taskPayloadsRef.current[taskId]) {
      message.warning('无法重试：缺少任务输入（请重新裁剪并发起解题）')
      return
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: 'pending',
              streamText: '',
              result: undefined,
              error: undefined,
              followUps: [],
              followUpDraft: '',
              followUpSending: false
            }
          : t
      )
    )
  }

  const retryFailedTasks = () => {
    const ids = tasks.filter((t) => t.status === 'error' || t.status === 'canceled').map((t) => t.id)
    ids.forEach(retryTask)
  }

  const startQueuedTask = useCallback(
    async (taskId: string) => {
      const payload = taskPayloadsRef.current[taskId]
      const task = tasks.find((t) => t.id === taskId)
      if (!payload || !task) return

      const controller = new AbortController()
      taskControllersRef.current[taskId] = controller

      const sanitize = (text: string) => text.replace(/<\/?think>/g, '')

      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: 'running', streamText: '', error: undefined } : t))
      )

      try {
        const onEvent = (event: StreamEvent) => {
          setTasks((prev) =>
            prev.map((t) => {
              if (t.id !== taskId) return t
              if (t.status === 'canceled') return t
              if (event.type === 'start') return { ...t, streamText: '' }
              if (event.type === 'delta' && event.value) return { ...t, streamText: t.streamText + sanitize(event.value) }
              if (event.type === 'model1' && event.content)
                return {
                  ...t,
                  streamText: `${t.streamText}\n\n[模型1 · 第${event.iteration ?? 0}轮]\n${sanitize(event.content)}\n`
                }
              if (event.type === 'model2' && event.content)
                return {
                  ...t,
                  streamText: `${t.streamText}\n\n[模型2 · 第${event.iteration ?? 0}轮]\n${sanitize(event.content)}\n`
                }
              if (event.type === 'status' && event.message) return { ...t, streamText: `${t.streamText}\n\n${sanitize(event.message)}\n` }
              if (event.type === 'complete' && event.value) {
                return { ...t, streamText: t.streamText ? t.streamText : sanitize(event.value) }
              }
              if (event.type === 'final') {
                return { ...t, streamText: `${t.streamText}\n\n[最终答案]\n${sanitize(event.result.answer)}\n` }
              }
              return t
            })
          )
        }

        const response =
          payload.kind === 'text'
            ? await solveQuestionTextStream(
                payload.text || '',
                onEvent,
                (u) => setUsageInfo(u),
                payload.apiConfig,
                task.mode,
                payload.subject,
                controller.signal
              )
            : await solveQuestionMultiStream(
                payload.blobs || [],
                payload.prompt,
                onEvent,
                (u) => setUsageInfo(u),
                payload.apiConfig,
                task.mode,
                payload.subject,
                controller.signal
              )

        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')

        let finalResponse = response
        let subjectiveStyle: SubjectiveAnswerStyle | undefined = undefined

        if (maxConcurrentTasks === 1 && isLikelySubjectiveQuestion(response.question)) {
          const chosen = await askSubjectiveAnswerStyle(response.question)
          if (chosen) {
            subjectiveStyle = chosen
            setTasks((prev) =>
              prev.map((t) => (t.id === taskId ? { ...t, status: 'running', subjectiveAnswerStyle: chosen, result: response } : t))
            )

            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')

            try {
              const followUpMode = (response as any)?.routedMode === 'debate' ? 'debate' : 'single'
              const follow = await followUpQuestion(
                {
                  baseQuestion: response.question,
                  baseAnswer: response.answer,
                  prompt: buildSubjectiveStylePrompt(chosen),
                  mode: followUpMode,
                  routedSubject: (response as any)?.routedSubject
                },
                payload.apiConfig
              )

              const mergedTokensUsed =
                typeof response.tokensUsed === 'number' && typeof follow.tokensUsed === 'number'
                  ? response.tokensUsed + follow.tokensUsed
                  : typeof response.tokensUsed === 'number'
                    ? response.tokensUsed
                    : typeof follow.tokensUsed === 'number'
                      ? follow.tokensUsed
                      : undefined

              finalResponse = {
                ...response,
                answer: follow.answer,
                ...(typeof mergedTokensUsed === 'number' ? { tokensUsed: mergedTokensUsed } : {})
              }
            } catch (e) {
              subjectiveStyle = undefined
              setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, subjectiveAnswerStyle: undefined } : t)))
              message.error(e instanceof Error ? e.message : '主观题答案生成失败（已保留原答案）')
            }
          }
        }

        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, status: 'done', result: finalResponse, subjectiveAnswerStyle: subjectiveStyle || t.subjectiveAnswerStyle }
              : t
          )
        )
        try {
          setUsageInfo(await getUsage())
        } catch {
          // ignore
        }
      } catch (error) {
        if ((error as any)?.name === 'AbortError') {
          setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: 'canceled', error: '已取消' } : t)))
          return
        }
        const errorMessage = error instanceof Error ? error.message : '解答失败，请重试'
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: 'error', error: errorMessage } : t)))
        message.error(errorMessage)
      } finally {
        delete taskControllersRef.current[taskId]
      }
    },
    [tasks, maxConcurrentTasks]
  )

  useEffect(() => {
    if (schedulerTickingRef.current) return
    schedulerTickingRef.current = true

    try {
      const running = tasks.filter((t) => t.status === 'running').length
      const slots = Math.max(0, maxConcurrentTasks - running)
      if (!slots) return

      const toStart = tasks
        .filter((t) => t.status === 'pending')
        .slice(0, slots)
        .map((t) => t.id)

      toStart.forEach((id) => void startQueuedTask(id))
    } finally {
      schedulerTickingRef.current = false
    }
  }, [tasks, maxConcurrentTasks, startQueuedTask])

  useEffect(() => {
    if (!taskDrawerOpen) return
    ;(async () => {
      try {
        setUsageInfo(await getUsage())
      } catch {
        // ignore
      }
    })()
  }, [taskDrawerOpen])

  useEffect(() => {
    ;(async () => {
      try {
        const result = await listFiles()
        setKnowledgeBaseFiles(result.files)
      } catch {
        // ignore
      }
    })()
  }, [])

  const clearFollowUps = (taskId: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              followUps: [],
              followUpDraft: '',
              followUpSending: false
            }
          : t
      )
    )
  }

  const sendFollowUp = async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task?.result) return
    if (apiConfigEnabled && !apiKey.trim()) {
      message.error('已开启自定义 API，但未填写 API Key')
      return
    }

    const prompt = task.followUpDraft.trim()
    if (!prompt) return

    const userMsg: FollowUpMessage = { id: createId(), role: 'user', content: prompt, createdAt: Date.now(), status: 'done' }
    const assistantMsgId = createId()
    const assistantMsg: FollowUpMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'pending'
    }

    const historyForApi: FollowUpChatMessage[] = task.followUps
      .filter((m) => m.status !== 'pending')
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-20)

    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              followUps: [...t.followUps, userMsg, assistantMsg],
              followUpDraft: '',
              followUpSending: true
            }
          : t
      )
    )

    try {
      const followUpMode = (task.result as any)?.routedMode === 'debate' ? 'debate' : 'single'
      const response = await followUpQuestion(
        {
          baseQuestion: task.result.question,
          baseAnswer: task.result.answer,
          prompt,
          mode: followUpMode,
          messages: historyForApi,
          routedSubject: (task.result as any)?.routedSubject
        },
        activeApiConfig
      )

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                followUpSending: false,
                followUps: t.followUps.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: response.answer, status: 'done' } : m
                )
              }
            : t
        )
      )
      try {
        setUsageInfo(await getUsage())
      } catch {
        // ignore
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '追问失败，请重试'
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                followUpSending: false,
                followUps: t.followUps.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: errorMessage, status: 'error' } : m
                )
              }
            : t
        )
      )
      message.error(errorMessage)
    }
  }

  const solveActiveImage = async () => {
    if (!activeImage) return
    if (activeImage.subject === 'unknown') {
      message.warning('请先在当前页面选择文科/理科分科')
      return
    }
    if (apiConfigEnabled && !apiKey.trim()) {
      message.error('已开启自定义 API，但未填写 API Key')
      return
    }

    type CropRef = { image: ImageItem; crop: CropBox; label: string; order: number }

    const groupKey = (crop: CropBox) => crop.groupId || crop.id

    const groups = new Map<string, CropRef[]>()
    const addToGroup = (key: string, ref: CropRef) => {
      const current = groups.get(key) || []
      const exists = current.some((x) => x.image.id === ref.image.id && x.crop.id === ref.crop.id)
      if (!exists) groups.set(key, [...current, ref])
    }

    const activeCropOrder = new Map<string, number>()
    activeImage.crops.forEach((c, idx) => activeCropOrder.set(c.id, idx))

    for (const crop of activeImage.crops) {
      addToGroup(groupKey(crop), {
        image: activeImage,
        crop,
        label: activeImage.name,
        order: (activeImageIndex >= 0 ? activeImageIndex : 0) * 10_000 + (activeCropOrder.get(crop.id) ?? 0)
      })
    }

    if (crossImageMergeEnabled && prevImage && prevImage.crops.length && activeImage.crops.length) {
      const override = crossImageMergeOverrides[activeImage.id]
      const fallbackFrom = prevImage.crops[prevImage.crops.length - 1]
      const fallbackTo = activeImage.crops[0]

      const fromCrop =
        (override?.fromImageId === prevImage.id ? prevImage.crops.find((c) => c.id === override.fromCropId) : undefined) ||
        fallbackFrom
      const toCrop = activeImage.crops.find((c) => c.id === override?.toCropId) || fallbackTo

      if (fromCrop && toCrop) {
        if (prevImage.subject === 'unknown') {
          message.warning('检测到跨图合并，但上一页未选择文科/理科分科')
          return
        }
        if (prevImage.subject !== activeImage.subject) {
          message.error('跨图合并的两页分科不一致，请先把两页都选成同一种（文科/理科）')
          return
        }
        const key = groupKey(toCrop)
        const prevCropOrder = new Map<string, number>()
        prevImage.crops.forEach((c, idx) => prevCropOrder.set(c.id, idx))

        const fromKey = groupKey(fromCrop)
        const fromGroupCrops = prevImage.crops.filter((c) => groupKey(c) === fromKey)

        for (const c of fromGroupCrops) {
          addToGroup(key, {
            image: prevImage,
            crop: c,
            label: prevImage.name,
            order: (activeImageIndex - 1) * 10_000 + (prevCropOrder.get(c.id) ?? 0)
          })
        }
      }
    }

    if (!groups.size) {
      message.warning('请先添加裁剪框')
      return
    }

    const ensureBlob = async (image: ImageItem, crop: CropBox): Promise<Blob | null> => {
      if (crop.blob) return crop.blob
      try {
        const blob = await cropToJpegBlobFromFile(image.file, crop.crop)
        if (blob) {
          updateImage(image.id, (prev) => ({
            ...prev,
            crops: prev.crops.map((c) => (c.id === crop.id ? { ...c, blob } : c))
          }))
        }
        return blob
      } catch {
        return null
      }
    }

    for (const [groupId, groupRefs] of groups) {
      const groupCrops = [...groupRefs].sort((a, b) => a.order - b.order)
      const title = activeImage.groups[groupId] || groupCrops.find((x) => x.image.id === activeImage.id)?.crop.title || '题目'

      // Check for mode conflicts
      const uniqueModes = [...new Set(groupCrops.map((gc) => gc.crop.mode))]
      let selectedMode: ModelMode

      if (uniqueModes.length > 1) {
        // Show modal to let user choose mode
        const modeChoice = await new Promise<ModelMode | null>((resolve) => {
          Modal.confirm({
            title: '模式冲突',
            content: (
              <div>
                <p>该组裁剪框包含不同的解题模式：</p>
                <ul>
                  {uniqueModes.map((mode) => (
                    <li key={mode}>
                      {mode === 'auto' ? '🔄 自动路由' : mode === 'single' ? '⚡ 单模型' : '🔍 双模型审查'}
                    </li>
                  ))}
                </ul>
                <p>请选择使用哪种模式：</p>
                <Select
                  defaultValue={uniqueModes[0]}
                  style={{ width: '100%' }}
                  onChange={(value) => {
                    // Store the selected value temporarily
                    (Modal as any)._selectedMode = value
                  }}
                  options={uniqueModes.map((mode) => ({
                    value: mode,
                    label: mode === 'auto' ? '🔄 自动路由（推荐）' : mode === 'single' ? '⚡ 单模型' : '🔍 双模型审查'
                  }))}
                />
              </div>
            ),
            onOk: () => {
              resolve((Modal as any)._selectedMode || uniqueModes[0])
              delete (Modal as any)._selectedMode
            },
            onCancel: () => {
              resolve(null)
              delete (Modal as any)._selectedMode
            },
            okText: '确定',
            cancelText: '取消'
          })
        })

        if (modeChoice === null) {
          // User cancelled
          return
        }
        selectedMode = modeChoice
      } else {
        selectedMode = uniqueModes[0]
      }

      const blobs: Blob[] = []
      for (const ref of groupCrops) {
        const blob = await ensureBlob(ref.image, ref.crop)
        if (!blob) {
          message.error(`「${ref.crop.title || title}」裁剪区域生成失败（请尝试重新调整裁剪框）`)
          return
        }
        blobs.push(blob)
      }

      const task: SolveTask = {
        id: createId(),
        createdAt: Date.now(),
        imageId: activeImage.id,
        title,
        mode: selectedMode,
        status: 'pending',
        streamText: '',
        followUps: [],
         followUpDraft: '',
         followUpSending: false
       }
      const prompt = buildPrompt(
        title,
        groupCrops.map((x) => ({ label: x.label, title: x.crop.title }))
      )
      enqueueTask(task, { kind: 'images', blobs, prompt, subject: activeImage.subject })
    }
  }

  const exportMarkdown = async () => {
    const completed = tasks.filter((t) => t.status === 'done' && t.result)
    if (!completed.length) {
      message.warning('暂无可导出的结果')
      return
    }
    setExportingMd(true)
    try {
      const clean = (text: string | undefined) => (text || '').replace(/<\/?think>/g, '').trim()
      const lines: string[] = []
      lines.push('# AI 搜题结果')
      lines.push(`导出时间：${new Date().toLocaleString()}`)
      lines.push('')

      for (const task of completed) {
        lines.push(`## ${task.title}`)
        const baseModeLabel = '自动路由'
        const routedSubject = (task.result as any)?.routedSubject
        const routedMode = (task.result as any)?.routedMode
        const routedSubjectLabel =
          routedSubject === 'science' ? '理科' : routedSubject === 'humanities' ? '文科' : routedSubject ? '不确定' : ''
        const routedModeLabel =
          routedMode === 'debate' ? '双模型' : routedMode === 'single' ? '单模型' : routedMode ? String(routedMode) : ''
        const routeSuffix =
          routedSubjectLabel || routedModeLabel
            ? `（${routedSubjectLabel}${routedModeLabel ? `→${routedModeLabel}` : ''}）`
            : ''
        lines.push(`- 模式：${baseModeLabel}${routeSuffix}`)
        lines.push(`- 时间：${new Date(task.createdAt).toLocaleString()}`)
        lines.push('')
        lines.push('### 题目')
        lines.push(clean(task.result?.question))
        lines.push('')
        lines.push('### 解答')
        lines.push(clean(task.result?.answer))
        lines.push('')
      }

      const markdown = lines.join('\n')
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const filename = `AI搜题结果-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExportingMd(false)
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="brand">
          <div className="brand-logo">
            <img src={logo} alt="All the Answer logo" />
          </div>
          <div className="brand-text">
            <span className="brand-kicker">ALL THE ANSWER</span>
            <h1>AI 搜题助手</h1>
            <p>上传题目图片，精准识别与逐步解答</p>
          </div>
        </div>
        <div className="hero-badges">
          <span>视觉识题</span>
          <span>步骤推理</span>
          <span>多模型校验</span>
        </div>
      </header>

      <main className="app-main">
        <Card className="upload-card">
          <input
            ref={imagePickerRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'))
              e.target.value = ''
              if (!files.length) return
              files.forEach(addImageFile)
              message.success(`已添加 ${files.length} 张图片`)
            }}
          />

          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Input.TextArea
              value={questionDraft}
              onChange={(e) => setQuestionDraft(e.target.value)}
              placeholder="输入题目文字提问（也可把图片拖到这里/粘贴截图）"
              autoSize={{ minRows: 4, maxRows: 10 }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'))
                if (!files.length) return
                files.forEach(addImageFile)
                message.success(`已添加 ${files.length} 张图片（来自粘贴）`)
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
                if (!files.length) return
                files.forEach(addImageFile)
                message.success(`已添加 ${files.length} 张图片（来自拖拽）`)
              }}
            />

            <Space wrap style={{ justifyContent: 'space-between' }}>
              <Space wrap>
                <Button onClick={() => imagePickerRef.current?.click()}>选择图片</Button>
                <Select
                  value={questionMode}
                  onChange={(v) => setQuestionMode(v as ModelMode)}
                  style={{ width: 160 }}
                  options={[
                    { value: 'auto', label: '自动路由' },
                    { value: 'single', label: '单模型' },
                    { value: 'debate', label: '双模型' }
                  ]}
                />
                <Select
                  value={questionSubject}
                  onChange={(v) => setQuestionSubject(v as ImageItem['subject'])}
                  style={{ width: 180 }}
                  options={[
                    { value: 'unknown', label: '不确定（推荐）' },
                    { value: 'science', label: '理科' },
                    { value: 'humanities', label: '文科' }
                  ]}
                />
              </Space>

              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={() => {
                  const text = questionDraft.trim()
                  if (!text) {
                    message.warning('请先输入题目文字')
                    return
                  }
                  if (apiConfigEnabled && !apiKey.trim()) {
                    message.error('已开启自定义 API，但未填写 API Key')
                    return
                  }

                  const title = text.replace(/\s+/g, ' ').slice(0, 24) || '文字题目'
                  const task: SolveTask = {
                    id: createId(),
                    createdAt: Date.now(),
                    imageId: '',
                    title,
                    mode: questionMode,
                    status: 'pending',
                    streamText: '',
                    followUps: [],
                    followUpDraft: '',
                    followUpSending: false
                  }

                  enqueueTask(task, { kind: 'text', text, subject: questionSubject })
                  setQuestionDraft('')
                }}
              >
                发送文字提问
              </Button>
            </Space>
          </Space>

          <div style={{ marginTop: 16 }}>
            <KnowledgeBasePanel files={knowledgeBaseFiles} onFilesChange={setKnowledgeBaseFiles} />
          </div>

          <div className="action-buttons" style={{ justifyContent: 'space-between' }}>
            <Button onClick={() => setApiConfigOpen(true)}>自定义 API（临时）{apiConfigEnabled ? '：已开启' : ''}</Button>
            {(images.length > 0 || tasks.length > 0) && (
              <Button danger icon={<DeleteOutlined />} onClick={resetAll}>
                清空所有图片与结果
              </Button>
            )}
          </div>
        </Card>

        {images.length > 0 && (
          <Card className="crop-card">
            <Tabs
              activeKey={activeImageId}
              onChange={setActiveImageId}
              items={images.map((img) => {
                const actionLabel = '开始解答（按每题模式）'

                return {
                  key: img.id,
                  label: img.name,
                  children: (
                    <div className="workspace">
                      <div className="workspace-toolbar">
                        <div className="mode-hint" style={{ fontSize: 12, color: '#666' }}>
                          每道题的解题模式请在题目列表中单独选择（自动/单模型/双模型）。
                        </div>

                        <div>
                          <span style={{ marginRight: 8, fontWeight: 500 }}>本页分科：</span>
                          <Select
                            value={img.subject}
                            onChange={(subject) =>
                              updateImage(img.id, (prev) => ({ ...prev, subject: subject as ImageItem['subject'] }))
                            }
                            style={{ width: 220 }}
                            options={[
                              { value: 'unknown', label: '请选择（文科/理科）' },
                              { value: 'humanities', label: '文科' },
                              { value: 'science', label: '理科' }
                            ]}
                          />
                        </div>

                        <Space wrap>
                          <Button icon={<LinkOutlined />} onClick={openCrossImageMergeModal} disabled={!activeImage}>
                            跨图合并
                          </Button>
                          <Button danger icon={<DeleteOutlined />} onClick={() => removeImage(img.id)}>
                            删除该图片
                          </Button>
                          <Button
                            type="primary"
                            icon={<SendOutlined />}
                            onClick={solveActiveImage}
                            disabled={activeImageId !== img.id}
                          >
                            {actionLabel}
                          </Button>
                        </Space>
                      </div>

                      <MultiCropper
                        imageUrl={img.url}
                        crops={img.crops}
                        groups={img.groups}
                        activeCropId={img.activeCropId}
                        defaultMode={img.defaultMode}
                        onChange={(next) =>
                          updateImage(img.id, (prev) => ({
                            ...prev,
                            crops: next.crops,
                            groups: next.groups,
                            activeCropId: next.activeCropId
                          }))
                        }
                      />
                    </div>
                  )
                }
              })}
            />
          </Card>
        )}

        <Drawer
          title={`任务中心（${tasks.length}）`}
          placement="right"
          open={taskDrawerOpen}
          onClose={() => setTaskDrawerOpen(false)}
          width={520}
          extra={
            <Space>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={exportMarkdown}
                  loading={exportingMd}
                  disabled={!tasks.some((t) => t.status === 'done' && t.result)}
                >
                  下载 MD
                </Button>
            </Space>
          }
        >
          {usageInfo?.enabled && usageInfo.limitTokens > 0 ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span>Token 用量</span>
                <span style={{ color: 'rgba(0,0,0,0.65)' }}>
                  {usageInfo.usedTokens}/{usageInfo.limitTokens}
                </span>
              </div>
              <Progress
                percent={Math.min(100, Math.round((usageInfo.usedTokens / usageInfo.limitTokens) * 100))}
                status={usageInfo.remainingTokens <= 0 ? 'exception' : 'active'}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'rgba(0,0,0,0.45)' }}>
                <span>剩余 {usageInfo.remainingTokens}</span>
                <span>
                  重置 {new Date(usageInfo.resetAtMs).toLocaleString()}（{usageInfo.windowHours}h）
                </span>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 16, color: 'rgba(0,0,0,0.45)' }}>Token 用量限制未开启</div>
          )}

          <div style={{ marginBottom: 16 }}>
            <Space wrap>
              <span>并发</span>
              <Select
                value={maxConcurrentTasks}
                onChange={(v) => setMaxConcurrentTasks(v)}
                style={{ width: 120 }}
                options={[1, 2, 3, 4].map((n) => ({ value: n, label: `${n}` }))}
              />
              <Button onClick={cancelAllTasks} disabled={!tasks.some((t) => t.status === 'pending' || t.status === 'running')}>
                取消全部
              </Button>
              <Button onClick={retryFailedTasks} disabled={!tasks.some((t) => t.status === 'error' || t.status === 'canceled')}>
                重试失败
              </Button>
            </Space>
          </div>

          <Collapse
            accordion={false}
            items={tasks.map((task) => {
              const statusColor =
                task.status === 'done'
                  ? 'success'
                  : task.status === 'error'
                    ? 'error'
                    : task.status === 'running'
                      ? 'processing'
                      : task.status === 'canceled'
                        ? 'warning'
                        : 'default'
              const modeLabel = task.mode === 'auto' ? '自动' : task.mode === 'single' ? '单模型' : '双模型'
              const modeColor = task.mode === 'auto' ? 'blue' : task.mode === 'single' ? 'green' : 'purple'
              const routedSubject = (task.result as any)?.routedSubject
              const routedMode = (task.result as any)?.routedMode
              const routedLabel =
                routedSubject || routedMode
                  ? `${routedSubject === 'science' ? '理科' : routedSubject === 'humanities' ? '文科' : '不确定'}→${
                      routedMode === 'debate' ? '双模型' : routedMode === 'single' ? '单模型' : '未知'
                    }`
                  : ''
              return {
                key: task.id,
                label: (
                  <div className="task-label">
                    <span className="task-title">{task.title}</span>
                    <Space size="small">
                      <Tag color={modeColor}>{modeLabel}</Tag>
                      {!!routedLabel && <Tag color="geekblue">{routedLabel}</Tag>}
                      {!!task.subjectiveAnswerStyle && (
                        <Tag color="gold">主观题：{getSubjectiveStyleLabel(task.subjectiveAnswerStyle)}</Tag>
                      )}
                      {typeof task.result?.tokensUsed === 'number' && <Tag color="purple">{task.result.tokensUsed} tokens</Tag>}
                      <Tag color={statusColor}>{task.status}</Tag>
                    </Space>
                  </div>
                ),
                children: (
                  <div className="task-body">
                    <Space wrap style={{ marginBottom: 8 }}>
                      {(task.status === 'pending' || task.status === 'running') && (
                        <Button danger size="small" onClick={() => cancelTask(task.id)}>
                          取消
                        </Button>
                      )}
                      {(task.status === 'error' || task.status === 'canceled') && (
                        <Button size="small" onClick={() => retryTask(task.id)}>
                          重试
                        </Button>
                      )}
                      <Button size="small" onClick={() => deleteTask(task.id)}>
                        移除
                      </Button>
                    </Space>
                    {task.error && <div className="task-error">{task.error}</div>}
                    <Collapse
                      className="stream-collapse"
                      items={[
                        {
                          key: 'stream',
                          label: '流式输出',
                          children: <pre className="stream-content">{task.streamText || '等待模型输出...'}</pre>
                        }
                      ]}
                    />
                    {task.result && (
                      <div className="task-result">
                        <div className="task-result-title">最终答案</div>
                        <div className="task-result-title" style={{ marginTop: 12 }}>
                          题目
                        </div>
                        <MarkdownView markdown={task.result.question} className="task-result-content" />
                        <div className="task-result-title" style={{ marginTop: 12 }}>
                          解答
                        </div>
                        <MarkdownView markdown={task.result.answer} className="task-result-content" />

                        <div className="task-result-title" style={{ marginTop: 16 }}>
                          继续提问
                        </div>
                        <div className="followup-thread">
                          {task.followUps.length ? (
                            task.followUps.map((m) => (
                              <div key={m.id} className={`followup-msg ${m.role} ${m.status === 'error' ? 'error' : ''}`.trim()}>
                                <div className="followup-meta">{m.role === 'user' ? '你' : 'AI'}</div>
                                <div className="followup-bubble">
                                  {m.role === 'assistant' ? (
                                    <MarkdownView
                                      markdown={m.content || (m.status === 'pending' ? '...' : '')}
                                      className="followup-content"
                                    />
                                  ) : (
                                    <div className="followup-content">{m.content}</div>
                                  )}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="followup-empty">可以在这里继续追问，比如“这题还有别的解法吗？”</div>
                          )}
                        </div>
                        <Space.Compact style={{ width: '100%' }}>
                          <Input
                            placeholder="继续提问..."
                            value={task.followUpDraft}
                            onChange={(e) =>
                              setTasks((prev) =>
                                prev.map((t) => (t.id === task.id ? { ...t, followUpDraft: e.target.value } : t))
                              )
                            }
                            onPressEnter={() => sendFollowUp(task.id)}
                            disabled={task.followUpSending}
                          />
                          <Button
                            type="primary"
                            loading={task.followUpSending}
                            disabled={!task.followUpDraft.trim() || task.followUpSending}
                            onClick={() => sendFollowUp(task.id)}
                          >
                            发送
                          </Button>
                        </Space.Compact>
                        {task.followUps.length > 0 && (
                          <div style={{ marginTop: 8, textAlign: 'right' }}>
                            <Button size="small" onClick={() => clearFollowUps(task.id)} disabled={task.followUpSending}>
                              清空追问
                            </Button>
                          </div>
                        )}
                        {typeof task.result.iterations === 'number' && (
                          <Space>
                            <Tag color="blue">迭代 {task.result.iterations} 次</Tag>
                            <Tag color={task.result.consensus ? 'success' : 'warning'}>
                              {task.result.consensus ? '达成共识' : '未达成共识'}
                            </Tag>
                          </Space>
                        )}
                      </div>
                    )}
                  </div>
                )
              }
            })}
          />
        </Drawer>

        {hasAnyTasks && (
          <FloatButton
            type="primary"
            onClick={() => setTaskDrawerOpen(true)}
            description={runningCount ? '解题中' : '结果'}
            badge={{ count: runningCount }}
          />
        )}

        <Modal
          title="跨图片合并"
          open={crossImageMergeModalOpen}
          onCancel={() => setCrossImageMergeModalOpen(false)}
          footer={
            <Space>
              {activeImage && crossImageMergeOverrides[activeImage.id] && (
                <Button danger onClick={clearCrossImageMergeOverride}>
                  清除自定义
                </Button>
              )}
              <Button onClick={() => setCrossImageMergeModalOpen(false)}>关闭</Button>
              <Button type="primary" onClick={applyCrossImageMergeOverride} disabled={!prevImage}>
                应用自定义
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <div style={{ marginBottom: 8 }}>启用跨图合并</div>
              <Switch
                checked={crossImageMergeEnabled}
                onChange={setCrossImageMergeEnabled}
                checkedChildren="开启"
                unCheckedChildren="关闭"
              />
            </div>

            {!prevImage ? (
              <div style={{ color: 'rgba(0,0,0,0.45)' }}>当前为第一张图片，没有上一张可合并。</div>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }}>
                <div style={{ color: 'rgba(0,0,0,0.45)' }}>
                  默认规则：上一张图片的最后一个裁剪框（及其合并组）合并到本图的第一个裁剪框（及其合并组）（开启时生效）。可在下方自定义覆盖。
                </div>
                <div>
                  <div style={{ marginBottom: 8 }}>上一张图片题目</div>
                  <Select
                    style={{ width: '100%' }}
                    value={mergeFromCropId}
                    onChange={setMergeFromCropId}
                    options={prevImage.crops.map((c, idx) => ({ value: c.id, label: `${idx + 1}. ${c.title || '题目'}` }))}
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 8 }}>本图题目</div>
                  <Select
                    style={{ width: '100%' }}
                    value={mergeToCropId}
                    onChange={setMergeToCropId}
                    options={activeImage?.crops.map((c, idx) => ({ value: c.id, label: `${idx + 1}. ${c.title || '题目'}` })) ?? []}
                  />
                </div>
              </Space>
            )}
          </Space>
        </Modal>

        <Modal
          title="自定义 API（临时，不保存）"
          open={apiConfigOpen}
          onCancel={() => setApiConfigOpen(false)}
          footer={
            <Space>
              <Button onClick={() => fileImportRef.current?.click()}>导入</Button>
              <Button icon={<DownloadOutlined />} onClick={exportApiConfig}>
                导出
              </Button>
              <Button
                danger
                onClick={() => {
                  setApiConfigEnabled(false)
                  setApiKey('')
                  setApiBaseUrl('')
                  setApiSingleModel('')
                  setApiDebateModel1('')
                  setApiDebateModel2('')
                  setApiRouterModel('')
                }}
              >
                清空
              </Button>
              <Button onClick={() => setApiConfigOpen(false)}>关闭</Button>
            </Space>
          }
        >
          <input
            ref={fileImportRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              importApiConfigFromFile(file)
            }}
          />
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div style={{ color: 'rgba(0,0,0,0.45)' }}>
              仅本次页面会话生效，不会写入本地存储；刷新页面会丢失。API Key 会随请求发送到本服务端用于调用模型。
            </div>
            <div>
              <div style={{ marginBottom: 8 }}>启用自定义 API</div>
              <Switch
                checked={apiConfigEnabled}
                onChange={setApiConfigEnabled}
                checkedChildren="开启"
                unCheckedChildren="关闭"
              />
            </div>
            <div>
              <div style={{ marginBottom: 8 }}>API Key</div>
              <Input.Password value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" />
            </div>
            <div>
              <div style={{ marginBottom: 8 }}>代理地址 / Base URL（可选）</div>
              <Input
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
              />
            </div>
            <div>
              <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
                <div style={{ marginBottom: 8 }}>模型（可选）</div>
                <Button size="small" loading={availableModelsLoading} onClick={refreshAvailableModels}>
                  刷新模型列表
                </Button>
              </Space>
              <Select
                mode="tags"
                value={customAvailableModels}
                onChange={setCustomAvailableModels}
                tokenSeparators={[',']}
                placeholder="可用模型列表（可选，逗号分隔）。例如：gpt-4o,gpt-4o-mini"
                style={{ width: '100%', marginBottom: 8 }}
                options={[...new Set([...customAvailableModels, ...availableModels])].map((m) => ({ value: m, label: m }))}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                <div>
                  <div style={{ marginBottom: 6, color: 'rgba(0,0,0,0.65)' }}>单模型（不填则随机）</div>
                  <AutoComplete
                    value={apiSingleModel}
                    onChange={setApiSingleModel}
                    placeholder="例如：gpt-4o-mini"
                    style={{ width: '100%' }}
                    options={[...new Set([...customAvailableModels, ...availableModels])].map((m) => ({ value: m, label: m }))}
                    filterOption={(input, option) =>
                      (option?.value ?? '')
                        .toString()
                        .toLowerCase()
                        .includes(input.toLowerCase())
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 6, color: 'rgba(0,0,0,0.65)' }}>双模型-主答（不填则随机）</div>
                  <AutoComplete
                    value={apiDebateModel1}
                    onChange={setApiDebateModel1}
                    placeholder="例如：gpt-4o-mini"
                    style={{ width: '100%' }}
                    options={[...new Set([...customAvailableModels, ...availableModels])].map((m) => ({ value: m, label: m }))}
                    filterOption={(input, option) =>
                      (option?.value ?? '')
                        .toString()
                        .toLowerCase()
                        .includes(input.toLowerCase())
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 6, color: 'rgba(0,0,0,0.65)' }}>双模型-审查（不填则随机）</div>
                  <AutoComplete
                    value={apiDebateModel2}
                    onChange={setApiDebateModel2}
                    placeholder="例如：gpt-4o"
                    style={{ width: '100%' }}
                    options={[...new Set([...customAvailableModels, ...availableModels])].map((m) => ({ value: m, label: m }))}
                    filterOption={(input, option) =>
                      (option?.value ?? '')
                        .toString()
                        .toLowerCase()
                        .includes(input.toLowerCase())
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 6, color: 'rgba(0,0,0,0.65)' }}>自动路由-路由模型（不填则随机）</div>
                  <AutoComplete
                    value={apiRouterModel}
                    onChange={setApiRouterModel}
                    placeholder="例如：gpt-4o-mini"
                    style={{ width: '100%' }}
                    options={[...new Set([...customAvailableModels, ...availableModels])].map((m) => ({ value: m, label: m }))}
                    filterOption={(input, option) =>
                      (option?.value ?? '')
                        .toString()
                        .toLowerCase()
                        .includes(input.toLowerCase())
                    }
                  />
                </div>
              </div>
              {customAvailableModels.length > 0 ? (
                <div style={{ marginTop: 6, color: 'rgba(0,0,0,0.45)' }}>当前优先使用你填写的“可用模型列表”。</div>
              ) : availableModels.length > 0 ? (
                <div style={{ marginTop: 6, color: 'rgba(0,0,0,0.45)' }}>
                  可用模型来自服务端通过 API 拉取（`GET /v1/models`，会自动使用你填写的 Key/BaseURL）。`AAS_MODEL_LIST` 已弃用。
                </div>
              ) : null}
            </div>
          </Space>
        </Modal>

      </main>
    </div>
  )
}

export default App
