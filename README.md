# 全部答案搜题AAS

一个基于AI的智能搜题网页应用，支持上传图片、裁剪题目区域，并通过AI识别和解答问题。

## 技术栈

### 前端
- React 18 + TypeScript
- Vite - 构建工具
- Ant Design - UI组件库
- react-image-crop - 图片裁剪
- Axios - HTTP客户端

### 后端
- Node.js + Express + TypeScript
- Multer - 文件上传
- OpenAI API - AI识别和解答
- LangChain + LangGraph - 多模型博弈系统

## 快速开始

### 1. 安装依赖

```bash
npm run install:all
```

### 2. 配置环境变量

复制 `server/.env.example` 到 `server/.env` 并填入你的OpenAI API密钥：

```bash
cd server
copy .env.example .env
```

编辑 `.env` 文件，填入你的API密钥。
单模型模式可通过 `OPENAI_MODEL` 指定模型，默认 `gpt-4o`。
如遇到单模型输出较长被截断，可在 `server/.env` 里设置 `OPENAI_MAX_TOKENS`（留空则不强制限制）。

### 3. 启动开发服务器

```bash
npm run dev
```

前端将运行在 http://localhost:5173
后端将运行在 http://localhost:5174

## 功能特性

- 📤 图片上传
- ✂️ 图片裁剪
- 🤖 AI识别题目
- 💡 智能解答
- 🎯 **单模型模式** - 快速解答
- 🔄 **多模型博弈模式** - 两个AI模型相互审查和改进答案，提高准确性
- 📱 响应式设计

## 项目结构

```
.
├── client/          # 前端React应用
│   ├── src/
│   └── package.json
├── server/          # 后端Express服务
│   ├── src/
│   └── package.json
└── package.json     # 根package.json
```


## 多模型博弈系统

### 什么是多模型博弈？

多模型博弈模式使用两个不同的AI模型相互审查和改进答案：

1. **模型1** 首先识别题目并给出解答
2. **模型2** 审查模型1的答案，提出改进建议
3. **模型1** 根据审查意见改进答案
4. 重复步骤2-3，直到：
   - 模型2认为答案已经很好（达成共识）
   - 或达到最大迭代次数

### 优势

- ✅ 更高的准确性 - 两个模型互相纠错
- ✅ 更完整的解答 - 多次迭代补充遗漏
- ✅ 更好的逻辑性 - 相互审查提升质量

### 配置

在 `server/.env` 中配置两个模型：

```env
# 模型1 - 用于提出答案
MODEL1_NAME=gpt-4o-mini
MODEL1_API_KEY=your_api_key
MODEL1_BASE_URL=https://api.openai.com/v1

# 模型2 - 用于审查答案
MODEL2_NAME=gpt-4o
MODEL2_API_KEY=your_api_key
MODEL2_BASE_URL=https://api.openai.com/v1

# 最大迭代次数
MAX_DEBATE_ITERATIONS=3
```

你可以使用：
- 相同的API密钥但不同的模型
- 不同的API提供商（如OpenAI、Azure、本地模型等）
- 任何兼容OpenAI格式的API

## 使用说明

1. 上传包含题目的图片
2. 裁剪题目区域
3. 选择解答模式：
   - **单模型模式**：快速获得答案
   - **多模型博弈模式**：获得更准确、更完整的答案
4. 查看AI解答结果
