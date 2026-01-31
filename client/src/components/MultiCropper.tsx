import { useMemo, useRef, useState } from 'react'
import ReactCrop, { Crop, PixelCrop } from 'react-image-crop'
import { Button, Checkbox, Divider, Input, Modal, Select, Space, Tag, Typography, message } from 'antd'
import { PlusOutlined, DeleteOutlined, LinkOutlined, DisconnectOutlined } from '@ant-design/icons'
import 'react-image-crop/dist/ReactCrop.css'
import './MultiCropper.css'

export type ModelMode = 'single' | 'debate' | 'auto'

export type CropBox = {
  id: string
  title: string
  crop: Crop
  pixelCrop?: PixelCrop
  blob?: Blob
  groupId?: string
  mode: ModelMode
}

export type CropGroups = Record<string, string>

interface MultiCropperProps {
  imageUrl: string
  crops: CropBox[]
  groups: CropGroups
  activeCropId: string
  defaultMode: ModelMode
  onChange: (next: { crops: CropBox[]; groups: CropGroups; activeCropId: string }) => void
}

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

const createDefaultCrop = (index: number): Crop => {
  const offset = Math.min(index * 6, 24)
  return { unit: '%', width: 50, height: 50, x: 25 - offset / 2, y: 25 - offset / 2 }
}

const cropToBlob = async (img: HTMLImageElement, pixelCrop: PixelCrop) => {
  const canvas = document.createElement('canvas')
  const scaleX = img.naturalWidth / img.width
  const scaleY = img.naturalHeight / img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Export at (close to) the original image resolution; otherwise small text becomes unreadable.
  const srcW = Math.max(1, Math.round(pixelCrop.width * scaleX))
  const srcH = Math.max(1, Math.round(pixelCrop.height * scaleY))

  // Avoid generating extremely large images (which increases upload size and vision token usage).
  const maxSide = 3000
  const downScale = Math.min(1, maxSide / Math.max(srcW, srcH))
  const outW = Math.max(1, Math.round(srcW * downScale))
  const outH = Math.max(1, Math.round(srcH * downScale))

  canvas.width = outW
  canvas.height = outH
  ctx.imageSmoothingEnabled = true
  try {
    ;(ctx as any).imageSmoothingQuality = 'high'
  } catch {
    // ignore
  }

  ctx.drawImage(
    img,
    pixelCrop.x * scaleX,
    pixelCrop.y * scaleY,
    pixelCrop.width * scaleX,
    pixelCrop.height * scaleY,
    0,
    0,
    outW,
    outH
  )

  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.95)
  })
}

const toPixelCrop = (crop: Crop, img: HTMLImageElement): PixelCrop | null => {
  const width = crop.width ?? 0
  const height = crop.height ?? 0
  const x = crop.x ?? 0
  const y = crop.y ?? 0
  if (width <= 0 || height <= 0) return null

  if (crop.unit === '%') {
    return {
      unit: 'px',
      x: (x / 100) * img.width,
      y: (y / 100) * img.height,
      width: (width / 100) * img.width,
      height: (height / 100) * img.height
    }
  }

  return { unit: 'px', x, y, width, height }
}

function MultiCropper({ imageUrl, crops, groups, activeCropId, defaultMode, onChange }: MultiCropperProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mergeModalOpen, setMergeModalOpen] = useState(false)
  const [mergeTitle, setMergeTitle] = useState('合并题目')

  const activeCrop = useMemo(() => {
    const found = crops.find((item) => item.id === activeCropId)
    return found || crops[0]
  }, [crops, activeCropId])

  const setCrops = (nextCrops: CropBox[], nextGroups: CropGroups = groups, nextActiveId?: string) => {
    const safeActiveId = nextActiveId || (nextCrops.find((c) => c.id === activeCropId)?.id ?? nextCrops[0]?.id)
    if (!safeActiveId) return
    onChange({ crops: nextCrops, groups: nextGroups, activeCropId: safeActiveId })
  }

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)))
  }

  const handleCropChange = (next: Crop) => {
    if (!activeCrop) return
    setCrops(
      crops.map((item) => (item.id === activeCrop.id ? { ...item, crop: next } : item)),
      groups,
      activeCrop.id
    )
  }

  const handleCropComplete = async (pixelCrop: PixelCrop) => {
    if (!activeCrop) return
    const img = imgRef.current
    if (!img) return
    const blob = await cropToBlob(img, pixelCrop)
    setCrops(
      crops.map((item) => (item.id === activeCrop.id ? { ...item, pixelCrop, blob: blob ?? item.blob } : item)),
      groups,
      activeCrop.id
    )
  }

  const ensureAllBlobs = async () => {
    const img = imgRef.current
    if (!img) return

    const nextCrops: CropBox[] = []
    let changed = false

    for (const cropBox of crops) {
      if (cropBox.blob) {
        nextCrops.push(cropBox)
        continue
      }

      const pixel = toPixelCrop(cropBox.crop, img)
      if (!pixel) {
        nextCrops.push(cropBox)
        continue
      }

      const blob = await cropToBlob(img, pixel)
      if (blob) {
        nextCrops.push({ ...cropBox, pixelCrop: pixel, blob })
        changed = true
      } else {
        nextCrops.push(cropBox)
      }
    }

    if (changed) {
      setCrops(nextCrops, groups, activeCropId)
    }
  }

  const addCrop = () => {
    const id = createId()
    const nextCrops: CropBox[] = [
      ...crops,
      { id, title: `题目 ${crops.length + 1}`, crop: createDefaultCrop(crops.length), mode: defaultMode }
    ]
    setSelectedIds([])
    setCrops(nextCrops, groups, id)
    setTimeout(() => {
      void ensureAllBlobs()
    }, 0)
  }

  const deleteCrop = (id: string) => {
    if (crops.length <= 1) {
      message.warning('至少保留一个裁剪框')
      return
    }
    const next = crops.filter((c) => c.id !== id)
    setSelectedIds((prev) => prev.filter((x) => x !== id))
    setCrops(next, groups, next[0].id)
  }

  const openMerge = () => {
    if (selectedIds.length < 2) {
      message.warning('请至少选择两个裁剪框进行合并')
      return
    }
    setMergeTitle('合并题目')
    setMergeModalOpen(true)
  }

  const confirmMerge = () => {
    const groupId = createId()
    const title = mergeTitle.trim() || '合并题目'
    const baseMode =
      crops.find((c) => selectedIds.includes(c.id))?.mode ||
      crops.find((c) => c.id === activeCropId)?.mode ||
      defaultMode
    const nextGroups = { ...groups, [groupId]: title }
    const nextCrops = crops.map((c) =>
      selectedIds.includes(c.id) ? { ...c, groupId, mode: baseMode } : c
    )
    setCrops(nextCrops, nextGroups)
    setMergeModalOpen(false)
    message.success('已创建合并组')
  }

  const unmergeSelected = () => {
    if (!selectedIds.length) {
      message.warning('请先选择裁剪框')
      return
    }
    const nextCrops = crops.map((c) => (selectedIds.includes(c.id) ? { ...c, groupId: undefined } : c))
    setCrops(nextCrops, groups)
    message.success('已取消合并')
  }

  const groupLabel = (groupId?: string) => (groupId ? groups[groupId] || '合并题目' : '单独解答')

  return (
    <div className="multi-cropper">
      <div className="multi-cropper-main">
        <div className="multi-cropper-image">
          <Typography.Title level={4} className="multi-cropper-title">
            裁剪题目区域
          </Typography.Title>
          <Typography.Paragraph className="multi-cropper-hint">
            可添加多个裁剪框；可勾选两个或多个裁剪框合并为同一道题
          </Typography.Paragraph>

          <ReactCrop crop={activeCrop?.crop} onChange={handleCropChange} onComplete={handleCropComplete} aspect={undefined}>
            <img ref={imgRef} src={imageUrl} alt="待裁剪图片" onLoad={ensureAllBlobs} />
          </ReactCrop>
        </div>

        <div className="multi-cropper-sidebar">
          <div className="multi-cropper-actions">
            <Space wrap>
              <Button icon={<PlusOutlined />} onClick={addCrop}>
                添加裁剪框
              </Button>
              <Button icon={<LinkOutlined />} onClick={openMerge} disabled={selectedIds.length < 2}>
                合并选中
              </Button>
              <Button icon={<DisconnectOutlined />} onClick={unmergeSelected} disabled={!selectedIds.length}>
                取消合并
              </Button>
            </Space>
          </div>

          <Divider className="multi-cropper-divider" />

          <div className="multi-cropper-list">
            {crops.map((item, index) => {
              const checked = selectedIds.includes(item.id)
              const isActive = item.id === activeCropId
              const hasBlob = !!item.blob
              return (
                <div key={item.id} className={`crop-item ${isActive ? 'active' : ''}`}>
                  <div className="crop-item-top">
                    <Checkbox checked={checked} onChange={(e) => toggleSelected(item.id, e.target.checked)} />
                    <Button
                      type={isActive ? 'primary' : 'default'}
                      size="small"
                      onClick={() => onChange({ crops, groups, activeCropId: item.id })}
                    >
                      编辑
                    </Button>
                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => deleteCrop(item.id)} />
                  </div>

                  <Input
                    value={item.title}
                    placeholder={`题目 ${index + 1}`}
                    onChange={(e) =>
                      setCrops(
                        crops.map((c) => (c.id === item.id ? { ...c, title: e.target.value } : c)),
                        groups,
                        activeCropId
                      )
                    }
                  />

                  <Select
                    value={item.mode}
                    onChange={(mode) =>
                      setCrops(
                        crops.map((c) => (c.id === item.id ? { ...c, mode } : c)),
                        groups,
                        activeCropId
                      )
                    }
                    size="small"
                    style={{ width: '100%', marginTop: 4 }}
                    options={[
                      { value: 'auto', label: '自动' },
                      { value: 'single', label: '单模型' },
                      { value: 'debate', label: '双模型' }
                    ]}
                  />

                  <div className="crop-item-meta">
                    <Tag color={item.groupId ? 'blue' : 'default'}>{groupLabel(item.groupId)}</Tag>
                    <Tag color={item.mode === 'auto' ? 'blue' : item.mode === 'single' ? 'green' : 'purple'}>
                      {item.mode === 'auto' ? '自动路由' : item.mode === 'single' ? '单模型' : '双模型'}
                    </Tag>
                    <Tag color={hasBlob ? 'success' : 'warning'}>{hasBlob ? '已保存' : '未保存'}</Tag>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <Modal
        title="合并为同一道题"
        open={mergeModalOpen}
        onOk={confirmMerge}
        onCancel={() => setMergeModalOpen(false)}
        okText="合并"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          合并后会将选中的裁剪区域一起发送给模型识别与解答。
        </Typography.Paragraph>
        <Input value={mergeTitle} onChange={(e) => setMergeTitle(e.target.value)} placeholder="合并题目标题" />
      </Modal>
    </div>
  )
}

export default MultiCropper
