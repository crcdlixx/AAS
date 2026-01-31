import { useState, useRef } from 'react'
import ReactCrop, { Crop, PixelCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import './ImageCropper.css'

interface ImageCropperProps {
  imageUrl: string
  onCropComplete: (blob: Blob) => void
}

function ImageCropper({ imageUrl, onCropComplete }: ImageCropperProps) {
  const [crop, setCrop] = useState<Crop>({
    unit: '%',
    width: 50,
    height: 50,
    x: 25,
    y: 25
  })
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>()
  const imgRef = useRef<HTMLImageElement>(null)

  const getCroppedImg = async () => {
    if (!completedCrop || !imgRef.current) return

    const image = imgRef.current
    const canvas = document.createElement('canvas')
    const scaleX = image.naturalWidth / image.width
    const scaleY = image.naturalHeight / image.height
    const ctx = canvas.getContext('2d')

    if (!ctx) return

    const srcW = Math.max(1, Math.round(completedCrop.width * scaleX))
    const srcH = Math.max(1, Math.round(completedCrop.height * scaleY))
    const maxSide = 3000
    const downScale = Math.min(1, maxSide / Math.max(srcW, srcH))

    canvas.width = Math.max(1, Math.round(srcW * downScale))
    canvas.height = Math.max(1, Math.round(srcH * downScale))
    ctx.imageSmoothingEnabled = true
    try {
      ;(ctx as any).imageSmoothingQuality = 'high'
    } catch {
      // ignore
    }

    ctx.drawImage(
      image,
      completedCrop.x * scaleX,
      completedCrop.y * scaleY,
      completedCrop.width * scaleX,
      completedCrop.height * scaleY,
      0,
      0,
      canvas.width,
      canvas.height
    )

    return new Promise<Blob>((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
      }, 'image/jpeg', 0.95)
    })
  }

  const handleCropChange = (c: Crop) => {
    setCrop(c)
  }

  const handleCropComplete = async (c: PixelCrop) => {
    setCompletedCrop(c)
    const blob = await getCroppedImg()
    if (blob) {
      onCropComplete(blob)
    }
  }

  return (
    <div className="image-cropper">
      <h3>裁剪题目区域</h3>
      <p className="hint">拖动选框选择题目区域，调整完成后会自动保存</p>
      <ReactCrop
        crop={crop}
        onChange={handleCropChange}
        onComplete={handleCropComplete}
        aspect={undefined}
      >
        <img ref={imgRef} src={imageUrl} alt="待裁剪图片" />
      </ReactCrop>
    </div>
  )
}

export default ImageCropper
