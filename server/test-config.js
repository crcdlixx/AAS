// 简单的配置测试脚本
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '.env') })

console.log('\n=== 配置检查 ===\n')

console.log('✓ 基本配置:')
console.log(`  PORT: ${process.env.PORT || '5174'}`)
console.log(`  OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '已配置 ✓' : '未配置 ✗'}`)
console.log(`  OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}`)
console.log(`  OPENAI_MODEL: ${process.env.OPENAI_MODEL || 'gpt-4o (默认)'}`)

console.log('\n✓ 多模型博弈配置:')
console.log(`  MODEL1_NAME: ${process.env.MODEL1_NAME || 'gpt-4o-mini (默认)'}`)
console.log(`  MODEL1_API_KEY: ${process.env.MODEL1_API_KEY ? '已配置 ✓' : '使用默认 OPENAI_API_KEY'}`)
console.log(`  MODEL1_BASE_URL: ${process.env.MODEL1_BASE_URL || 'https://api.openai.com/v1 (默认)'}`)

console.log(`\n  MODEL2_NAME: ${process.env.MODEL2_NAME || 'gpt-4o (默认)'}`)
console.log(`  MODEL2_API_KEY: ${process.env.MODEL2_API_KEY ? '已配置 ✓' : '使用默认 OPENAI_API_KEY'}`)
console.log(`  MODEL2_BASE_URL: ${process.env.MODEL2_BASE_URL || 'https://api.openai.com/v1 (默认)'}`)

console.log(`\n  MAX_DEBATE_ITERATIONS: ${process.env.MAX_DEBATE_ITERATIONS || '3 (默认)'}`)

console.log('\n=== 功能状态 ===\n')

const hasBasicConfig = !!process.env.OPENAI_API_KEY
const hasDebateConfig = !!(process.env.MODEL1_API_KEY || process.env.OPENAI_API_KEY) && 
                         !!(process.env.MODEL2_API_KEY || process.env.OPENAI_API_KEY)

console.log(`单模型模式: ${hasBasicConfig ? '✓ 可用' : '✗ 需要配置 OPENAI_API_KEY'}`)
console.log(`多模型博弈模式: ${hasDebateConfig ? '✓ 可用' : '✗ 需要配置模型API密钥'}`)

if (!hasBasicConfig) {
  console.log('\n⚠️  警告: 请在 server/.env 中配置 OPENAI_API_KEY')
}

console.log('\n')
