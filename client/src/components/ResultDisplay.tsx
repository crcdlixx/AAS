import { Card, Button, Tag, Space } from 'antd'
import { ReloadOutlined, CheckCircleOutlined, SyncOutlined } from '@ant-design/icons'
import './ResultDisplay.css'

interface ResultDisplayProps {
  result: string
  onReset: () => void
  debateInfo?: {
    iterations?: number
    consensus?: boolean
  } | null
}

function ResultDisplay({ result, onReset, debateInfo }: ResultDisplayProps) {
  return (
    <Card className="result-card">
      <div className="result-header">
        <div>
          <h2>AI 解答</h2>
          <p className="result-subtitle">结构化步骤呈现</p>
        </div>
        {debateInfo && (
          <Space>
            <Tag icon={<SyncOutlined />} color="blue">
              迭代 {debateInfo.iterations} 次
            </Tag>
            {debateInfo.consensus ? (
              <Tag icon={<CheckCircleOutlined />} color="success">
                达成共识
              </Tag>
            ) : (
              <Tag color="warning">
                达到最大迭代次数
              </Tag>
            )}
          </Space>
        )}
      </div>
      <div className="result-content">
        <pre>{result}</pre>
      </div>
      <div className="result-actions">
        <Button type="primary" icon={<ReloadOutlined />} onClick={onReset}>
          继续搜题
        </Button>
      </div>
    </Card>
  )
}

export default ResultDisplay
