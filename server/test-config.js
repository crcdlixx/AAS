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

console.log('\n✓ 自动路由配置:')
console.log(`  ROUTER_MODEL: ${process.env.ROUTER_MODEL || 'gpt-4o-mini (默认)'}`)
console.log(`  ROUTER_API_KEY: ${process.env.ROUTER_API_KEY ? '已配置 ✓' : '使用默认 OPENAI_API_KEY'}`)
console.log(`  ROUTER_BASE_URL: ${process.env.ROUTER_BASE_URL || '使用默认 OPENAI_BASE_URL'}`)
console.log(`  ROUTE_HUMANITIES_MODE: ${process.env.ROUTE_HUMANITIES_MODE || 'single (默认)'}`)
console.log(`  ROUTE_SCIENCE_MODE: ${process.env.ROUTE_SCIENCE_MODE || 'debate (默认)'}`)

console.log('\n✓ 双模型审查配置（可选）:')
console.log(`  MODEL1_NAME: ${process.env.MODEL1_NAME || 'gpt-4o-mini (默认)'}`)
console.log(`  MODEL1_API_KEY: ${process.env.MODEL1_API_KEY ? '已配置 ✓' : '使用默认 OPENAI_API_KEY'}`)
console.log(`  MODEL1_BASE_URL: ${process.env.MODEL1_BASE_URL || 'https://api.openai.com/v1 (默认)'}`)

console.log(`\n  MODEL2_NAME: ${process.env.MODEL2_NAME || 'gpt-4o (默认)'}`)
console.log(`  MODEL2_API_KEY: ${process.env.MODEL2_API_KEY ? '已配置 ✓' : '使用默认 OPENAI_API_KEY'}`)
console.log(`  MODEL2_BASE_URL: ${process.env.MODEL2_BASE_URL || 'https://api.openai.com/v1 (默认)'}`)

console.log(`\n  MAX_DEBATE_ITERATIONS: ${process.env.MAX_DEBATE_ITERATIONS || '3 (默认)'}`)

console.log('\n=== 功能状态 ===\n')

const hasBasicConfig = !!process.env.OPENAI_API_KEY
const hasReviewConfig =
  !!(process.env.MODEL1_API_KEY || process.env.OPENAI_API_KEY) &&
  !!(process.env.MODEL2_API_KEY || process.env.OPENAI_API_KEY)

console.log(`自动路由: ${hasBasicConfig ? '✓ 可用' : '✗ 需要配置 OPENAI_API_KEY'}`)
console.log(`双模型审查: ${hasReviewConfig ? '✓ 可用' : '✗ 未配置（将无法使用需要双模型的路由策略）'}`)

if (!hasBasicConfig) {
  console.log('\n⚠️  警告: 请在 server/.env 中配置 OPENAI_API_KEY')
}

console.log('\n')
