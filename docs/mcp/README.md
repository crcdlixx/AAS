# MCP Python（Pyodide）工具服务

本项目内置一个 MCP Server，用于在“理科题”场景下执行/验算 Python 代码（例如计算、解方程、作图）。

## 位置

- 服务目录：`tools/mcp_python`
- 默认 HTTP 工具接口：`POST /method/execute_python`

## 本地开发（随 `npm run dev` 启动）

根目录执行：

```bash
npm run dev
```

默认会启动：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:5174`
- MCP Python HTTP：`http://127.0.0.1:8080/method/execute_python`

## 单独运行 MCP（可选）

```bash
cd tools/mcp_python
npm install
npm run build
npm start
```

可用健康检查：

- `GET http://127.0.0.1:8080/health`

## 后端配置

在 `server/.env` 中：

- `MCP_PYTHON_ENABLED=1`（设为 `0` 可禁用）
- `MCP_PYTHON_URL=http://127.0.0.1:8080/method/execute_python`
- `MCP_PYTHON_TIMEOUT_MS=120000`

> 使用 docker-compose 时，后端会把 `MCP_PYTHON_URL` 指向 compose 网络内的 `mcp` 服务（例如 `http://mcp:8080/method/execute_python`）。

