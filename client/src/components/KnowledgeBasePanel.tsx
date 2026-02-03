import { useState } from 'react'
import { Upload, Button, List, Tag, Space, message, Collapse, Input } from 'antd'
import { UploadOutlined, DeleteOutlined, FileTextOutlined, FilePdfOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { uploadFiles, listFiles, removeFile, clearAll, type KnowledgeBaseFile } from '../services/knowledgeBaseApi'
import type { ApiConfig } from '../services/api'

type Props = {
  files: KnowledgeBaseFile[]
  onFilesChange: (files: KnowledgeBaseFile[]) => void
  apiConfig?: ApiConfig
}

export default function KnowledgeBasePanel({ files, onFilesChange, apiConfig }: Props) {
  const [uploading, setUploading] = useState(false)
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [fileDescriptions, setFileDescriptions] = useState<Record<string, string>>({})

  const handleUpload = async () => {
    if (!fileList.length) {
      message.warning('请选择文件')
      return
    }

    setUploading(true)
    try {
      const filesToUpload = fileList.map((f) => f.originFileObj as File)
      const descriptions = fileList.map((f) => (fileDescriptions[f.uid] || '').trim())
      if (descriptions.some((d) => !d)) {
        message.warning('请为每个文件填写描述')
        return
      }

      const response = await uploadFiles(filesToUpload, descriptions, apiConfig)

      const successCount = response.files.filter((f) => !f.error).length
      const errorCount = response.files.filter((f) => f.error).length

      if (successCount > 0) {
        message.success(`成功上传 ${successCount} 个文件`)
      }
      if (errorCount > 0) {
        message.error(`${errorCount} 个文件上传失败`)
      }

      // Refresh file list
      const updated = await listFiles(apiConfig)
      onFilesChange(updated.files)
      setFileList([])
      setFileDescriptions({})
    } catch (error) {
      message.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = async (fileId: string) => {
    try {
      await removeFile(fileId, apiConfig)
      message.success('文件已删除')
      const updated = await listFiles(apiConfig)
      onFilesChange(updated.files)
    } catch (error) {
      message.error('删除失败')
    }
  }

  const handleClearAll = async () => {
    try {
      await clearAll(apiConfig)
      message.success('已清空知识库')
      onFilesChange([])
    } catch (error) {
      message.error('清空失败')
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  return (
    <Collapse
      items={[
        {
          key: 'kb',
          label: (
            <Space>
              <span>知识库</span>
              {files.length > 0 && <Tag color="blue">{files.length} 个文件</Tag>}
            </Space>
          ),
          children: (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <div>
                <Upload
                  fileList={fileList}
                  onChange={({ fileList: next }) => {
                    setFileList(next)
                    setFileDescriptions((prev) => {
                      const out: Record<string, string> = {}
                      for (const f of next) out[f.uid] = prev[f.uid] || ''
                      return out
                    })
                  }}
                  beforeUpload={() => false}
                  accept=".pdf,.txt"
                  multiple
                >
                  <Button icon={<UploadOutlined />}>选择文件 (PDF/TXT)</Button>
                </Upload>
                {fileList.length > 0 && (
                  <List
                    size="small"
                    bordered
                    style={{ marginTop: 8 }}
                    dataSource={fileList}
                    renderItem={(f) => (
                      <List.Item>
                        <Space direction="vertical" style={{ width: '100%' }} size="small">
                          <div style={{ fontWeight: 500 }}>{f.name}</div>
                          <Input.TextArea
                            rows={2}
                            value={fileDescriptions[f.uid] || ''}
                            onChange={(e) => {
                              const value = e.target.value
                              setFileDescriptions((prev) => ({ ...prev, [f.uid]: value }))
                            }}
                            placeholder="文件描述（必填）：这份资料主要包含什么、适用于哪些题目/场景"
                          />
                        </Space>
                      </List.Item>
                    )}
                  />
                )}
                <div style={{ marginTop: 8 }}>
                  <Space>
                    <Button
                      type="primary"
                      onClick={handleUpload}
                      loading={uploading}
                      disabled={!fileList.length || fileList.some((f) => !(fileDescriptions[f.uid] || '').trim())}
                    >
                      上传
                    </Button>
                    {files.length > 0 && (
                      <Button danger onClick={handleClearAll}>
                        清空全部
                      </Button>
                    )}
                  </Space>
                </div>
              </div>

              {files.length > 0 && (
                <List
                  size="small"
                  bordered
                  dataSource={files}
                  renderItem={(file) => (
                    <List.Item
                      actions={[
                        <Button
                          key="delete"
                          type="text"
                          danger
                          size="small"
                          icon={<DeleteOutlined />}
                          onClick={() => handleRemove(file.id)}
                        >
                          删除
                        </Button>
                      ]}
                    >
                      <List.Item.Meta
                        avatar={file.type === 'pdf' ? <FilePdfOutlined /> : <FileTextOutlined />}
                        title={file.originalName}
                        description={
                          <div>
                            <Space size="small">
                            <Tag color={file.type === 'pdf' ? 'red' : 'blue'}>{file.type.toUpperCase()}</Tag>
                            <Tag color={file.extractionMethod === 'text' ? 'green' : 'orange'}>
                              {file.extractionMethod === 'text' ? '文本提取' : '图像回退'}
                            </Tag>
                            <span style={{ color: 'rgba(0,0,0,0.45)' }}>{formatFileSize(file.sizeBytes)}</span>
                            </Space>
                            {file.description && (
                              <div style={{ marginTop: 4, color: 'rgba(0,0,0,0.65)' }}>{file.description}</div>
                            )}
                          </div>
                        }
                      />
                    </List.Item>
                  )}
                />
              )}

              {files.length === 0 && (
                <div style={{ textAlign: 'center', color: 'rgba(0,0,0,0.45)', padding: '20px 0' }}>
                  暂无知识库文件。上传 PDF 或 TXT 文件后，系统会在解答文科题目时自动参考这些资料。
                </div>
              )}
            </Space>
          )
        }
      ]}
    />
  )
}
