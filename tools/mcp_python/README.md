# mcp-pyodide-python

一个使用 **Pyodide**（Python in WebAssembly）在 Node.js 里运行 Python 代码的 MCP Server，并默认预加载常用科学计算库：`numpy` / `pandas` / `scipy` / `sympy` / `matplotlib`。

## 需求

- Node.js `>= 18.17`

## 安装 & 构建

```bash
npm install
npm run build
```

（可选）跑一次科学计算库的 smoke test：

```bash
npm run smoke
```

## 运行

```bash
npm start
```

默认会启动 HTTP 服务：`POST /method/execute_python`（用于被其他应用直接调用）。

如果你要以 MCP stdio 方式运行（例如 Claude Desktop），请使用：

```bash
npm run start:stdio
```

## MCP 工具

- `python.run`
  - `code` (string, required)：Python 代码
  - `packages` (string[], optional)：需要 `pyodide.loadPackage()` 的包名列表；不传则默认加载科学计算包集合
  - `timeoutMs` (number, optional)：超时（best-effort）

（新增）`execute_python`
  - 入参同上
  - 返回结构对齐为：`{ success, output, image_base64, error, ... }`

## 说明

- 首次加载科学计算包可能会从 Pyodide CDN 下载并缓存在 `node_modules/`（后续会快很多）。
- MCP 的 stdio 协议占用 stdout；本项目把 Pyodide 的日志输出到 stderr。可用 `PYODIDE_LOG=off` 关闭这些日志。

## Claude Desktop 示例配置

在 `claude_desktop_config.json` 里添加：

```json
{
  "mcpServers": {
    "pyodide-python": {
      "command": "node",
      "args": ["C:/Users/Lixx/Documents/mcp_python/dist/index.js"]
    }
  }
}
```

## 可选：指定 Pyodide 资源路径

默认会直接 `loadPyodide()`（会使用你本地安装的 `pyodide` npm 包中的资源）。如果你想显式指定本地资源目录：

- `PYODIDE_INDEX_URL=./node_modules/pyodide/`
