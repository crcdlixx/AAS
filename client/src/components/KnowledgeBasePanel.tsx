import { useState } from 'react'
import { Upload, Button, List, Tag, Space, message, Collapse } from 'antd'
import { UploadOutlined, DeleteOutlined, FileTextOutlined, FilePdfOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { uploadFiles, listFiles, removeFile, clearAll, type KnowledgeBaseFile } from '../services/knowledgeBaseApi'

type Props = {
  files: KnowledgeBaseFile[]
  onFilesChange: (files: KnowledgeBaseFile[]) => void
}

export default function KnowledgeBasePanel({ files, onFilesChange }: Props) {
  const [uploading, setUploading] = useState(false)
  const [fileList, setFileList] = useState<UploadFile[]>([])

  const handleUpload = async () => {
    if (!fileList.length) {
      message.warning('请选择文件')
      return
    }

    setUploading(true)
    try {
      const filesToUpload = fileList.map((f) => f.originFileObj as File)
      const response = await uploadFiles(filesToUpload)

      const successCount = response.files.filter((f) => !f.error).length
      const errorCount = response.files.filter((f) => f.error).length

      if (successCount > 0) {
        message.success(`成功上传 ${successCount} 个文件`)
      }
      if (errorCount > 0) {
        message.error(`${errorCount} 个文件上传失败`)
      }

      // Refresh file list
      const updated = await listFiles()
      onFilesChange(updated.files)
      setFileList([])
    } catch (error) {
      message.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = async (fileId: string) => {
    try {
      await removeFile(fileId)
      message.success('文件已删除')
      const updated = await listFiles()
      onFilesChange(updated.files)
    } catch (error) {
      message.error('删除失败')
    }
  }

  const handleClearAll = async () => {
    try {
      await clearAll()
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
                  onChange={({ fileList }) => setFileList(fileList)}
                  beforeUpload={() => false}
                  accept=".pdf,.txt"
                  multiple
                >
                  <Button icon={<UploadOutlined />}>选择文件 (PDF/TXT)</Button>
                </Upload>
                <div style={{ marginTop: 8 }}>
                  <Space>
                    <Button type="primary" onClick={handleUpload} loading={uploading} disabled={!fileList.length}>
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
                          <Space size="small">
                            <Tag color={file.type === 'pdf' ? 'red' : 'blue'}>{file.type.toUpperCase()}</Tag>
                            <Tag color={file.extractionMethod === 'text' ? 'green' : 'orange'}>
                              {file.extractionMethod === 'text' ? '文本提取' : '图像回退'}
                            </Tag>
                            <span style={{ color: 'rgba(0,0,0,0.45)' }}>{formatFileSize(file.sizeBytes)}</span>
                          </Space>
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
