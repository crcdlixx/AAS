import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import './MarkdownView.css'

const normalizeMathDelimiters = (text: string) =>
  text
    .replace(/\\\[/g, '$$')
    .replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$')
    .replace(/\\\)/g, '$')

const sanitizeModelText = (text: string) => normalizeMathDelimiters(text).replace(/<\/?think>/g, '')

interface MarkdownViewProps {
  markdown: string
  className?: string
}

function MarkdownView({ markdown, className }: MarkdownViewProps) {
  return (
    <div className={['markdown-view', className].filter(Boolean).join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {sanitizeModelText(markdown || '')}
      </ReactMarkdown>
    </div>
  )
}

export default MarkdownView
