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
- LangChain + LangGraph - 自动路由/多模型编排

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
默认回答模型可通过 `OPENAI_MODEL` 指定，默认 `gpt-4o`。
如遇到输出较长被截断，可在 `server/.env` 里设置 `OPENAI_MAX_TOKENS`（留空则不强制限制）。

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
- 🧭 **自动路由** - 先判断文科/理科，再按学科配置选择模型组合回答
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


## 自动路由机制

自动路由会先用“路由模型”判断题目属于文科/理科，然后按学科配置选择合适的模型组合进行解答（可能是单模型，也可能是双模型审查）。

配置示例见 `server/.env.example`（`ROUTER_*` / `ROUTE_*` / `MODEL1_*` / `MODEL2_*`）。

## 使用说明

1. 上传包含题目的图片
2. 裁剪题目区域
3. 点击“自动路由解答”
4. 查看AI解答结果
