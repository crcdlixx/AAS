import type { Crop } from 'react-image-crop'

type NaturalPixelCrop = { x: number; y: number; width: number; height: number }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const toNaturalPixelCrop = (crop: Crop, naturalWidth: number, naturalHeight: number): NaturalPixelCrop | null => {
  const width = crop.width ?? 0
  const height = crop.height ?? 0
  const x = crop.x ?? 0
  const y = crop.y ?? 0
  if (width <= 0 || height <= 0) return null

  if (crop.unit === '%') {
    const pxX = (x / 100) * naturalWidth
    const pxY = (y / 100) * naturalHeight
    const pxW = (width / 100) * naturalWidth
    const pxH = (height / 100) * naturalHeight
    return {
      x: clamp(pxX, 0, naturalWidth),
      y: clamp(pxY, 0, naturalHeight),
      width: clamp(pxW, 1, naturalWidth),
      height: clamp(pxH, 1, naturalHeight)
    }
  }

  return {
    x: clamp(x, 0, naturalWidth),
    y: clamp(y, 0, naturalHeight),
    width: clamp(width, 1, naturalWidth),
    height: clamp(height, 1, naturalHeight)
  }
}

const loadImageFromFile = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片加载失败'))
    }
    img.src = url
  })

export const cropToJpegBlobFromFile = async (file: File, crop: Crop): Promise<Blob | null> => {
  const img = await loadImageFromFile(file)
  const pixelCrop = toNaturalPixelCrop(crop, img.naturalWidth, img.naturalHeight)
  if (!pixelCrop) return null

  const sx = clamp(pixelCrop.x, 0, img.naturalWidth)
  const sy = clamp(pixelCrop.y, 0, img.naturalHeight)
  const sw = clamp(pixelCrop.width, 1, img.naturalWidth - sx)
  const sh = clamp(pixelCrop.height, 1, img.naturalHeight - sy)

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw))
  canvas.height = Math.max(1, Math.round(sh))

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.95)
  })
}

