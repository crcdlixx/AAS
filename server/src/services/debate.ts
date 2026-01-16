import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

interface DebateState {
  question: string
  images?: { base64Image: string; mimeType: string }[]
  extraPrompt?: string
  model1_answer: string
  model2_review: string
  iteration: number
  max_iterations: number
  consensus_reached: boolean
  final_answer: string
}

type DebateStreamUpdate = {
  type: 'status' | 'model1' | 'model2'
  content?: string
  iteration: number
  message?: string
}

type DebateUpdateHandler = (update: DebateStreamUpdate) => void

function initializeModels() {
  const model1 = new ChatOpenAI({
    modelName: process.env.MODEL1_NAME || 'gpt-4o-mini',
    temperature: 0.7,
    openAIApiKey: process.env.MODEL1_API_KEY || process.env.OPENAI_API_KEY,
    configuration: {
      baseURL: process.env.MODEL1_BASE_URL || 'https://api.openai.com/v1'
    }
  })

  const model2 = new ChatOpenAI({
    modelName: process.env.MODEL2_NAME || 'gpt-4o',
    temperature: 0.7,
    openAIApiKey: process.env.MODEL2_API_KEY || process.env.OPENAI_API_KEY,
    configuration: {
      baseURL: process.env.MODEL2_BASE_URL || 'https://api.openai.com/v1'
    }
  })

  console.log(`模型1: ${process.env.MODEL1_NAME || 'gpt-4o-mini'} @ ${process.env.MODEL1_BASE_URL || 'default'}`)
  console.log(`模型2: ${process.env.MODEL2_NAME || 'gpt-4o'} @ ${process.env.MODEL2_BASE_URL || 'default'}`)

  return { model1, model2 }
}

const { model1, model2 } = initializeModels()

async function model1Propose(state: DebateState, onUpdate?: DebateUpdateHandler): Promise<DebateState> {
  const { iteration, images, extraPrompt, model1_answer, model2_review } = state

  let content: any[]

  if (iteration === 0) {
    // 第一次回答
    content = [
      {
        type: 'text',
        text: `请识别图片中的题目（可能包含多张图片/多个裁剪区域，属于同一道题的不同部分），并合并理解后给出详细的解答步骤。请用中文回答。格式如下：\n\n题目：[识别出的题目内容]\n\n解答：[详细的解答步骤]${
          extraPrompt ? `\n\n补充说明：\n${extraPrompt}` : ''
        }`
      }
    ]

    if (images?.length) {
      for (const image of images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${image.mimeType};base64,${image.base64Image}`
          }
        })
      }
    }
  } else {
    // 根据模型2的审查意见改进答案
    content = [
      {
        type: 'text',
        text: `原始问题：识别并解答图片中的题目

你之前的答案：
${model1_answer}

审查意见：
${model2_review}

请根据审查意见改进你的答案。如果你认为审查意见合理，请修改答案；如果你认为原答案已经很好，请说明理由并保持或微调答案。保持格式：题目：[内容] 解答：[内容]`
      }
    ]
  }

  const response = await model1.invoke([new HumanMessage({ content })])
  const answer = response.content as string

  console.log(`\n${'='.repeat(60)}`)
  console.log(`迭代 ${iteration + 1} - 模型1的答案：`)
  console.log(`${'='.repeat(60)}`)
  console.log(answer)

  state.model1_answer = answer
  if (onUpdate) {
    onUpdate({ type: 'model1', content: answer, iteration: iteration + 1 })
  }
  return state
}

async function model2Review(state: DebateState, onUpdate?: DebateUpdateHandler): Promise<DebateState> {
  const { question, model1_answer, iteration } = state

  const prompt = `原始任务：识别并解答图片中的题目

待审查的答案：
${model1_answer}

请仔细审查这个答案，评估其：
1. 题目识别的准确性
2. 解答的完整性和正确性
3. 逻辑性和清晰度
4. 是否有遗漏或错误

如果答案已经很好，请回复"APPROVED: [简短说明为什么这个答案很好]"
如果需要改进，请提供具体的改进建议。`

  const response = await model2.invoke([new HumanMessage(prompt)])
  const review = response.content as string

  console.log(`\n${'-'.repeat(60)}`)
  console.log(`模型2的审查意见：`)
  console.log(`${'-'.repeat(60)}`)
  console.log(review)

  state.model2_review = review
  state.consensus_reached = review.toUpperCase().includes('APPROVED')
  
  if (state.consensus_reached) {
    state.final_answer = model1_answer
  }
  
  state.iteration += 1
  if (onUpdate) {
    onUpdate({ type: 'model2', content: review, iteration: state.iteration })
  }

  return state
}

export async function solveQuestionWithDebate(imagePath: string, maxIterations: number = 3) {
  return solveQuestionWithDebateFromImages([imagePath], maxIterations)
}

export async function solveQuestionWithDebateFromImages(
  imagePaths: string[],
  maxIterations: number = 3,
  extraPrompt?: string
) {
  try {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`开始多模型博弈`)
    console.log(`${'='.repeat(60)}`)
    console.log(`最大迭代次数：${maxIterations}`)

    const images = imagePaths.map((p) => ({
      base64Image: fs.readFileSync(p).toString('base64'),
      mimeType: getMimeType(p)
    }))

    let state: DebateState = {
      question: '识别并解答图片中的题目',
      images,
      extraPrompt,
      model1_answer: '',
      model2_review: '',
      iteration: 0,
      max_iterations: maxIterations,
      consensus_reached: false,
      final_answer: ''
    }

    // 博弈循环
    while (state.iteration < maxIterations && !state.consensus_reached) {
      // 模型1提出或改进答案
      state = await model1Propose(state)
      
      // 模型2审查
      state = await model2Review(state)
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`博弈结束`)
    console.log(`${'='.repeat(60)}`)
    console.log(`总迭代次数：${state.iteration}`)
    console.log(`是否达成共识：${state.consensus_reached ? '是' : '否（达到最大迭代次数）'}`)

    // 如果没有最终答案，使用最后一次的答案
    const answer = state.final_answer || state.model1_answer

    // 解析题目和答案
    const questionMatch = answer.match(/题目[：:]\s*(.+?)(?=\n\n解答|$)/s)
    const answerMatch = answer.match(/解答[：:]\s*(.+)/s)

    return {
      question: questionMatch ? questionMatch[1].trim() : '未识别到题目',
      answer: answerMatch ? answerMatch[1].trim() : answer,
      iterations: state.iteration,
      consensus: state.consensus_reached
    }
  } catch (error) {
    console.error('多模型博弈失败:', error)
    throw new Error('多模型博弈失败，请检查配置')
  }
}

export async function solveQuestionWithDebateStream(
  imagePath: string,
  maxIterations: number = 3,
  onUpdate?: DebateUpdateHandler
) {
  return solveQuestionWithDebateStreamFromImages([imagePath], maxIterations, undefined, onUpdate)
}

export async function solveQuestionWithDebateStreamFromImages(
  imagePaths: string[],
  maxIterations: number = 3,
  extraPrompt?: string,
  onUpdate?: DebateUpdateHandler
) {
  try {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`开始多模型博弈`)
    console.log(`${'='.repeat(60)}`)
    console.log(`最大迭代次数：${maxIterations}`)

    const images = imagePaths.map((p) => ({
      base64Image: fs.readFileSync(p).toString('base64'),
      mimeType: getMimeType(p)
    }))

    let state: DebateState = {
      question: '识别并解答图片中的题目',
      images,
      extraPrompt,
      model1_answer: '',
      model2_review: '',
      iteration: 0,
      max_iterations: maxIterations,
      consensus_reached: false,
      final_answer: ''
    }

    while (state.iteration < maxIterations && !state.consensus_reached) {
      if (onUpdate) {
        onUpdate({ type: 'status', message: '模型1 生成答案中...', iteration: state.iteration + 1 })
      }
      state = await model1Propose(state, onUpdate)

      if (onUpdate) {
        onUpdate({ type: 'status', message: '模型2 审查中...', iteration: state.iteration + 1 })
      }
      state = await model2Review(state, onUpdate)
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`博弈结束`)
    console.log(`${'='.repeat(60)}`)
    console.log(`总迭代次数：${state.iteration}`)
    console.log(`是否达成共识：${state.consensus_reached ? '是' : '否（达到最大迭代次数）'}`)

    const answer = state.final_answer || state.model1_answer
    const questionMatch = answer.match(/题目[：:]\s*(.+?)(?=\n\n解答|$)/s)
    const answerMatch = answer.match(/解答[：:]\s*(.+)/s)

    return {
      question: questionMatch ? questionMatch[1].trim() : '未识别到题目',
      answer: answerMatch ? answerMatch[1].trim() : answer,
      iterations: state.iteration,
      consensus: state.consensus_reached
    }
  } catch (error) {
    console.error('多模型博弈失败:', error)
    throw new Error('多模型博弈失败，请检查配置')
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }
  return mimeTypes[ext] || 'image/jpeg'
}
