import { useMemo, useState } from 'react'
import { Upload, Button, Card, message, Switch, Space, Tooltip, Tabs, Drawer, Collapse, Tag, FloatButton } from 'antd'
import { UploadOutlined, SendOutlined, TeamOutlined, UserOutlined, DeleteOutlined, DownloadOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import MultiCropper, { CropBox, CropGroups, ModelMode } from './components/MultiCropper'
import MarkdownView from './components/MarkdownView'
import { solveQuestionMultiStream, StreamEvent, SolveQuestionResponse } from './services/api'
import logo from './assets/logo.png'
import './App.css'

type ImageItem = {
  id: string
  file: File
  name: string
  url: string
  defaultMode: ModelMode
  crops: CropBox[]
  groups: CropGroups
  activeCropId: string
}

type SolveTask = {
  id: string
  createdAt: number
  imageId: string
  title: string
  mode: ModelMode
  status: 'pending' | 'running' | 'done' | 'error'
  streamText: string
  result?: SolveQuestionResponse
  error?: string
}

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

function App() {
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [images, setImages] = useState<ImageItem[]>([])
  const [activeImageId, setActiveImageId] = useState<string>('')

  const [tasks, setTasks] = useState<SolveTask[]>([])
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false)
  const [exportingMd, setExportingMd] = useState(false)
  const [globalMode, setGlobalMode] = useState<ModelMode>('single')

  const activeImage = useMemo(() => images.find((img) => img.id === activeImageId), [images, activeImageId])
  const runningCount = useMemo(() => tasks.filter((t) => t.status === 'running' || t.status === 'pending').length, [tasks])
  const hasAnyTasks = tasks.length > 0

  const handleUpload = (file: File) => {
    const id = createId()
    const url = URL.createObjectURL(file)
    const firstCropId = createId()
    const newImage: ImageItem = {
      id,
      file,
      name: file.name,
      url,
      defaultMode: globalMode,
      crops: [
        {
          id: firstCropId,
          title: '题目 1',
          crop: { unit: '%', width: 50, height: 50, x: 25, y: 25 },
          mode: globalMode
        }
      ],
      groups: {},
      activeCropId: firstCropId
    }

    setImages((prev) => [...prev, newImage])
    setActiveImageId((prev) => prev || id)
    setFileList((prev) => [
      ...prev,
      { uid: id, name: file.name, status: 'done', originFileObj: file } as UploadFile
    ])
    return false
  }

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((x) => x.id === id)
      if (target) URL.revokeObjectURL(target.url)
      const next = prev.filter((x) => x.id !== id)
      if (activeImageId === id) setActiveImageId(next[0]?.id || '')
      return next
    })
    setFileList((prev) => prev.filter((f) => f.uid !== id))
  }

  const resetAll = () => {
    for (const image of images) {
      URL.revokeObjectURL(image.url)
    }
    setImages([])
    setActiveImageId('')
    setFileList([])
    setTasks([])
  }

  const updateImage = (id: string, updater: (img: ImageItem) => ImageItem) => {
    setImages((prev) => prev.map((img) => (img.id === id ? updater(img) : img)))
  }

  const buildPrompt = (groupTitle: string, groupCrops: CropBox[]) => {
    const lines: string[] = []
    if (groupCrops.length > 1) {
      lines.push(`以下是同一道题的多个裁剪区域，请合并理解后解答。合并题目：${groupTitle}`)
    } else {
      lines.push(`题目标题：${groupTitle}`)
    }
    lines.push(...groupCrops.map((c, idx) => `区域${idx + 1}：${c.title || `题目 ${idx + 1}`}`))
    return lines.join('\n')
  }

  const runTask = async (task: SolveTask, blobs: Blob[], prompt: string) => {
    setTaskDrawerOpen(true)

    const sanitize = (text: string) => text.replace(/<\/?think>/g, '')

    try {
      const response = await solveQuestionMultiStream(blobs, task.mode === 'debate', prompt, (event: StreamEvent) => {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== task.id) return t
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
            if (event.type === 'status' && event.message)
              return { ...t, streamText: `${t.streamText}\n\n${sanitize(event.message)}\n` }
            if (event.type === 'complete' && event.value) {
              return { ...t, streamText: t.streamText ? t.streamText : sanitize(event.value) }
            }
            if (event.type === 'final') {
              return { ...t, streamText: `${t.streamText}\n\n[最终答案]\n${sanitize(event.result.answer)}\n` }
            }
            return t
          })
        )
      })

      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                status: 'done',
                result: response
              }
            : t
        )
      )
      message.success(task.mode === 'debate' ? '多模型博弈完成！' : 'AI解答完成！')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '解答失败，请重试'
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: 'error', error: errorMessage } : t)))
      message.error(errorMessage)
      console.error(error)
    }
  }

  const solveActiveImage = async () => {
    if (!activeImage) return

    const groups = new Map<string, CropBox[]>()
    for (const crop of activeImage.crops) {
      const key = crop.groupId || crop.id
      const arr = groups.get(key) || []
      arr.push(crop)
      groups.set(key, arr)
    }

    if (!groups.size) {
      message.warning('请先添加裁剪框')
      return
    }

    for (const [groupId, groupCrops] of groups) {
      const title = activeImage.groups[groupId] || groupCrops[0]?.title || '题目'
      const blobs: Blob[] = []
      for (const c of groupCrops) {
        if (!c.blob) {
          message.error(`「${c.title || title}」尚未保存裁剪区域（请先调整一次裁剪框）`)
          return
        }
        blobs.push(c.blob)
      }

      const mode = groupCrops[0]?.mode || activeImage.defaultMode
      const task: SolveTask = {
        id: createId(),
        createdAt: Date.now(),
        imageId: activeImage.id,
        title,
        mode,
        status: 'running',
        streamText: ''
      }
      const prompt = buildPrompt(title, groupCrops)
      setTasks((prev) => [task, ...prev])
      runTask(task, blobs, prompt)
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
        lines.push(`- 模式：${task.mode === 'debate' ? '多模型博弈' : '单模型'}`)
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
          <Upload.Dragger
            fileList={fileList}
            beforeUpload={handleUpload}
            accept="image/*"
            multiple
            showUploadList={false}
          >
            <p className="ant-upload-drag-icon">
              <UploadOutlined />
            </p>
            <p className="ant-upload-text">点击或拖拽多张图片到此区域上传</p>
            <p className="ant-upload-hint">支持 JPG、PNG、WebP 等图片格式</p>
          </Upload.Dragger>
          {images.length > 0 && (
            <div className="action-buttons">
              <Button danger icon={<DeleteOutlined />} onClick={resetAll}>
                清空所有图片与结果
              </Button>
            </div>
          )}
        </Card>

        {images.length > 0 && (
          <Card className="crop-card">
            <Tabs
              activeKey={activeImageId}
              onChange={setActiveImageId}
              items={images.map((img) => {
                const activeCrop = img.crops.find((c) => c.id === img.activeCropId) || img.crops[0]
                const activeMode = activeCrop?.mode || img.defaultMode
                const modeSet = new Set(img.crops.map((c) => c.mode))
                const summaryMode = modeSet.size === 1 ? (modeSet.has('debate') ? 'debate' : 'single') : 'mixed'
                const actionLabel =
                  summaryMode === 'debate'
                    ? '开始多模型博弈'
                    : summaryMode === 'single'
                    ? '发送给 AI 解答'
                    : '开始解答（含单/多模型）'

                return {
                  key: img.id,
                  label: img.name,
                  children: (
                    <div className="workspace">
                      <div className="workspace-toolbar">
                        <Space direction="vertical" size="small">
                          <Space>
                            <Tooltip title="单模型模式使用一个AI模型快速解答">
                              <UserOutlined className={activeMode === 'single' ? 'mode-icon active' : 'mode-icon muted'} />
                            </Tooltip>
                            <Switch
                              checked={activeMode === 'debate'}
                              onChange={(checked) => {
                                const nextMode: ModelMode = checked ? 'debate' : 'single'
                                setGlobalMode(nextMode)
                                updateImage(img.id, (prev) => {
                                  const selected =
                                    prev.crops.find((c) => c.id === prev.activeCropId) || prev.crops[0]
                                  if (!selected) {
                                    return { ...prev, defaultMode: nextMode }
                                  }
                                  const groupKey = selected.groupId || selected.id
                                  const nextCrops = prev.crops.map((c) =>
                                    (c.groupId || c.id) === groupKey ? { ...c, mode: nextMode } : c
                                  )
                                  return { ...prev, defaultMode: nextMode, crops: nextCrops }
                                })
                              }}
                              checkedChildren="多模型博弈"
                              unCheckedChildren="单模型"
                            />
                            <Tooltip title="多模型博弈模式让两个AI模型相互审查和改进答案，提高准确性">
                              <TeamOutlined className={activeMode === 'debate' ? 'mode-icon active' : 'mode-icon muted'} />
                            </Tooltip>
                          </Space>
                          <div className="mode-hint">
                            当前题目为{activeMode === 'debate' ? '多模型' : '单模型'}，新增题目默认使用该模式
                          </div>
                          {activeMode === 'debate' && <div className="mode-hint">两个AI模型将相互审查与改进答案</div>}
                        </Space>

                        <Space wrap>
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
          <Collapse
            accordion={false}
            items={tasks.map((task) => {
              const statusColor =
                task.status === 'done' ? 'success' : task.status === 'error' ? 'error' : task.status === 'running' ? 'processing' : 'default'
              const modeLabel = task.mode === 'debate' ? '多模型' : '单模型'
              return {
                key: task.id,
                label: (
                  <div className="task-label">
                    <span className="task-title">{task.title}</span>
                    <Space size="small">
                      <Tag color="blue">{modeLabel}</Tag>
                      <Tag color={statusColor}>{task.status}</Tag>
                    </Space>
                  </div>
                ),
                children: (
                  <div className="task-body">
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

      </main>
    </div>
  )
}

export default App
