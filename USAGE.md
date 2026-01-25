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

#### 基础模型配置（必需）

自动路由在需要“单模型回答”时，会使用这组默认 OpenAI 配置：

```env
PORT=5174
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

#### 双模型审查配置（可选）

自动路由在需要“双模型审查”时，会使用两套模型配置（模型1生成，模型2审查）：

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

#### 自动路由配置（推荐）

自动路由会先用“路由模型”判断题目更偏文科还是理科，然后按学科配置选择“单模型回答”或“双模型审查”来回答。

```env
# 路由模型（可选，留空则默认复用 OPENAI_API_KEY / OPENAI_BASE_URL）
ROUTER_MODEL=gpt-4o-mini
ROUTER_API_KEY=
ROUTER_BASE_URL=

# 路由策略（可按需调整）
ROUTE_HUMANITIES_MODE=single
ROUTE_SCIENCE_MODE=debate
ROUTE_DEFAULT_MODE=debate

# 自动路由下：单模型模型列表（逗号分隔，取第一个）
ROUTE_HUMANITIES_SINGLE_MODELS=gpt-4o-mini
ROUTE_SCIENCE_SINGLE_MODELS=gpt-4o

# 自动路由下：双模型审查模型列表（逗号分隔，对应模型1、模型2）
ROUTE_HUMANITIES_DEBATE_MODELS=gpt-4o-mini,gpt-4o
ROUTE_SCIENCE_DEBATE_MODELS=gpt-4o-mini,gpt-4o

# 若需要为“双模型审查”分别配置不同的 Key/BaseURL，可按学科覆盖（可选）
# ROUTE_SCIENCE_DEBATE_MODEL1_API_KEY=
# ROUTE_SCIENCE_DEBATE_MODEL1_BASE_URL=
# ROUTE_SCIENCE_DEBATE_MODEL2_API_KEY=
# ROUTE_SCIENCE_DEBATE_MODEL2_BASE_URL=
```

### 3. 启动应用

```bash
npm run dev
```

应用将在以下地址运行：
- 前端：http://localhost:5173
- 后端：http://localhost:5174

### 4. MCP 工具服务（理科用）

理科题会尝试调用 MCP 工具 `execute_python` 进行计算/验算。

本仓库已内置 MCP Python 服务：`tools/mcp_python`，根目录 `npm run dev` 会自动启动它；默认地址为：

- 默认地址：`http://127.0.0.1:8080/method/execute_python`
- 后端配置：`server/.env` 里设置 `MCP_PYTHON_URL` / `MCP_PYTHON_ENABLED`

## 使用流程

### 1. 上传图片

- 点击上传区域或拖拽图片文件
- 支持 JPG、PNG、GIF、WebP 格式

### 2. 裁剪题目

- 拖动选框选择题目区域
- 调整选框大小以精确框选题目
- 裁剪会自动保存

### 3. 自动路由解答

- 先判断文科/理科
- 再按学科配置选择“单模型回答”或“双模型审查”
- 适合不确定题型或批量处理

### 4. 查看结果

结果会显示：
- 识别出的题目内容
- 详细的解答步骤

当自动路由选择“双模型审查”时，还会显示：
- 迭代次数
- 是否达成共识

## 常见问题

### Q: 双模型审查需要两个不同的API密钥吗？

A: 不需要。你可以使用同一个API密钥配置两个不同的模型（如 gpt-4o-mini 和 gpt-4o）。

### Q: 双模型审查会消耗更多API调用吗？

A: 是的。每次迭代都会调用两个模型，所以会消耗更多token，但通常能提高答案质量。

### Q: 如何调整迭代次数？

A: 在 `server/.env` 中修改 `MAX_DEBATE_ITERATIONS` 的值。建议设置为 2-5 次。

### Q: 可以使用本地模型吗？

A: 可以！只要模型API兼容OpenAI格式，就可以配置使用。例如使用 Ollama、LM Studio 等本地模型服务。

### Q: 为什么界面没有“单模型/多模型”切换？

A: 本项目仅保留自动路由模式；是否采用单模型或双模型审查由路由结果自动决定。

## 技术支持

如有问题，请检查：
1. API密钥是否正确配置
2. 网络连接是否正常
3. 查看浏览器控制台和服务器日志
