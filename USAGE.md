# 使用指南

## 安装和配置

### 1. 安装依赖

```bash
npm run install:all
```

### 2. 配置环境变量

复制环境变量模板：

```bash
cd server
copy .env.example .env
```

编辑 `server/.env` 文件：

#### 单模型模式配置

如果只使用单模型模式，只需配置基本的 OpenAI API：

```env
PORT=5174
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

#### 多模型博弈模式配置

如果要使用多模型博弈功能，需要配置两个模型：

**方案1：使用相同API密钥的不同模型**

```env
PORT=5174
OPENAI_API_KEY=sk-your-api-key-here

# 模型1 - 快速模型用于提出答案
MODEL1_NAME=gpt-4o-mini
MODEL1_API_KEY=sk-your-api-key-here
MODEL1_BASE_URL=https://api.openai.com/v1

# 模型2 - 强大模型用于审查
MODEL2_NAME=gpt-4o
MODEL2_API_KEY=sk-your-api-key-here
MODEL2_BASE_URL=https://api.openai.com/v1

# 最大迭代次数
MAX_DEBATE_ITERATIONS=3
```

**方案2：使用不同的API提供商**

```env
PORT=5174
OPENAI_API_KEY=sk-your-default-key

# 模型1 - 使用 OpenAI
MODEL1_NAME=gpt-4o-mini
MODEL1_API_KEY=sk-openai-key
MODEL1_BASE_URL=https://api.openai.com/v1

# 模型2 - 使用其他兼容OpenAI格式的API（如Azure、本地模型等）
MODEL2_NAME=gpt-4
MODEL2_API_KEY=your-other-api-key
MODEL2_BASE_URL=https://your-other-api-endpoint.com/v1

MAX_DEBATE_ITERATIONS=3
```

### 3. 启动应用

```bash
npm run dev
```

应用将在以下地址运行：
- 前端：http://localhost:5173
- 后端：http://localhost:5174

## 使用流程

### 1. 上传图片

- 点击上传区域或拖拽图片文件
- 支持 JPG、PNG、GIF、WebP 格式

### 2. 裁剪题目

- 拖动选框选择题目区域
- 调整选框大小以精确框选题目
- 裁剪会自动保存

### 3. 选择解答模式

#### 单模型模式 🤖
- 快速获得答案
- 适合简单题目
- 响应速度快

#### 多模型博弈模式 🔄
- 两个AI模型相互审查和改进
- 适合复杂题目
- 答案更准确、更完整
- 可以看到迭代过程和共识状态

### 4. 查看结果

结果会显示：
- 识别出的题目内容
- 详细的解答步骤

如果使用多模型博弈模式，还会显示：
- 迭代次数
- 是否达成共识

## 多模型博弈工作原理

```
┌─────────────────────────────────────────┐
│  1. 模型1识别题目并给出初始解答          │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  2. 模型2审查答案，提出改进建议          │
└─────────────────┬───────────────────────┘
                  │
                  ▼
         ┌────────┴────────┐
         │  是否APPROVED？  │
         └────────┬────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
       是                   否
        │                   │
        ▼                   ▼
    ┌──────┐      ┌──────────────────┐
    │ 结束 │      │ 模型1改进答案     │
    └──────┘      └────────┬─────────┘
                           │
                           ▼
                  ┌────────────────────┐
                  │ 返回步骤2继续审查  │
                  └────────────────────┘
```

## 常见问题

### Q: 多模型博弈需要两个不同的API密钥吗？

A: 不需要。你可以使用同一个API密钥配置两个不同的模型（如 gpt-4o-mini 和 gpt-4o）。

### Q: 多模型博弈会消耗更多API调用吗？

A: 是的。每次迭代都会调用两个模型，所以会消耗更多token。但这能显著提高答案质量。

### Q: 如何调整迭代次数？

A: 在 `server/.env` 中修改 `MAX_DEBATE_ITERATIONS` 的值。建议设置为 2-5 次。

### Q: 可以使用本地模型吗？

A: 可以！只要模型API兼容OpenAI格式，就可以配置使用。例如使用 Ollama、LM Studio 等本地模型服务。

### Q: 单模型模式和多模型博弈模式可以同时使用吗？

A: 可以。用户可以在界面上自由切换两种模式。

## 技术支持

如有问题，请检查：
1. API密钥是否正确配置
2. 网络连接是否正常
3. 查看浏览器控制台和服务器日志
